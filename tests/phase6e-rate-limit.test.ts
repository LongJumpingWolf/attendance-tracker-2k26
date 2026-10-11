/**
 * Phase 6E: rate limiting, IP trust, revocation and configuration of the PROPOSED bootstrap function.
 * Fakes only: no Firebase, no Supabase, no network, no credentials. Nothing is deployed or applied.
 * The database counter itself is tested in supabase/tests/database/bootstrap_rate_limit.test.sql and concurrency.sh.
 */
import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"

import {
  DEFAULT_RATE,
  clientKey,
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
const BEARER = "A".repeat(40) + ".bbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccc"
const tokenFor = (uid: string, over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  uid,
  sub: uid,
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  iat: Math.floor(Date.now() / 1000),
  ...over,
})

/** A faithful fake of public.bootstrap_rate_check: fixed windows, refused calls still count */
function fakeDb(opts: { fail?: boolean } = {}) {
  const counts = new Map<string, number>()
  const calls: { bucket: string; key: string; limit: number; window: number }[] = []
  const db: DbRateLimiter = {
    async take(bucket, key, limit, window) {
      calls.push({ bucket, key, limit, window })
      if (opts.fail) throw new Error("db down")
      const k = `${bucket}|${key}|${window}`
      const n = (counts.get(k) ?? 0) + 1
      counts.set(k, n)
      return n <= limit
    },
  }
  return { db, calls, counts }
}

function setup(
  o: {
    env?: Record<string, string>
    uid?: string
    token?: (calls: number) => VerifiedToken | Error
    user?: Partial<UserRecordLike>
    db?: ReturnType<typeof fakeDb>
  } = {},
) {
  const db = o.db ?? fakeDb()
  const stats = { verify: 0, getUser: 0, set: 0, logs: [] as string[] }
  const parsed = parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT, ...(o.env ?? {}) })
  const handler = createHandler(parsed, {
    ipLimiter: createRateLimiter({ windowMs: 60_000, max: 100000 }),
    uidLimiter: createRateLimiter({ windowMs: 60_000, max: 100000 }),
    fastLimiter: createRateLimiter({ windowMs: 60_000, max: 100000 }),
    revocationLimiter: createRateLimiter({ windowMs: 60_000, max: 100000, maxKeys: 1 }),
    dbLimiter: db.db,
    log: (c) => stats.logs.push(c),
    async verifyIdToken() {
      stats.verify++
      const t = o.token ? o.token(stats.verify) : tokenFor(o.uid ?? "AliceFbUid0000000000000000a1")
      if (t instanceof Error) throw t
      return t
    },
    async getUser() {
      stats.getUser++
      return { disabled: false, customClaims: null, ...(o.user ?? {}) }
    },
    async setCustomClaims() {
      stats.set++
    },
  })
  const call = (headers: Record<string, string> = {}, body?: string) =>
    handler(new Request("https://x.supabase.co/functions/v1/auth-role-bootstrap", { method: "POST", headers: { authorization: `Bearer ${BEARER}`, ...headers }, body }))
  return { call, db, stats, handler }
}

describe("configuration", () => {
  it("has safe defaults: IP mode off, documented thresholds", () => {
    const r = parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT })
    expect(r.ok && r.config.ipMode).toBe("off")
    expect(r.ok && r.config.rate).toEqual(DEFAULT_RATE)
    expect(DEFAULT_RATE).toEqual({ uidPer10Min: 6, globalPerMin: 120, ipPerMin: 60 })
  })
  it("thresholds are configurable within 1..10000, and an invalid value fails closed", () => {
    const base = { ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT }
    const ok = parseConfig({ ...base, RATE_UID_PER_10MIN: "3", RATE_GLOBAL_PER_MIN: "500", RATE_IP_PER_MIN: "200", CLIENT_IP_MODE: "xff-last" })
    expect(ok.ok && ok.config.rate).toEqual({ uidPer10Min: 3, globalPerMin: 500, ipPerMin: 200 })
    for (const bad of ["0", "-1", "10001", "abc", "1.5", "1e3", "999999"]) {
      expect(parseConfig({ ...base, RATE_GLOBAL_PER_MIN: bad }), bad).toEqual({ ok: false, reason: "rate-invalid" })
    }
    for (const bad of ["on", "first", "XFF-FIRST", "true", "cf"]) expect(parseConfig({ ...base, CLIENT_IP_MODE: bad }), bad).toEqual({ ok: false, reason: "ip-mode-invalid" })
  })
})

describe("client IP trust: not established, so OFF by default", () => {
  it("mode off ignores X-Forwarded-For completely: spoofing it changes nothing", () => {
    const a = new Request("https://x/", { headers: { "x-forwarded-for": "198.51.100.7" } })
    const b = new Request("https://x/", { headers: { "x-forwarded-for": "203.0.113.99, 10.0.0.1" } })
    expect(clientKey(a, "off")).toBe("instance")
    expect(clientKey(b, "off")).toBe("instance")
  })
  it("no database IP counter is touched in mode off, whatever headers arrive", async () => {
    const s = setup()
    for (let i = 0; i < 5; i++) await s.call({ "x-forwarded-for": `203.0.113.${i}` })
    expect(s.db.calls.filter((c) => c.bucket === "ip")).toEqual([])
  })
  it("first / last entry selection, IPv6 accepted, anything that is not an address becomes 'unknown'", () => {
    const r = (v: string) => new Request("https://x/", { headers: { "x-forwarded-for": v } })
    expect(clientKey(r("1.1.1.1, 2.2.2.2, 3.3.3.3"), "xff-first")).toBe("1.1.1.1")
    expect(clientKey(r("1.1.1.1, 2.2.2.2, 3.3.3.3"), "xff-last")).toBe("3.3.3.3")
    expect(clientKey(r("2001:db8::1"), "xff-first")).toBe("2001:db8::1")
    for (const v of ["", "garbage", "1.1.1.1; drop table", "'--", "a".repeat(200), "<script>"]) expect(clientKey(r(v), "xff-first"), v).toBe("unknown")
    expect(clientKey(new Request("https://x/"), "xff-first")).toBe("unknown")
  })
  it("with a mode on, the database sees only a 32-hex hash of the address, never the address", async () => {
    const s = setup({ env: { CLIENT_IP_MODE: "xff-first" } })
    await s.call({ "x-forwarded-for": "198.51.100.7" })
    const ip = s.db.calls.find((c) => c.bucket === "ip")!
    expect(ip.key).toMatch(/^[0-9a-f]{32}$/)
    expect(ip.key).not.toContain("198")
    expect(ip.window).toBe(60)
    expect(ip.limit).toBe(60)
  })
  it("an unreadable address is not counted per address (no shared 'unknown' lockout bucket in the database)", async () => {
    const s = setup({ env: { CLIENT_IP_MODE: "xff-first" } })
    await s.call({ "x-forwarded-for": "not-an-ip" })
    expect(s.db.calls.filter((c) => c.bucket === "ip")).toEqual([])
  })
  it("campus case: many different users behind one address pass until the configured per-address cap, then are refused (the documented trade-off)", async () => {
    const s = setup({ env: { CLIENT_IP_MODE: "xff-first", RATE_IP_PER_MIN: "60", RATE_GLOBAL_PER_MIN: "10000" }, token: (n) => tokenFor(`CampusUser${String(n).padStart(17, "0")}`) })
    const statuses: number[] = []
    for (let i = 0; i < 62; i++) statuses.push((await s.call({ "x-forwarded-for": "198.51.100.7" })).status)
    expect(statuses.filter((x) => x === 200)).toHaveLength(60)
    expect(statuses.slice(60)).toEqual([429, 429])
    // another address is unaffected
    expect((await s.call({ "x-forwarded-for": "198.51.100.8" })).status).toBe(200)
  })
})

describe("database limits cannot be steered by the client", () => {
  it("the per-account key is the verified uid; a uid in the body or headers is ignored", async () => {
    const s = setup({ uid: "RealUid00000000000000000001" })
    await s.call({ "x-uid": "Victim", "x-user-id": "Victim" }, JSON.stringify({ uid: "Victim", key: "Victim", bucket: "global" }))
    const uidCalls = s.db.calls.filter((c) => c.bucket === "uid")
    expect(uidCalls.map((c) => c.key)).toEqual(["RealUid00000000000000000001"])
    expect(s.db.calls.every((c) => !JSON.stringify(c).includes("Victim"))).toBe(true)
  })
  it("limits and windows come from configuration only", async () => {
    const s = setup({ env: { RATE_UID_PER_10MIN: "2", RATE_GLOBAL_PER_MIN: "7" } })
    await s.call()
    expect(s.db.calls).toEqual([
      { bucket: "uid", key: "AliceFbUid0000000000000000a1", limit: 2, window: 600 },
      { bucket: "global", key: "bootstrap", limit: 7, window: 60 },
    ])
  })
  it("an account that exceeds its cap is refused with 429 and never reaches the Admin API again", async () => {
    const s = setup({ env: { RATE_UID_PER_10MIN: "2" }, user: { customClaims: { role: "authenticated" } } })
    const out: number[] = []
    for (let i = 0; i < 4; i++) out.push((await s.call()).status)
    expect(out).toEqual([200, 200, 429, 429])
    expect(s.stats.getUser).toBe(2)
  })
  it("a refused account does not consume the shared project budget", async () => {
    const s = setup({ env: { RATE_UID_PER_10MIN: "1" }, user: { customClaims: { role: "authenticated" } } })
    for (let i = 0; i < 5; i++) await s.call()
    expect(s.db.calls.filter((c) => c.bucket === "global")).toHaveLength(1)
  })
  it("the project-wide cap bounds Admin traffic from many different accounts", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "5" }, token: (n) => tokenFor(`Fresh${String(n).padStart(22, "0")}`), user: { customClaims: { role: "authenticated" } } })
    const out: number[] = []
    for (let i = 0; i < 8; i++) out.push((await s.call()).status)
    expect(out).toEqual([200, 200, 200, 200, 200, 429, 429, 429])
    expect(s.stats.getUser).toBe(5)
  })
  it("exhausting the project cap does not affect accounts that already have the role (no Admin work, no counter)", async () => {
    const s = setup({ env: { RATE_GLOBAL_PER_MIN: "1" }, token: (n) => tokenFor(`Existing${String(n).padStart(19, "0")}`, { role: "authenticated" }) })
    for (let i = 0; i < 6; i++) expect((await s.call()).status).toBe(200)
    expect(s.db.calls).toEqual([])
    expect(s.stats.getUser).toBe(0)
  })
})

describe("the database counter failing closes the door, safely", () => {
  it("503 with a fixed word, no Admin call, no write, a fixed log code", async () => {
    const s = setup({ db: fakeDb({ fail: true }) })
    const res = await s.call()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ success: false, error: "unavailable" })
    expect(s.stats.getUser).toBe(0)
    expect(s.stats.set).toBe(0)
    expect(s.stats.logs).toContain("rate-store-failed")
  })
  it("in IP mode a failing counter also stops the request before token verification", async () => {
    const s = setup({ db: fakeDb({ fail: true }), env: { CLIENT_IP_MODE: "xff-first" } })
    expect((await s.call({ "x-forwarded-for": "198.51.100.7" })).status).toBe(503)
    expect(s.stats.verify).toBe(0)
  })
  it("the existing-role fast path still works while the counter is down (it needs no counter)", async () => {
    const s = setup({ db: fakeDb({ fail: true }), token: () => tokenFor("Existing00000000000000000001", { role: "authenticated" }) })
    expect((await s.call()).status).toBe(200)
  })
})

describe("revocation and disabled users", () => {
  const err = (code: string) => Object.assign(new Error("Firebase says: secret detail " + BEARER), { code })
  it("a revoked token is 401 invalid-token with a fixed log code and no detail", async () => {
    const s = setup({ token: () => err("auth/id-token-revoked") })
    const res = await s.call()
    const text = await res.text()
    expect(res.status).toBe(401)
    expect(JSON.parse(text)).toEqual({ success: false, error: "invalid-token" })
    expect(text).not.toMatch(/secret detail|A{20}/)
    expect(s.stats.logs).toEqual(["token-revoked"])
  })
  it("a disabled user is 403 unauthorized", async () => {
    const s = setup({ token: () => err("auth/user-disabled") })
    expect((await s.call()).status).toBe(403)
    expect(s.stats.logs).toEqual(["user-disabled"])
  })
  it("any other verification error is a plain 401", async () => {
    for (const code of ["auth/id-token-expired", "auth/argument-error", "", "weird"]) expect((await setup({ token: () => err(code) }).call()).status, code).toBe(401)
  })
  it("a disabled user found at lookup time and a pre-revocation token are refused on the write path", async () => {
    expect((await setup({ user: { disabled: true } }).call()).status).toBe(403)
    const old = setup({ token: () => tokenFor("Alice", { iat: 1000 }), user: { tokensValidAfterTime: new Date(2_000_000).toUTCString() } })
    expect((await old.call()).status).toBe(401)
    expect(old.stats.set).toBe(0)
  })
  it("a conflicting existing role is never overwritten", async () => {
    const s = setup({ user: { customClaims: { role: "admin" } } })
    expect((await s.call()).status).toBe(403)
    expect(s.stats.set).toBe(0)
  })
  it("index.ts verifies with revocation checking", () => {
    // index.ts passes the flag through; the handler asks for the revocation check on every path that acts (first-time bootstrap) and on the established-user path
    expect(fs.readFileSync(path.join(FN_DIR, "index.ts"), "utf8")).toMatch(/verifyIdToken\(token, checkRevoked === true\)/)
    expect(fs.readFileSync(path.join(FN_DIR, "handler.ts"), "utf8").match(/verifyIdToken\(m\[1\], true\)/g)).toHaveLength(1) // inside revocationCheck(), which both paths call
    expect(fs.readFileSync(path.join(FN_DIR, "handler.ts"), "utf8").match(/await revocationCheck\(\)/g)).toHaveLength(2)
  })
})

describe("the database call in index.ts", () => {
  const src = fs.readFileSync(path.join(FN_DIR, "index.ts"), "utf8")
  it("calls only the service-role rate-limit RPC, with a timeout, and never logs or returns the key", () => {
    expect(src).toMatch(/\/rest\/v1\/rpc\/bootstrap_rate_check/)
    expect(src).toMatch(/AbortSignal\.timeout\(3000\)/)
    expect(src).toMatch(/Deno\.env\.get\("SUPABASE_SERVICE_ROLE_KEY"\)/)
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "")
    for (const line of code.split("\n").filter((l) => /console\./.test(l))) expect(line).not.toMatch(/serviceKey|Key|token|authorization/i)
    expect(code).not.toMatch(/return new Response\([^)]*serviceKey/)
  })
  it("the migration grants the RPC to service_role only", () => {
    const sql = fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20261009000200_bootstrap_rate_limit.sql"), "utf8")
    expect(sql).toMatch(/revoke all on function public\.bootstrap_rate_check\(text, text, integer, integer\) from public, anon, authenticated;/)
    expect(sql).toMatch(/grant execute on function public\.bootstrap_rate_check\(text, text, integer, integer\) to service_role;/)
    expect(sql).toMatch(/security definer set search_path = ''/)
    expect(sql).toMatch(/NOT applied to production/)
  })
})
