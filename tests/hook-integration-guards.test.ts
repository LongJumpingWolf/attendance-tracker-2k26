/**
 * The safety rails around the test-only hook integration (scripts/e2e-hook-supabase.mjs, scripts/local-supabase-gateway.mjs,
 * lib/firebase.ts emulator wiring): none of it can switch on by accident, reach production, or point at a hosted service.
 * The behaviour itself is proven end to end by `node scripts/run-hook-supabase.mjs` (needs the emulators and the local stack).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8")

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function emulatorsOn(env: Record<string, string>, nodeEnv = "test") {
  vi.resetModules()
  vi.unstubAllEnvs()
  vi.stubEnv("NODE_ENV", nodeEnv)
  for (const k of ["NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST", "NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST"]) vi.stubEnv(k, env[k] ?? "")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "k")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "demo-hook")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "1:0:web:0")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", "0")
  const m = await import("@/lib/firebase")
  return m.usingFirebaseEmulators
}

describe("the Firebase emulator wiring (lib/firebase.ts)", () => {
  const both = { NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" }

  it("is off by default (nothing set)", async () => {
    expect(await emulatorsOn({})).toBe(false)
  })
  it("turns on only when BOTH hosts are set, loopback, in a non-production build", async () => {
    expect(await emulatorsOn(both)).toBe(true)
    expect(await emulatorsOn({ NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099", NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "localhost:8080" })).toBe(true)
  })
  it("never half-connects: one host alone does nothing", async () => {
    expect(await emulatorsOn({ NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" })).toBe(false)
    expect(await emulatorsOn({ NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" })).toBe(false)
  })
  it("ignores any host that is not loopback or not host:port", async () => {
    for (const bad of ["example.com:9099", "10.0.0.5:9099", "127.0.0.1", "127.0.0.1:9099/evil", "http://127.0.0.1:9099", "127.0.0.1.evil.com:9099", "evil.com#127.0.0.1:9099"]) {
      expect(await emulatorsOn({ ...both, NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: bad }), bad).toBe(false)
      expect(await emulatorsOn({ ...both, NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: bad }), bad).toBe(false)
    }
  })
  it("a PRODUCTION build ignores it completely, whatever the variables say", async () => {
    expect(await emulatorsOn(both, "production")).toBe(false)
  })
  it("it also turns push messaging off (no push service in the emulator setup), and the connection code is behind the same flag", () => {
    const src = read("lib/firebase.ts")
    expect(src).toMatch(/if \(usingFirebaseEmulators\) return null/)
    expect(src).toMatch(/if \(usingFirebaseEmulators && typeof window !== 'undefined'\)/)
    expect(src).toMatch(/process\.env\.NODE_ENV !== 'production' && LOOPBACK_HOSTPORT\.test\(authEmulatorHost\) && LOOPBACK_HOSTPORT\.test\(firestoreEmulatorHost\)/)
  })
})

describe("the local gateway refuses to start unless everything is loopback", () => {
  const run = (env: Record<string, string>) =>
    spawnSync("node", ["scripts/local-supabase-gateway.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env } as unknown as NodeJS.ProcessEnv })
  const good = { FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099", LOCAL_SUPABASE_API_URL: "http://127.0.0.1:54321", LOCAL_SUPABASE_JWT_SECRET: "x".repeat(32) }

  it("no Auth emulator host", () => {
    const r = run({ ...good, FIREBASE_AUTH_EMULATOR_HOST: "" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/refusing to start/)
  })
  it("an Auth emulator host that is not loopback (i.e. the real service)", () => {
    const r = run({ ...good, FIREBASE_AUTH_EMULATOR_HOST: "identitytoolkit.googleapis.com:443" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/loopback/)
  })
  it("a hosted Supabase API", () => {
    const r = run({ ...good, LOCAL_SUPABASE_API_URL: "https://ajfyyknqdqaptuuzbwnv.supabase.co" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/not loopback/)
  })
  it("an allowed origin that is not loopback", () => {
    const r = run({ ...good, ALLOWED_ORIGIN: "https://attendance-tracker-2k26.vercel.app" })
    expect(r.status).not.toBe(0)
    expect(r.stderr).toMatch(/loopback origins/)
  })
  it("the end-to-end script refuses to run without the local stack's coordinates, or with a non-loopback emulator or API", () => {
    const run2 = (env: Record<string, string>) => spawnSync("node", ["scripts/e2e-hook-supabase.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 15_000, env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", ...env } as unknown as NodeJS.ProcessEnv })
    expect(run2({}).stderr).toMatch(/run-hook-supabase/)
    expect(run2({ FIREBASE_AUTH_EMULATOR_HOST: "example.com:9099", LOCAL_SUPABASE_API_URL: "http://127.0.0.1:54321", LOCAL_SUPABASE_JWT_SECRET: "x", LOCAL_SUPABASE_PUBLISHABLE_KEY: "k" }).stderr).toMatch(/not loopback/)
    expect(run2({ LOCAL_SUPABASE_API_URL: "https://x.supabase.co", LOCAL_SUPABASE_JWT_SECRET: "x", LOCAL_SUPABASE_PUBLISHABLE_KEY: "k" }).stderr).toMatch(/not loopback/)
  })
})

describe("how the gateway decides (source rules; the behaviour is proven by the end-to-end run)", () => {
  const gw = read("scripts/local-supabase-gateway.mjs")
  it("listens on loopback only, and its test controls refuse any browser request", () => {
    expect(gw).toMatch(/server\.listen\(PORT, "127\.0\.0\.1"/)
    expect(gw).toMatch(/\/__test\/[\s\S]{0,200}origin\)\s*return void res\.writeHead\(403\)/)
  })
  it("mints a token only after the Auth emulator has confirmed the incoming one AND it carries the bootstrapped role", () => {
    const ex = gw.slice(gw.indexOf("async function exchange"), gw.indexOf("// ---- the HTTP side"))
    expect(ex.indexOf("verifyWithEmulator(token)")).toBeGreaterThan(-1)
    expect(ex.indexOf("verifyWithEmulator(token)")).toBeLessThan(ex.indexOf("mint("))
    expect(ex).toMatch(/c\.role !== "authenticated"/)
    expect(ex).toMatch(/c\.aud !== PROJECT|c\.iss !== `https:\/\/securetoken\.google\.com\/\$\{PROJECT\}`/)
  })
  it("an unverifiable token is refused (401) or its socket dropped; nothing is forwarded", () => {
    expect(gw).toMatch(/restRefused\+\+[\s\S]{0,200}writeHead\(401/)
    expect(gw).toMatch(/if \(!swapped\) return void end\(\)/)
  })
  it("uses the real bootstrap handler, not a copy, and holds no fixed token or key", () => {
    expect(gw).toMatch(/auth-role-bootstrap\/handler\.ts/)
    expect(gw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret|sb_publishable_[A-Za-z0-9]{10,}/)
  })
  it("only the local database guard's public project id is used as the issuer of minted tokens", () => {
    expect(gw).toMatch(/const DB_PROJECT = "attendance-tracker-2k26"/)
  })
})

describe("the browser run proves domain isolation (it cannot silently fall back to a global switch)", () => {
  const runner = read("scripts/e2e-hook-supabase.mjs")
  it("routes ONLY the sync domain, never the global value or another domain", () => {
    expect(runner).toMatch(/NEXT_PUBLIC_BACKEND_SYNC: "supabase"/)
    expect(runner).not.toMatch(/NEXT_PUBLIC_BACKEND:/)
    expect(runner).not.toMatch(/NEXT_PUBLIC_BACKEND_(SOCIAL|PING|PUSH):/)
  })
  it("performs a real social action and checks it reached Firebase and not the gateway", () => {
    expect(runner).toMatch(/placeholder="Your name"/)
    expect(runner).toMatch(/the name is stored in Firebase/)
    expect(runner).toMatch(/the gateway saw no request for it/)
    expect(runner).toMatch(/t !== "syncs" && t !== "rpc:sync_put"/)
  })
})

describe("nothing in the app enables any of this", () => {
  it("no tracked app source sets the emulator hosts or the Supabase flags; they exist only in the test runner's child process", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx|json|mjs|js)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const files = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => f !== "lib/firebase.ts")
    const code = (f: string) => read(f).split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join(" ") // comments may name a variable
    for (const f of files) expect(code(f), f).not.toMatch(/NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST\s*=|NEXT_PUBLIC_SUPABASE_REALTIME\s*=\s*['"]?true/)
    const setters = ["next.config.ts", "next.config.mjs", "next.config.js", ".env", ".env.local", ".env.production", "vercel.json"].filter((f) => fs.existsSync(path.join(ROOT, f)))
    for (const f of setters) expect(read(f), f).not.toMatch(/AUTH_EMULATOR_HOST|SUPABASE_REALTIME|FIRESTORE_EMULATOR_HOST/)
  })
  it("lib/cloud-sync.ts reaches the Supabase backend only through the sync domain, selected by NEXT_PUBLIC_BACKEND_SYNC (or the global value)", () => {
    expect(read("lib/cloud-sync.ts")).toMatch(/getDomainBackend\("sync"\)\.sync/)
    expect(read("lib/backend/index.ts")).toMatch(/if \(!v \|\| v === "firebase"\) return "firebase"/)
  })
})
