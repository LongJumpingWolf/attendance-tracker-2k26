/**
 * Supabase Realtime session controller (Phase 6D). NOT wired into the application: nothing imports it, the Supabase adapter
 * still reports realtime as "not live", and the bridge flag is off. It encodes the two Phase 5 (S12) rules so the later
 * Realtime phase cannot get them wrong:
 *
 *   1. `realtime.setAuth(token)` is called with the bridge's Firebase token BEFORE every subscribe, again on every token
 *      change, and before a dropped channel re-joins. Without it every event arrives as "401 Unauthorized" (fail closed).
 *   2. Postgres Changes events missed while disconnected are NOT replayed, so the data is refetched every time the channel
 *      becomes subscribed (the first time too: events between the initial read and the subscribe would otherwise be lost).
 *
 * Sign-out / account switch (the bridge emits a null token) clears the Realtime token and drops the channel. The session
 * never throws into the caller and never subscribes unless the bridge is authenticated for the current Firebase user.
 */
import type { Unsubscribe } from "../contracts"
import type { AuthBridge } from "../supabase-auth"

export type ChannelStatus = "subscribed" | "closed" | "error"

export interface RealtimeTransport {
  /** Supabase `realtime.setAuth(token)`; null clears it */
  setAuth(token: string | null): void | Promise<void>
  /** Opens the channel. `onStatus` reports its lifecycle (including automatic re-joins); `onChange` reports a database change. Returns the unsubscribe. */
  subscribe(handlers: { onStatus(status: ChannelStatus): void; onChange(): void }): Unsubscribe
}

export interface RealtimeSessionDeps {
  bridge: Pick<AuthBridge, "ensureAuthenticated" | "getToken" | "onToken">
  transport: RealtimeTransport
  /** Re-reads the data this subscription covers. Called after every (re)subscribe. */
  refetch: () => void | Promise<void>
  /** Called when the data changed in the database (the caller usually refetches or applies it) */
  onChange?: () => void
  onState?: (live: boolean) => void
}

export interface RealtimeSession {
  start(): Promise<void>
  stop(): void
}

export function createRealtimeSession(deps: RealtimeSessionDeps): RealtimeSession {
  let wanted = false
  let generation = 0
  let unsubscribeChannel: Unsubscribe | null = null
  let opening = false // one open at a time: the token the bridge emits while authenticating must not start a second one
  let offToken: Unsubscribe | null = null

  const safe = async (f: () => void | Promise<void>) => {
    try {
      await f()
    } catch {
      /* a Realtime problem must never reach the app */
    }
  }

  function dropChannel() {
    const u = unsubscribeChannel
    unsubscribeChannel = null
    if (u) void safe(u)
  }

  async function open(gen: number) {
    if (opening || unsubscribeChannel) return
    opening = true
    try {
      await openOnce(gen)
    } finally {
      opening = false
    }
  }

  async function openOnce(gen: number) {
    const state = await deps.bridge.ensureAuthenticated()
    if (gen !== generation || !wanted) return
    if (state.status !== "authenticated") return void deps.onState?.(false)
    const token = await deps.bridge.getToken()
    if (gen !== generation || !wanted) return
    if (!token) return void deps.onState?.(false)
    await safe(() => deps.transport.setAuth(token)) // BEFORE subscribing
    if (gen !== generation || !wanted || unsubscribeChannel) return
    unsubscribeChannel = deps.transport.subscribe({
      onChange: () => void safe(() => deps.onChange?.()),
      onStatus: (status) => {
        if (gen !== generation || !wanted) return
        if (status === "subscribed") {
          deps.onState?.(true)
          void safe(deps.refetch) // missed events are not replayed
          return
        }
        deps.onState?.(false)
        void refreshAuthForRejoin(gen) // the channel will re-join on its own: give it a fresh token first
      },
    })
  }

  async function refreshAuthForRejoin(gen: number) {
    let token: string | null = null
    try {
      token = await deps.bridge.getToken()
    } catch {
      token = null
    }
    if (gen !== generation || !wanted) return
    if (!token) {
      dropChannel() // signed out meanwhile: do not re-join as anyone
      return
    }
    await safe(() => deps.transport.setAuth(token))
  }

  return {
    async start() {
      if (wanted) return
      wanted = true
      const gen = ++generation
      offToken = deps.bridge.onToken((token) => {
        if (!wanted) return
        if (opening && token !== null) return // open() is about to read the latest token itself
        if (token === null) {
          // sign-out or account switch: clear the Realtime identity and drop the channel
          void safe(() => deps.transport.setAuth(null))
          dropChannel()
          deps.onState?.(false)
          return
        }
        void safe(() => deps.transport.setAuth(token)) // every token change
        if (!unsubscribeChannel) void safe(() => open(gen)) // signed back in: resubscribe, setAuth first
      })
      await safe(() => open(gen))
    },
    stop() {
      wanted = false
      generation++
      offToken?.()
      offToken = null
      dropChannel()
      void safe(() => deps.transport.setAuth(null))
      deps.onState?.(false)
    },
  }
}
