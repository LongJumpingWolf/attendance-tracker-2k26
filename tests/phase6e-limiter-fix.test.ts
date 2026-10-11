/**
 * Phase 6E finding A: the bootstrap function must not throttle established (role-bearing) users with the shared first-time
 * bootstrap limiter, while first-time bootstraps and bad tokens stay protected. Fakes only: no Firebase, no Supabase, no network.
 * (The database counter itself: supabase/tests/database/bootstrap_rate_limit.test.sql and concurrency.sh.)
 */
import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

import {
  createHandler,
  createRateLimiter,
  parseConfig,
  type DbRateLimiter,
  type UserRecordLike,
  type VerifiedToken,
} from "../supabase/functions/auth-role-bootstrap/handler"

const ROOT = path.resolve(import.meta.dirname, "..")
const FN_DIR = path.join(ROOT, "supabase", "functions", "auth-role-bootstrap")
const PROJECT = "demo-project-123"
const ORIGIN = "https://app.example.test"
const iss = `https://securetoken.google.com/${PROJECT}`
const uidN = (kind: string, n: number) => `${kind}${String(n).padStart(28 - kind.length, "0")}`

/** The token carried by a request is its identity in these tests: "established-7", "fresh-12", "garbage", ... */
const parse = (bearer: string): { kind: string; n: number } => {
  const m = /^(established|fresh|same|revoked|disabled|flaky|garbage|expired|wrongiss|wrongaud|badsub)-?(\d*)/.exec(bearer.replace(/^x+/, ""))
  return { kind: m?.[1] ?? "garbage", n: Number(m?.[2] ?? 0) }
}
const bearerFor = (kind: string, n = 0) => `${"x".repeat(12)}${kind}-${n}-${"A".repeat(24)}`

/** A faithful fake of public.bootstrap_rate_check: fixed windows, atomic per call, refused calls still count */
function fakeDb(opts: { fail?: boolean } = {}) {
  const counts = new Map<string, number>()
  const calls: { bucket: string; key: string }[] = []
  const db: DbRateLimiter = {
    async take(bucket, key, limit, window) {
      calls.push({ bucket, key })
      if (opts.fail) throw new Error("db down")
      await Promise.resolve() // let concurrent requests interleave
      const k = `${bucket}|${key}|${window}`
      const n = (counts.get(k) ?? 0) + 1
      counts.set(k, n)
      return n <= limit
    },
  }
  return { db, calls }
}

interface Opts {
  env?: Record<string, string>
  fastMax?: number
  uidMax?: number
  valveMax?: number
  db?: ReturnType<typeof fakeDb>
  revokedCheckFails?: string
}

function setup(o: Opts = {}) {
  const db = o.db ?? fakeDb()
  const stats = { local: 0, revoked: 0, getUser: 0, writes: [] as [string, Record<string, unknown>][], logs: [] as string[] }
  const claimsOf = new Map<string, Record<string, unknown>>()
  const parsed = parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT, RATE_GLOBAL_PER_MIN: "120", ...(o.env ?? {}) })
  const handler = createHandler(parsed, {
    ipLimiter: createRateLimiter({ windowMs: 60_000, max: 30 }), // the cap the deployed v1 applied to EVERY request through one shared key
    uidLimiter: createRateLimiter({ windowMs: 60_000, max: o.uidMax ?? 100000 }),
    fastLimiter: createRateLimiter({ windowMs: 60_000, max: o.fastMax ?? 100000 }),
    revocationLimiter: createRateLimiter({ windowMs: 60_000, max: o.valveMax ?? 100000, maxKeys: 1 }),
    dbLimiter: db.db,
    log: (c) => stats.logs.push(c),
    async verifyIdToken(token, checkRevoked) {
      if (checkRevoked) stats.revoked++
      else stats.local++
      const { kind, n } = parse(token)
      const err = (code: string) => Object.assign(new Error("library message with token " + token), { code })
      if (kind === "garbage") throw err("auth/argument-error")
      if (kind === "expired") throw err("auth/id-token-expired")
      if (checkRevoked && kind === "revoked") throw err("auth/id-token-revoked")
      if (checkRevoked && kind === "disabled") throw err("auth/user-disabled")
      if (checkRevoked && kind === "flaky") throw err("auth/internal-error")
      if (checkRevoked && o.revokedCheckFails) throw err(o.revokedCheckFails)
      const uid = kind === "same" ? uidN("same", 0) : uidN(kind, n)
      const base: VerifiedToken = { uid, sub: uid, iss, aud: PROJECT, iat: Math.floor(Date.now() / 1000) }
      if (kind === "wrongiss") return { ...base, iss: "https://securetoken.google.com/other" }
      if (kind === "wrongaud") return { ...base, aud: "other" }
      if (kind === "badsub") return { ...base, uid: "someone-else" }
      const established = kind === "established" || kind === "revoked" || kind === "disabled" || kind === "flaky"
      return established ? { ...base, role: "authenticated" } : base
    },
    async getUser(uid) {
      stats.getUser++
      return { disabled: false, customClaims: claimsOf.get(uid) ?? null } as UserRecordLike
    },
    async setCustomClaims(uid, claims) {
      stats.writes.push([uid, claims])
      claimsOf.set(uid, claims)
    },
  })
  const call = (bearer: string, headers: Record<string, string> = {}) =>
    handler(new Request("https://x.supabase.co/functions/v1/auth-role-bootstrap", { method: "POST", headers: { authorization: `Bearer ${bearer}`, ...headers } }))
  return { call, db, stats }
}
const statuses = async (rs: Promise<Response>[]) => (await Promise.all(rs)).map((r) => r.status)
const count = (xs: number[], v: number) => xs.filter((x) => x === v).length

describe("first-time bootstrap stays throttled", () => {
  it("the project-wide cap limits distinct new accounts; the 429 says wait 60 s", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "5" } })
    const out: Response[] = []
    for (let i = 1; i <= 8; i++) out.push(await s.call(bearerFor("fresh", i)))
    expect(out.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 429, 429, 429])
    expect(out[5].headers.get("retry-after")).toBe("60")
    expect(await out[5].json()).toEqual({ success: false, error: "rate-limited" })
    expect(s.stats.writes).toHaveLength(5)
  })
  it("one account is limited per 10 minutes; the 429 says wait 600 s", async () => {
    const s = setup({ env: { RATE_UID_PER_10MIN: "3" } })
    const out: Response[] = []
    for (let i = 0; i < 5; i++) out.push(await s.call(bearerFor("same")))
    expect(out.map((r) => r.status)).toEqual([200, 200, 200, 429, 429])
    expect(out[3].headers.get("retry-after")).toBe("600")
    expect(s.stats.writes.length).toBeLessThanOrEqual(1) // idempotent: only the first request writes
  })
  it("the per-instance account limit answers 429 / 60 s before any database counter is touched", async () => {
    const s = setup({ uidMax: 2 })
    const out: Response[] = []
    for (let i = 0; i < 4; i++) out.push(await s.call(bearerFor("same")))
    expect(out.map((r) => r.status)).toEqual([200, 200, 429, 429])
    expect(out[2].headers.get("retry-after")).toBe("60")
    expect(s.db.calls.filter((c) => c.bucket === "uid")).toHaveLength(2)
  })
  it("429 responses are no-store JSON and carry CORS headers only for the allow-listed origin", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "1" } })
    await s.call(bearerFor("fresh", 1))
    const ok = await s.call(bearerFor("fresh", 2), { origin: ORIGIN })
    expect(ok.status).toBe(429)
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(ok.headers.get("cache-control")).toBe("no-store")
    expect((await s.call(bearerFor("fresh", 3), { origin: "https://evil.example" })).status).toBe(403) // origin is checked first
  })
  it("a failing counter closes the door for first-time bootstraps (503) and does no Admin work", async () => {
    const s = setup({ db: fakeDb({ fail: true }) })
    expect((await s.call(bearerFor("fresh", 1))).status).toBe(503)
    expect(s.stats.getUser).toBe(0)
    expect(s.stats.writes).toHaveLength(0)
  })
})

describe("established users are not throttled by the bootstrap limiter (the finding)", () => {
  it("regression: 300 requests from established users in a minute, with the address header ignored, all succeed (the old shared 30/min cap would have refused 270)", async () => {
    const s = setup()
    const out = await statuses(Array.from({ length: 300 }, (_, i) => s.call(bearerFor("established", i % 100), { "x-forwarded-for": `203.0.113.${i % 250}` })))
    expect(count(out, 200)).toBe(300)
  })
  it("established users keep working while the project-wide first-time budget is exhausted", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "1" } })
    expect((await s.call(bearerFor("fresh", 1))).status).toBe(200)
    expect((await s.call(bearerFor("fresh", 2))).status).toBe(429) // exhausted
    s.db.calls.length = 0
    const out = await statuses(Array.from({ length: 50 }, (_, i) => s.call(bearerFor("established", i))))
    expect(count(out, 200)).toBe(50)
    expect(s.db.calls).toEqual([]) // the established path never touches the database counters
    expect(s.stats.getUser).toBe(1) // only the first fresh account read a user record
  })
  it("and while the per-instance first-time account limit is exhausted", async () => {
    const s = setup({ uidMax: 1 })
    await s.call(bearerFor("fresh", 1))
    expect((await s.call(bearerFor("fresh", 1))).status).toBe(429)
    expect((await s.call(bearerFor("established", 1))).status).toBe(200)
  })
  it("one established account is bounded on its own (429 / 60 s) without affecting anyone else", async () => {
    const s = setup({ fastMax: 3 })
    const out: Response[] = []
    for (let i = 0; i < 5; i++) out.push(await s.call(bearerFor("established", 7)))
    expect(out.map((r) => r.status)).toEqual([200, 200, 200, 429, 429])
    expect(out[3].headers.get("retry-after")).toBe("60")
    expect((await s.call(bearerFor("established", 8))).status).toBe(200)
  })
  it("the revocation valve is a safety limit: past it, established requests get 429 / 60 s, while bad tokens are still just 401", async () => {
    const s = setup({ valveMax: 5 })
    const out: number[] = []
    for (let i = 0; i < 8; i++) out.push((await s.call(bearerFor("established", i))).status)
    expect(out).toEqual([200, 200, 200, 200, 200, 429, 429, 429])
    expect((await s.call(bearerFor("garbage", 0))).status).toBe(401)
  })
  it("established requests still get the revocation / disabled check: revoked = 401, disabled = 403, Firebase trouble = 503 (not a verdict)", async () => {
    const s = setup()
    const rev = await s.call(bearerFor("revoked", 1))
    expect(rev.status).toBe(401)
    expect(await rev.json()).toEqual({ success: false, error: "invalid-token" })
    expect((await s.call(bearerFor("disabled", 1))).status).toBe(403)
    expect((await s.call(bearerFor("flaky", 1))).status).toBe(503)
    expect(s.stats.logs).toEqual(["token-revoked", "user-disabled", "verify-unavailable"])
    expect(JSON.stringify(s.stats.logs)).not.toMatch(/library message|xxxx/)
  })
  it("a role-bearing established request performs no Admin read or write", async () => {
    const s = setup()
    await s.call(bearerFor("established", 1))
    expect(s.stats.getUser).toBe(0)
    expect(s.stats.writes).toHaveLength(0)
  })
})

describe("invalid tokens stay protected and consume nothing", () => {
  it("garbage, expired, wrong issuer, wrong audience and mismatching subject are cheap 401s: no counter, no Admin call, no revocation look-up", async () => {
    const s = setup()
    for (const kind of ["garbage", "expired", "wrongiss", "wrongaud", "badsub"]) {
      const r = await s.call(bearerFor(kind, 1))
      expect(r.status, kind).toBe(401)
      expect(await r.json()).toEqual({ success: false, error: "invalid-token" })
    }
    expect(s.db.calls).toEqual([])
    expect(s.stats.getUser).toBe(0)
    expect(s.stats.writes).toHaveLength(0)
    expect(s.stats.revoked).toBe(0)
  })
  it("a flood of 2000 bad tokens does not use up any budget: right afterwards a new account and an established account are served", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "5" }, valveMax: 5 })
    const flood = await statuses(Array.from({ length: 2000 }, (_, i) => s.call(bearerFor(i % 2 ? "garbage" : "expired", i))))
    expect(count(flood, 401)).toBe(2000)
    expect((await s.call(bearerFor("fresh", 1))).status).toBe(200)
    expect((await s.call(bearerFor("established", 1))).status).toBe(200)
  })
  it("malformed or missing Authorization is still refused before any work", async () => {
    const s = setup()
    for (const h of ["", "Basic abc", "Bearer short"]) {
      const r = await createHandler(parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT }), {
        ipLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
        uidLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
        fastLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
        revocationLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
        dbLimiter: s.db.db,
        log: () => {},
        verifyIdToken: async () => {
          throw new Error("must not be called")
        },
        getUser: async () => ({ disabled: false }),
        setCustomClaims: async () => {},
      })(new Request("https://x/y", { method: "POST", headers: { authorization: h } }))
      expect(r.status, h).toBe(401)
    }
  })
  it("the client cannot claim to be established: a token without the role takes the first-time path whatever the request says", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "1" } })
    await s.call(bearerFor("fresh", 1))
    const r = await s.call(bearerFor("fresh", 2), { "x-role": "authenticated", "x-established": "1" })
    expect(r.status).toBe(429)
  })
})

describe("concurrency", () => {
  it("100 simultaneous established requests are all served with no database traffic", async () => {
    const s = setup()
    const out = await statuses(Array.from({ length: 100 }, (_, i) => s.call(bearerFor("established", i))))
    expect(count(out, 200)).toBe(100)
    expect(s.db.calls).toEqual([])
  })
  it("200 simultaneous first-time bootstraps against a cap of 120: exactly 120 pass and 80 are refused", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "120" } })
    const out = await statuses(Array.from({ length: 200 }, (_, i) => s.call(bearerFor("fresh", i))))
    expect(count(out, 200)).toBe(120)
    expect(count(out, 429)).toBe(80)
    expect(s.stats.writes).toHaveLength(120)
  })
  it("20 simultaneous first-time requests for ONE account against a per-account cap of 6: exactly 6 pass; every write is identical", async () => {
    const s = setup({ env: { RATE_UID_PER_10MIN: "6" } })
    const out = await statuses(Array.from({ length: 20 }, () => s.call(bearerFor("same"))))
    expect(count(out, 200)).toBe(6)
    expect(count(out, 429)).toBe(14)
    expect(s.stats.writes.length).toBeGreaterThan(0)
    expect(s.stats.writes.length).toBeLessThanOrEqual(6)
    for (const [, claims] of s.stats.writes) expect(claims).toEqual({ role: "authenticated" }) // concurrent writers write the same constant
  })
  it("a mixed storm (established, new, invalid) is judged per request: only new accounts beyond the cap are refused", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "10" } })
    const reqs: Promise<Response>[] = []
    for (let i = 0; i < 60; i++) reqs.push(s.call(bearerFor("established", i)))
    for (let i = 0; i < 30; i++) reqs.push(s.call(bearerFor("fresh", i)))
    for (let i = 0; i < 60; i++) reqs.push(s.call(bearerFor("garbage", i)))
    const out = await statuses(reqs)
    expect(count(out.slice(0, 60), 200)).toBe(60)
    expect(count(out.slice(60, 90), 200)).toBe(10)
    expect(count(out.slice(60, 90), 429)).toBe(20)
    expect(count(out.slice(90), 401)).toBe(60)
  })
})

describe("the IP mode, when the owner enables it, is unchanged", () => {
  it("still limits per address before any verification (a documented trade-off for shared addresses), and other addresses are unaffected", async () => {
    const s = setup({ env: { CLIENT_IP_MODE: "xff-first", RATE_IP_PER_MIN: "3" } })
    const out: number[] = []
    for (let i = 0; i < 5; i++) out.push((await s.call(bearerFor("established", i), { "x-forwarded-for": "198.51.100.7" })).status)
    expect(out).toEqual([200, 200, 200, 429, 429])
    expect((await s.call(bearerFor("established", 9), { "x-forwarded-for": "198.51.100.8" })).status).toBe(200)
    expect(s.stats.local).toBe(4) // the two refused requests never reached verification
  })
})

describe("the source keeps the order that makes this safe", () => {
  const src = fs.readFileSync(path.join(FN_DIR, "handler.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  it("the per-address limiter is only used inside the IP-mode branch, before verification", () => {
    expect(src.match(/deps\.ipLimiter\.take/g)).toHaveLength(1)
    const ipBlock = src.indexOf('if (ipMode !== "off") {')
    expect(ipBlock).toBeGreaterThan(0)
    expect(src.indexOf("deps.ipLimiter.take")).toBeGreaterThan(ipBlock)
    expect(src.indexOf("deps.ipLimiter.take")).toBeLessThan(src.indexOf("verifyIdToken(m[1], false)"))
  })
  it("local verification comes first; the established path and the first-time path use different limiters; the revocation check precedes any Admin read", () => {
    const local = src.indexOf("verifyIdToken(m[1], false)")
    const fast = src.indexOf("deps.fastLimiter.take(uid)")
    const first = src.indexOf("deps.uidLimiter.take(uid)")
    const dbUid = src.indexOf('deps.dbLimiter.take("uid"')
    const getUser = src.indexOf("deps.getUser(uid)")
    expect(local).toBeGreaterThan(0)
    expect(fast).toBeGreaterThan(local)
    expect(first).toBeGreaterThan(fast)
    expect(dbUid).toBeGreaterThan(first)
    expect(getUser).toBeGreaterThan(dbUid)
    expect(src.indexOf("await revocationCheck()", dbUid)).toBeLessThan(getUser)
    // the established path returns before the first-time counters
    expect(src.slice(fast, first)).toMatch(/return respond\(200/)
    expect(src.slice(fast, first)).not.toMatch(/dbLimiter/)
  })
  it("no limiter key ever comes from the request", () => {
    for (const m of src.matchAll(/(?:Limiter|dbLimiter)\.take\(([^)]*)\)/g)) expect(m[1], m[0]).not.toMatch(/req\.|headers|body|m\[1\]/)
  })
})

describe("the cheap local check is the SDK's real verification, and nothing unverified is trusted", () => {
  const handlerSrc = fs.readFileSync(path.join(FN_DIR, "handler.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const indexSrc = fs.readFileSync(path.join(FN_DIR, "index.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("the handler decodes no JWT itself: no base64, no JSON.parse of a token, no splitting on dots", () => {
    expect(handlerSrc).not.toMatch(/\batob\(|\bbtoa\(|Buffer\.|base64|JSON\.parse|\.split\("\."\)|jwt-decode|jose/)
  })
  it("every claim the handler reads comes from the object returned by the SDK's verification, never from the request", () => {
    expect(handlerSrc.match(/token\.(role|iss|aud|sub|uid|iat)\b/g)?.length).toBeGreaterThan(5)
    expect(handlerSrc).not.toMatch(/req\.(json|text|formData|arrayBuffer)|searchParams/)
    // the only value derived from the Authorization header is the opaque bearer string passed to the SDK
    expect(handlerSrc.match(/m\[1\]/g)?.length).toBe(2)
    expect(handlerSrc).toMatch(/verifyIdToken\(m\[1\], false\)/)
    expect(handlerSrc).toMatch(/verifyIdToken\(m\[1\], true\)/)
  })
  it("index.ts returns claims only from the SDK's decoded token, and verifies with the Admin SDK (not a hand-written check)", () => {
    expect(indexSrc).toMatch(/const d = await admin\(\)\.verifyIdToken\(token, checkRevoked === true\)/)
    expect(indexSrc).toMatch(/return \{ uid: d\.uid, sub: d\.sub, iss: d\.iss, aud: d\.aud, iat: d\.iat, role: d\.role \}/)
    expect(indexSrc).not.toMatch(/\batob\(|JSON\.parse\(token|decodeJwt|jose/)
  })
  it("the Admin SDK is initialised with the configured project id (it enforces aud and iss against it), and the key must belong to that project", () => {
    expect(indexSrc).toMatch(/initializeApp\(\{ credential: cert\(sa\), projectId: sa\.project_id \}\)/)
    expect(indexSrc).toMatch(/sa\.project_id !== configResult\.config\.projectId/)
  })
  it("a function environment that contains FIREBASE_AUTH_EMULATOR_HOST fails closed (the SDK would otherwise accept unsigned tokens)", async () => {
    for (const v of ["localhost:9099", "127.0.0.1:9099", "x"]) {
      const parsed = parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT, FIREBASE_AUTH_EMULATOR_HOST: v })
      expect(parsed).toEqual({ ok: false, reason: "emulator-host-set" })
    }
    expect(parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT, FIREBASE_AUTH_EMULATOR_HOST: "" }).ok).toBe(true)
    expect(parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT }).ok).toBe(true)
    // and the handler built from it answers 503 to everything without verifying anything
    const verify = { n: 0 }
    const handler = createHandler(parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT, FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }), {
      ipLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
      uidLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
      fastLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
      revocationLimiter: createRateLimiter({ windowMs: 1000, max: 9 }),
      dbLimiter: fakeDb().db,
      log: () => {},
      verifyIdToken: async () => (verify.n++, { uid: "u", sub: "u", iss, aud: PROJECT, iat: 1, role: "authenticated" }),
      getUser: async () => ({ disabled: false }),
      setCustomClaims: async () => {},
    })
    const res = await handler(new Request("https://x/y", { method: "POST", headers: { authorization: `Bearer ${bearerFor("established", 1)}` } }))
    expect(res.status).toBe(503)
    expect(verify.n).toBe(0)
  })
  it("index.ts passes the emulator variable into the configuration check", () => {
    expect(indexSrc).toMatch(/FIREBASE_AUTH_EMULATOR_HOST: Deno\.env\.get\("FIREBASE_AUTH_EMULATOR_HOST"\)/)
  })
})
