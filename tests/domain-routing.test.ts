/**
 * Per-domain backend routing (M3a): sync, social (profiles / invites / connections), ping and push can each be served by Firebase or
 * Supabase independently. Firebase is the default for every domain; the sync-only Supabase route is opt-in, build-time and test-process
 * only. The real-browser proof is `node scripts/run-hook-supabase.mjs` (the hook with only sync on local Supabase).
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)

import {
  BACKEND_DOMAINS,
  backendKindFor,
  getAuthBridge,
  getBackend,
  getDomainBackend,
  resolveDomainKind,
  setBackendForTests,
  setDomainBackendForTests,
  type Backend,
} from "@/lib/backend"

const ROOT = path.resolve(import.meta.dirname, "..")
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8")

const ALL_ENV = ["NEXT_PUBLIC_BACKEND", "NEXT_PUBLIC_BACKEND_SYNC", "NEXT_PUBLIC_BACKEND_SOCIAL", "NEXT_PUBLIC_BACKEND_PING", "NEXT_PUBLIC_BACKEND_PUSH"]
function clean() {
  vi.unstubAllEnvs()
  for (const k of ALL_ENV) vi.stubEnv(k, "")
}
afterEach(() => {
  vi.unstubAllEnvs()
  setBackendForTests(null)
  for (const d of BACKEND_DOMAINS) setDomainBackendForTests(d, null)
})
const kinds = () => Object.fromEntries(BACKEND_DOMAINS.map((d) => [d, getDomainBackend(d).kind]))

describe("default: Firebase for every domain", () => {
  it("nothing set -> every domain is Firebase, and they share ONE backend object (no duplicated state)", () => {
    clean()
    expect(kinds()).toEqual({ sync: "firebase", social: "firebase", ping: "firebase", push: "firebase" })
    const first = getDomainBackend("sync")
    for (const d of BACKEND_DOMAINS) expect(getDomainBackend(d)).toBe(first)
    expect(getBackend()).toBe(first)
  })
  it("Supabase variables being present change nothing", () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54399")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_not_real_0000000000")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE", "true")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_REALTIME", "true")
    expect(kinds()).toEqual({ sync: "firebase", social: "firebase", ping: "firebase", push: "firebase" })
  })
  it("empty or blank domain values follow the (default) global value", () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SYNC", "   ")
    expect(backendKindFor("sync")).toBe("firebase")
  })
})

describe("sync-only: Supabase for sync, Firebase for everything else", () => {
  it("NEXT_PUBLIC_BACKEND_SYNC=supabase routes ONLY sync", () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SYNC", "supabase")
    expect(kinds()).toEqual({ sync: "supabase", social: "firebase", ping: "firebase", push: "firebase" })
    // social, ping and push-token operations are served by the very same Firebase object as before, not by Supabase
    const fb = getDomainBackend("social")
    expect(getDomainBackend("ping")).toBe(fb)
    expect(getDomainBackend("push")).toBe(fb)
    expect(getDomainBackend("sync")).not.toBe(fb)
    expect(getBackend().kind).toBe("firebase") // the global default is untouched
  })
  it("each domain is independently selectable", () => {
    for (const d of BACKEND_DOMAINS) {
      clean()
      vi.stubEnv(`NEXT_PUBLIC_BACKEND_${d.toUpperCase()}`, "supabase")
      const expected = Object.fromEntries(BACKEND_DOMAINS.map((x) => [x, x === d ? "supabase" : "firebase"]))
      expect(kinds(), d).toEqual(expected)
    }
  })
  it("a domain value beats the global one in both directions", () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase")
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SOCIAL", "firebase")
    expect(kinds()).toEqual({ sync: "supabase", social: "firebase", ping: "supabase", push: "supabase" })
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SYNC", "firebase")
    expect(kinds().sync).toBe("firebase")
  })
  it("the Supabase backend is built once and only when some domain uses it; flag changes make a new one, never mutate the old", () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SYNC", "supabase")
    const a = getDomainBackend("sync")
    expect(getDomainBackend("sync")).toBe(a)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_REALTIME", "true")
    const b = getDomainBackend("sync")
    expect(b).not.toBe(a)
    expect(b.kind).toBe("supabase")
    expect(getDomainBackend("social").kind).toBe("firebase")
    expect(getDomainBackend("social")).toBe(getDomainBackend("ping"))
  })
})

describe("unconfigured, disabled or invalid: the established safe failure, never a silent switch", () => {
  it("sync on Supabase without the configuration / bridge refuses every sync call (no fallback to Firebase), other domains unaffected", async () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SYNC", "supabase")
    await expect(getDomainBackend("sync").sync.get("owner")).rejects.toMatchObject({ code: "supabase-not-configured" })
    await expect(getDomainBackend("sync").sync.put("owner", "x", null)).rejects.toMatchObject({ code: "supabase-not-configured" })
    expect(getDomainBackend("social").kind).toBe("firebase")
    expect(getDomainBackend("ping").kind).toBe("firebase")
  })
  it("with the configuration but the bridge flag off it still refuses", async () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SYNC", "supabase")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54399")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_not_real_0000000000")
    await expect(getDomainBackend("sync").sync.get("owner")).rejects.toMatchObject({ code: "supabase-not-configured" })
  })
  it("an unknown value throws for THAT domain only", () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_PING", "mongodb")
    expect(() => getDomainBackend("ping")).toThrow(/Unknown backend/)
    expect(getDomainBackend("sync").kind).toBe("firebase")
    expect(getDomainBackend("social").kind).toBe("firebase")
  })
  it("resolveDomainKind: domain wins, blank inherits, junk throws", () => {
    expect(resolveDomainKind({})).toBe("firebase")
    expect(resolveDomainKind({ global: "supabase" })).toBe("supabase")
    expect(resolveDomainKind({ global: "supabase", domain: "firebase" })).toBe("firebase")
    expect(resolveDomainKind({ global: "firebase", domain: " Supabase " })).toBe("supabase")
    expect(resolveDomainKind({ global: "supabase", domain: "  " })).toBe("supabase")
    expect(() => resolveDomainKind({ domain: "x" })).toThrow()
  })
})

describe("account switching and sign-out do not move state between domains", () => {
  it("resetting the auth bridge (sign-out / account switch) changes no routing and no backend object", () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_BACKEND_SYNC", "supabase")
    const before = Object.fromEntries(BACKEND_DOMAINS.map((d) => [d, getDomainBackend(d)]))
    getAuthBridge().reset()
    getAuthBridge().reset()
    for (const d of BACKEND_DOMAINS) expect(getDomainBackend(d), d).toBe(before[d])
    expect(kinds()).toEqual({ sync: "supabase", social: "firebase", ping: "firebase", push: "firebase" })
  })
})

describe("the application calls its OWN domain, and only that one (stub backends record every call)", () => {
  function stub(kind: "firebase" | "supabase") {
    const calls: string[] = []
    const rec = (name: string) => async () => (calls.push(name), null)
    const be = {
      kind,
      sync: { get: rec("sync.get"), put: async () => (calls.push("sync.put"), { ok: true as const, rev: 1 }), watch: () => (calls.push("sync.watch"), () => {}) },
      profiles: { save: rec("profiles.save"), getName: rec("profiles.getName") },
      invites: { create: rec("invites.create"), read: rec("invites.read"), remove: rec("invites.remove") },
      connections: { watch: () => () => {}, list: rec("connections.list"), send: rec("connections.send"), respond: rec("connections.respond"), remove: rec("connections.remove") },
      pings: { watch: () => () => {}, create: rec("pings.create"), answer: rec("pings.answer"), lease: rec("pings.lease"), finalize: rec("pings.finalize"), remove: rec("pings.remove") },
      pushTokens: { save: rec("push.save"), remove: rec("push.remove") },
    } as unknown as Backend
    return { be, calls }
  }

  it("cloud-sync goes through the 'sync' domain: with sync on a Supabase stub and the rest on a Firebase stub, only the Supabase stub is called", async () => {
    clean()
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "k")
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "demo-x")
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "1:0:web:0")
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID", "0")
    const sb = stub("supabase")
    const fb = stub("firebase")
    setDomainBackendForTests("sync", sb.be)
    for (const d of ["social", "ping", "push"] as const) setDomainBackendForTests(d, fb.be)
    const cloud = await import("@/lib/cloud-sync")
    expect(cloud.cloudKind()).toBe("firebase") // "a configured backend"; which one is the domain's business
    await cloud.cloudGet("owner")
    await cloud.cloudPut("owner", "{}", null)
    const stop = cloud.watchCloud("owner", () => {}, () => {})
    stop()
    expect(sb.calls.length).toBeGreaterThanOrEqual(3)
    expect(sb.calls.every((c) => c.startsWith("sync."))).toBe(true)
    expect(fb.calls).toEqual([])
  })

  it("setDomainBackendForTests touches only its domain; setBackendForTests(null) and per-domain removal restore the configured routing", () => {
    clean()
    const s = stub("supabase")
    setDomainBackendForTests("ping", s.be)
    expect(getDomainBackend("ping")).toBe(s.be)
    expect(getDomainBackend("sync")).not.toBe(s.be)
    setDomainBackendForTests("ping", null)
    expect(getDomainBackend("ping").kind).toBe("firebase")
  })
})

describe("source rules: no code outside lib/backend picks a backend by itself", () => {
  const walk = (d: string): string[] =>
    fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
  const app = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => !f.startsWith("lib/backend/"))

  it("application code never calls the global getBackend(); it names its domain", () => {
    for (const f of app) {
      const code = read(f).split(/\r?\n/).filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n")
      expect(code, f).not.toMatch(/\bgetBackend\s*\(/)
    }
  })
  it("sync -> 'sync'; profiles / invites / connections -> 'social'; pings -> 'ping'; push tokens -> 'push' (and nothing else)", () => {
    expect(read("lib/cloud-sync.ts")).not.toMatch(/getDomainBackend\("(social|ping|push)"\)/)
    expect((read("lib/cloud-sync.ts").match(/getDomainBackend\("sync"\)\.sync/g) ?? []).length).toBe(3)
    const social = read("lib/use-social.ts")
    expect(social).not.toMatch(/getDomainBackend\("sync"\)/)
    for (const [domain, store] of [["push", "pushTokens"], ["ping", "pings"], ["social", "profiles"], ["social", "connections"], ["social", "invites"]] as const) {
      const uses = [...social.matchAll(new RegExp(`getDomainBackend\\("(\\w+)"\\)\\.${store}\\b`, "g"))].map((m) => m[1])
      expect(uses.length, store).toBeGreaterThan(0)
      expect(new Set(uses), store).toEqual(new Set([domain]))
    }
  })
  it("no production setting names a domain value: only the test runner's child process sets NEXT_PUBLIC_BACKEND_SYNC", () => {
    for (const f of ["next.config.ts", "next.config.mjs", "next.config.js", "vercel.json", ".env", ".env.production"].filter((x) => fs.existsSync(path.join(ROOT, x)))) {
      expect(read(f), f).not.toMatch(/NEXT_PUBLIC_BACKEND/)
    }
    const runner = read("scripts/e2e-hook-supabase.mjs")
    expect(runner).toMatch(/NEXT_PUBLIC_BACKEND_SYNC: "supabase"/)
    expect(runner).not.toMatch(/NEXT_PUBLIC_BACKEND: "supabase"/)
  })
})

