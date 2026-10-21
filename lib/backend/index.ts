/**
 * The ONE place that decides which backend answers. Everything else asks `getDomainBackend("sync" | "social" | "ping" | "push")` and never
 * checks a flag. Each domain has its own optional NEXT_PUBLIC_BACKEND_<DOMAIN> value (see resolveDomainKind below); with none set, every domain
 * follows NEXT_PUBLIC_BACKEND, described next, whose default is Firebase.
 *
 *   NEXT_PUBLIC_BACKEND   unset or "firebase"  -> Firebase (the production backend, the default)
 *                         "supabase"           -> the Supabase skeleton, which refuses every call (fails closed): nothing
 *                                                 can reach Supabase until a later phase wires and authorizes it. Even then it
 *                                                 needs NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE=true, the Supabase configuration and a
 *                                                 valid bridge token (lib/backend/supabase/guard.ts)
 *                         anything else        -> an error, never a silent fallback
 *
 * There is no user-visible setting and no runtime switch.
 */
import { getAuth, onIdTokenChanged } from "firebase/auth"
import { app, db } from "../firebase"
import { ensureSignedIn } from "../social"
import { BackendError } from "./errors"
import type { Backend, BackendKind } from "./contracts"
import { createFirebaseBackend } from "./firebase"
import { createSupabaseBackend, createSupabaseGuard, readBuildSupabaseConfig } from "./supabase"
import { createFetchTransport } from "./supabase/transport"
import { createPhoenixRealtimeTransport } from "./supabase/realtime-transport"
import { anyShadowFlag, authBridgeEnabled, realtimeEnabled, shadowFlags, shadowReadEnabled, type ShadowFlags } from "./flags"
import { isolateShadowFailures } from "./shadow"
import { createSupabaseShadowWriter } from "./shadow-supabase"
import { withShadow } from "./shadow-backend"
import { createShadowReader, readSurface, type ShadowReader } from "./shadow-read"
import { createAuthBridge, createFetchBootstrapTransport, type AuthBridge } from "./supabase-auth"

export * from "./contracts"
export { BackendError, isBackendError, type BackendErrorKind } from "./errors"

export function resolveBackendKind(raw: string | undefined): BackendKind {
  const v = raw?.trim().toLowerCase()
  if (!v || v === "firebase") return "firebase"
  if (v === "supabase") return "supabase"
  throw new BackendError("invalid", `Unknown backend "${raw}". Use "firebase" or "supabase".`, { code: "invalid-backend-config" })
}

/** The static reference lets Next.js inline the build-time value */
const configured = () => resolveBackendKind(process.env.NEXT_PUBLIC_BACKEND)

let bridge: AuthBridge | null = null

/**
 * The Firebase -> Supabase auth bridge, built on first use. Building it does nothing: no Firebase call, no network, no
 * subscription. It is only consulted by the Supabase guard, and the guard only runs when the Supabase backend is selected.
 */
export function getAuthBridge(): AuthBridge {
  bridge ??= createAuthBridge({
    enabled: authBridgeEnabled,
    identity: {
      current: () => {
        try {
          return getAuth(app).currentUser
        } catch {
          return null // Firebase Auth is not configured (local mode): there is no user, so the bridge stays unauthorized
        }
      },
      onChange: (listener) => onIdTokenChanged(getAuth(app), () => listener()),
    },
    bootstrap: async (idToken) => {
      const config = readBuildSupabaseConfig()
      if (!config) throw new Error("Supabase is not configured")
      return createFetchBootstrapTransport(config)(idToken)
    },
    // Phase 6D: at most 3 attempts with backoff for transient failures, tokens refreshed 2 minutes before expiry, and a
    // 30 s pause after a failure so a down bootstrap is not called once per operation. Only reachable with the bridge flag on.
    retry: { maxAttempts: 3 },
    refreshMarginMs: 120_000,
    failureCooldownMs: 30_000,
  })
  return bridge
}

/**
 * Firebase, optionally with the Phase 6B shadow writer around it. With every shadow flag off (the default), or the auth
 * bridge off, or the Supabase configuration missing, this returns `base` itself: the same object, nothing wrapped.
 */
function firebaseWithOptionalShadow(base: Backend, flags: ShadowFlags): Backend {
  if (!anyShadowFlag(flags) || !authBridgeEnabled() || !readBuildSupabaseConfig()) return base
  const guard = createSupabaseGuard({ flagEnabled: authBridgeEnabled, config: readBuildSupabaseConfig, bridge: getAuthBridge() })
  const writer = createSupabaseShadowWriter({
    guard,
    config: readBuildSupabaseConfig,
    currentUid: () => {
      try {
        return getAuth(app).currentUser?.uid ?? null
      } catch {
        return null
      }
    },
  })
  return withShadow(base, isolateShadowFailures(writer), flags)
}

/**
 * The real Supabase transport, built ONLY when the `supabase` backend kind is selected. A missing or unsafe configuration
 * yields no transport, and the adapter then refuses every call as "not configured". The guard still runs before each call.
 */
function buildSupabaseTransport() {
  const config = readBuildSupabaseConfig()
  if (!config) return undefined
  try {
    return createFetchTransport({ config })
  } catch {
    return undefined
  }
}

/**
 * Phase 8: live delivery of the sync document. Only built inside the `supabase` branch of getBackend() (so never while Firebase is
 * selected, which is the production default), only with NEXT_PUBLIC_SUPABASE_REALTIME=true, and only with the configuration present.
 */
function buildRealtime() {
  if (!realtimeEnabled()) return undefined
  const config = readBuildSupabaseConfig()
  if (!config) return undefined
  return {
    bridge: getAuthBridge(),
    createTransport: (owner: string) => createPhoenixRealtimeTransport({ config, table: "syncs", filter: `uid=eq.${owner}` }),
  }
}

/** The four independently routable areas of the app. Each one is served by exactly one backend kind. */
export type BackendDomain = "sync" | "social" | "ping" | "push"
export const BACKEND_DOMAINS: readonly BackendDomain[] = ["sync", "social", "ping", "push"]

/**
 * Per-domain choice (Phase 9-12 cutover, one domain at a time). Each domain has its own optional build-time value; when it is unset or
 * empty the domain follows NEXT_PUBLIC_BACKEND, which itself defaults to Firebase. So with nothing set every domain is Firebase, and a
 * domain value always wins over the global one (a domain can be pinned to Firebase even if the global value says supabase).
 *
 *   NEXT_PUBLIC_BACKEND_SYNC     the synced backup copy (lib/cloud-sync.ts)
 *   NEXT_PUBLIC_BACKEND_SOCIAL   profile names, invites, connections
 *   NEXT_PUBLIC_BACKEND_PING     Pings
 *   NEXT_PUBLIC_BACKEND_PUSH     push tokens
 *
 * "supabase" for a domain without the Supabase configuration, the bridge flag or a valid bridge token does NOT fall back to Firebase:
 * that backend refuses every call (the established fail-closed rule, lib/backend/supabase/guard.ts), so a half-configured build cannot
 * silently keep using, or silently stop using, the other system. An unknown value throws, as before.
 */
export function resolveDomainKind(raw: { global?: string; domain?: string }): BackendKind {
  const specific = raw.domain?.trim()
  return resolveBackendKind(specific ? specific : raw.global)
}

/** The static references let Next.js inline the build-time values */
const rawDomainValue = (d: BackendDomain): string | undefined =>
  d === "sync"
    ? process.env.NEXT_PUBLIC_BACKEND_SYNC
    : d === "social"
      ? process.env.NEXT_PUBLIC_BACKEND_SOCIAL
      : d === "ping"
        ? process.env.NEXT_PUBLIC_BACKEND_PING
        : process.env.NEXT_PUBLIC_BACKEND_PUSH

export const backendKindFor = (d: BackendDomain): BackendKind => resolveDomainKind({ global: process.env.NEXT_PUBLIC_BACKEND, domain: rawDomainValue(d) })

// One instance per kind (and per flag combination), shared by every domain that uses that kind: a Firebase domain and another Firebase
// domain get the very same backend object, and the Supabase backend (with its watchers) exists only if some domain actually uses it.
const instances = new Map<string, Backend>()
let override: Backend | null = null
const domainOverride = new Map<BackendDomain, Backend>()

function backendOfKind(kind: BackendKind): Backend {
  const flags = shadowFlags()
  const key = `${kind}|${flags.sync}|${flags.social}|${flags.push}|${authBridgeEnabled()}|${realtimeEnabled()}`
  const hit = instances.get(key)
  if (hit) return hit
  const made =
    kind === "supabase"
      ? createSupabaseBackend({ guard: createSupabaseGuard({ flagEnabled: authBridgeEnabled, config: readBuildSupabaseConfig, bridge: getAuthBridge() }), transport: buildSupabaseTransport(), realtime: buildRealtime(), watchPollMs: realtimeEnabled() ? 5_000 : undefined })
      : firebaseWithOptionalShadow(createFirebaseBackend({ db, ensureSignedIn }), flags)
  instances.set(key, made)
  return made
}

/** The backend that answers for ONE domain. Application code asks for its domain and never checks a flag. */
export function getDomainBackend(domain: BackendDomain): Backend {
  return domainOverride.get(domain) ?? override ?? backendOfKind(backendKindFor(domain))
}

/** The backend selected by NEXT_PUBLIC_BACKEND alone (what a domain with no value of its own follows). Application code uses getDomainBackend. */
export function getBackend(): Backend {
  if (override) return override
  return backendOfKind(resolveBackendKind(process.env.NEXT_PUBLIC_BACKEND)) // throws on an invalid value: fail closed
}

/**
 * The Phase 7 read-only shadow reader, or null. It exists only when ALL of these hold: NEXT_PUBLIC_SUPABASE_SHADOW_READ=true,
 * NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE=true, the Supabase configuration is present and safe, and Firebase is the selected backend.
 * Nothing in the application calls it: it is for a controlled build, a developer panel or a test. It never writes to either side;
 * the Firebase side is created without the anonymous sign-in helper, so reading can never create a user.
 */
export function getShadowReader(): ShadowReader | null {
  if (!shadowReadEnabled() || !authBridgeEnabled() || !readBuildSupabaseConfig()) return null
  try {
    if (configured() !== "firebase") return null
  } catch {
    return null
  }
  const transport = buildSupabaseTransport()
  if (!transport) return null
  const guard = createSupabaseGuard({ flagEnabled: authBridgeEnabled, config: readBuildSupabaseConfig, bridge: getAuthBridge() })
  return createShadowReader({
    authoritative: readSurface(createFirebaseBackend({ db })),
    shadow: readSurface(createSupabaseBackend({ guard, transport })),
    currentUid: () => {
      try {
        return getAuth(app).currentUser?.uid ?? null
      } catch {
        return null
      }
    },
  })
}

/** Tests only: install a backend (or null to go back to the configured one) */
export function setBackendForTests(b: Backend | null) {
  override = b
}

/** Tests only: install a backend for one domain (or null to remove it) */
export function setDomainBackendForTests(domain: BackendDomain, b: Backend | null) {
  if (b) domainOverride.set(domain, b)
  else domainOverride.delete(domain)
}
