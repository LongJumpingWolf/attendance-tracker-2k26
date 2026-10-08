/**
 * Phase 6A: the auth bridge client, its feature flag, the Supabase authorization guard and the Realtime token seam.
 * Everything here uses fakes: no network, no Firebase, no Supabase, no credentials. The flag is OFF by default.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)

import { authBridgeEnabled, parseAuthBridgeFlag } from "@/lib/backend/flags"
import {
  bootstrapFirebaseIdentity,
  createAuthBridge,
  createFetchBootstrapTransport,
  mapBootstrapStatus,
  type BootstrapTransport,
  type FirebaseIdentitySource,
  type FirebaseUserLike,
} from "@/lib/backend/supabase-auth"
import { createSupabaseBackend, createSupabaseGuard, type SupabaseTransport } from "@/lib/backend/supabase"
import { getAuthBridge, getBackend, resolveBackendKind, setBackendForTests } from "@/lib/backend"
import { BackendError } from "@/lib/backend/errors"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setBackendForTests(null)
})

const ROOT = path.resolve(import.meta.dirname, "..")

/** A fake Firebase user whose tokens are opaque strings; records how it was called */
function fakeUser(uid: string) {
  let n = 0
  const calls: (boolean | undefined)[] = []
  const user: FirebaseUserLike = {
    uid,
    getIdToken: async (force) => {
      calls.push(force)
      return force ? `token-${uid}-refreshed-${++n}` : `token-${uid}-initial`
    },
  }
  return { user, calls }
}
function fakeIdentity(initial: FirebaseUserLike | null) {
  let current = initial
  const listeners = new Set<() => void>()
  const identity: FirebaseIdentitySource = {
    current: () => current,
    onChange: (l) => {
      listeners.add(l)
      return () => void listeners.delete(l)
    },
  }
  return {
    identity,
    switchTo: (u: FirebaseUserLike | null) => {
      current = u
      listeners.forEach((l) => l())
    },
    fire: () => listeners.forEach((l) => l()),
  }
}
const ok: BootstrapTransport = async () => ({ status: 200 })

describe("the feature flag: OFF by default, only an explicit true turns it on", () => {
  it("is off when unset, empty, false or anything else", () => {
    expect(authBridgeEnabled()).toBe(false)
    for (const v of [undefined, "", "false", "0", "1", "yes", "on", "tru", "truee"]) expect(parseAuthBridgeFlag(v), String(v)).toBe(false)
  })
  it("is on only for true (any case, spaces ignored)", () => {
    for (const v of ["true", "TRUE", " True "]) expect(parseAuthBridgeFlag(v)).toBe(true)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE", "true")
    expect(authBridgeEnabled()).toBe(true)
  })
  it("is read in exactly one place and has no user-visible setting", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const files = ["app", "components", "hooks", "lib"].flatMap((d) => walk(d))
    expect(files.filter((f) => /process\.env\.NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))).toEqual(["lib/backend/flags.ts"])
    expect(files.filter((f) => /authBridgeEnabled/.test(fs.readFileSync(path.join(ROOT, f), "utf8"))).every((f) => f.startsWith("lib/backend/"))).toBe(true)
  })
})

describe("flag OFF preserves current behaviour", () => {
  it("the production default is Firebase, with or without Supabase variables, and the bridge is never touched", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "not-a-real-key")
    expect(resolveBackendKind(process.env.NEXT_PUBLIC_BACKEND)).toBe("firebase")
    expect(getBackend().kind).toBe("firebase")
    expect(getBackend().realtimeAuth).toBeUndefined() // the Firebase adapter is unchanged: it has no token seam
  })
  it("with the flag off the bridge never asks Firebase for anything and never sends anything", async () => {
    const f = fakeUser("u1")
    const send = vi.fn(ok)
    const identity = vi.fn(() => f.user)
    const bridge = createAuthBridge({ enabled: () => false, identity: { current: identity }, bootstrap: send })
    expect(await bridge.ensureAuthenticated()).toEqual({ status: "unavailable", reason: "disabled" })
    expect(await bridge.getToken()).toBeNull()
    expect(identity).not.toHaveBeenCalled()
    expect(f.calls).toEqual([])
    expect(send).not.toHaveBeenCalled()
  })
  it("the default wiring does not touch the network when the flag is off", async () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    vi.stubGlobal("XMLHttpRequest", net)
    expect(await getAuthBridge().ensureAuthenticated()).toEqual({ status: "unavailable", reason: "disabled" })
    expect(net).not.toHaveBeenCalled()
  })
})

describe("the bootstrap contract maps every outcome to the five errors", () => {
  it("maps HTTP statuses without reading any body", () => {
    expect(mapBootstrapStatus(200)).toEqual({ ok: true, refreshRequired: true })
    expect(mapBootstrapStatus(401)).toEqual({ ok: false, error: "invalid-token" })
    expect(mapBootstrapStatus(403)).toEqual({ ok: false, error: "unauthorized" })
    expect(mapBootstrapStatus(429)).toEqual({ ok: false, error: "rate-limited" })
    for (const s of [404, 408, 502, 503, 504]) expect(mapBootstrapStatus(s)).toEqual({ ok: false, error: "unavailable" })
    for (const s of [400, 500, 501, 418]) expect(mapBootstrapStatus(s)).toEqual({ ok: false, error: "server-error" })
  })
  it("a thrown transport (offline, CORS) is unavailable; an empty token is invalid and never sent", async () => {
    expect(await bootstrapFirebaseIdentity("t", async () => Promise.reject(new TypeError("Failed to fetch")))).toEqual({ ok: false, error: "unavailable" })
    const send = vi.fn(ok)
    expect(await bootstrapFirebaseIdentity("", send)).toEqual({ ok: false, error: "invalid-token" })
    expect(send).not.toHaveBeenCalled()
  })
  it("the fetch transport sends only the Firebase token and the publishable key, no body, and returns only the status", async () => {
    const fetchFn = vi.fn(async () => new Response('{"secret":"server internals"}', { status: 500 }))
    const res = await createFetchBootstrapTransport({ url: "https://p.example/", publishableKey: "pk" }, fetchFn as unknown as typeof fetch)("tok")
    expect(res).toEqual({ status: 500 })
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe("https://p.example/functions/v1/auth-role-bootstrap")
    expect(init.method).toBe("POST")
    expect(init.body).toBeUndefined()
    expect(init.headers).toEqual({ authorization: "Bearer tok", apikey: "pk" })
  })
})

describe("the bridge: bootstrap, force refresh, states", () => {
  it("bootstraps with the initial token, then force-refreshes, and only then is authenticated", async () => {
    const f = fakeUser("uid-A")
    const { identity } = fakeIdentity(f.user)
    const sent: string[] = []
    const states: string[] = []
    const tokens: (string | null)[] = []
    const bridge = createAuthBridge({ enabled: () => true, identity, bootstrap: async (t) => (sent.push(t), { status: 200 }) })
    bridge.subscribe((s) => states.push(s.status))
    bridge.onToken((t) => tokens.push(t))
    expect(bridge.state()).toEqual({ status: "idle" })
    expect(await bridge.ensureAuthenticated()).toEqual({ status: "authenticated" })
    expect(sent).toEqual(["token-uid-A-initial"]) // the bootstrap sees only the Firebase token
    expect(f.calls).toEqual([undefined, true]) // normal token, then forced refresh
    expect(states).toEqual(["bootstrapping", "authenticated"])
    expect(tokens).toEqual(["token-uid-A-refreshed-1"])
  })
  it("an already authenticated user is not bootstrapped again, and concurrent calls share one attempt", async () => {
    const f = fakeUser("uid-A")
    const send = vi.fn(ok)
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(f.user).identity, bootstrap: send })
    await Promise.all([bridge.ensureAuthenticated(), bridge.ensureAuthenticated(), bridge.ensureAuthenticated()])
    await bridge.ensureAuthenticated()
    expect(send).toHaveBeenCalledTimes(1)
  })
  it("each bootstrap error becomes the right state and reason, and no token is exposed", async () => {
    const table: [number, string, string][] = [
      [503, "unavailable", "unavailable"],
      [401, "unauthorized", "invalid-token"],
      [403, "unauthorized", "unauthorized"],
      [429, "error", "rate-limited"],
      [500, "error", "server-error"],
    ]
    for (const [status, st, reason] of table) {
      const f = fakeUser("u")
      const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(f.user).identity, bootstrap: async () => ({ status }) })
      expect(await bridge.ensureAuthenticated(), String(status)).toEqual({ status: st, reason })
      expect(await bridge.getToken()).toBeNull()
      expect(f.calls).toEqual([undefined]) // no forced refresh after a failed bootstrap
    }
  })
  it("no Firebase user means unauthorized, and nothing is sent", async () => {
    const send = vi.fn(ok)
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(null).identity, bootstrap: send })
    expect(await bridge.ensureAuthenticated()).toEqual({ status: "unauthorized", reason: "no-firebase-user" })
    expect(send).not.toHaveBeenCalled()
  })
  it("a Firebase token that cannot be obtained is unavailable", async () => {
    const user: FirebaseUserLike = { uid: "u", getIdToken: async () => Promise.reject(new Error("auth/network-request-failed")) }
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(user).identity, bootstrap: ok })
    expect(await bridge.ensureAuthenticated()).toEqual({ status: "unavailable", reason: "unavailable" })
  })
  it("an account switch drops the bridge, and an attempt that finishes after a switch is discarded", async () => {
    const a = fakeUser("uid-A")
    const b = fakeUser("uid-B")
    const f = fakeIdentity(a.user)
    const tokens: (string | null)[] = []
    const bridge = createAuthBridge({ enabled: () => true, identity: f.identity, bootstrap: ok })
    bridge.onToken((t) => tokens.push(t))
    await bridge.ensureAuthenticated()
    f.switchTo(b.user)
    expect(bridge.state()).toEqual({ status: "idle" })
    expect(await bridge.getToken()).toBeNull()
    expect(tokens.at(-1)).toBeNull()
    expect(await bridge.ensureAuthenticated()).toEqual({ status: "authenticated" })
    expect(b.calls).toEqual([undefined, true]) // B was bootstrapped on its own, not on A's say-so

    // a switch in the middle of an attempt
    const c = fakeUser("uid-C")
    const d = fakeUser("uid-D")
    const g = fakeIdentity(c.user)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = createAuthBridge({ enabled: () => true, identity: g.identity, bootstrap: async () => (await gate, { status: 200 }) })
    const attempt = slow.ensureAuthenticated()
    g.switchTo(d.user)
    release()
    expect((await attempt).status).toBe("idle")
    expect(await slow.getToken()).toBeNull()
  })
  it("passes a changed Firebase token on (the Realtime seam), and stops when the user goes away", async () => {
    const a = fakeUser("uid-A")
    const f = fakeIdentity(a.user)
    const tokens: (string | null)[] = []
    const bridge = createAuthBridge({ enabled: () => true, identity: f.identity, bootstrap: ok })
    bridge.onToken((t) => tokens.push(t))
    await bridge.ensureAuthenticated()
    f.fire() // Firebase refreshed the token on its own
    await new Promise((r) => setTimeout(r, 0))
    expect(tokens).toEqual(["token-uid-A-refreshed-1", "token-uid-A-initial"])
    f.switchTo(null) // signed out
    expect(tokens.at(-1)).toBeNull()
    expect(bridge.state()).toEqual({ status: "idle" })
  })
})

describe("nobody can supply a uid, a role or a claim", () => {
  it("the public surface takes no identity: every method has no parameters that could carry one", () => {
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(null).identity, bootstrap: ok })
    expect(bridge.ensureAuthenticated.length).toBe(0)
    expect(bridge.getToken.length).toBe(0)
    expect(bridge.reset.length).toBe(0)
  })
  it("extra arguments are ignored: a forged uid, role or claim changes nothing and is never sent", async () => {
    const f = fakeUser("uid-REAL")
    const sent: string[] = []
    const bridge = createAuthBridge({ enabled: () => true, identity: fakeIdentity(f.user).identity, bootstrap: async (t) => (sent.push(t), { status: 200 }) })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (bridge.ensureAuthenticated as any)("uid-FORGED", { role: "service_role", claims: { admin: true } })
    expect(sent).toEqual(["token-uid-REAL-initial"])
    expect(sent.join()).not.toMatch(/FORGED|service_role|admin/)
  })
  it("the module cannot decode, build or sign tokens, or reach the Admin SDK", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib/backend/supabase-auth.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(src).not.toMatch(/atob|btoa|JSON\.parse|split\(["']\.["']\)|jsonwebtoken|\bjose\b|firebase-admin|service[_-]?account|private_key|customClaims|setCustomUserClaims/i)
    expect(src).not.toMatch(/from\s+["']firebase/) // it never imports Firebase at all: the identity is injected
  })
})

describe("the Supabase adapter refuses to operate unless flag, configuration and bridge token all exist", () => {
  const cfg = { url: "https://p.example", publishableKey: "pk" }
  const spyTransport = () => {
    const t = { rpc: vi.fn(async () => ({ data: "ok", error: null })), select: vi.fn(async () => ({ data: [], error: null })), setAccessToken: vi.fn(), setRealtimeAuth: vi.fn() }
    return t as typeof t & SupabaseTransport
  }
  const bridgeWith = (status: string, token: string | null = "tok") => ({ ensureAuthenticated: async () => ({ status }) as never, getToken: async () => token })

  it("flag off: refused as not-configured, the transport is never touched", async () => {
    const t = spyTransport()
    const be = createSupabaseBackend({ transport: t, guard: createSupabaseGuard({ flagEnabled: () => false, config: () => cfg, bridge: bridgeWith("authenticated") }) })
    await expect(be.profiles.save("u", "n")).rejects.toMatchObject({ code: "supabase-not-configured", kind: "unauthorized" })
    expect(t.rpc).not.toHaveBeenCalled()
    expect(t.select).not.toHaveBeenCalled()
  })
  it("flag on but configuration missing: refused", async () => {
    const t = spyTransport()
    const be = createSupabaseBackend({ transport: t, guard: createSupabaseGuard({ flagEnabled: () => true, config: () => null, bridge: bridgeWith("authenticated") }) })
    await expect(be.sync.get("o")).rejects.toMatchObject({ code: "supabase-not-configured" })
    expect(t.select).not.toHaveBeenCalled()
  })
  it("flag and configuration present but the bridge is not authenticated: refused (fail closed), never anonymous access", async () => {
    for (const status of ["idle", "bootstrapping", "unauthorized", "error", "unavailable"]) {
      const t = spyTransport()
      const be = createSupabaseBackend({ transport: t, guard: createSupabaseGuard({ flagEnabled: () => true, config: () => cfg, bridge: bridgeWith(status) }) })
      const err = await be.pings.finalize("p").catch((e) => e)
      expect(err, status).toBeInstanceOf(BackendError)
      expect(err.code).toBe("supabase-unauthenticated")
      expect(err.kind).toBe(status === "unavailable" ? "unavailable" : "unauthorized")
      expect(t.rpc).not.toHaveBeenCalled()
    }
  })
  it("authenticated but no token for the current user: refused", async () => {
    const t = spyTransport()
    const be = createSupabaseBackend({ transport: t, guard: createSupabaseGuard({ flagEnabled: () => true, config: () => cfg, bridge: bridgeWith("authenticated", null) }) })
    await expect(be.profiles.getName("u")).rejects.toMatchObject({ code: "supabase-unauthenticated" })
    expect(t.rpc).not.toHaveBeenCalled()
  })
  it("with flag, configuration and a bridge token, the call goes through and the token is handed to the transport", async () => {
    const t = spyTransport()
    const be = createSupabaseBackend({ transport: t, guard: createSupabaseGuard({ flagEnabled: () => true, config: () => cfg, bridge: bridgeWith("authenticated", "firebase-token") }) })
    await be.profiles.save("ignored-uid", "Alice")
    expect(t.setAccessToken).toHaveBeenCalledWith("firebase-token")
    expect(t.rpc).toHaveBeenCalledWith("upsert_profile", { p_name: "Alice" }) // the uid is still never sent
  })
  it("the app's own selection (NEXT_PUBLIC_BACKEND=supabase) is refused while the flag is off, and nothing reaches the network", async () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://p.example")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk")
    const be = getBackend()
    expect(be.kind).toBe("supabase")
    await expect(be.sync.get("o")).rejects.toMatchObject({ code: "supabase-not-configured" })
    expect(net).not.toHaveBeenCalled()
  })
  it("with the flag on and the configuration present but no Firebase user, the selected backend still refuses", async () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE", "true")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://p.example")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk")
    await expect(getBackend().sync.get("o")).rejects.toMatchObject({ kind: "unauthorized" })
    expect(net).not.toHaveBeenCalled()
  })
})

describe("the Realtime token seam", () => {
  it("the Supabase adapter hands a token (and null on sign-out) to realtime.setAuth, nothing else", () => {
    const setRealtimeAuth = vi.fn()
    const be = createSupabaseBackend({ transport: { rpc: vi.fn(), select: vi.fn(), setRealtimeAuth } as unknown as SupabaseTransport })
    be.realtimeAuth!.setToken("t1")
    be.realtimeAuth!.setToken("t2") // again whenever the token changes
    be.realtimeAuth!.setToken(null)
    expect(setRealtimeAuth.mock.calls).toEqual([["t1"], ["t2"], [null]])
  })
  it("without a transport the seam is inert, and a bridge token change can be bound to it", async () => {
    expect(() => createSupabaseBackend().realtimeAuth!.setToken("t")).not.toThrow()
    const setRealtimeAuth = vi.fn()
    const be = createSupabaseBackend({ transport: { rpc: vi.fn(), select: vi.fn(), setRealtimeAuth } as unknown as SupabaseTransport })
    const f = fakeUser("uid-A")
    const fi = fakeIdentity(f.user)
    const bridge = createAuthBridge({ enabled: () => true, identity: fi.identity, bootstrap: ok })
    bridge.onToken((t) => be.realtimeAuth!.setToken(t))
    await bridge.ensureAuthenticated()
    fi.switchTo(null)
    expect(setRealtimeAuth.mock.calls).toEqual([["token-uid-A-refreshed-1"], [null]])
  })
  it("the Supabase subscription is still not implemented: it reports not live and never subscribes", () => {
    const onState = vi.fn()
    const unsub = createSupabaseBackend().pings.watch("u", { onData: vi.fn(), onState })
    expect(onState).toHaveBeenCalledWith(false, expect.anything())
    expect(() => unsub()).not.toThrow()
  })
})

describe("backend selection stays safe (task 12)", () => {
  it("missing -> firebase, firebase -> firebase, supabase -> supabase adapter, anything else fails closed", () => {
    expect(resolveBackendKind(undefined)).toBe("firebase")
    expect(resolveBackendKind("firebase")).toBe("firebase")
    expect(resolveBackendKind("supabase")).toBe("supabase")
    for (const bad of ["firestore", "postgres", "sb", "false", "0"]) expect(() => resolveBackendKind(bad)).toThrow(/Unknown backend/)
  })
})
