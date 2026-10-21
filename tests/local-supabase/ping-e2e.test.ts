/**
 * Phase 9 slice against the REAL local Supabase stack: the Ping state machine through the real adapter, real fetch transport, real RPCs
 * and real RLS, plus the polling Ping/connection watchers. Failure paths first: strangers, wrong roles, duplicates, bad state, expiry,
 * lease takeover, and genuinely concurrent calls. LOCAL ONLY (loopback enforced); tokens are HS256 JWTs signed with the local stack's
 * development secret; no production credential is used. Rows are created with this run's unique uids and removed afterwards.
 * Run with: npm run test:local-supabase
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

import type { Backend } from "@/lib/backend/contracts"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createFetchTransport } from "@/lib/backend/supabase/transport"
import type { Ping } from "@/lib/types"

const PROJECT = "attendance-tracker-2k26"
const run = Date.now().toString(36)
const pad = (s: string) => (s + "0".repeat(28)).slice(0, 28)
const A = pad(`PingAsker${run}`)
const B = pad(`PingMate${run}`)
const C = pad(`PingStranger${run}`)
const DB = "supabase_db_Attendance_tracker"

let apiUrl = ""
let publishableKey = ""
let jwtSecret = ""
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url")
function sign(sub: string): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64u(JSON.stringify({ sub, role: "authenticated", iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, exp: Math.floor(Date.now() / 1000) + 3600 }))
  return `${head}.${body}.${crypto.createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url")}`
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 10_000, what = "condition") {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await sleep(40)
  }
  throw new Error("timed out waiting for " + what)
}
const today = () => new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10)
const psql = (sql: string) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-X", "-q", "-c", sql], { stdio: "ignore" })

function backendFor(token: () => string, watchPollMs?: number): Backend {
  return createSupabaseBackend({ transport: createFetchTransport({ config: { url: apiUrl, publishableKey }, timeoutMs: 8000 }), guard: async () => token(), watchPollMs })
}
const items = (answer: "yes" | "no" | null = null) => [{ key: "m@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer }]
let seq = 0
const newId = () => `png-${run}-${String(++seq).padStart(4, "0")}`

let a: Backend
let b: Backend
let c: Backend
let requestId = ""
const ping = (id: string, over: Partial<Parameters<Backend["pings"]["create"]>[0]> = {}) => ({
  id,
  from: { uid: A, name: "Asker" },
  to: { uid: B, name: "Mate" },
  date: today(),
  items: items(),
  requestId,
  ...over,
})

beforeAll(async () => {
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const s = JSON.parse(out.slice(out.indexOf("{")))
  apiUrl = s.API_URL
  publishableKey = s.PUBLISHABLE_KEY
  jwtSecret = s.JWT_SECRET
  if (!["127.0.0.1", "localhost"].includes(new URL(apiUrl).hostname)) throw new Error("refusing to run: the API URL is not loopback")
  if (!publishableKey || !jwtSecret) throw new Error("the local Supabase stack is not running (npx supabase start)")
  a = backendFor(() => sign(A))
  b = backendFor(() => sign(B))
  c = backendFor(() => sign(C))
  requestId = await a.connections.send({ uid: A, name: "Asker" }, { uid: B, name: "Mate" })
  await b.connections.respond(requestId, "accepted")
})

afterAll(() => {
  const uids = [A, B, C].map((u) => `'${u}'`).join(",")
  try {
    psql(`delete from public.pings where from_uid in (${uids}) or to_uid in (${uids}); delete from public.connections where from_uid in (${uids}) or to_uid in (${uids}); delete from public.profiles where uid in (${uids});`)
  } catch {
    /* best effort; rows are tagged with this run's uids */
  }
})

describe("Ping authorization and identity (real RPCs, real RLS)", () => {
  it("a stranger cannot ping someone they are not connected to, and a connected pair cannot ping a third party", async () => {
    await expect(c.pings.create({ ...ping(newId()), from: { uid: C, name: "Stranger" }, to: { uid: B, name: "Mate" } })).rejects.toMatchObject({ code: "42501" })
    await expect(a.pings.create({ ...ping(newId()), to: { uid: C, name: "Stranger" } })).rejects.toMatchObject({ code: "42501" })
  })

  it("the sender is the caller, whatever the payload says: C claiming to be A, on A's connection, is refused (identity is server-derived)", async () => {
    const id = newId()
    await expect(c.pings.create({ ...ping(id), from: { uid: A, name: "Asker" }, to: { uid: B, name: "Mate" }, requestId })).rejects.toMatchObject({ code: "42501" })
    expect(await a.pings.create(ping(id))).toBe("created") // the id was not burned by the refused attempt
    await a.pings.remove(id)
  })

  it("only the person asked can answer; the asker and strangers cannot", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    await expect(a.pings.answer(id, items("yes"))).rejects.toMatchObject({ code: "42501" })
    await expect(c.pings.answer(id, items("yes"))).rejects.toMatchObject({ code: "42501" })
    await b.pings.answer(id, items("yes"))
    await a.pings.lease(id, "device-0001")
    await a.pings.finalize(id)
    await a.pings.remove(id)
  })

  it("only the asker can lease or finalize; strangers cannot touch, remove, or even see the ping", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    await b.pings.answer(id, items("no"))
    await expect(b.pings.lease(id, "device-b001")).rejects.toMatchObject({ code: "42501" })
    await expect(c.pings.lease(id, "device-c001")).rejects.toMatchObject({ code: "42501" })
    await expect(b.pings.finalize(id)).rejects.toMatchObject({ code: "42501" })
    await expect(c.pings.finalize(id)).rejects.toMatchObject({ code: "42501" })
    await expect(c.pings.remove(id)).rejects.toMatchObject({ code: "42501" })
    expect(await a.pings.lease(id, "device-0001")).toBe(true)
    expect(await a.pings.finalize(id)).toBe("processed")
    await a.pings.remove(id)
  })
})

describe("Ping idempotency, state and expiry", () => {
  it("a retry of the same request is the same Ping; the same id for a different request is refused", async () => {
    const id = newId()
    expect(await a.pings.create(ping(id))).toBe("created")
    expect(await a.pings.create(ping(id))).toBe("existing")
    await expect(a.pings.create(ping(id, { date: daysAgo(1) }))).rejects.toMatchObject({ code: "23505" })
    await expect(a.pings.create(ping(id, { items: [{ key: "other", subjectId: "s9", name: "Physics", answer: null }] }))).rejects.toMatchObject({ code: "23505" })
    await a.pings.remove(id)
  })

  it("invalid ids, dates, recipients, names and class lists are refused before anything is stored", async () => {
    await expect(a.pings.create(ping("short"))).rejects.toMatchObject({ code: "22023" })
    await expect(a.pings.create(ping(newId(), { date: "12/10/2026" }))).rejects.toMatchObject({ code: "22023" })
    await expect(a.pings.create(ping(newId(), { to: { uid: A, name: "Self" } }))).rejects.toMatchObject({ code: "22023" })
    await expect(a.pings.create(ping(newId(), { items: [] }))).rejects.toMatchObject({ code: "22023" })
    await expect(a.pings.create(ping(newId(), { from: { uid: A, name: "x".repeat(41) } }))).rejects.toMatchObject({ code: "22023" })
    await expect(a.pings.create(ping(newId(), { items: [{ key: "k", subjectId: "s", name: "M", answer: "yes" as never }] }))).rejects.toMatchObject({ code: "22023" }) // an unanswered ping must not arrive answered
  })

  it("a class day older than the Ping's lifetime is refused", async () => {
    await expect(a.pings.create(ping(newId(), { date: daysAgo(5) }))).rejects.toMatchObject({ code: "22023" })
  })

  it("state machine: no lease or finalize before an answer; no second answer; an unapplied answer cannot be removed", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    expect(await a.pings.lease(id, "device-0001")).toBe(false) // nothing to apply yet
    await expect(a.pings.finalize(id)).rejects.toMatchObject({ code: "55000" })
    await expect(b.pings.answer(id, [{ key: "m@09:00", subjectId: "s1", name: "CHANGED", t: "09:00", answer: "yes" }])).rejects.toMatchObject({ code: "22023" }) // only the answers may change
    await expect(b.pings.answer(id, items(null))).rejects.toMatchObject({ code: "22023" })
    await b.pings.answer(id, items("yes"))
    await expect(b.pings.answer(id, items("no"))).rejects.toMatchObject({ code: "55000" }) // already answered
    await expect(a.pings.remove(id)).rejects.toMatchObject({ code: "55000" }) // the answer is not applied yet
    expect(await a.pings.lease(id, "device-0001")).toBe(true)
    expect(await a.pings.finalize(id)).toBe("processed")
    expect(await a.pings.finalize(id)).toBe("already")
    expect(await a.pings.lease(id, "device-0001")).toBe(false) // processed: nothing left to lease
    await a.pings.remove(id)
  })

  it("an expired Ping cannot be answered (server clock)", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    psql(`update public.pings set created_at = now() - interval '4 days' where id = '${id}'`)
    await expect(b.pings.answer(id, items("yes"))).rejects.toMatchObject({ code: "55000" })
    await a.pings.remove(id)
  })

  it("lease takeover only after the lease has run out; the old holder then loses it; finalize still happens exactly once", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    await b.pings.answer(id, items("yes"))
    expect(await a.pings.lease(id, "device-0001")).toBe(true)
    expect(await a.pings.lease(id, "device-0002")).toBe(false)
    expect(await a.pings.lease(id, "device-0001")).toBe(true) // the holder may renew
    psql(`update public.pings set claimed_at = now() - interval '3 minutes' where id = '${id}'`)
    expect(await a.pings.lease(id, "device-0002")).toBe(true) // taken over
    expect(await a.pings.lease(id, "device-0001")).toBe(false)
    expect(await a.pings.finalize(id)).toBe("processed")
    expect(await a.pings.finalize(id)).toBe("already")
    await a.pings.remove(id)
  })
})

describe("Ping concurrency (genuinely simultaneous calls)", () => {
  it("two identical creates at once: one is created, the other reports 'existing'; exactly one row", async () => {
    const id = newId()
    const results = await Promise.all([a.pings.create(ping(id)), a.pings.create(ping(id))])
    expect([...results].sort()).toEqual(["created", "existing"])
    await a.pings.remove(id) // removing it proves there was exactly one row to remove; a second remove is a no-op
    await a.pings.remove(id)
  })

  it("two devices lease at the same moment: exactly one wins; two finalizes: one 'processed', one 'already'", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    await b.pings.answer(id, items("yes"))
    const leases = await Promise.all([a.pings.lease(id, "device-0001"), a.pings.lease(id, "device-0002")])
    expect(leases.filter(Boolean)).toHaveLength(1)
    const fin = await Promise.all([a.pings.finalize(id), a.pings.finalize(id)])
    expect([...fin].sort()).toEqual(["already", "processed"])
    await a.pings.remove(id)
  })

  it("two answers at once: one is accepted, the other refused", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    const settled = await Promise.allSettled([b.pings.answer(id, items("yes")), b.pings.answer(id, items("no"))])
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1)
    expect(settled.filter((s) => s.status === "rejected")).toHaveLength(1)
    await a.pings.lease(id, "device-0001")
    await a.pings.finalize(id)
    await a.pings.remove(id)
  })
})

describe("Ping watchers over the real read path", () => {
  it("each side sees the Ping move asking -> answered -> processed; a stranger's watcher sees none of it", async () => {
    const wa = backendFor(() => sign(A), 300)
    const wb = backendFor(() => sign(B), 300)
    const wc = backendFor(() => sign(C), 300)
    const seenA: Ping[][] = []
    const seenB: Ping[][] = []
    const seenC: Ping[][] = []
    const offs = [wa.pings.watch(A, { onData: (l) => void seenA.push(l) }), wb.pings.watch(B, { onData: (l) => void seenB.push(l) }), wc.pings.watch(C, { onData: (l) => void seenC.push(l) })]
    const id = newId()
    const has = (l: Ping[][], status: string) => l.some((x) => x.some((p) => p.id === id && p.status === status))
    await a.pings.create(ping(id))
    await until(() => has(seenB, "asking") && has(seenA, "asking"), 8000, "both participants to see the new ping")
    await b.pings.answer(id, items("yes"))
    await until(() => has(seenA, "answered"), 8000, "the asker to see the answer")
    await a.pings.lease(id, "device-0001")
    await a.pings.finalize(id)
    await until(() => has(seenB, "processed") && has(seenA, "processed"), 8000, "processed")
    await sleep(700)
    expect(seenC.flat().some((p) => p.id === id)).toBe(false)
    const answered = seenA.flat().find((p) => p.id === id && p.status === "answered")!
    expect(answered).toMatchObject({ from: A, to: B, participants: [A, B], requestId })
    expect(answered.items[0].answer).toBe("yes")
    offs.forEach((o) => o())
    await a.pings.remove(id)
  })

  it("account transition: a watcher for one account fed another account's token never delivers the other account's Pings", async () => {
    const id = newId()
    await a.pings.create(ping(id))
    let current = sign(B)
    const w = backendFor(() => current, 300)
    const got: Ping[][] = []
    const off = w.pings.watch(B, { onData: (l) => void got.push(l) })
    await until(() => got.some((l) => l.some((p) => p.id === id)), 8000, "B to see the ping")
    current = sign(C) // the identity under the same watcher changes (sign-out / account switch)
    got.length = 0
    await sleep(1200)
    // C's rows are read, none involves B, so nothing of C's (or of A's) is delivered under B's name
    expect(got.flat().every((p) => p.participants.includes(B))).toBe(true)
    expect(got.flat().some((p) => p.id === id)).toBe(false)
    off()
    await a.pings.remove(id)
  })
})
