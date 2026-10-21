/**
 * Safety fixes on top of the sign-in reconciliation (lib/signin-reconcile.ts):
 *  1. no choice runs while demo data is on screen or sync is paused;
 *  2. after a write whose result is unknown, the stored copy is read before merging, so counters are not added twice;
 *  3. restore points are written one at a time and read back, and a failure is reported instead of claimed as success.
 * Same approach as tests/signin-reconcile.test.ts: real merge, restore-point and reconcile code on a stubbed storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { buildBackup, type FullBackupData } from "@/lib/backup"
import { mergeData, same } from "@/lib/merge"
import { listRestorePoints, RestorePointError, saveRestorePoint } from "@/lib/restore-points"
import { applyChoice, decideIngest, emptyData, planFirstSignIn, type ApplyDeps, type Offer } from "@/lib/signin-reconcile"
import type { Mate, Subject } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")

function stubStorage(failWrites = false) {
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error("storage full")
      m.set(k, v)
    },
    removeItem: (k: string) => void m.delete(k),
  })
}
beforeEach(() => stubStorage())
afterEach(() => vi.unstubAllGlobals())

const sub = (id: string, name: string, marks: [string, "P" | "A"][] = []): Subject => {
  const log = marks.map(([d, s]) => ({ d, s }))
  return { id, name, attended: log.filter((e) => e.s === "P").length, missed: log.filter((e) => e.s === "A").length, requirement: 75, glowColor: "#000", tags: [], log }
}
const data = (subjects: Subject[] = [], extra: Partial<FullBackupData> = {}): FullBackupData => ({ ...emptyData(), subjects, ...extra })
const mate = (covered: number): Mate => ({ id: "m1", name: "Arjun", covered, repaid: 0 })

const DEVICE = data([sub("d1", "DBMS", [["2026-10-01", "P"]]), sub("d2", "Anatomy", [["2026-10-01", "A"]])])
const ACCOUNT = data([sub("a1", "DBMS", [["2026-10-03", "P"]]), sub("a2", "Pharmacology", [["2026-10-02", "P"]])])

function setup(over: Partial<ApplyDeps> = {}) {
  let device = DEVICE
  const store = { rev: 1, text: buildBackup(ACCOUNT, false) }
  const log = { puts: 0, applied: 0 }
  const deps: ApplyDeps = {
    getDevice: () => device,
    applyDevice: (d) => {
      log.applied++
      device = d
    },
    verifyDevice: async (d) => same(device, d),
    saveRestorePoint,
    listRestorePoints,
    cloudGet: async () => ({ data: store.text, rev: store.rev, updatedAt: 1 }),
    cloudPut: async (_o, text, expected) => {
      if (expected !== store.rev) return { ok: false, reason: "conflict" }
      log.puts++
      store.rev++
      store.text = text
      return { ok: true, rev: store.rev }
    },
    ...over,
  }
  const plan = planFirstSignIn({ device, cloud: { kind: "doc", doc: { data: store.text, rev: store.rev, updatedAt: 1 } }, accountId: "acct", dataOwner: null })
  if (plan.kind !== "choose") throw new Error("expected a choice")
  const offer: Offer = plan.offer
  return { deps, offer, log, device: () => device, store }
}

describe("1. no choice while demo data is on screen or sync is paused", () => {
  it.each(["merge", "device", "cloud"] as const)("%s: refused before anything is read, saved, applied or sent", async (choice) => {
    const s = setup({ blocked: () => true })
    const res = await applyChoice(choice, s.offer, "acct", true, s.deps)
    expect(res).toMatchObject({ ok: false, reason: "paused" })
    expect(s.log).toEqual({ puts: 0, applied: 0 })
    expect(same(s.device(), DEVICE)).toBe(true)
    expect(await listRestorePoints()).toEqual([])
    expect(s.store.rev).toBe(1)
  })

  it.each(["merge", "device", "cloud"] as const)("%s: pausing while it runs stops it before this device's data is read or replaced", async (choice) => {
    let checks = 0
    const s = setup({ blocked: () => ++checks > 1 }) // fine at the start, paused by the time the data is read
    const res = await applyChoice(choice, s.offer, "acct", true, s.deps)
    expect(res).toMatchObject({ ok: false, reason: "paused" })
    expect(s.log).toEqual({ puts: 0, applied: 0 })
    expect(same(s.device(), DEVICE)).toBe(true)
  })

  it("when not blocked the same choice still works", async () => {
    const s = setup({ blocked: () => false })
    expect((await applyChoice("merge", s.offer, "acct", false, s.deps)).ok).toBe(true)
  })

  it("the hook refuses and clears the prompt while paused, and passes the pause into every choice", () => {
    const src = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(src).toMatch(/paused: \(\) => pausedRef\.current/) // handed to runChoice, which checks it before and during every choice
    expect(src).toMatch(/if \(paused\) \{\s*prompts\.clear\(\)/)
    expect(src).toMatch(/reconcile: paused \? null : prompt/) // hidden at once, not a render later
  })
})

describe("2. a write whose result is unknown is settled by reading the stored copy first", () => {
  // base = last agreed copy; the device logged 2 favours and sent them; the answer was lost; the store has them.
  const base = data([], { mates: [mate(0)] })
  const local = data([], { mates: [mate(2)] })
  const stored = local

  it("merging that stored copy over the old base WOULD count the favours twice (the problem)", () => {
    expect(mergeData(base, local, stored).data.mates[0].covered).toBe(4)
  })

  it("the stored copy equal to what was sent is recognised as having landed, so it is adopted, not merged", () => {
    const text = buildBackup(local, false)
    const d = decideIngest({ stored: { rev: 4, text }, localRev: 3, base: { rev: 3 }, markers: [{ id: "w1", sentText: text, expectedRev: 3, at: 0 }], source: "pull" })
    expect(d.kind).toBe("landed")
  })

  it("a stored copy that differs is 'unknown', and merging without the old base never adds twice", () => {
    const theirs = data([sub("x", "Physics")], { mates: [mate(2)] })
    const sentText = buildBackup(local, false)
    const d = decideIngest({ stored: { rev: 5, text: buildBackup(theirs, false) }, localRev: 3, base: { rev: 3 }, markers: [{ id: "w1", sentText, expectedRev: 3, at: 0 }], source: "pull" })
    expect(d).toMatchObject({ kind: "merge", useBase: false, why: "ambiguous-write" })
    expect(mergeData(null, local, theirs).data.mates[0].covered).toBe(2)
  })

  it("when the write did not land and another device changed things, neither side's work is lost", () => {
    const theirs = data([sub("x", "Physics", [["2026-10-05", "P"]])], { mates: [mate(0)] })
    const { data: merged } = mergeData(null, local, theirs)
    expect(merged.subjects.map((s) => s.name)).toEqual(["Physics"])
    expect(merged.mates[0].covered).toBe(2)
  })

  it("the hook sends every copy through putTracked (marker written first) and reads every stored copy through the one ingestor (behaviour: tests/uncertain-writes.test.ts)", () => {
    const src = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(src).toMatch(/putTracked\(ledger, boundedPut, owner,/)
    expect(src).toMatch(/ing\.ingest\(doc, source, canProceed\)/)
    expect(src).not.toMatch(/settleUncertainWrite|setUncertain|uncertainRef/) // the earlier, weaker bookkeeping is gone
  })
})

describe("3. restore points are written one at a time and read back", () => {
  it("many overlapping saves all survive (none is lost to a read-then-rewrite race)", async () => {
    const copies = Array.from({ length: 12 }, (_, i) => data([sub(`s${i}`, `Subject ${i}`)]))
    await Promise.all(copies.map((c, i) => saveRestorePoint(`point ${i}`, c)))
    const all = await listRestorePoints()
    expect(all).toHaveLength(12)
    expect(new Set(all.map((p) => p.reason)).size).toBe(12)
  })

  it("a failed save does not block the ones queued after it", async () => {
    stubStorage(true)
    await expect(saveRestorePoint("a", data([sub("s1", "A")]))).rejects.toBeInstanceOf(RestorePointError)
    stubStorage(false)
    await saveRestorePoint("b", data([sub("s2", "B")]))
    expect((await listRestorePoints()).map((p) => p.reason)).toEqual(["b"])
  })

  it("when storage refuses the write, saving reports the failure instead of succeeding quietly", async () => {
    stubStorage(true)
    await expect(saveRestorePoint("x", data([sub("s1", "A")]))).rejects.toBeInstanceOf(RestorePointError)
    expect(await listRestorePoints()).toEqual([])
  })

  it("empty data and an exact repeat of the newest point are still skipped without error", async () => {
    await saveRestorePoint("empty", data([]))
    await saveRestorePoint("a", data([sub("s1", "A")]))
    await saveRestorePoint("a again", data([sub("s1", "A")]))
    expect(await listRestorePoints()).toHaveLength(1)
  })

  it.each(["merge", "device", "cloud"] as const)("%s: if the safety copy cannot be saved, nothing is changed and the reason is restore-point-failed", async (choice) => {
    const s = setup()
    stubStorage(true) // storage starts refusing after the comparison was made
    const res = await applyChoice(choice, s.offer, "acct", true, s.deps)
    expect(res).toMatchObject({ ok: false, reason: "restore-point-failed" })
    expect(s.log).toEqual({ puts: 0, applied: 0 })
    expect(same(s.device(), DEVICE)).toBe(true)
    expect(s.store.rev).toBe(1)
  })

  it("the reset and restore handlers in the app go through the safety-copy-first module and show its message (behaviour: tests/safe-replace.test.ts)", () => {
    const src = fs.readFileSync(path.join(ROOT, "app/page.tsx"), "utf8")
    expect(src).toContain("resetEverything(")
    expect(src).toContain("restoreFrom(")
    expect(src).toContain("showToast(r.message)")
    const lib = fs.readFileSync(path.join(ROOT, "lib/safe-replace.ts"), "utf8")
    expect(lib).toContain("so nothing was reset")
    expect(lib).toContain("so your data was not replaced")
  })
})
