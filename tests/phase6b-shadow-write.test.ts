/**
 * Phase 6B: shadow dual-write. Firebase is the only authority; Supabase receives a best-effort mirror that can never
 * affect the Firebase result. Everything here uses fakes (an in-memory Firestore and a fake fetch): no network, no real
 * Supabase, no credentials. Every flag is OFF unless a test turns it on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import * as fake from "./helpers/fake-firestore"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)
vi.mock("@/lib/social", async (orig) => ({ ...(await orig<typeof import("@/lib/social")>()), ensureSignedIn: async () => ({}) as never }))

import { anyShadowFlag, parseShadowFlags, shadowFlags, type ShadowFlags } from "@/lib/backend/flags"
import { createFirebaseBackend } from "@/lib/backend/firebase"
import { getBackend, setBackendForTests } from "@/lib/backend"
import { withShadow } from "@/lib/backend/shadow-backend"
import { createSupabaseShadowWriter } from "@/lib/backend/shadow-supabase"
import { createShadowDiagnostics, shadowDiagnostics } from "@/lib/backend/shadow-diagnostics"
import { BackendError } from "@/lib/backend/errors"
import type { Backend } from "@/lib/backend/contracts"

const ROOT = path.resolve(import.meta.dirname, "..")
const A = "uidAlice00000000000000000001"
const B = "uidBob0000000000000000000002"
const ALL: ShadowFlags = { sync: true, social: true, push: true }
const db = {} as never

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  setBackendForTests(null)
  shadowDiagnostics.clear()
})
beforeEach(() => fake.reset())

const tick = () => new Promise((r) => setTimeout(r, 0))
async function waitFor(cond: () => boolean, ms = 1500) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out waiting for the shadow")
    await tick()
  }
}

interface Req {
  url: string
  method: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

/** A fake Supabase: records requests and answers with whatever `reply` says */
function fakeSupabase(reply: (req: Req, n: number) => Response | Promise<Response> = (req) => new Response(String(typeof req.body.p_expected_rev === "number" ? req.body.p_expected_rev + 1 : 1), { status: 200 })) {
  const requests: Req[] = []
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    const req: Req = { url, method: init.method ?? "GET", headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body ?? "null")) }
    requests.push(req)
    return reply(req, requests.length)
  })
  return { requests, fetchFn: fetchFn as unknown as typeof fetch }
}

function setup(opts: { reply?: Parameters<typeof fakeSupabase>[0]; uid?: string | null; timeoutMs?: number; cooldownMs?: number; maxQueue?: number; guard?: () => Promise<string>; now?: () => number; flags?: ShadowFlags } = {}) {
  const sb = fakeSupabase(opts.reply)
  const diagnostics = createShadowDiagnostics()
  const writer = createSupabaseShadowWriter({
    guard: opts.guard ?? (async () => "firebase-token-SECRET"),
    config: () => ({ url: "https://p.example", publishableKey: "pk-SECRET" }),
    currentUid: () => (opts.uid === undefined ? A : opts.uid),
    fetchFn: sb.fetchFn,
    timeoutMs: opts.timeoutMs,
    cooldownMs: opts.cooldownMs,
    maxQueue: opts.maxQueue,
    now: opts.now,
    diagnostics,
  })
  const base = createFirebaseBackend({ db, ensureSignedIn: async () => {} })
  const be = withShadow(base, writer, opts.flags ?? ALL)
  return { ...sb, diagnostics, writer, base, be, events: () => diagnostics.snapshot().events }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

describe("flags: every shadow flag is OFF by default", () => {
  it("nothing is on unless the build says exactly true", () => {
    expect(shadowFlags()).toEqual({ sync: false, social: false, push: false })
    expect(anyShadowFlag(shadowFlags())).toBe(false)
    for (const v of [undefined, "", "false", "1", "yes", "tru", "TRUE-ish"]) expect(parseShadowFlags({ sync: v, social: v, push: v })).toEqual({ sync: false, social: false, push: false })
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_SYNC", "true")
    expect(shadowFlags()).toEqual({ sync: true, social: false, push: false })
  })
  it("the production env and the example env set none of them", () => {
    for (const f of [".env.local", ".env.local.example"]) {
      const p = path.join(ROOT, f)
      if (fs.existsSync(p)) expect(fs.readFileSync(p, "utf8"), f).not.toMatch(/SUPABASE|NEXT_PUBLIC_BACKEND/)
    }
  })
  it("with no flag on, withShadow returns the very same Firebase backend object", () => {
    const base = createFirebaseBackend({ db, ensureSignedIn: async () => {} })
    const w = createSupabaseShadowWriter({ guard: async () => "t", config: () => null, currentUid: () => A })
    expect(withShadow(base, w, { sync: false, social: false, push: false })).toBe(base)
  })
  it("the default getBackend() is Firebase, unwrapped, and sends nothing anywhere even with a flag but no bridge", async () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_SYNC", "true") // bridge flag still off
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://p.example")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk")
    const be = getBackend()
    expect(be.kind).toBe("firebase")
    expect(await be.sync.put(A, "gz1:abc", null)).toEqual({ ok: true, rev: 1 })
    await tick()
    expect(net).not.toHaveBeenCalled()
    expect(shadowDiagnostics.snapshot().events).toEqual([])
  })
  it("with flags and bridge on but no signed-in Firebase user, the shadow skips and Firebase is unaffected", async () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE", "true")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_SYNC", "true")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://p.example")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "pk")
    const be = getBackend()
    expect(await be.sync.put(A, "gz1:abc", null)).toEqual({ ok: true, rev: 1 })
    await waitFor(() => shadowDiagnostics.snapshot().events.length === 1)
    expect(shadowDiagnostics.snapshot().events[0]).toMatchObject({ domain: "sync", outcome: "skipped", reason: "identity-mismatch" })
    expect(net).not.toHaveBeenCalled()
  })
})

describe("a successful shadow write", () => {
  it("sends the confirmed (data, rev) to sync_put: expected = rev - 1, no owner, the JWT as the only identity", async () => {
    const t = setup()
    expect(await t.be.sync.put(A, "gz1:abc", null)).toEqual({ ok: true, rev: 1 })
    expect(await t.be.sync.put(A, "gz1:def", 1)).toEqual({ ok: true, rev: 2 })
    await waitFor(() => t.events().length === 2)
    expect(t.requests.map((r) => [r.url, r.body.p_expected_rev, r.body.p_data])).toEqual([
      ["https://p.example/rest/v1/rpc/sync_put", 0, "gz1:abc"],
      ["https://p.example/rest/v1/rpc/sync_put", 1, "gz1:def"],
    ])
    for (const r of t.requests) {
      expect(Object.keys(r.body).sort()).toEqual(["p_data", "p_expected_rev", "p_updated_at"]) // no owner, no uid
      expect(r.method).toBe("POST") // only writes; nothing is ever read from Supabase
      expect(r.headers.authorization).toBe("Bearer firebase-token-SECRET")
    }
    expect(t.events().map((e) => e.outcome)).toEqual(["ok", "ok"])
  })
  it("mirrors profile, invite (same token) and push token", async () => {
    const t = setup()
    await t.be.profiles.save(A, "Alice")
    const { token } = await t.be.invites.create(A, "Alice", 15)
    await t.be.invites.remove(token)
    await t.be.pushTokens.save(A, "fcm-token-123")
    await t.be.pushTokens.remove(A)
    await waitFor(() => t.events().length === 5)
    const by = Object.fromEntries(t.requests.map((r) => [r.url.split("/rpc/")[1], r.body])) // different domains run side by side
    expect(Object.keys(by).sort()).toEqual(["create_invite", "delete_invite", "delete_push_token", "save_push_token", "upsert_profile"])
    expect(by.upsert_profile).toEqual({ p_name: "Alice" })
    expect(by.create_invite).toEqual({ p_token: token, p_owner_name: "Alice", p_minutes: 15 }) // the id Firebase issued, never regenerated
    expect(by.delete_invite).toEqual({ p_token: token })
    expect(by.save_push_token).toEqual({ p_token: "fcm-token-123", p_device_id: "legacy" })
    expect(t.events().every((e) => e.outcome === "ok")).toBe(true)
  })
  it("a returned revision different from Firebase's is recorded as drift, still never reaching the app", async () => {
    const t = setup({ reply: () => new Response("7", { status: 200 }) })
    expect(await t.be.sync.put(A, "gz1:abc", null)).toEqual({ ok: true, rev: 1 })
    await waitFor(() => t.events().length === 1)
    expect(t.events()[0]).toMatchObject({ outcome: "conflict", reason: "rev-drift" })
  })
})

describe("the sync blob is byte-preserved", () => {
  it("the text Firebase stored is the text Supabase is sent, character for character", async () => {
    const t = setup()
    const blob = 'gz1:H4sIAAAAAAAA/+3 +/= é中 "q" \\ \n\t {not json}'
    await t.be.sync.put(A, blob, null)
    await waitFor(() => t.requests.length === 1)
    const sent = t.requests[0].body.p_data as string
    expect(sent).toBe(blob)
    expect(crypto.createHash("sha256").update(sent, "utf8").digest("hex")).toBe(crypto.createHash("sha256").update(blob, "utf8").digest("hex"))
    expect(fake.state.writes.find((w) => w.op === "tx.set")!.data).toMatchObject({ data: blob, rev: 1 })
  })
  it("the rev sent is Firebase's rev - 1 for every write of a longer history", async () => {
    const t = setup()
    let rev: number | null = null
    for (let i = 0; i < 5; i++) {
      const r = await t.be.sync.put(A, `gz1:v${i}`, rev)
      if (!r.ok) throw new Error("unexpected")
      rev = r.rev
    }
    await waitFor(() => t.events().length === 5)
    expect(t.requests.map((r) => r.body.p_expected_rev)).toEqual([0, 1, 2, 3, 4])
  })
})

describe("fault tolerance: Firebase's answer is never affected", () => {
  const cases: [string, Parameters<typeof setup>[0], { outcome: string; reason: string; status?: number }][] = [
    ["Supabase unreachable", { reply: () => Promise.reject(new TypeError("Failed to fetch")) }, { outcome: "failed", reason: "unavailable" }],
    ["Supabase times out", { timeoutMs: 25, reply: () => new Promise<Response>(() => {}) }, { outcome: "failed", reason: "timeout" }],
    ["Supabase answers 400", { reply: () => json(400, { code: "22023", message: "invalid data" }) }, { outcome: "failed", reason: "http-4xx", status: 400 }],
    ["Supabase answers 401", { reply: () => json(401, { code: "PGRST301", message: "JWT" }) }, { outcome: "failed", reason: "unauthorized", status: 401 }],
    ["Supabase answers 429", { reply: () => json(429, { message: "slow down" }) }, { outcome: "failed", reason: "rate-limited", status: 429 }],
    ["Supabase answers 500", { reply: () => json(500, { message: "boom" }) }, { outcome: "failed", reason: "http-5xx", status: 500 }],
    ["Supabase answers 503 with a non-JSON body", { reply: () => new Response("<html>bad gateway</html>", { status: 503 }) }, { outcome: "failed", reason: "http-5xx", status: 503 }],
    ["Supabase reports a stale revision (40001)", { reply: () => json(409, { code: "40001", message: "revision conflict" }) }, { outcome: "conflict", reason: "conflict", status: 409 }],
  ]
  for (const [name, opts, want] of cases) {
    it(`${name}: the Firebase result is returned, and the failure is only recorded`, async () => {
      const t = setup(opts)
      const result = await t.be.sync.put(A, "gz1:abc", null)
      expect(result).toEqual({ ok: true, rev: 1 }) // exactly what Firebase said
      await waitFor(() => t.events().length === 1)
      expect(t.events()[0]).toMatchObject({ domain: "sync", op: "put", ...want })
    })
  }

  it("the application never waits for Supabase: the put resolves while the shadow request is still pending", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const t = setup({ reply: async () => (await gate, new Response("1", { status: 200 })) })
    expect(await t.be.sync.put(A, "gz1:abc", null)).toEqual({ ok: true, rev: 1 })
    await waitFor(() => t.requests.length === 1)
    expect(t.events()).toEqual([]) // still waiting
    release()
    await waitFor(() => t.events().length === 1)
  })

  it("a guard (authorization) that throws or never answers cannot affect Firebase", async () => {
    const throwing = setup({ guard: async () => Promise.reject(new BackendError("unauthorized", "no", { code: "supabase-unauthenticated" })) })
    expect(await throwing.be.profiles.save(A, "Alice")).toBeUndefined()
    await waitFor(() => throwing.events().length === 1)
    expect(throwing.events()[0]).toMatchObject({ outcome: "failed", reason: "unauthorized" })
    expect(throwing.requests).toEqual([])
    const hanging = setup({ timeoutMs: 25, guard: () => new Promise<string>(() => {}) })
    expect(await hanging.be.sync.put(A, "gz1:x", null)).toEqual({ ok: true, rev: 1 })
    await waitFor(() => hanging.events().length === 1)
    expect(hanging.events()[0]).toMatchObject({ outcome: "failed", reason: "timeout" })
  })

  it("a writer that throws synchronously or rejects cannot affect Firebase either", async () => {
    const base = createFirebaseBackend({ db, ensureSignedIn: async () => {} })
    const evil = {
      active: true,
      syncBlob: () => {
        throw new Error("sync boom")
      },
      profile: async () => Promise.reject(new Error("async boom")),
      connection: async () => {},
      ping: async () => {},
      pushToken: () => {
        throw new Error("boom")
      },
      invite: async () => Promise.reject(new Error("boom")),
    }
    const be = withShadow(base, evil, ALL)
    const unhandled = vi.fn()
    process.on("unhandledRejection", unhandled)
    expect(await be.sync.put(A, "gz1:abc", null)).toEqual({ ok: true, rev: 1 })
    await be.profiles.save(A, "Alice")
    await be.pushTokens.save(A, "tok")
    await be.invites.create(A, "Alice", 15)
    await tick()
    await tick()
    process.off("unhandledRejection", unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})

describe("the shadow cannot change the authoritative Firebase result", () => {
  /** Runs the same scenario with and without the shadow and returns what Firebase saw and answered */
  async function scenario(withShadowOn: boolean, reply?: Parameters<typeof fakeSupabase>[0]) {
    fake.reset()
    const t = setup({ reply, flags: withShadowOn ? ALL : { sync: false, social: false, push: false } })
    const be = t.be
    const out: unknown[] = []
    out.push(await be.sync.put(A, "gz1:one", null))
    out.push(await be.sync.put(A, "gz1:two", 1))
    out.push(await be.sync.put(A, "gz1:stale", 1)) // a real Firebase conflict
    out.push(await be.sync.get(A))
    await be.profiles.save(A, "Alice")
    out.push(await be.profiles.getName(A))
    const inv = await be.invites.create(A, "Alice", 15)
    out.push(inv.expiresAt > 0, (await be.invites.read(inv.token))?.ownerName)
    await be.invites.remove(inv.token)
    out.push(await be.invites.read(inv.token))
    await be.pushTokens.save(A, "tok")
    await be.pushTokens.remove(A)
    await tick()
    return { out: JSON.parse(JSON.stringify(out, (k, v) => (k === "updatedAt" ? "*" : v))), writes: fake.state.writes.map((w) => JSON.stringify(w, (k, v) => (k === "updatedAt" || k === "expiresAt" || k === "token" || k === "id" || k === "path" && typeof v === "string" && v.startsWith("invites/") ? "*" : v))), t }
  }

  it("Firebase writes and return values are identical with the shadow off, working, failing and timing out", async () => {
    const off = await scenario(false)
    for (const reply of [undefined, () => json(500, { message: "x" }), () => Promise.reject(new TypeError("down")), () => new Promise<Response>(() => {})]) {
      const on = await scenario(true, reply)
      expect(on.out).toEqual(off.out)
      expect(on.writes).toEqual(off.writes)
    }
  })
  it("a Firebase conflict is not mirrored, and a Firebase error passes through unchanged with no shadow call", async () => {
    const t = setup()
    await t.be.sync.put(A, "gz1:one", null)
    await waitFor(() => t.requests.length === 1)
    expect(await t.be.sync.put(A, "gz1:stale", null)).toEqual({ ok: false, reason: "conflict" })
    await tick()
    expect(t.requests).toHaveLength(1)
    // offline: the Firebase call rejects; the same error reaches the caller, and nothing is shadowed
    const failing: Backend = createFirebaseBackend({ db, ensureSignedIn: async () => Promise.reject(Object.assign(new Error("offline"), { code: "unavailable" })) })
    const sb = fakeSupabase()
    const w = createSupabaseShadowWriter({ guard: async () => "t", config: () => ({ url: "https://p.example", publishableKey: "k" }), currentUid: () => A, fetchFn: sb.fetchFn })
    const be = withShadow(failing, w, ALL)
    await expect(be.sync.put(A, "gz1:x", null)).rejects.toMatchObject({ kind: "unavailable", code: "unavailable" })
    await tick()
    expect(sb.requests).toEqual([])
  })
  it("reads and subscriptions are passed straight through and never touch Supabase", async () => {
    const t = setup()
    await t.base.sync.put(A, "gz1:abc", null)
    expect(await t.be.sync.get(A)).toEqual(await t.base.sync.get(A))
    expect(t.be.sync.watch).toBe(t.base.sync.watch)
    expect(t.be.connections).toBe(t.base.connections) // connections and Pings are not wrapped
    expect(t.be.pings).toBe(t.base.pings)
    expect(t.be.kind).toBe("firebase")
    expect(t.requests).toEqual([])
  })
  it("only the domains whose flag is on are wrapped", () => {
    const t = setup({ flags: { sync: true, social: false, push: false } })
    expect(t.be.sync.put).not.toBe(t.base.sync.put)
    expect(t.be.profiles).toBe(t.base.profiles)
    expect(t.be.invites).toBe(t.base.invites)
    expect(t.be.pushTokens).toBe(t.base.pushTokens)
  })
})

describe("duplicates, retries, ordering and back-pressure", () => {
  it("a repeated write (an app retry) is answered with a conflict by Supabase and recorded, with no duplicate effect", async () => {
    let calls = 0
    const t = setup({ reply: () => (++calls === 1 ? new Response("1", { status: 200 }) : json(409, { code: "40001", message: "revision conflict" })) })
    await t.be.sync.put(A, "gz1:abc", null)
    await waitFor(() => t.events().length === 1)
    t.writer.syncBlob({ owner: A, data: "gz1:abc", rev: 1, updatedAt: 1 }) // the same confirmed write offered again
    await waitFor(() => t.events().length === 2)
    expect(t.events().map((e) => e.outcome)).toEqual(["ok", "conflict"])
  })
  it("writes for one account go out one at a time, in order, even when the first is slow", async () => {
    const order: number[] = []
    const t = setup({
      reply: async (req) => {
        order.push(req.body.p_expected_rev as number)
        if (req.body.p_expected_rev === 0) await new Promise((r) => setTimeout(r, 40))
        return new Response("1", { status: 200 })
      },
    })
    await t.be.sync.put(A, "gz1:a", null)
    await t.be.sync.put(A, "gz1:b", 1)
    await t.be.sync.put(A, "gz1:c", 2)
    await waitFor(() => t.events().length === 3)
    expect(order).toEqual([0, 1, 2])
  })
  it("at most maxQueue writes wait per account; the rest are dropped and recorded, never an error", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const t = setup({ maxQueue: 2, reply: async () => (await gate, new Response("1", { status: 200 })) })
    for (let i = 0; i < 5; i++) t.writer.syncBlob({ owner: A, data: `gz1:${i}`, rev: i + 1, updatedAt: 1 })
    await waitFor(() => t.events().some((e) => e.outcome === "dropped"))
    release()
    await waitFor(() => t.events().length === 5)
    expect(t.events().filter((e) => e.outcome === "dropped")).toHaveLength(3)
    expect(t.events().filter((e) => e.outcome === "dropped").every((e) => e.reason === "queue-full")).toBe(true)
  })
  it("after an authorization failure the writer pauses instead of hammering the bootstrap endpoint, then resumes", async () => {
    let clock = 1_000_000
    let guardCalls = 0
    let healthy = false
    const t = setup({
      now: () => clock,
      cooldownMs: 60_000,
      guard: async () => {
        guardCalls++
        if (!healthy) throw new BackendError("unavailable", "bridge down", { code: "supabase-unauthenticated" })
        return "tok"
      },
    })
    for (let i = 0; i < 3; i++) await t.be.profiles.save(A, `n${i}`)
    await waitFor(() => t.events().length === 3)
    expect(guardCalls).toBe(1)
    expect(t.events().map((e) => e.reason)).toEqual(["unavailable", "cooldown", "cooldown"])
    clock += 61_000
    healthy = true
    await t.be.profiles.save(A, "later")
    await waitFor(() => t.events().length === 4)
    expect(t.events()[3].outcome).toBe("ok")
  })
  it("a write is skipped when its account is not the current Firebase user (an account switch in flight)", async () => {
    const t = setup({ uid: B })
    await t.be.sync.put(A, "gz1:abc", null)
    await t.be.profiles.save(A, "Alice")
    await waitFor(() => t.events().length === 2)
    expect(t.events().every((e) => e.outcome === "skipped" && e.reason === "identity-mismatch")).toBe(true)
    expect(t.requests).toEqual([])
    const signedOut = setup({ uid: null })
    await signedOut.be.pushTokens.save(A, "tok")
    await waitFor(() => signedOut.events().length === 1)
    expect(signedOut.requests).toEqual([])
  })
})

describe("connections and Pings are deliberately not mirrored", () => {
  it("the writer records them as skipped and sends nothing", async () => {
    const t = setup()
    await t.writer.connection({ op: "send", id: "r1", from: { uid: A, name: "A" }, to: { uid: B, name: "B" } })
    await t.writer.ping({ op: "finalize", id: "ping-AB-00000001" })
    expect(t.requests).toEqual([])
    expect(t.events().map((e) => [e.domain, e.outcome, e.reason])).toEqual([["connection", "skipped", "unsupported"], ["ping", "skipped", "unsupported"]])
  })
})

describe("diagnostics leak nothing", () => {
  it("events hold no blob, name, token, full uid, header or server message", async () => {
    const t = setup({ reply: () => json(500, { message: "SERVER-INTERNAL-DETAIL", hint: "secret hint" }) })
    await t.be.sync.put(A, "gz1:THE-USER-BACKUP-BLOB", null)
    await t.be.profiles.save(A, "Secret Name")
    await t.be.pushTokens.save(A, "FCM-TOKEN-VALUE")
    await t.be.invites.create(A, "Secret Name", 15)
    await waitFor(() => t.events().length === 4)
    const dump = JSON.stringify(t.diagnostics.snapshot())
    for (const secret of ["THE-USER-BACKUP-BLOB", "Secret Name", "FCM-TOKEN-VALUE", "firebase-token-SECRET", "pk-SECRET", "SERVER-INTERNAL-DETAIL", "secret hint", A, "Bearer"]) expect(dump, secret).not.toContain(secret)
    expect(t.events()[0].who).toBe("uidA***")
  })
  it("the ring is bounded and counts every outcome", () => {
    const d = createShadowDiagnostics(3)
    for (let i = 0; i < 10; i++) d.record({ at: i, domain: "sync", op: "put", who: "x", outcome: i % 2 ? "ok" : "failed", ms: 0 })
    const s = d.snapshot()
    expect(s.events).toHaveLength(3)
    expect(s.counts).toMatchObject({ ok: 5, failed: 5 })
  })
})

describe("architecture: the shadow stays inside lib/backend and cannot read Supabase", () => {
  const walk = (d: string): string[] =>
    fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
  const text = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8")
  it("no file outside lib/backend refers to the shadow modules", () => {
    const hits = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => !f.startsWith("lib/backend/")).filter((f) => /shadow-(backend|supabase|diagnostics)|backend\/shadow/.test(text(f)))
    expect(hits).toEqual([])
  })
  it("the writer only ever calls write RPCs: there is no select, no GET and no read of a table", () => {
    const src = text("lib/backend/shadow-supabase.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(src).not.toMatch(/method:\s*["']GET["']|\/rest\/v1\/(?!rpc\/)|\.select\(|from\s+["']@supabase/)
    expect([...src.matchAll(/rpc\("([a-z_]+)"/g)].map((m) => m[1]).sort()).toEqual(["create_invite", "delete_invite", "delete_push_token", "save_push_token", "sync_put", "upsert_profile"])
  })
  it("the wrapper awaits nothing from the shadow", () => {
    const src = text("lib/backend/shadow-backend.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(src).not.toMatch(/await\s+writer|return\s+writer|await\s+fire/)
  })
  it("the pinned application files are untouched by Phase 6B", () => {
    const protectedFiles = JSON.parse(text("tests/migration-protected.json")) as Record<string, string>
    for (const [f, h] of Object.entries(protectedFiles)) {
      expect(crypto.createHash("sha256").update(text(f).replace(/\r\n/g, "\n")).digest("hex"), f).toBe(h)
    }
  })
})
