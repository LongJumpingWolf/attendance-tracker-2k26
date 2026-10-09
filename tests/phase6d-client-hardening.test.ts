/**
 * Phase 6D: client-side authentication hardening. Bounded bootstrap retry, pre-expiry refresh margin, failure cooldown,
 * identity changes, graceful unavailability, and the Realtime session rules (setAuth before subscribe, refetch after
 * reconnect). Everything uses fakes: no network, no Firebase, no Supabase. The bridge flag stays OFF in the application.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)

import { createAuthBridge, type BootstrapTransport, type FirebaseIdentitySource, type FirebaseUserLike } from "@/lib/backend/supabase-auth"
import { createRealtimeSession, type ChannelStatus, type RealtimeTransport } from "@/lib/backend/supabase/realtime-session"
import { getBackend, setBackendForTests } from "@/lib/backend"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createSupabaseGuard } from "@/lib/backend/supabase/guard"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setBackendForTests(null)
})
const ROOT = path.resolve(import.meta.dirname, "..")

/** A fake Firebase user. `life` = ms until the current token expires (needs getIdTokenResult). */
function fakeUser(uid: string, opts: { life?: number; refreshFails?: boolean; clock?: { t: number } } = {}) {
  const clock = opts.clock ?? { t: 1_000_000 }
  let n = 0
  let exp = clock.t + (opts.life ?? 3_600_000)
  let token = `tok-${uid}-0`
  const forced: boolean[] = []
  const user: FirebaseUserLike = {
    uid,
    getIdToken: async (force) => {
      forced.push(!!force)
      if (force) {
        if (opts.refreshFails) throw new Error("offline")
        token = `tok-${uid}-${++n}`
        exp = clock.t + 3_600_000
      }
      return token
    },
    getIdTokenResult: async () => ({ token, expirationTime: new Date(exp).toISOString() }),
  }
  return { user, forced, clock, setLife: (ms: number) => (exp = clock.t + ms) }
}
function fakeIdentity(initial: FirebaseUserLike | null) {
  let current = initial
  const listeners = new Set<() => void>()
  const identity: FirebaseIdentitySource = { current: () => current, onChange: (l) => (listeners.add(l), () => void listeners.delete(l)) }
  return { identity, switchTo: (u: FirebaseUserLike | null) => ((current = u), listeners.forEach((l) => l())), fire: () => listeners.forEach((l) => l()) }
}
const statuses = (...s: number[]): BootstrapTransport & { calls: number } => {
  const f = Object.assign(async () => ({ status: s[Math.min(f.calls++, s.length - 1)] }), { calls: 0 })
  return f
}
const noSleep = () => {
  const slept: number[] = []
  return { slept, sleep: async (ms: number) => void slept.push(ms) }
}

describe("bootstrap retry is bounded and only for transient errors", () => {
  it("retries 503 twice with exponential backoff, then succeeds", async () => {
    const { user } = fakeUser("u1")
    const send = statuses(503, 503, 200)
    const s = noSleep()
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: send, retry: { maxAttempts: 3, baseDelayMs: 500, random: () => 0, sleep: s.sleep } })
    expect((await bridge.ensureAuthenticated()).status).toBe("authenticated")
    expect(send.calls).toBe(3)
    expect(s.slept).toEqual([500, 1000])
  })
  it("gives up after maxAttempts, stays unavailable, and never exceeds the cap", async () => {
    const { user } = fakeUser("u1")
    const send = statuses(503)
    const s = noSleep()
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: send, retry: { maxAttempts: 3, random: () => 0, sleep: s.sleep } })
    expect(await bridge.ensureAuthenticated()).toEqual({ status: "unavailable", reason: "unavailable" })
    expect(send.calls).toBe(3)
    expect(s.slept).toHaveLength(2)
  })
  it("the delay is capped and jittered upwards by at most 25 percent", async () => {
    const { user } = fakeUser("u1")
    const s = noSleep()
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: statuses(503), retry: { maxAttempts: 6, baseDelayMs: 1000, maxDelayMs: 3000, random: () => 1, sleep: s.sleep } })
    await bridge.ensureAuthenticated()
    expect(s.slept).toEqual([1250, 2500, 3750, 3750, 3750])
  })
  it("retries 429 and 500; never retries 401 or 403", async () => {
    for (const [status, calls] of [[429, 3], [500, 3], [502, 3], [401, 1], [403, 1]] as const) {
      const { user } = fakeUser("u1")
      const send = statuses(status)
      const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: send, retry: { maxAttempts: 3, random: () => 0, sleep: async () => {} } })
      await bridge.ensureAuthenticated()
      expect(send.calls, String(status)).toBe(calls)
    }
  })
  it("without a retry policy there is exactly one attempt (the 6A behaviour)", async () => {
    const { user } = fakeUser("u1")
    const send = statuses(503)
    await createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: send }).ensureAuthenticated()
    expect(send.calls).toBe(1)
  })
  it("signing out while backing off stops everything: no further send, no token, back to idle", async () => {
    const { user } = fakeUser("u1")
    const id = fakeIdentity(user)
    const send = statuses(503)
    const tokens: (string | null)[] = []
    const bridge = createAuthBridge({ enabled: () => true, identity: id.identity, bootstrap: send, retry: { maxAttempts: 3, sleep: async () => id.switchTo(null) } })
    bridge.onToken((t) => tokens.push(t))
    expect((await bridge.ensureAuthenticated()).status).toBe("idle")
    expect(send.calls).toBe(1)
    expect(tokens).toEqual([])
  })
  it("switching accounts while backing off drops the old attempt entirely", async () => {
    const a = fakeUser("A")
    const b = fakeUser("B")
    const id = fakeIdentity(a.user)
    const send = statuses(503, 200)
    const bridge = createAuthBridge({ enabled: () => true, identity: id.identity, bootstrap: send, retry: { maxAttempts: 3, sleep: async () => id.switchTo(b.user) } })
    expect((await bridge.ensureAuthenticated()).status).toBe("idle")
    expect(await bridge.getToken()).toBeNull() // nothing of A survives
    expect((await bridge.ensureAuthenticated()).status).toBe("authenticated") // B bootstraps on its own
    expect(b.forced).toContain(true)
  })
})

describe("failure cooldown: a failing bootstrap is not called once per operation", () => {
  it("returns the failed state during the cooldown, retries after it, and clears on success", async () => {
    const { user } = fakeUser("u1")
    const clock = { t: 0 }
    const send = statuses(503, 503, 200)
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: send, failureCooldownMs: 30_000, now: () => clock.t })
    expect((await bridge.ensureAuthenticated()).status).toBe("unavailable")
    expect(send.calls).toBe(1)
    clock.t = 10_000
    expect((await bridge.ensureAuthenticated()).status).toBe("unavailable")
    expect(send.calls).toBe(1) // inside the cooldown: nothing sent
    clock.t = 31_000
    expect((await bridge.ensureAuthenticated()).status).toBe("unavailable")
    expect(send.calls).toBe(2)
    clock.t = 62_000
    expect((await bridge.ensureAuthenticated()).status).toBe("authenticated")
    expect(send.calls).toBe(3)
  })
  it("a different account is not held back by another account's failure", async () => {
    const a = fakeUser("A")
    const b = fakeUser("B")
    const id = fakeIdentity(a.user)
    const send = statuses(503, 200)
    const bridge = createAuthBridge({ enabled: () => true, identity: id.identity, bootstrap: send, failureCooldownMs: 30_000, now: () => 0 })
    expect((await bridge.ensureAuthenticated()).status).toBe("unavailable")
    id.switchTo(b.user)
    expect((await bridge.ensureAuthenticated()).status).toBe("authenticated")
  })
})

describe("the app stays usable when the bridge is unavailable", () => {
  it("ensureAuthenticated never throws: unreadable identity, failing getIdToken, failing transport", async () => {
    const throwing: FirebaseIdentitySource = { current: () => { throw new Error("auth not configured") } }
    expect(await createAuthBridge({ enabled: () => true, identity: throwing, bootstrap: statuses(200) }).ensureAuthenticated()).toEqual({ status: "unauthorized", reason: "no-firebase-user" })
    const bad: FirebaseUserLike = { uid: "u", getIdToken: async () => { throw new Error("no token") } }
    expect((await createAuthBridge({ enabled: () => true, identity: fakeIdentity(bad).identity, bootstrap: statuses(200) }).ensureAuthenticated()).status).toBe("unavailable")
    const boom: BootstrapTransport = async () => { throw new Error("offline") }
    expect((await createAuthBridge({ enabled: () => true, identity: fakeIdentity(fakeUser("u").user).identity, bootstrap: boom }).ensureAuthenticated()).status).toBe("unavailable")
  })
  it("a selected Supabase backend with an unavailable bridge refuses with a typed error and sends nothing; the Firebase default is untouched", async () => {
    const { user } = fakeUser("u1")
    const send = statuses(503)
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: send })
    const guard = createSupabaseGuard({ flagEnabled: () => true, config: () => ({ url: "https://x.invalid", publishableKey: "k" }), bridge })
    const rpc = vi.fn()
    const b = createSupabaseBackend({ guard, transport: { rpc, select: vi.fn() } })
    await expect(b.profiles.save("u1", "Name")).rejects.toMatchObject({ kind: "unavailable" })
    expect(rpc).not.toHaveBeenCalled()
    expect(getBackend().kind).toBe("firebase")
  })
})

describe("token refresh margin", () => {
  const mk = (over: Parameters<typeof fakeUser>[1], margin = 120_000) => {
    const f = fakeUser("u1", over)
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(f.user).identity, bootstrap: statuses(200), refreshMarginMs: margin, now: () => f.clock.t })
    return { f, bridge }
  }
  it("hands out the cached token when plenty of life is left (no forced refresh)", async () => {
    const { f, bridge } = mk({ life: 600_000 })
    await bridge.ensureAuthenticated()
    f.forced.length = 0
    expect(await bridge.getToken()).toMatch(/^tok-u1-/)
    expect(f.forced).toEqual([])
  })
  it("force-refreshes a token that has less than the margin left", async () => {
    const { f, bridge } = mk({ life: 600_000 })
    await bridge.ensureAuthenticated()
    f.setLife(60_000)
    f.forced.length = 0
    const t = await bridge.getToken()
    expect(f.forced).toEqual([true])
    expect(t).toMatch(/^tok-u1-/)
  })
  it("if the refresh fails, a token that is still valid is used, an expired one is not", async () => {
    // bootstrap itself force-refreshes, so make the refresh work first and fail afterwards
    const ok = fakeUser("u2", { life: 600_000 })
    let fail = false
    const flaky: FirebaseUserLike = { ...ok.user, getIdToken: async (force) => { if (force && fail) throw new Error("offline"); return ok.user.getIdToken(force) } }
    const b3 = createAuthBridge({ enabled: () => true, identity: fakeIdentity(flaky).identity, bootstrap: statuses(200), refreshMarginMs: 120_000, now: () => ok.clock.t })
    await b3.ensureAuthenticated()
    fail = true
    ok.setLife(60_000)
    expect(await b3.getToken()).toMatch(/^tok-u2-/) // refresh failed, token still valid for 60 s
    ok.setLife(-1000)
    expect(await b3.getToken()).toBeNull() // expired and cannot be refreshed
  })
  it("Firebase's own refresh event hands the Realtime listener a token that respects the margin", async () => {
    const f = fakeUser("u1", { life: 600_000 })
    const id = fakeIdentity(f.user)
    const bridge = createAuthBridge({ enabled: () => true, identity: id.identity, bootstrap: statuses(200), refreshMarginMs: 120_000, now: () => f.clock.t })
    await bridge.ensureAuthenticated()
    const seen: (string | null)[] = []
    bridge.onToken((t) => seen.push(t))
    id.fire()
    await new Promise((r) => setTimeout(r, 0))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatch(/^tok-u1-/)
  })
  it("without a margin (the default) behaviour is unchanged: the SDK's token is handed out as is", async () => {
    const f = fakeUser("u1", { life: 1000 })
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(f.user).identity, bootstrap: statuses(200) })
    await bridge.ensureAuthenticated()
    f.forced.length = 0
    await bridge.getToken()
    expect(f.forced).toEqual([false])
  })
})

describe("identity changes", () => {
  it("sign-out emits a null token once; sign-in as another account bootstraps again and never reuses the old token", async () => {
    const a = fakeUser("A")
    const b = fakeUser("B")
    const id = fakeIdentity(a.user)
    const send = statuses(200)
    const bridge = createAuthBridge({ enabled: () => true, identity: id.identity, bootstrap: send })
    const tokens: (string | null)[] = []
    bridge.onToken((t) => tokens.push(t))
    await bridge.ensureAuthenticated()
    id.switchTo(null)
    expect(tokens.filter((t) => t === null)).toHaveLength(1)
    expect(await bridge.getToken()).toBeNull()
    id.switchTo(b.user)
    await bridge.ensureAuthenticated()
    expect(send.calls).toBe(2)
    expect(tokens.at(-1)).toMatch(/^tok-B-/)
    expect(tokens.filter((t) => t?.includes("-A-"))).toHaveLength(1)
  })
})

// ---- Realtime session ---------------------------------------------------------------------------------------------------

function realtimeHarness(initial: FirebaseUserLike | null = fakeUser("u1").user) {
  const id = fakeIdentity(initial)
  const bridge = createAuthBridge({ enabled: () => true, identity: id.identity, bootstrap: statuses(200) })
  const log: string[] = []
  let push: ((s: ChannelStatus) => void) | null = null
  let change: (() => void) | null = null
  const transport: RealtimeTransport = {
    setAuth: (t) => void log.push(`setAuth:${t ?? "null"}`),
    subscribe: (h) => {
      log.push("subscribe")
      push = h.onStatus
      change = h.onChange
      return () => void log.push("unsubscribe")
    },
  }
  const refetch = vi.fn(() => void log.push("refetch"))
  const onChange = vi.fn()
  const states: boolean[] = []
  const session = createRealtimeSession({ bridge, transport, refetch, onChange, onState: (l) => states.push(l) })
  const flush = () => new Promise((r) => setTimeout(r, 0))
  return { id, bridge, log, session, refetch, onChange, states, flush, status: (s: ChannelStatus) => push?.(s), change: () => change?.() }
}

describe("Realtime session: setAuth before subscribe, refetch after (re)subscribe", () => {
  it("authenticates the bridge, calls setAuth with the Firebase token, THEN subscribes, then refetches on subscribed", async () => {
    const h = realtimeHarness()
    await h.session.start()
    expect(h.log.slice(0, 2)).toEqual([expect.stringMatching(/^setAuth:tok-u1-/), "subscribe"])
    h.status("subscribed")
    await h.flush()
    expect(h.log.at(-1)).toBe("refetch")
    expect(h.states.at(-1)).toBe(true)
  })
  it("a reconnect refreshes the token first, then refetches again (missed events are not replayed)", async () => {
    const h = realtimeHarness()
    await h.session.start()
    h.status("subscribed")
    await h.flush()
    h.log.length = 0
    h.status("closed")
    await h.flush()
    expect(h.log).toEqual([expect.stringMatching(/^setAuth:tok-u1-/)]) // fresh token before the channel re-joins
    expect(h.states.at(-1)).toBe(false)
    h.status("subscribed")
    await h.flush()
    expect(h.refetch).toHaveBeenCalledTimes(2)
    h.status("error")
    h.status("subscribed")
    await h.flush()
    expect(h.refetch).toHaveBeenCalledTimes(3)
  })
  it("every token change is passed to setAuth without resubscribing", async () => {
    const h = realtimeHarness()
    await h.session.start()
    h.log.length = 0
    h.id.fire()
    await h.flush()
    expect(h.log.filter((l) => l.startsWith("setAuth:tok"))).toHaveLength(1)
    expect(h.log).not.toContain("subscribe")
  })
  it("sign-out clears the Realtime token and drops the channel; signing back in resubscribes with setAuth first", async () => {
    const h = realtimeHarness()
    await h.session.start()
    h.log.length = 0
    h.id.switchTo(null)
    await h.flush()
    expect(h.log).toEqual(["setAuth:null", "unsubscribe"])
    expect(h.states.at(-1)).toBe(false)
    h.log.length = 0
    h.id.switchTo(fakeUser("u2").user)
    await h.bridge.ensureAuthenticated()
    await h.flush()
    expect(h.log.indexOf("subscribe")).toBeGreaterThan(h.log.findIndex((l) => l.startsWith("setAuth:tok-u2")))
  })
  it("a late event after sign-out cannot re-join as the old account", async () => {
    const h = realtimeHarness()
    await h.session.start()
    h.status("subscribed")
    await h.flush()
    h.id.switchTo(null)
    await h.flush()
    h.log.length = 0
    h.status("closed")
    await h.flush()
    expect(h.log.filter((l) => l.startsWith("setAuth:tok"))).toEqual([])
  })
  it("never subscribes when the bridge is not authenticated", async () => {
    const h = realtimeHarness(null)
    await h.session.start()
    expect(h.log).toEqual([])
    expect(h.states).toEqual([false])
  })
  it("stop() unsubscribes, clears the token and ignores later events", async () => {
    const h = realtimeHarness()
    await h.session.start()
    h.log.length = 0
    h.session.stop()
    await h.flush()
    expect(h.log).toEqual(expect.arrayContaining(["unsubscribe", "setAuth:null"]))
    h.status("subscribed")
    h.change()
    await h.flush()
    expect(h.refetch).not.toHaveBeenCalled()
  })
  it("database changes are forwarded; transport failures never reach the caller", async () => {
    const h = realtimeHarness()
    await h.session.start()
    h.change()
    expect(h.onChange).toHaveBeenCalledTimes(1)
    const bad = createRealtimeSession({
      bridge: h.bridge,
      transport: { setAuth: () => { throw new Error("socket") }, subscribe: () => { throw new Error("socket") } },
      refetch: () => { throw new Error("refetch") },
    })
    await expect(bad.start()).resolves.toBeUndefined()
    bad.stop()
  })
  it("start() is idempotent", async () => {
    const h = realtimeHarness()
    await h.session.start()
    await h.session.start()
    expect(h.log.filter((l) => l === "subscribe")).toHaveLength(1)
  })
})

describe("no new dependency for the normal app while the bridge is disabled", () => {
  it("no application file imports the Realtime session, and only lib/backend names Supabase", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const importers = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => /realtime-session/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    expect(importers).toEqual([])
  })
  it("production wiring sets the documented limits", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib", "backend", "index.ts"), "utf8")
    expect(src).toMatch(/retry: \{ maxAttempts: 3 \}/)
    expect(src).toMatch(/refreshMarginMs: 120_000/)
    expect(src).toMatch(/failureCooldownMs: 30_000/)
  })
  it("with the flag off the bridge is inert whatever the retry settings", async () => {
    const { user } = fakeUser("u1")
    const send = vi.fn(async () => ({ status: 200 }))
    const cur = vi.fn(() => user)
    const bridge = createAuthBridge({ enabled: () => false, identity: { current: cur }, bootstrap: send, retry: { maxAttempts: 3 }, refreshMarginMs: 120_000, failureCooldownMs: 30_000 })
    expect(await bridge.ensureAuthenticated()).toEqual({ status: "unavailable", reason: "disabled" })
    expect(cur).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })
})
