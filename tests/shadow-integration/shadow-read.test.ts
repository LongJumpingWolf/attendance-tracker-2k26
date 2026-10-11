/**
 * Phase 7 preparation: the read-only shadow reader against the REAL Firestore emulator (with the real firestore.rules) and the
 * REAL local Supabase stack (PostgREST + the 12 migrations), through the real Firebase adapter and the real fetch transport.
 * LOCAL ONLY. Run with: npm run test:shadow-integration   (needs Java, the firebase CLI, and `npx supabase start`)
 *
 * The test proves the reader reports each situation correctly AND that it performs no writes to either backend: Firestore
 * documents and Supabase rows are snapshotted before and after, and every HTTP request the reader made is recorded and checked.
 * Tokens are HS256 JWTs signed with the LOCAL stack's development secret; no production credential or URL is involved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { doc, getDoc, type Firestore } from "firebase/firestore"
import fs from "node:fs"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

import { createFirebaseBackend } from "@/lib/backend/firebase"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createFetchTransport } from "@/lib/backend/supabase/transport"
import { createShadowReader, formatShadowReadReport, readSurface, verdict, type ShadowReadReport } from "@/lib/backend/shadow-read"

const PROJECT = "attendance-tracker-2k26"
const run = Date.now().toString(36)
const pad = (s: string) => (s + "0".repeat(28)).slice(0, 28)
const uidFor = (tag: string) => pad(`ShRd${tag}${run}`)

let env: RulesTestEnvironment
let apiUrl = ""
let publishableKey = ""
let jwtSecret = ""
const used: string[] = []

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url")
const sign = (claims: Record<string, unknown>, secret = jwtSecret) => {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64u(JSON.stringify(claims))
  return `${head}.${body}.${crypto.createHmac("sha256", secret).update(`${head}.${body}`).digest("base64url")}`
}
const claims = (sub: string, over: Record<string, unknown> = {}) => ({ sub, role: "authenticated", iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, exp: Math.floor(Date.now() / 1000) + 3600, ...over })

/** every HTTP request the Supabase side makes is recorded */
const requests: { method: string; path: string }[] = []
const recordingFetch: typeof fetch = (input, init) => {
  const u = new URL(String(input))
  requests.push({ method: String(init?.method ?? "GET"), path: u.pathname + (u.search ? "?" + u.search.slice(1).replace(/uid=eq\.[^&]*/, "uid=eq.<uid>") : "") })
  return fetch(input, init)
}

const fbDb = (uid: string) => env.authenticatedContext(uid).firestore() as unknown as Firestore
const fbBackend = (uid: string) => createFirebaseBackend({ db: fbDb(uid) })
const sbBackend = (uid: string, over: { token?: string; url?: string } = {}) => {
  const transport = createFetchTransport({ config: { url: over.url ?? apiUrl, publishableKey }, fetch: recordingFetch, timeoutMs: 6000 })
  return createSupabaseBackend({ transport, guard: async () => over.token ?? sign(claims(uid)) })
}
const readerFor = (uid: string, sb = sbBackend(uid), fb = fbBackend(uid)) =>
  createShadowReader({ authoritative: readSurface(fb), shadow: readSurface(sb), currentUid: () => uid, recheckDelayMs: 50 })

async function go(uid: string, sb?: ReturnType<typeof sbBackend>, fb?: ReturnType<typeof fbBackend>): Promise<ShadowReadReport> {
  const r = await readerFor(uid, sb, fb).run()
  if (r.status !== "done") throw new Error("skipped " + r.reason)
  return r.report
}
const newUser = (tag: string) => {
  const u = uidFor(tag)
  used.push(u)
  return u
}

const psql = (sql: string) => execFileSync("docker", ["exec", "-i", "supabase_db_Attendance_tracker", "psql", "-U", "postgres", "-X", "-tA", "-c", sql], { encoding: "utf8" }).trim()
const sbSnapshot = (uid: string) => psql(`select coalesce((select row_to_json(s)::text from public.syncs s where uid='${uid}'),'-') || '|' || coalesce((select row_to_json(p)::text from public.profiles p where uid='${uid}'),'-')`)
const fbSnapshot = async (uid: string) => {
  let out = ""
  await env.withSecurityRulesDisabled(async (c) => {
    const db = c.firestore() as unknown as Firestore
    const [s, u] = await Promise.all([getDoc(doc(db, "syncs", uid)), getDoc(doc(db, "users", uid))])
    out = JSON.stringify([s.exists() ? s.data() : null, u.exists() ? u.data() : null])
  })
  return out
}

beforeAll(async () => {
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const s = JSON.parse(out.slice(out.indexOf("{")))
  apiUrl = s.API_URL
  publishableKey = s.PUBLISHABLE_KEY
  jwtSecret = s.JWT_SECRET
  if (!["127.0.0.1", "localhost"].includes(new URL(apiUrl).hostname)) throw new Error("refusing to run: the API URL is not loopback")
  if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error("run through `npm run test:shadow-integration` (it starts the Firestore emulator)")
  env = await initializeTestEnvironment({ projectId: "demo-shadow", firestore: { rules: fs.readFileSync("firestore.rules", "utf8") } })
})

afterAll(async () => {
  try {
    const uids = used.map((u) => `'${u}'`).join(",")
    if (uids) psql(`delete from public.syncs where uid in (${uids}); delete from public.profiles where uid in (${uids})`)
  } catch {
    /* best effort; rows are tagged with this run's uids */
  }
  await env?.cleanup()
})

/** seeds both sides THROUGH THE ADAPTERS, as test setup (the reader itself never writes) */
async function seed(uid: string, side: "fb" | "sb", o: { name?: string; puts?: string[] }) {
  const be = side === "fb" ? fbBackend(uid) : sbBackend(uid)
  if (o.name) await be.profiles.save(uid, o.name)
  let rev: number | null = null
  for (const data of o.puts ?? []) {
    const r = await be.sync.put(uid, data, rev)
    if (!r.ok) throw new Error("seed conflict")
    rev = r.rev
  }
}

describe("each situation is reported correctly (real Firestore emulator + real local Supabase)", () => {
  it("match: same revision, same text, same name", async () => {
    const u = newUser("match")
    await seed(u, "fb", { name: "Alice", puts: ["gz1:one", "gz1:two"] })
    await seed(u, "sb", { name: "Alice", puts: ["gz1:one", "gz1:two"] })
    const r = await go(u)
    expect(r.sync).toEqual({ status: "match" })
    expect(r.profile).toEqual({ status: "match" })
    expect(verdict(r)).toBe("clean")
  })

  it("a brand-new account (nothing anywhere) is a match", async () => {
    const r = await go(newUser("empty"))
    expect(r.sync.status).toBe("match")
    expect(r.profile.status).toBe("match")
  })

  it("missing in Supabase: Firebase has it, the mirror does not", async () => {
    const u = newUser("missSb")
    await seed(u, "fb", { name: "Bob", puts: ["gz1:only-firebase"] })
    const r = await go(u)
    expect(r.sync).toMatchObject({ status: "mismatch", mismatches: [{ kind: "missing-in-supabase", confirmed: true }] })
    expect(r.profile).toMatchObject({ status: "mismatch", mismatches: [{ kind: "missing-in-supabase" }] })
  })

  it("missing in Firebase: only the shadow has it", async () => {
    const u = newUser("missFb")
    await seed(u, "sb", { name: "Carol", puts: ["gz1:only-supabase"] })
    const r = await go(u)
    expect(r.sync).toMatchObject({ mismatches: [{ kind: "missing-in-firebase" }] })
    expect(r.profile).toMatchObject({ mismatches: [{ kind: "missing-in-firebase" }] })
  })

  it("revision mismatch: the mirror is behind Firebase", async () => {
    const u = newUser("lag")
    await seed(u, "fb", { name: "Dan", puts: ["gz1:a", "gz1:b", "gz1:c"] })
    await seed(u, "sb", { name: "Dan", puts: ["gz1:a"] })
    const r = await go(u)
    expect(r.sync).toMatchObject({ mismatches: [{ kind: "revision-mismatch", lag: "supabase-behind", detail: "firebase rev 3, supabase rev 1" }] })
    expect(r.profile).toEqual({ status: "match" })
    console.log("SAMPLE REPORT (revision lag):\n" + formatShadowReadReport({ status: "done", report: r }))
  })

  it("value mismatch: same revision, different text, with lengths only", async () => {
    const u = newUser("value")
    await seed(u, "fb", { name: "Eve", puts: ["gz1:same-length-A"] })
    await seed(u, "sb", { name: "Eve Two", puts: ["gz1:same-length-B"] })
    const r = await go(u)
    expect(r.sync).toMatchObject({ mismatches: [{ kind: "value-mismatch" }] })
    expect(r.profile).toMatchObject({ mismatches: [{ kind: "value-mismatch" }] })
    expect(JSON.stringify(r)).not.toMatch(/same-length|Eve/)
  })

  it("a token the database guard refuses (wrong issuer): reported as a Supabase error, never as 'missing'; the sync table is not even read", async () => {
    const u = newUser("badiss")
    await seed(u, "sb", { name: "Frank", puts: ["gz1:x"] })
    await seed(u, "fb", { name: "Frank", puts: ["gz1:x"] })
    requests.length = 0
    const r = await go(u, sbBackend(u, { token: sign(claims(u, { iss: "https://securetoken.google.com/some-other-project" })) }))
    expect(r.profile).toEqual({ status: "shadow-error", reason: "unauthorized" })
    expect(r.sync).toEqual({ status: "shadow-error", reason: "unauthorized" })
    expect(requests.some((q) => q.path.startsWith("/rest/v1/syncs"))).toBe(false)
    expect(verdict(r)).toBe("inconclusive")
  })

  it("an expired token and a forged signature are Supabase-side authorization errors too", async () => {
    const u = newUser("tokens")
    for (const token of [sign(claims(u, { exp: Math.floor(Date.now() / 1000) - 3600 })), sign(claims(u), "a-completely-different-secret-value-1234567890")]) {
      const r = await go(u, sbBackend(u, { token }))
      expect(r.sync).toEqual({ status: "shadow-error", reason: "unauthorized" })
    }
  })

  it("Supabase unreachable: unavailable on both domains", async () => {
    const u = newUser("down")
    await seed(u, "fb", { name: "Gina", puts: ["gz1:x"] })
    const r = await go(u, sbBackend(u, { url: "http://127.0.0.1:1" }))
    expect(r.profile).toEqual({ status: "shadow-error", reason: "unavailable" })
    expect(r.sync).toEqual({ status: "shadow-error", reason: "unavailable" })
  })

  it("a Firebase-side refusal (rules deny reading another account's sync) is a Firebase error and concludes nothing", async () => {
    const u = newUser("fbdeny")
    await seed(u, "sb", { name: "Hal", puts: ["gz1:x"] })
    const stranger = pad(`ShRdStranger${run}`)
    const r = await go(u, sbBackend(u), fbBackend(stranger)) // Firestore context signed in as someone else
    expect(r.sync).toMatchObject({ status: "firebase-error", reason: "unauthorized" })
    expect(verdict(r)).toBe("inconclusive")
  })

  it("never reads another user's data: with a neighbour's data present on both sides, only the signed-in uid is requested", async () => {
    const mine = newUser("mine")
    const other = newUser("other")
    await seed(other, "fb", { name: "Neighbour", puts: ["gz1:neighbour-secret"] })
    await seed(other, "sb", { name: "Neighbour", puts: ["gz1:neighbour-secret"] })
    await seed(mine, "fb", { name: "Me", puts: ["gz1:mine"] })
    await seed(mine, "sb", { name: "Me", puts: ["gz1:mine"] })
    requests.length = 0
    const r = await go(mine)
    expect(r.sync).toEqual({ status: "match" })
    expect(JSON.stringify(r)).not.toMatch(/neighbour/i)
    expect(requests.every((q) => !q.path.includes(other))).toBe(true)
  })
})

describe("the reader performs no writes to either backend", () => {
  it("Firestore documents and Supabase rows are byte-identical before and after, in every outcome, and only read requests were made", async () => {
    const scenarios: { tag: string; fb?: { name?: string; puts?: string[] }; sb?: { name?: string; puts?: string[] } }[] = [
      { tag: "nwMatch", fb: { name: "N", puts: ["gz1:1"] }, sb: { name: "N", puts: ["gz1:1"] } },
      { tag: "nwLag", fb: { name: "N", puts: ["gz1:1", "gz1:2"] }, sb: { name: "N", puts: ["gz1:1"] } },
      { tag: "nwMissSb", fb: { name: "N", puts: ["gz1:1"] } },
      { tag: "nwMissFb", sb: { name: "N", puts: ["gz1:1"] } },
    ]
    for (const sc of scenarios) {
      const u = newUser(sc.tag)
      if (sc.fb) await seed(u, "fb", sc.fb)
      if (sc.sb) await seed(u, "sb", sc.sb)
      const beforeFb = await fbSnapshot(u)
      const beforeSb = sbSnapshot(u)
      requests.length = 0
      await go(u)
      await go(u) // twice, to also cover repeated runs
      expect(await fbSnapshot(u), sc.tag).toBe(beforeFb)
      expect(sbSnapshot(u), sc.tag).toBe(beforeSb)
      for (const q of requests) {
        const readOnly = (q.method === "GET" && q.path.startsWith("/rest/v1/syncs?")) || (q.method === "POST" && q.path === "/rest/v1/rpc/get_profile_name")
        expect(readOnly, `${q.method} ${q.path}`).toBe(true)
      }
      expect(requests.some((q) => /sync_put|upsert_profile|delete_|send_request|create_/.test(q.path))).toBe(false)
    }
  })

  it("control: the snapshots DO change when something is written, so the equality above is meaningful", async () => {
    const u = newUser("control")
    await seed(u, "fb", { name: "C", puts: ["gz1:1"] })
    await seed(u, "sb", { name: "C", puts: ["gz1:1"] })
    const [fb0, sb0] = [await fbSnapshot(u), sbSnapshot(u)]
    await fbBackend(u).sync.put(u, "gz1:2", 1)
    await sbBackend(u).sync.put(u, "gz1:2", 1)
    expect(await fbSnapshot(u)).not.toBe(fb0)
    expect(sbSnapshot(u)).not.toBe(sb0)
  })

  it("running the reader does not create the missing side", async () => {
    const u = newUser("nocreate")
    await seed(u, "fb", { name: "Z", puts: ["gz1:z"] })
    await go(u)
    expect(psql(`select count(*) from public.syncs where uid='${u}'`)).toBe("0")
    expect(psql(`select count(*) from public.profiles where uid='${u}'`)).toBe("0")
  })
})
