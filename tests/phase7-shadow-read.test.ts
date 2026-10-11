/**
 * Phase 7 preparation: the read-only shadow reader, its report, and its independent OFF-by-default flag. Fakes only: no network,
 * no Firebase, no Supabase. The real Firebase emulator + local Supabase integration is tests/shadow-integration/.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)

import { parseShadowReadFlag, shadowFlags, shadowReadEnabled } from "@/lib/backend/flags"
import { createShadowReader, formatShadowReadReport, readSurface, verdict, type ReadSurface, type ShadowReadReport, type ShadowReadResult } from "@/lib/backend/shadow-read"
import { getBackend, getShadowReader, setBackendForTests } from "@/lib/backend"
import { BackendError } from "@/lib/backend/errors"
import type { StoredSync } from "@/lib/backend/contracts"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setBackendForTests(null)
})
const ROOT = path.resolve(import.meta.dirname, "..")
const UID = "AliceFbUid0000000000000000a1"
const BLOB = "gz1:SECRET-BACKUP-CONTENT-DO-NOT-LEAK"
const NAME = "Alicia Personal-Name"
const sync = (rev: number, data = BLOB): StoredSync => ({ data, rev, updatedAt: 1790000000000 })

type Behaviour<T> = T | null | Error | ((n: number) => T | null | Error)
function surface(sy: Behaviour<StoredSync>, name: Behaviour<string>) {
  const seen = { sync: [] as string[], name: [] as string[], syncCalls: 0, nameCalls: 0 }
  const resolve = <T>(b: Behaviour<T>, n: number): T | null => {
    const v = typeof b === "function" ? (b as (n: number) => T | null | Error)(n) : b
    if (v instanceof Error) throw v
    return v
  }
  const s: ReadSurface = {
    sync: { get: async (o) => (seen.sync.push(o), resolve(sy, seen.syncCalls++)) },
    profiles: { getName: async (u) => (seen.name.push(u), resolve(name, seen.nameCalls++)) },
  }
  return { s, seen }
}
const reader = (fb: ReadSurface, sb: ReadSurface, over: { uid?: () => string | null; sleep?: (ms: number) => Promise<void> } = {}) =>
  createShadowReader({ authoritative: fb, shadow: sb, currentUid: over.uid ?? (() => UID), sleep: over.sleep ?? (async () => {}), recheckDelayMs: 1, now: () => 1 })
const done = (r: ShadowReadResult): ShadowReadReport => {
  if (r.status !== "done") throw new Error("expected a report, got " + r.status)
  return r.report
}
const be = (kind: BackendError["kind"], code?: string) => new BackendError(kind, "server said: secret detail", { code })

describe("the flag: independent and OFF by default", () => {
  it("only an explicit true (any case, spaces ignored) turns it on", () => {
    for (const v of [undefined, "", "false", "0", "1", "yes", "on", "tru", "truee", "TRUE-ish", " "]) expect(parseShadowReadFlag(v), String(v)).toBe(false)
    for (const v of ["true", "TRUE", " True "]) expect(parseShadowReadFlag(v)).toBe(true)
    expect(shadowReadEnabled()).toBe(false)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_READ", "tru")
    expect(shadowReadEnabled()).toBe(false)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_READ", "true")
    expect(shadowReadEnabled()).toBe(true)
  })
  it("is independent of the write flags: it does not switch them on and they do not switch it on", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_READ", "true")
    expect(shadowFlags()).toEqual({ sync: false, social: false, push: false })
    vi.unstubAllEnvs()
    for (const k of ["SYNC", "SOCIAL", "PUSH"]) vi.stubEnv(`NEXT_PUBLIC_SUPABASE_SHADOW_${k}`, "true")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE", "true")
    expect(shadowReadEnabled()).toBe(false)
  })
  it("is read in one place only, and no env file or example sets it", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const files = ["app", "components", "hooks", "lib"].flatMap(walk)
    expect(files.filter((f) => /process\.env\.NEXT_PUBLIC_SUPABASE_SHADOW_READ/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))).toEqual(["lib/backend/flags.ts"])
    for (const f of [".env.local", ".env.local.example"]) {
      const p = path.join(ROOT, f)
      if (fs.existsSync(p)) expect(fs.readFileSync(p, "utf8"), f).not.toMatch(/SHADOW_READ|SUPABASE|NEXT_PUBLIC_BACKEND/)
    }
  })
  it("getShadowReader is null unless EVERY condition holds", () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    expect(getShadowReader()).toBeNull() // default
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_READ", "true")
    expect(getShadowReader()).toBeNull() // bridge off
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE", "true")
    expect(getShadowReader()).toBeNull() // no Supabase configuration
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://proj.example.test") // unsafe (http, not loopback): no transport
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_testkey_0123456789")
    expect(getShadowReader()).toBeNull()
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://proj.supabase.test")
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase")
    expect(getShadowReader()).toBeNull() // the shadow reader exists only while Firebase is the backend
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "bogus")
    expect(getShadowReader()).toBeNull() // an invalid backend value fails closed
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "firebase")
    expect(getShadowReader()).not.toBeNull() // constructing it still touches nothing
    expect(net).not.toHaveBeenCalled()
  })
  it("with the read flag on the application still runs on the unwrapped Firebase backend", () => {
    const before = getBackend()
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_SHADOW_READ", "true")
    expect(getBackend().kind).toBe("firebase")
    expect(getBackend()).toBe(before)
  })
  it("no application file imports the reader or calls getShadowReader", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const users = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => !f.startsWith("lib/backend/") && /shadow-read|getShadowReader/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    expect(users).toEqual([])
  })
})

describe("comparison outcomes", () => {
  it("identical sync and name: match / match / clean", async () => {
    const fb = surface(sync(3), NAME)
    const sb = surface(sync(3), NAME)
    const r = done(await reader(fb.s, sb.s).run())
    expect(r.sync).toEqual({ status: "match" })
    expect(r.profile).toEqual({ status: "match" })
    expect(verdict(r)).toBe("clean")
    expect(r.rechecked).toBe(false)
    expect(r.authoritative).toBe("firebase")
    expect(r.readOnly).toBe(true)
  })
  it("nothing on either side is a match (a new account)", async () => {
    const r = done(await reader(surface(null, null).s, surface(null, null).s).run())
    expect(r.sync.status).toBe("match")
    expect(r.profile.status).toBe("match")
  })
  it("missing in Supabase / missing in Firebase", async () => {
    let r = done(await reader(surface(sync(1), NAME).s, surface(null, null).s).run())
    expect(r.sync).toMatchObject({ status: "mismatch", mismatches: [{ kind: "missing-in-supabase", entity: "sync", confirmed: true }] })
    expect(r.profile).toMatchObject({ status: "mismatch", mismatches: [{ kind: "missing-in-supabase", entity: "profile" }] })
    r = done(await reader(surface(null, null).s, surface(sync(1), NAME).s).run())
    expect(r.sync).toMatchObject({ mismatches: [{ kind: "missing-in-firebase" }] })
    expect(r.profile).toMatchObject({ mismatches: [{ kind: "missing-in-firebase" }] })
    expect(verdict(r)).toBe("differs")
  })
  it("revision mismatch is classified behind or ahead, and is checked before the payload", async () => {
    const behind = done(await reader(surface(sync(5, "x"), NAME).s, surface(sync(4, "y"), NAME).s).run())
    expect(behind.sync).toMatchObject({ mismatches: [{ kind: "revision-mismatch", lag: "supabase-behind" }] })
    const ahead = done(await reader(surface(sync(4), NAME).s, surface(sync(5), NAME).s).run())
    expect(ahead.sync).toMatchObject({ mismatches: [{ kind: "revision-mismatch", lag: "supabase-ahead" }] })
  })
  it("same revision, different stored text is a value mismatch with lengths only", async () => {
    const r = done(await reader(surface(sync(2, "aaaa"), NAME).s, surface(sync(2, "bbbbbb"), NAME).s).run())
    expect(r.sync).toMatchObject({ mismatches: [{ kind: "value-mismatch", detail: expect.stringContaining("4 vs 6 chars") }] })
  })
  it("different profile names are a value mismatch that does not contain either name", async () => {
    const r = done(await reader(surface(sync(1), "Alicia One").s, surface(sync(1), "Alicia Two").s).run())
    expect(r.profile).toMatchObject({ mismatches: [{ kind: "value-mismatch", entity: "profile" }] })
    expect(JSON.stringify(r)).not.toMatch(/Alicia One|Alicia Two/)
  })
  it("a difference is read a second time: a transient one disappears, a lasting one is confirmed", async () => {
    const sleep = vi.fn(async () => {})
    // the shadow is behind on the first pass and caught up on the second (an asynchronous mirror write landed)
    const transient = done(await reader(surface(sync(2), NAME).s, surface((n) => (n === 0 ? sync(1) : sync(2)), NAME).s, { sleep }).run())
    expect(transient.sync).toEqual({ status: "match" })
    expect(transient.rechecked).toBe(true)
    expect(sleep).toHaveBeenCalledTimes(1)
    const lasting = done(await reader(surface(sync(2), NAME).s, surface(sync(1), NAME).s, { sleep }).run())
    expect(lasting.sync).toMatchObject({ mismatches: [{ confirmed: true }] })
    // a clean first pass is not re-read
    sleep.mockClear()
    await reader(surface(sync(1), NAME).s, surface(sync(1), NAME).s, { sleep }).run()
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe("failures are distinct from `missing`", () => {
  it("Supabase transport errors: unavailable, unauthorized, invalid, unknown, malformed; never reported as missing", async () => {
    const cases: [Error, string][] = [
      [be("unavailable"), "unavailable"],
      [be("unauthorized", "42501"), "unauthorized"],
      [be("invalid"), "invalid"],
      [be("unknown"), "unknown"],
      [be("unknown", "supabase-malformed"), "malformed"],
      [new TypeError("boom"), "unknown"],
    ]
    for (const [err, reason] of cases) {
      // the sync read fails (profile read succeeds), so only the sync domain carries the error
      const r = done(await reader(surface(sync(1), NAME).s, surface(err, NAME).s).run())
      expect(r.sync, reason).toEqual({ status: "shadow-error", reason })
      expect(r.profile).toEqual({ status: "match" })
      expect(verdict(r)).toBe("inconclusive")
    }
  })
  it("Firebase read errors are their own outcome and conclude nothing about the shadow", async () => {
    const r = done(await reader(surface(be("unavailable"), be("unavailable")).s, surface(sync(1), NAME).s).run())
    expect(r.sync).toEqual({ status: "firebase-error", reason: "unavailable" })
    expect(r.profile).toEqual({ status: "firebase-error", reason: "unavailable" })
    expect(verdict(r)).toBe("inconclusive")
  })
  it("malformed rows from the shadow (wrong types, negative or fractional revision, bad timestamp) are `malformed`, not compared", async () => {
    const bad = [{ data: 5, rev: 1, updatedAt: 1 }, { data: "x", rev: -1, updatedAt: 1 }, { data: "x", rev: 1.5, updatedAt: 1 }, { data: "x", rev: 1, updatedAt: Number.NaN }, { data: "x", rev: "1", updatedAt: 1 }, { data: null, rev: 1, updatedAt: 1 }]
    for (const row of bad) {
      const r = done(await reader(surface(sync(1), NAME).s, surface(row as unknown as StoredSync, NAME).s).run())
      expect(r.sync, JSON.stringify(row)).toEqual({ status: "shadow-error", reason: "malformed" })
    }
  })
  it("a refused or unreachable shadow is found by the profile probe: the sync table is NOT read (a refused read looks empty)", async () => {
    for (const reason of ["unauthorized", "unavailable"] as const) {
      const sb = surface(sync(1), be(reason))
      const r = done(await reader(surface(sync(1), NAME).s, sb.s).run())
      expect(r.profile).toEqual({ status: "shadow-error", reason })
      expect(r.sync).toEqual({ status: "shadow-error", reason })
      expect(sb.seen.sync, reason).toEqual([]) // never asked
      expect(verdict(r)).toBe("inconclusive")
    }
  })
  it("other profile-probe failures do not stop the sync comparison", async () => {
    const r = done(await reader(surface(sync(1), NAME).s, surface(sync(1), be("unknown")).s).run())
    expect(r.profile).toEqual({ status: "shadow-error", reason: "unknown" })
    expect(r.sync).toEqual({ status: "match" })
  })
})

describe("one user, read-only, no data in the report", () => {
  it("nobody signed in: skipped, and nothing is read from either side", async () => {
    const fb = surface(sync(1), NAME)
    const sb = surface(sync(1), NAME)
    const r = await reader(fb.s, sb.s, { uid: () => null }).run()
    expect(r).toEqual({ status: "skipped", reason: "no-user" })
    expect(fb.seen.syncCalls + fb.seen.nameCalls + sb.seen.syncCalls + sb.seen.nameCalls).toBe(0)
    expect(formatShadowReadReport(r)).toMatch(/skipped/)
  })
  it("only the current user's own uid is ever read, on both sides, in every pass", async () => {
    const fb = surface(sync(2), NAME)
    const sb = surface(sync(1), NAME)
    await reader(fb.s, sb.s).run() // differs, so two passes
    for (const seen of [fb.seen, sb.seen]) {
      expect(seen.sync.length).toBeGreaterThan(0)
      expect([...seen.sync, ...seen.name].every((u) => u === UID)).toBe(true)
    }
  })
  it("the account changing mid-read discards everything (before or during the re-read)", async () => {
    let uid: string | null = UID
    const first = await createShadowReader({
      authoritative: surface(sync(1), NAME).s,
      shadow: { sync: { get: async () => ((uid = "SomeoneElse0000000000000000x9"), sync(1)) }, profiles: { getName: async () => NAME } },
      currentUid: () => uid,
      sleep: async () => {},
    }).run()
    expect(first).toEqual({ status: "skipped", reason: "identity-changed" })
    uid = UID
    const second = await createShadowReader({
      authoritative: surface(sync(2), NAME).s,
      shadow: surface(sync(1), NAME).s,
      currentUid: () => uid,
      sleep: async () => void (uid = null), // signs out while waiting to re-read
    }).run()
    expect(second).toEqual({ status: "skipped", reason: "identity-changed" })
  })
  it("readSurface exposes only get / getName and holds no write method", async () => {
    const trap = new Proxy({}, { get: (_t, p) => { throw new Error(`touched ${String(p)}`) } })
    const calls: string[] = []
    const backend = {
      sync: new Proxy({ get: async () => (calls.push("sync.get"), null) }, { get: (t, p) => (p === "get" ? t.get : () => { throw new Error(`sync.${String(p)} must not be reachable`) }) }),
      profiles: new Proxy({ getName: async () => (calls.push("profiles.getName"), null) }, { get: (t, p) => (p === "getName" ? t.getName : () => { throw new Error(`profiles.${String(p)} must not be reachable`) }) }),
    }
    const s = readSurface(backend as never)
    expect(Object.keys(s)).toEqual(["sync", "profiles"])
    expect(Object.keys(s.sync)).toEqual(["get"])
    expect(Object.keys(s.profiles)).toEqual(["getName"])
    const r = done(await reader(s, readSurface(backend as never)).run())
    expect(r.sync.status).toBe("match")
    expect(new Set(calls)).toEqual(new Set(["sync.get", "profiles.getName"]))
    void trap
  })
  it("the report and its text never contain the sync blob, a name, a token or the full uid", async () => {
    const cases = [
      done(await reader(surface(sync(2), NAME).s, surface(sync(1, BLOB + "-different"), "Other Name Entirely").s).run()),
      done(await reader(surface(sync(1), NAME).s, surface(be("unauthorized", "42501"), be("unauthorized")).s).run()),
      done(await reader(surface(sync(1), NAME).s, surface(sync(1), NAME).s).run()),
    ]
    for (const r of cases) {
      const text = JSON.stringify(r) + formatShadowReadReport({ status: "done", report: r })
      expect(text).not.toContain(BLOB)
      expect(text).not.toContain(NAME)
      expect(text).not.toContain("Other Name Entirely")
      expect(text).not.toContain("secret detail")
      expect(text).not.toContain(UID)
      expect(text).toContain("Alic***")
    }
  })
  it("the reader writes no logs", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => {}))
    await reader(surface(sync(2), NAME).s, surface(be("unavailable"), be("unknown")).s).run()
    spies.forEach((s) => expect(s).not.toHaveBeenCalled())
  })
  it("the source has no write calls, no logging and no network of its own", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib", "backend", "shadow-read.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(src).not.toMatch(/\.(put|save|remove|create|send|respond|answer|lease|finalize)\s*\(|\brpc\b|setDoc|updateDoc|deleteDoc|runTransaction|console\.|fetch\(|localStorage|indexedDB/)
  })
})

describe("report text", () => {
  it("the exact text of a typical report (this is the example in PHASE7_SUPABASE_TRANSPORT.md)", async () => {
    const text = formatShadowReadReport(await reader(surface(sync(3), NAME).s, surface(sync(1), NAME).s).run())
    expect(text).toBe(
      [
        "Shadow read, read-only. Reference: Firebase (authoritative). Account: Alic***. Re-read before reporting: yes.",
        "  sync:    revision-mismatch (supabase-behind) [confirmed]: firebase rev 3, supabase rev 1",
        "  profile: match",
        "  verdict: differs",
      ].join("\n"),
    )
  })
  it("states the reference, the account (shortened), whether it re-read, and a verdict", async () => {
    const text = formatShadowReadReport(await reader(surface(sync(2), NAME).s, surface(sync(1), NAME).s).run())
    expect(text).toMatch(/Reference: Firebase \(authoritative\)/)
    expect(text).toMatch(/Re-read before reporting: yes/)
    expect(text).toMatch(/revision-mismatch \(supabase-behind\) \[confirmed\]/)
    expect(text).toMatch(/verdict: differs/)
    const inconclusive = formatShadowReadReport(await reader(surface(sync(1), NAME).s, surface(be("unavailable"), be("unavailable")).s).run())
    expect(inconclusive).toMatch(/SUPABASE READ FAILED \(unavailable\): not the same as missing/)
    expect(inconclusive).toMatch(/verdict: inconclusive/)
  })
})
