/**
 * Phase 6A: the shadow-writer interface (a no-op) and the reconciliation model. Nothing is connected to production data,
 * nothing is written anywhere, and the comparison is read-only.
 */
import { describe, expect, it, vi } from "vitest"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { getShadowWriter, isolateShadowFailures, noopShadowWriter, type ShadowWriter } from "@/lib/backend/shadow"
import { buildReport, checkOwner, compareRelation, compareSync, diffCollections } from "@/lib/backend/reconcile"
import type { StoredSync } from "@/lib/backend/contracts"

const ROOT = path.resolve(import.meta.dirname, "..")
const walk = (d: string): string[] =>
  fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
const text = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8")

describe("the shadow writer defaults to a no-op, and is connected to nothing", () => {
  it("getShadowWriter() is the inactive no-op, and every operation resolves without doing anything", async () => {
    const w = getShadowWriter()
    expect(w).toBe(noopShadowWriter)
    expect(w.active).toBe(false)
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    await expect(w.syncBlob({ owner: "o", data: "blob", rev: 1, updatedAt: null })).resolves.toBeUndefined()
    await expect(w.profile({ uid: "u", name: "n" })).resolves.toBeUndefined()
    await expect(w.connection({ op: "remove", id: "r" })).resolves.toBeUndefined()
    await expect(w.ping({ op: "finalize", id: "p" })).resolves.toBeUndefined()
    await expect(w.pushToken({ op: "remove", uid: "u" })).resolves.toBeUndefined()
    expect(net).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
  it("no application file uses the shadow writer or the reconciliation model: only lib/backend wires them (Phase 6B), behind flags", () => {
    // Phase 6B: lib/backend/index.ts builds the real writer and wraps the Firebase backend, only when the shadow flags are on.
    const users = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => !f.startsWith("lib/backend/")).filter((f) => /backend\/(shadow|reconcile)/.test(text(f)))
    expect(users).toEqual([])
  })
  it("the shadow and reconcile modules import no backend library and no transport: they cannot reach anything", () => {
    for (const f of ["lib/backend/shadow.ts", "lib/backend/reconcile.ts"]) {
      const src = text(f).replace(/\/\*[\s\S]*?\*\//g, "")
      expect(src, f).not.toMatch(/from\s+["'](?:firebase|@supabase|\.\/supabase|\.\/firebase|\.\.\/firebase)/)
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/)
    }
  })
  it("a failing or rejecting writer never reaches the caller when isolated", async () => {
    const boom: ShadowWriter = {
      active: true,
      syncBlob: async () => Promise.reject(new Error("supabase down")),
      profile: () => {
        throw new Error("sync throw")
      },
      connection: async () => {},
      ping: async () => Promise.reject(new Error("x")),
      pushToken: async () => {},
      invite: async () => {},
    }
    const errors: string[] = []
    const w = isolateShadowFailures(boom, (op) => errors.push(op))
    await expect(w.syncBlob({ owner: "o", data: "d", rev: 1, updatedAt: null })).resolves.toBeUndefined()
    await expect(w.profile({ uid: "u", name: "n" })).resolves.toBeUndefined()
    await expect(w.ping({ op: "remove", id: "p" })).resolves.toBeUndefined()
    expect(errors).toEqual(["syncBlob", "profile", "ping"])
    const loud = isolateShadowFailures(boom, () => {
      throw new Error("reporter broke")
    })
    await expect(loud.syncBlob({ owner: "o", data: "d", rev: 1, updatedAt: null })).resolves.toBeUndefined()
  })
  it("the opaque sync blob is handed over unchanged, byte for byte", async () => {
    const seen: string[] = []
    const w: ShadowWriter = { ...noopShadowWriter, active: true, syncBlob: async (x) => void seen.push(x.data) }
    const blob = 'H4sIAAAAAAAA/ +/= \u0000é "packed" {not json'
    await isolateShadowFailures(w).syncBlob({ owner: "o", data: blob, rev: 4, updatedAt: 1 })
    expect(seen).toEqual([blob])
    expect(crypto.createHash("sha256").update(seen[0]).digest("hex")).toBe(crypto.createHash("sha256").update(blob).digest("hex"))
  })
  it("the shadow interface never parses or normalizes the blob and has no attendance model", () => {
    const src = text("lib/backend/shadow.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(src).not.toMatch(/JSON\.parse|atob|decompress|inflate|pako|unpack|attendance/i)
  })
})

describe("reconciliation: the mismatch model", () => {
  const S = (rev: number, data = "blob"): StoredSync => ({ data, rev, updatedAt: 1 })

  it("sync: equal, missing on either side, revision and value mismatches", () => {
    expect(compareSync("u", S(3), S(3))).toEqual([])
    expect(compareSync("u", null, null)).toEqual([])
    expect(compareSync("u", S(3), null).map((m) => m.kind)).toEqual(["missing-in-supabase"])
    expect(compareSync("u", null, S(3)).map((m) => m.kind)).toEqual(["missing-in-firebase"])
    expect(compareSync("u", S(4), S(3)).map((m) => m.kind)).toEqual(["revision-mismatch"])
    expect(compareSync("u", S(3, "a"), S(3, "b")).map((m) => m.kind)).toEqual(["value-mismatch"])
  })
  it("the report never contains the sync blob (it is the user's whole backup)", () => {
    const secret = "SECRET-BACKUP-CONTENT"
    const m = compareSync("u", S(3, secret + "1"), S(3, secret + "2"))
    expect(JSON.stringify(m)).not.toContain(secret)
  })
  it("collections: missing both ways, value mismatch, revision mismatch, unexpected record", () => {
    const f = new Map([["a", { v: 1, rev: 1 }], ["b", { v: 2, rev: 5 }], ["c", { v: 3, rev: 1 }], ["d", { v: 4, rev: 1 }]])
    const s = new Map([["a", { v: 1, rev: 1 }], ["b", { v: 2, rev: 4 }], ["c", { v: 9, rev: 1 }], ["x", { v: 7, rev: 1 }], ["weird", { v: 0, rev: 1 }]])
    const out = diffCollections({ entity: "profile", firebase: f, supabase: s, revisionOf: (r) => r.rev, isExpectedKey: (k) => k !== "weird" })
    const by = Object.fromEntries(out.map((m) => [m.key, m.kind]))
    expect(by).toEqual({ b: "revision-mismatch", c: "value-mismatch", d: "missing-in-supabase", x: "missing-in-firebase", weird: "unexpected-record" })
  })
  it("ownership: the same account on both sides, or an auth-mismatch", () => {
    expect(checkOwner("sync", "k", "uidA", "uidA")).toEqual([])
    expect(checkOwner("sync", "k", "uidA", "uidB").map((m) => m.kind)).toEqual(["auth-mismatch"])
  })
  it("relations: same people in any order, same request and status; otherwise relation-mismatch", () => {
    const base = { participants: ["a", "b"], requestId: "r1", status: "accepted" }
    expect(compareRelation("connection", "k", base, { ...base, participants: ["b", "a"] })).toEqual([])
    expect(compareRelation("ping", "k", base, { ...base, participants: ["a", "c"] }).map((m) => m.kind)).toEqual(["relation-mismatch"])
    expect(compareRelation("ping", "k", base, { ...base, requestId: "r2" }).map((m) => m.kind)).toEqual(["relation-mismatch"])
    expect(compareRelation("connection", "k", base, { ...base, status: "declined" }).map((m) => m.kind)).toEqual(["relation-mismatch"])
  })
  it("all seven mismatch kinds exist, and Firebase is always the authority", () => {
    const kinds = ["missing-in-supabase", "missing-in-firebase", "value-mismatch", "revision-mismatch", "auth-mismatch", "relation-mismatch", "unexpected-record"]
    const src = text("lib/backend/reconcile.ts")
    for (const k of kinds) expect(src).toContain(`"${k}"`)
    expect(buildReport([]).authoritative).toBe("firebase")
    expect(buildReport(compareSync("u", S(1), null))).toEqual({ authoritative: "firebase", mismatches: [expect.objectContaining({ kind: "missing-in-supabase" })] })
  })
  it("the model cannot overwrite Firebase: pure functions over plain values, with no store, writer or handle in any signature", () => {
    const src = text("lib/backend/reconcile.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")
    expect(src).not.toMatch(/\b(?:put|set|save|create|delete|remove|write|update|finalize|lease)\s*\(/)
    expect(src).not.toMatch(/\w*(?:Backend|Store|Writer)|Firestore|transport/)
  })
})

describe("the Firebase adapter is untouched by Phase 6A", () => {
  it("lib/backend/firebase/index.ts is byte-for-byte the Phase 4A file", () => {
    const hash = crypto.createHash("sha256").update(text("lib/backend/firebase/index.ts").replace(/\r\n/g, "\n")).digest("hex")
    const recorded = JSON.parse(text("tests/migration-protected.json")) as Record<string, string>
    expect(hash).toBe(recorded["lib/backend/firebase/index.ts"])
  })
})
