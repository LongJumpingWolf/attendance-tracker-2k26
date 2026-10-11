/**
 * Phase 7 preparation: the REAL fetch transport and the Supabase adapter against the REAL local Supabase stack
 * (PostgREST, Kong and the local database started by `npx supabase start`). LOCAL ONLY: it refuses any URL that is not loopback.
 * Run with: npm run test:local-supabase    (excluded from `npm test` because it needs the local stack)
 *
 * Tokens are HS256 JWTs signed with the LOCAL stack's own development secret, shaped like a bridged Firebase token
 * (sub = a Firebase-style uid, role = authenticated, iss/aud = the production Firebase project). No production credential is used.
 * Nothing here can reach production: the base URL is checked to be loopback before any request.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

import { createFetchTransport } from "@/lib/backend/supabase/transport"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import type { Backend } from "@/lib/backend/contracts"

const PROJECT = "attendance-tracker-2k26"
const run = Date.now().toString(36)
const pad = (s: string) => (s + "0".repeat(28)).slice(0, 28)
const A = pad(`E2eAlice${run}`)
const B = pad(`E2eBobby${run}`)
const C = pad(`E2eCarol${run}`)

let apiUrl = ""
let publishableKey = ""
let jwtSecret = ""

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url")
function sign(claims: Record<string, unknown>, secret = jwtSecret): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64u(JSON.stringify(claims))
  return `${head}.${body}.${crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`
}
const claims = (sub: string, over: Record<string, unknown> = {}) => ({
  sub,
  role: "authenticated",
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
})
const today = () => new Date().toISOString().slice(0, 10)

function backendFor(token: string | (() => string), url = apiUrl): Backend {
  const transport = createFetchTransport({ config: { url, publishableKey }, timeoutMs: 8000 })
  return createSupabaseBackend({ transport, guard: async () => (typeof token === "function" ? token() : token) })
}

beforeAll(() => {
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const s = JSON.parse(out.slice(out.indexOf("{")))
  apiUrl = s.API_URL
  publishableKey = s.PUBLISHABLE_KEY
  jwtSecret = s.JWT_SECRET
  const host = new URL(apiUrl).hostname
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("refusing to run: the API URL is not loopback")
  if (!publishableKey || !jwtSecret) throw new Error("the local Supabase stack is not running (npx supabase start)")
})

afterAll(() => {
  // local database only: remove the rows these users created
  const name = "supabase_db_Attendance_tracker"
  const uids = [A, B, C].map((u) => `'${u}'`).join(",")
  const sql = `delete from public.pings where from_uid in (${uids}) or to_uid in (${uids}); delete from public.connections where from_uid in (${uids}) or to_uid in (${uids}); delete from public.invites where owner in (${uids}); delete from public.push_tokens where uid in (${uids}); delete from public.syncs where uid in (${uids}); delete from public.profiles where uid in (${uids});`
  try {
    execFileSync("docker", ["exec", "-i", name, "psql", "-U", "postgres", "-X", "-q", "-c", sql], { stdio: "ignore" })
  } catch {
    /* best effort; the rows are tagged with this run's uids */
  }
})

describe("real PostgREST through the real transport (local stack)", () => {
  it("profiles: a user saves their own name; another signed-in user can look up exactly that uid", async () => {
    const a = backendFor(sign(claims(A)))
    const b = backendFor(sign(claims(B)))
    await a.profiles.save(A, "Alice")
    await b.profiles.save(B, "Bobby")
    expect(await b.profiles.getName(A)).toBe("Alice")
    expect(await b.profiles.getName(pad("NobodyAtAll" + run))).toBeNull()
  })

  it("sync: create, read back byte for byte, compare-and-set, and no cross-user access", async () => {
    const a = backendFor(sign(claims(A)))
    const b = backendFor(sign(claims(B)))
    expect(await a.sync.get(A)).toBeNull()
    const blob = " gz1:H4sI+/== \r\né中😀\t"
    expect(await a.sync.put(A, blob, null)).toEqual({ ok: true, rev: 1 })
    const got = await a.sync.get(A)
    expect(got?.data).toBe(blob)
    expect(got?.rev).toBe(1)
    expect(await a.sync.put(A, "stale", 0)).toEqual({ ok: false, reason: "conflict" })
    expect(await a.sync.put(A, "second", 1)).toEqual({ ok: true, rev: 2 })
    expect(await b.sync.get(A)).toBeNull() // B sees only their own (none)
    expect(await b.sync.put(A, "bob-overwrites-alice", 2)).toEqual({ ok: false, reason: "conflict" })
    expect((await a.sync.get(A))?.data).toBe("second")
  })

  it("invites: create, read, remove", async () => {
    const a = backendFor(sign(claims(A)))
    const b = backendFor(sign(claims(B)))
    const { token, expiresAt } = await a.invites.create(A, "Alice", 15)
    expect(expiresAt).toBeGreaterThan(Date.now())
    const read = await b.invites.read(token)
    expect(read).toMatchObject({ owner: A, ownerName: "Alice", expired: false })
    await a.invites.remove(token)
    expect(await b.invites.read(token)).toBeNull()
  })

  it("connections and pings: request, accept, ping, answer, lease, finalize exactly once, remove", async () => {
    const a = backendFor(sign(claims(A)))
    const b = backendFor(sign(claims(B)))
    const id = await a.connections.send({ uid: A, name: "Alice" }, { uid: B, name: "Bobby" })
    expect(typeof id).toBe("string")
    expect((await b.connections.list(B)).map((c) => c.id)).toContain(id)
    expect((await backendFor(sign(claims(C))).connections.list(C)).map((c) => c.id)).not.toContain(id) // a stranger sees nothing
    await b.connections.respond(id, "accepted")
    expect((await a.connections.list(A)).find((c) => c.id === id)?.status).toBe("accepted")

    const pingId = `ping-${run}-0001`
    const ping = { id: pingId, from: { uid: A, name: "Alice" }, to: { uid: B, name: "Bobby" }, date: today(), items: [{ key: "m@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer: null }], requestId: id }
    expect(await a.pings.create(ping)).toBe("created")
    expect(await a.pings.create(ping)).toBe("existing") // a retry is the same Ping
    await b.pings.answer(pingId, [{ key: "m@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer: "yes" }])
    expect(await a.pings.lease(pingId, "device-1")).toBe(true)
    expect(await a.pings.lease(pingId, "device-2")).toBe(false) // one device holds the lease
    expect(await a.pings.finalize(pingId)).toBe("processed")
    expect(await a.pings.finalize(pingId)).toBe("already") // exactly once
    await a.pings.remove(pingId)
    await a.connections.remove(id)
  })

  it("push tokens: save and remove", async () => {
    const a = backendFor(sign(claims(A)))
    await a.pushTokens.save(A, "push-token-for-e2e-test-" + run)
    await a.pushTokens.remove(A)
  })
})

describe("authorization failures against the real stack", () => {
  // a write that needs an identity: refused with "unauthorized" when the token is not acceptable
  const probe = async (token: string) => {
    const be = backendFor(token)
    return be.profiles.save(A, "Probe").then(
      () => "ok",
      (e) => `${(e as { kind?: string }).kind}`,
    )
  }
  // a READ with a token that fails the guard returns nothing (fail closed) and never the user's real data
  const readsNothing = async (token: string) => (await backendFor(token).sync.get(A).catch(() => null)) === null
  it("a token for another Firebase project (issuer) is refused by the database guard, and reads return nothing of the real data", async () => {
    const t = sign(claims(A, { iss: "https://securetoken.google.com/some-other-project" }))
    expect(await probe(t)).toBe("unauthorized")
    expect(await readsNothing(t)).toBe(true)
  })
  it("a wrong audience, or a missing issuer/audience, is refused the same way", async () => {
    for (const t of [sign(claims(A, { aud: "some-other-project" })), sign({ sub: A, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 3600 })]) {
      expect(await probe(t)).toBe("unauthorized")
      expect(await readsNothing(t)).toBe(true)
    }
  })
  it("sanity: the real owner's token DOES read the data these probes must not see", async () => {
    expect((await backendFor(sign(claims(A))).sync.get(A))?.rev).toBeGreaterThanOrEqual(1)
  })
  it("an expired token is refused", async () => {
    expect(await probe(sign(claims(A, { exp: Math.floor(Date.now() / 1000) - 3600 })))).toBe("unauthorized")
  })
  it("a token signed with the wrong secret is refused", async () => {
    expect(await probe(sign(claims(A), "a-completely-different-secret-value-1234567890"))).toBe("unauthorized")
  })
  it("a token without the authenticated role (anon) is refused", async () => {
    expect(await probe(sign(claims(A, { role: "anon" })))).toBe("unauthorized")
  })
  it("a sub-less authenticated token cannot write", async () => {
    const be = backendFor(sign({ ...claims(A), sub: "" }))
    await expect(be.profiles.save(A, "x")).rejects.toMatchObject({ kind: "unauthorized" })
  })
  it("no token at all: nothing is sent", async () => {
    const t = createFetchTransport({ config: { url: apiUrl, publishableKey } })
    await expect(t.rpc("get_profile_name", { p_uid: A })).rejects.toMatchObject({ kind: "unauthorized" })
  })
  it("direct table writes through the API surface are denied (the transport has no write path; raw fetch confirms the server)", async () => {
    const token = sign(claims(A))
    const res = await fetch(`${apiUrl}/rest/v1/syncs`, { method: "POST", headers: { apikey: publishableKey, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ uid: A, data: "x", rev: 9 }) })
    expect([401, 403]).toContain(res.status)
    const profiles = await fetch(`${apiUrl}/rest/v1/profiles?select=uid`, { headers: { apikey: publishableKey, authorization: `Bearer ${token}` } })
    expect([401, 403]).toContain(profiles.status)
  })
  it("the service-only rate-limit RPC is not callable by a signed-in user", async () => {
    const t = createFetchTransport({ config: { url: apiUrl, publishableKey } })
    t.setAccessToken?.(sign(claims(A)))
    const r = await t.rpc("bootstrap_rate_check", { p_bucket: "global", p_key: "x", p_limit: 1, p_window_seconds: 60 })
    expect(r.error?.code).toBe("42501")
  })
})

describe("network trouble against a dead port", () => {
  it("reports unavailable (retryable), quickly", async () => {
    const be = backendFor(sign(claims(A)), "http://127.0.0.1:1")
    const started = Date.now()
    await expect(be.sync.get(A)).rejects.toMatchObject({ kind: "unavailable", retryable: true })
    expect(Date.now() - started).toBeLessThan(9000)
  })
})
