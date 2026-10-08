/**
 * The future Firebase -> Supabase auth bridge CLIENT (Phase 6A). Feature-flagged OFF, wired to nothing, never called by
 * the application. It exists so the Supabase adapter can be written against a stable, tested seam.
 *
 * What the bridge does (when a later phase turns it on):
 *   1. looks at the current FIREBASE user (never at a uid someone hands it),
 *   2. takes that user's Firebase ID token and asks the (future) bootstrap endpoint to give the account the Supabase
 *      `authenticated` role,
 *   3. force-refreshes the Firebase token so the new claim is in it (a claim only appears on a newly issued token),
 *   4. exposes the refreshed token and a small state model.
 * (Phase 5 spike: PHASE5_AUTH_SPIKE.md. A new user's first token runs as `anon` until steps 2 and 3 have finished, so
 * nothing authenticated may start before `ensureAuthenticated()` has resolved to `authenticated`.)
 *
 * What it can NOT do, by construction: it takes no uid, no role, no claim and no token from its callers; it never reads,
 * decodes, builds or signs a JWT; it holds no service account and does not talk to the Firebase Admin SDK. The bootstrap
 * sees only the Firebase token it is given and answers with a status; the response body is never read, so no server
 * detail can reach the UI.
 *
 * "A Firebase user exists" does NOT mean "the sync identity is ready". The bridge only says whether the Firebase user can
 * talk to Supabase. Whether that user is anonymous or a Google account, and what that means for sync, stays with the
 * existing identity layer (lib/identity.ts), which this file does not touch.
 */
import type { Unsubscribe } from "./contracts"

// ---- the bootstrap contract ---------------------------------------------------------------------------------------

export type BootstrapErrorKind = "unavailable" | "unauthorized" | "invalid-token" | "rate-limited" | "server-error"

/** `refreshRequired` is always true on success: the caller must force-refresh the Firebase token before using it */
export type BootstrapOutcome = { ok: true; refreshRequired: true } | { ok: false; error: BootstrapErrorKind }

/** The only thing the bridge looks at in the bootstrap response */
export interface BootstrapResponse {
  status: number
}

/** Sends the Firebase ID token (and nothing else) to the bootstrap endpoint */
export type BootstrapTransport = (idToken: string) => Promise<BootstrapResponse>

export function mapBootstrapStatus(status: number): BootstrapOutcome {
  if (status === 200) return { ok: true, refreshRequired: true }
  if (status === 401) return { ok: false, error: "invalid-token" }
  if (status === 403) return { ok: false, error: "unauthorized" }
  if (status === 429) return { ok: false, error: "rate-limited" }
  if (status === 404 || status === 408 || status === 502 || status === 503 || status === 504) return { ok: false, error: "unavailable" }
  return { ok: false, error: "server-error" }
}

/** Input: a Firebase ID token. Output: success (refresh required) or one of five errors. Never throws. */
export async function bootstrapFirebaseIdentity(idToken: string, send: BootstrapTransport): Promise<BootstrapOutcome> {
  if (typeof idToken !== "string" || idToken.length === 0) return { ok: false, error: "invalid-token" }
  try {
    return mapBootstrapStatus((await send(idToken)).status)
  } catch {
    return { ok: false, error: "unavailable" } // offline, DNS, CORS, timeout
  }
}

/** The path of the future bootstrap Edge Function on the Supabase project. Not deployed in production. */
export const BOOTSTRAP_PATH = "/functions/v1/auth-role-bootstrap"

/** A fetch-based transport. Only built when the flag is on and the Supabase configuration exists; never sends a body. */
export function createFetchBootstrapTransport(config: { url: string; publishableKey: string }, fetchFn: typeof fetch = fetch): BootstrapTransport {
  return async (idToken) => {
    const res = await fetchFn(`${config.url.replace(/\/+$/, "")}${BOOTSTRAP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${idToken}`, apikey: config.publishableKey },
    })
    return { status: res.status }
  }
}

// ---- the bridge ---------------------------------------------------------------------------------------------------

/** The two things the bridge needs from Firebase Auth. `uid` is only ever read from here. */
export interface FirebaseUserLike {
  readonly uid: string
  getIdToken(forceRefresh?: boolean): Promise<string>
}

export interface FirebaseIdentitySource {
  current(): FirebaseUserLike | null
  /** Optional: Firebase's own signal that the ID token changed (hourly refresh, sign-in, sign-out) */
  onChange?(listener: () => void): Unsubscribe
}

export type BridgeStatus = "idle" | "bootstrapping" | "authenticated" | "unavailable" | "unauthorized" | "error"
export type BridgeReason = BootstrapErrorKind | "disabled" | "no-firebase-user"

export interface BridgeState {
  status: BridgeStatus
  reason?: BridgeReason
}

export interface AuthBridge {
  state(): BridgeState
  subscribe(listener: (state: BridgeState) => void): Unsubscribe
  /** Takes no argument: the identity is the current Firebase user, nothing else. Resolves to the final state. */
  ensureAuthenticated(): Promise<BridgeState>
  /** A Firebase token that carries the bridged role, or null when the bridge is not authenticated for the CURRENT Firebase user */
  getToken(): Promise<string | null>
  /** Called with the token whenever it changes, and with null when the bridge stops being authenticated (Supabase `realtime.setAuth` follows this) */
  onToken(listener: (token: string | null) => void): Unsubscribe
  /** Back to idle (sign-out, account switch). Emits a null token if it was authenticated. */
  reset(): void
}

export interface AuthBridgeDeps {
  enabled: () => boolean
  identity: FirebaseIdentitySource
  bootstrap: BootstrapTransport
}

const statusFor = (error: BootstrapErrorKind): BridgeStatus =>
  error === "unavailable" ? "unavailable" : error === "unauthorized" || error === "invalid-token" ? "unauthorized" : "error"

export function createAuthBridge(deps: AuthBridgeDeps): AuthBridge {
  let state: BridgeState = { status: "idle" }
  let authedUid: string | null = null
  let inflight: { uid: string; promise: Promise<BridgeState> } | null = null
  const stateListeners = new Set<(s: BridgeState) => void>()
  const tokenListeners = new Set<(t: string | null) => void>()
  let offIdentity: Unsubscribe | null = null

  const set = (next: BridgeState) => {
    state = next
    stateListeners.forEach((l) => l(state))
  }
  const emitToken = (t: string | null) => tokenListeners.forEach((l) => l(t))

  function reset() {
    const was = authedUid !== null
    authedUid = null
    inflight = null
    set({ status: "idle" })
    if (was) emitToken(null)
  }

  /** Follows Firebase's own token changes so Realtime can be given the new token, and drops the bridge on an account change */
  const watchIdentity = () => {
    if (offIdentity || !deps.identity.onChange) return
    offIdentity = deps.identity.onChange(() => {
      const user = deps.identity.current()
      if (!authedUid) return
      if (!user || user.uid !== authedUid) return reset()
      user.getIdToken().then(emitToken, () => {})
    })
  }

  async function run(uid: string, user: FirebaseUserLike): Promise<BridgeState> {
    set({ status: "bootstrapping" })
    let outcome: BootstrapOutcome
    try {
      outcome = await bootstrapFirebaseIdentity(await user.getIdToken(), deps.bootstrap)
    } catch {
      outcome = { ok: false, error: "unavailable" } // no Firebase token could be obtained
    }
    if (deps.identity.current()?.uid !== uid) {
      reset() // the account changed while we were waiting: nothing from this attempt may survive
      return state
    }
    if (!outcome.ok) {
      set({ status: statusFor(outcome.error), reason: outcome.error })
      return state
    }
    let token: string
    try {
      token = await user.getIdToken(true) // the new claim is only in a newly issued token
    } catch {
      set({ status: "unavailable", reason: "unavailable" })
      return state
    }
    if (deps.identity.current()?.uid !== uid) {
      reset()
      return state
    }
    authedUid = uid
    set({ status: "authenticated" })
    emitToken(token)
    return state
  }

  return {
    state: () => state,
    subscribe(l) {
      stateListeners.add(l)
      return () => void stateListeners.delete(l)
    },
    async ensureAuthenticated() {
      if (!deps.enabled()) {
        set({ status: "unavailable", reason: "disabled" }) // flag off: Firebase Auth is not even consulted
        return state
      }
      const user = deps.identity.current()
      if (!user) {
        if (authedUid) reset()
        set({ status: "unauthorized", reason: "no-firebase-user" })
        return state
      }
      const uid = user.uid
      if (authedUid && authedUid !== uid) reset() // account switch
      if (authedUid === uid && state.status === "authenticated") return state
      if (inflight && inflight.uid === uid) return inflight.promise
      watchIdentity()
      const promise = run(uid, user).finally(() => {
        if (inflight?.promise === promise) inflight = null
      })
      inflight = { uid, promise }
      return promise
    },
    async getToken() {
      if (!deps.enabled() || !authedUid) return null
      const user = deps.identity.current()
      if (!user || user.uid !== authedUid) return null
      try {
        return await user.getIdToken()
      } catch {
        return null
      }
    },
    onToken(l) {
      tokenListeners.add(l)
      return () => void tokenListeners.delete(l)
    },
    reset,
  }
}
