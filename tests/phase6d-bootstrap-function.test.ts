/**
 * Phase 6D: the PROPOSED production bootstrap function (supabase/functions/auth-role-bootstrap/handler.ts).
 * Everything is faked: no Firebase, no Supabase, no network, no credentials. Nothing here deploys or activates anything.
 */
import { describe, expect, it, vi, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"

import {
  createHandler,
  createRateLimiter,
  parseConfig,
  type UserRecordLike,
  type VerifiedToken,
} from "../supabase/functions/auth-role-bootstrap/handler"
import { BOOTSTRAP_PATH, mapBootstrapStatus } from "@/lib/backend/supabase-auth"

afterEach(() => vi.unstubAllEnvs())

const ROOT = path.resolve(import.meta.dirname, "..")
const FN_DIR = path.join(ROOT, "supabase", "functions", "auth-role-bootstrap")
const PROJECT = "demo-project-123"
const ORIGIN = "https://app.example.test"
const UID = "AliceFbUid0000000000000000a1"
const BEARER = "A".repeat(40) + ".bbbbbbbbbbbbbbbbbbbb.cccccccccccccccccccc"

const good = (over: Partial<VerifiedToken> = {}): VerifiedToken => ({
  uid: UID,
  sub: UID,
  iss: `https://securetoken.google.com/${PROJECT}`,
  aud: PROJECT,
  iat: Math.floor(Date.now() / 1000),
  ...over,
})

function setup(opts: { token?: VerifiedToken | "throw"; user?: Partial<UserRecordLike>; config?: Record<string, string>; ipMax?: number; uidMax?: number; setFails?: string } = {}) {
  const parsed = parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT, ...(opts.config ?? {}) })
  const calls = { verify: 0, revoked: 0, getUser: 0, set: [] as [string, Record<string, unknown>][], logs: [] as string[] }
  const user: UserRecordLike = { disabled: false, customClaims: null, ...(opts.user ?? {}) }
  const handler = createHandler(parsed, {
    ipLimiter: createRateLimiter({ windowMs: 60_000, max: opts.ipMax ?? 1000 }),
    uidLimiter: createRateLimiter({ windowMs: 60_000, max: opts.uidMax ?? 1000 }),
    fastLimiter: createRateLimiter({ windowMs: 60_000, max: 100000 }), // established users: covered in phase6e-limiter-fix.test.ts
    revocationLimiter: createRateLimiter({ windowMs: 60_000, max: 100000, maxKeys: 1 }),
    dbLimiter: { take: async () => true }, // the database counters have their own tests (phase6e-rate-limit.test.ts)
    log: (c) => calls.logs.push(c),
    async verifyIdToken(_t: string, revoked: boolean) {
      calls.verify++
      if (revoked) calls.revoked++
      if (opts.token === "throw") throw Object.assign(new Error("Firebase ID token has expired. Raw token: " + BEARER), { code: "auth/id-token-expired" })
      return opts.token ?? good()
    },
    async getUser() {
      calls.getUser++
      return user
    },
    async setCustomClaims(uid, claims) {
      if (opts.setFails) throw Object.assign(new Error("PRIVATE KEY -----BEGIN"), { code: opts.setFails })
      calls.set.push([uid, claims])
      user.customClaims = claims
    },
  })
  const call = (init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    handler(new Request("https://x.supabase.co/functions/v1/auth-role-bootstrap", { method: init.method ?? "POST", headers: { authorization: `Bearer ${BEARER}`, ...(init.headers ?? {}) }, body: init.body }))
  return { call, calls, user, handler }
}

describe("configuration fails closed", () => {
  it("requires exact https origins and a project id", () => {
    expect(parseConfig({}).ok).toBe(false)
    expect(parseConfig({ ALLOWED_ORIGINS: ORIGIN }).ok).toBe(false)
    expect(parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: PROJECT }).ok).toBe(true)
    for (const bad of ["*", "http://app.example.test", "https://app.example.test/", "https://app.example.test/path", "https://*.example.test", "https://localhost", "app.example.test", "https://app.example.test, *", "null"]) {
      expect(parseConfig({ ALLOWED_ORIGINS: bad, FIREBASE_PROJECT_ID: PROJECT }).ok, bad).toBe(false)
    }
    expect(parseConfig({ ALLOWED_ORIGINS: ORIGIN, FIREBASE_PROJECT_ID: "NOT A PROJECT" }).ok).toBe(false)
  })
  it("a missing configuration answers 503 to everything and does no work", async () => {
    const { call, calls } = setup({ config: { ALLOWED_ORIGINS: "" } })
    for (const init of [{}, { headers: { origin: ORIGIN } }, { method: "OPTIONS", headers: { origin: ORIGIN } }]) {
      const res = await call(init)
      expect(res.status).toBe(503)
      expect(await res.json()).toEqual({ success: false, error: "unavailable" })
    }
    expect(calls.verify).toBe(0)
    expect(calls.logs).toContain("config-invalid")
  })
})

describe("CORS: strict allow-list", () => {
  it("answers the preflight only for an allow-listed origin, with exact headers and never *", async () => {
    const { call } = setup()
    const ok = await call({ method: "OPTIONS", headers: { origin: ORIGIN } })
    expect(ok.status).toBe(204)
    expect(ok.headers.get("access-control-allow-origin")).toBe(ORIGIN)
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS")
    expect(ok.headers.get("access-control-allow-origin")).not.toBe("*")
    for (const o of ["https://evil.example.test", "http://app.example.test", "https://app.example.test.evil.test", "null", "https://APP.example.test"]) {
      const bad = await call({ method: "OPTIONS", headers: { origin: o } })
      expect(bad.status, o).toBe(403)
      expect(bad.headers.get("access-control-allow-origin"), o).toBeNull()
    }
    expect((await call({ method: "OPTIONS" })).status).toBe(403) // a preflight without an origin is not a CORS request
  })
  it("refuses a POST from a foreign origin before verifying anything", async () => {
    const { call, calls } = setup()
    const res = await call({ headers: { origin: "https://evil.example.test" } })
    expect(res.status).toBe(403)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
    expect(calls.verify).toBe(0)
  })
  it("echoes only the matched allow-listed origin and varies on Origin", async () => {
    const { call } = setup({ config: { ALLOWED_ORIGINS: `${ORIGIN}, https://second.example.test` } })
    const res = await call({ headers: { origin: "https://second.example.test" } })
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBe("https://second.example.test")
    expect(res.headers.get("vary")).toMatch(/origin/i)
  })
  it("a server-side call with no Origin header still needs a valid token, and gets no CORS header", async () => {
    const { call } = setup()
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })
})

describe("request shape", () => {
  it("accepts POST only", async () => {
    const { call } = setup()
    for (const m of ["GET", "PUT", "DELETE", "PATCH"]) expect((await call({ method: m })).status, m).toBe(405)
  })
  it("requires a well-formed bearer token and does no work without one", async () => {
    const { call, calls } = setup()
    for (const h of ["", "Basic abc", "Bearer ", "Bearer short", "Bearer a b", `bearer ${BEARER}`, `Bearer ${BEARER} extra`]) {
      const res = await call({ headers: { authorization: h } })
      expect(res.status, h).toBe(401)
      expect((await res.json()).error).toBe("missing-or-malformed-bearer")
    }
    expect(calls.verify).toBe(0)
  })
  it("never reads the request body, so a client-supplied uid/role/claims have no effect", async () => {
    const { call, calls } = setup()
    const req = new Request("https://x/y", { method: "POST", headers: { authorization: `Bearer ${BEARER}`, "content-type": "application/json" }, body: JSON.stringify({ uid: "Victim", role: "admin", claims: { admin: true } }) })
    const handler = setup().handler
    const res = await handler(req)
    expect(res.status).toBe(200)
    expect(req.bodyUsed).toBe(false)
    await call({ body: JSON.stringify({ uid: "Victim", role: "service_role" }) })
    expect(calls.set).toEqual([[UID, { role: "authenticated" }]])
  })
})

describe("token verification", () => {
  it("a token the SDK rejects is 401 invalid-token, with no library message, no token and no private-key text in the response or logs", async () => {
    const { call, calls } = setup({ token: "throw" })
    const res = await call()
    const text = await res.text()
    expect(res.status).toBe(401)
    expect(JSON.parse(text)).toEqual({ success: false, error: "invalid-token" })
    expect(text).not.toContain(BEARER)
    expect(text).not.toMatch(/expired|PRIVATE|BEGIN|Firebase ID token/i)
    expect(calls.logs.join(" ")).not.toContain(BEARER)
    expect(calls.getUser).toBe(0)
    expect(calls.set).toEqual([])
  })
  it("refuses a token for another Firebase project (issuer or audience), a non-matching sub/uid, and a missing sub", async () => {
    const bad: Partial<VerifiedToken>[] = [
      { iss: "https://securetoken.google.com/other-project" },
      { aud: "other-project" },
      { iss: "https://accounts.google.com" },
      { iss: `https://securetoken.google.com/${PROJECT.toUpperCase()}` },
      { sub: "" },
      { sub: "x".repeat(129), uid: "x".repeat(129) },
      { uid: "SomeoneElse" },
    ]
    for (const o of bad) {
      const { call, calls } = setup({ token: good(o) })
      const res = await call()
      expect(res.status, JSON.stringify(o)).toBe(401)
      expect(calls.getUser).toBe(0)
      expect(calls.set).toEqual([])
    }
  })
})

describe("claim bootstrap", () => {
  it("writes exactly role=authenticated for the verified uid, and the response carries no identity", async () => {
    const { call, calls } = setup()
    const res = await call({ headers: { origin: ORIGIN } })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ success: true })
    expect(text).not.toContain(UID)
    expect(calls.set).toEqual([[UID, { role: "authenticated" }]])
  })
  it("merges existing unrelated claims and never invents others", async () => {
    const { call, calls } = setup({ user: { customClaims: { beta: true } } })
    await call()
    expect(calls.set).toEqual([[UID, { beta: true, role: "authenticated" }]])
  })
  it("is idempotent: a second request writes nothing", async () => {
    const { call, calls } = setup()
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    expect((await call()).status).toBe(200)
    expect(calls.set).toHaveLength(1)
  })
  it("a token that already carries the role needs no Admin call at all", async () => {
    const { call, calls } = setup({ token: good({ role: "authenticated" }) })
    expect((await call()).status).toBe(200)
    expect(calls.getUser).toBe(0)
    expect(calls.set).toEqual([])
  })
  it("a claim set by another device is detected and not rewritten", async () => {
    const { call, calls } = setup({ user: { customClaims: { role: "authenticated" } } })
    expect((await call()).status).toBe(200)
    expect(calls.set).toEqual([])
  })
  it("a different pre-existing role is never overwritten", async () => {
    for (const role of ["admin", "service_role", "anon", "x"]) {
      const { call, calls } = setup({ user: { customClaims: { role } } })
      const res = await call()
      expect(res.status, role).toBe(403)
      expect((await res.json()).error).toBe("unauthorized")
      expect(calls.set).toEqual([])
    }
  })
  it("refuses a disabled user, and a token issued before the account's revocation time", async () => {
    const a = setup({ user: { disabled: true } })
    expect((await a.call()).status).toBe(403)
    expect(a.calls.set).toEqual([])
    const b = setup({ token: good({ iat: 1_000_000 }), user: { tokensValidAfterTime: new Date(2_000_000 * 1000).toUTCString() } })
    expect((await b.call()).status).toBe(401)
    expect(b.calls.set).toEqual([])
    const c = setup({ token: good({ iat: 3_000_000 }), user: { tokensValidAfterTime: new Date(2_000_000 * 1000).toUTCString() } })
    expect((await c.call()).status).toBe(200)
  })
  it("Admin API failures give a fixed word: transient -> 503, otherwise 500; never the library text", async () => {
    for (const [code, status] of [["auth/quota-exceeded", 503], ["auth/internal-error", 503], ["auth/user-not-found", 500], ["some-unexpected-failure", 500]] as const) {
      const { call, calls } = setup({ setFails: code })
      const res = await call()
      const text = await res.text()
      expect(res.status, code).toBe(status)
      expect(text).not.toMatch(/PRIVATE|BEGIN/)
      expect(calls.logs.join(" ")).not.toMatch(/PRIVATE|BEGIN/)
    }
  })
})

describe("rate limiting (best effort, per instance)", () => {
  it("limits per client before any verification work", async () => {
    const { call, calls } = setup({ ipMax: 3, config: { CLIENT_IP_MODE: "xff-first" } }) // per-address buckets exist only when the owner enables an IP mode
    const statuses = []
    for (let i = 0; i < 5; i++) statuses.push((await call({ headers: { "x-forwarded-for": "203.0.113.9" } })).status)
    expect(statuses).toEqual([200, 200, 200, 429, 429])
    expect(calls.verify - calls.revoked).toBe(3) // local verifications: the per-address cap stops the rest before any verification
    expect((await call({ headers: { "x-forwarded-for": "203.0.113.10" } })).status).toBe(200) // another client is unaffected
  })
  it("limits Admin lookups per account, with Retry-After", async () => {
    const { call, calls } = setup({ uidMax: 2, user: { customClaims: { role: "someone" } } })
    const res: number[] = []
    for (let i = 0; i < 4; i++) res.push((await call()).status)
    expect(res).toEqual([403, 403, 429, 429])
    expect(calls.getUser).toBe(2)
    expect((await call()).headers.get("retry-after")).toBe("60")
  })
  it("the limiter resets after its window and is memory-bounded", () => {
    let t = 0
    const l = createRateLimiter({ windowMs: 1000, max: 1, maxKeys: 2 }, () => t)
    expect(l.take("a")).toBe(true)
    expect(l.take("a")).toBe(false)
    t = 1000
    expect(l.take("a")).toBe(true)
    expect(l.take("b")).toBe(true)
    expect(l.take("c")).toBe(false) // full of live keys: refuse rather than grow
  })
})

describe("response hygiene", () => {
  it("every response is no-store, non-sniffable JSON with a fixed error word", async () => {
    const cases = [setup(), setup({ token: "throw" }), setup({ user: { disabled: true } }), setup({ config: { ALLOWED_ORIGINS: "" } })]
    for (const s of cases) {
      const res = await s.call({ headers: { origin: ORIGIN } })
      expect(res.headers.get("cache-control")).toBe("no-store")
      expect(res.headers.get("content-type")).toBe("application/json")
      const body = await res.json()
      expect(Object.keys(body).sort()).toEqual(body.success ? ["success"] : ["error", "success"])
    }
  })
})

describe("the shipped source", () => {
  const handlerSrc = fs.readFileSync(path.join(FN_DIR, "handler.ts"), "utf8")
  const indexSrc = fs.readFileSync(path.join(FN_DIR, "index.ts"), "utf8")
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")

  it("the handler never reads the body or a client-supplied claim", () => {
    expect(code(handlerSrc)).not.toMatch(/\.(json|text|formData|arrayBuffer|blob)\s*\(|\.body\b|searchParams|new URL\(/)
  })
  it("the only claim the code writes is the constant role", () => {
    expect(code(handlerSrc)).toMatch(/setCustomClaims\(uid, \{ \.\.\.existing, role: REQUIRED_ROLE \}\)/)
    expect(code(indexSrc)).not.toMatch(/req\.|request\./)
  })
  it("the handler never logs or returns a token, uid, key or library message", () => {
    const h = code(handlerSrc)
    expect(h).not.toMatch(/console\./)
    for (const m of h.matchAll(/deps\.log\((.*)\)\s*$/gm)) {
      // each call passes a fixed string literal, or the sanitised Admin error code (never a message, token or uid)
      expect(m[1].startsWith('"') || m[1].startsWith("code.startsWith") || m[1].startsWith('code === "auth/id-token-revoked" ?'), m[1]).toBe(true)
      expect(m[1]).not.toMatch(/\.message|\bm\[1\]|\btoken\.|\buid\b/)
    }
  })
  it("the service account is read from an environment secret only, in index.ts only, and there is no key material in the repo", () => {
    expect(code(indexSrc)).toContain('Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")')
    expect(handlerSrc).not.toMatch(/FIREBASE_SERVICE_ACCOUNT|private_key|BEGIN (RSA )?PRIVATE KEY/)
    const files = [path.join(FN_DIR, "handler.ts"), path.join(FN_DIR, "index.ts"), path.join(ROOT, "PHASE6D_PRODUCTION_BRIDGE_READINESS.md")]
    for (const f of files) if (fs.existsSync(f)) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:|"private_key_id"\s*:\s*"[0-9a-f]{8}|eyJ[A-Za-z0-9_-]{20,}\.eyJ/)
  })
  it("index.ts logs only a fixed code and wires every dependency", () => {
    expect(code(indexSrc)).toMatch(/log: \(code\) => console\.error\("auth-role-bootstrap", code\)/)
    expect(code(indexSrc)).toMatch(/verifyIdToken\(token, checkRevoked\)/)
  })
  it("deployment copy (Phase 6E): the function is in supabase/functions with exactly one config entry, verify_jwt off, and no secret in config or beside it", () => {
    // Phase 6D asserted the opposite ("not deployable by accident"). The owner completed the pre-deployment checks and the
    // function was moved into place in the Phase 6E deployment commit. Committing it deploys nothing.
    expect(fs.readdirSync(path.join(ROOT, "supabase", "functions"))).toEqual(["auth-role-bootstrap"])
    expect(fs.readdirSync(FN_DIR).sort()).toEqual(["handler.ts", "index.ts"]) // no .env, key file or extra source
    const cfg = fs.readFileSync(path.join(ROOT, "supabase", "config.toml"), "utf8")
    expect([...cfg.matchAll(/^\s*\[functions\.([^\]]+)\]/gm)].map((m) => m[1])).toEqual(["auth-role-bootstrap"])
    expect(cfg).toMatch(/\[functions\.auth-role-bootstrap\]\s*\n(?:[^\[]*\n)?verify_jwt = false/)
    expect(cfg).not.toMatch(/FIREBASE_SERVICE_ACCOUNT|private_key|ALLOWED_ORIGINS/)
    expect(fs.existsSync(path.join(ROOT, "supabase", "proposed"))).toBe(false) // one copy only, no drift
  })
  it("the issuer/audience guard is a LOCAL migration (promoted in the hardening step) and the remote list is the owner's to change", () => {
    // Phase 6D readiness kept it in supabase/proposed/; the hardening step promoted it. Applying it to production stays an explicit owner action.
    expect(fs.existsSync(path.join(ROOT, "supabase", "migrations", "20261009000100_firebase_issuer_audience_guard.sql"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "supabase", "proposed", "20261009000100_firebase_issuer_audience_guard.sql"))).toBe(false)
    expect(fs.readFileSync(path.join(ROOT, "supabase", "migrations", "20261009000100_firebase_issuer_audience_guard.sql"), "utf8")).toMatch(/NOT been applied to the production project/)
  })
})

describe("client contract still matches", () => {
  it("the client calls the path this function is deployed under, and reads only the status", () => {
    expect(BOOTSTRAP_PATH).toBe("/functions/v1/auth-role-bootstrap")
    expect(path.basename(FN_DIR)).toBe(BOOTSTRAP_PATH.split("/").pop())
  })
  it("every status this function returns maps to a defined client outcome", () => {
    const expected: Record<number, string> = { 200: "ok", 401: "invalid-token", 403: "unauthorized", 429: "rate-limited", 503: "unavailable", 500: "server-error", 405: "server-error" }
    for (const [status, want] of Object.entries(expected)) {
      const o = mapBootstrapStatus(Number(status))
      expect(o.ok ? "ok" : o.error, status).toBe(want)
    }
  })
})

describe("production stays inactive", () => {
  it("no Supabase, backend or bridge variable is set in .env.local or .env.local.example", () => {
    for (const f of [".env.local", ".env.local.example"]) {
      const p = path.join(ROOT, f)
      if (fs.existsSync(p)) expect(fs.readFileSync(p, "utf8"), f).not.toMatch(/SUPABASE|NEXT_PUBLIC_BACKEND|AUTH_BRIDGE|ALLOWED_ORIGINS/)
    }
  })
  it("the flags default to off and the default backend is Firebase", async () => {
    const { authBridgeEnabled, shadowFlags } = await import("@/lib/backend/flags")
    const { resolveBackendKind } = await import("@/lib/backend")
    expect(authBridgeEnabled()).toBe(false)
    expect(shadowFlags()).toEqual({ sync: false, social: false, push: false })
    expect(resolveBackendKind(process.env.NEXT_PUBLIC_BACKEND)).toBe("firebase")
  })
  it("no application source imports the proposed function or references the new env names", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        if (["node_modules", ".next", "supabase", "tests", ".git", "migration-output", "public"].includes(e.name)) return []
        const p = path.join(d, e.name)
        return e.isDirectory() ? walk(p) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [p] : []
      })
    // The ONE deliberate exception: the local-only test gateway runs the real handler against the Firebase Auth EMULATOR (scripts/local-supabase-gateway.mjs;
    // it refuses to start unless everything is loopback, and tests/hook-integration-guards.test.ts pins that). No app, hook or library file may.
    const exception = path.join(ROOT, "scripts", "local-supabase-gateway.mjs")
    const importers = walk(ROOT).filter((f) => /auth-role-bootstrap\/handler/.test(fs.readFileSync(f, "utf8")))
    expect(importers.map((f) => path.relative(ROOT, f).split(path.sep).join("/"))).toEqual(["scripts/local-supabase-gateway.mjs"])
    for (const f of walk(ROOT).filter((f) => f !== exception)) expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/auth-role-bootstrap\/handler|proposed\/functions|ALLOWED_ORIGINS/)
  })
})
