/**
 * Signing in with Google on a device that already has data: the decisions, the comparison and every option, with the safeguards.
 * Real code under test: lib/signin-reconcile.ts, lib/merge.ts (the one merge engine) and lib/restore-points.ts (the one backup
 * mechanism, on a stubbed storage). Faked: the account's stored copy (compare-and-set like the real one) and the device.
 * No network, no Firebase, no browser. Scenario numbers follow the task list.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { buildBackup, type FullBackupData } from "@/lib/backup"
import { mergeData, same } from "@/lib/merge"
import { listRestorePoints, saveRestorePoint } from "@/lib/restore-points"
import {
  applyChoice,
  compareData,
  countsOf,
  emptyData,
  hasUserData,
  planFirstSignIn,
  PromptController,
  restorable,
  runChoice,
  type ApplyDeps,
  type Choice,
  type ChoiceEnv,
  type CloudRead,
  type Offer,
  type Plan,
} from "@/lib/signin-reconcile"
import type { Mate, Subject, Task } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")

function stubStorage() {
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  return m
}
beforeEach(() => void stubStorage())
afterEach(() => vi.unstubAllGlobals())

// ---- fixtures ----------------------------------------------------------------------------------------------------------
const sub = (id: string, name: string, marks: [string, "P" | "A"][] = [], over: Partial<Subject> = {}): Subject => {
  const log = marks.map(([d, s]) => ({ d, s }))
  return { id, name, attended: log.filter((e) => e.s === "P").length, missed: log.filter((e) => e.s === "A").length, requirement: 75, glowColor: "#000", tags: [], log, ...over }
}
const data = (subjects: Subject[] = [], extra: Partial<FullBackupData> = {}): FullBackupData => ({ ...emptyData(), subjects, ...extra })
const task = (id: string, title: string): Task => ({ id, title, dueDate: "2026-11-01" })
const mate = (id: string, name: string, over: Partial<Mate> = {}): Mate => ({ id, name, covered: 0, repaid: 0, ...over })

const DEVICE = data([sub("d1", "DBMS", [["2026-10-01", "P"], ["2026-10-02", "P"]]), sub("d2", "Anatomy", [["2026-10-01", "A"]])], { tasks: [task("t1", "Viva")] })
const ACCOUNT = data([sub("a1", "DBMS", [["2026-10-01", "P"], ["2026-10-03", "P"]]), sub("a2", "Pharmacology", [["2026-10-02", "P"]])], { tasks: [task("t9", "Lab record")], tags: ["core"] })

/** A device plus the account's stored copy, with the same compare-and-set rule as the real store and switches for every failure */
function world(o: { device: FullBackupData; account?: FullBackupData | null; rev?: number }) {
  const w = {
    device: o.device,
    store: o.account ? { rev: o.rev ?? 1, text: buildBackup(o.account, false) } : (null as { rev: number; text: string } | null),
    down: false, // the account cannot be reached
    failPutOnce: false as false | "unavailable" | "closed",
    putBlocked: false,
    deviceVerifies: true,
    staleReadBack: false, // reads after a write return the previous copy
    staleReadBackOnce: false, // simulate a transient stale read immediately after commit
    previous: null as { rev: number; text: string } | null,
    applied: [] as FullBackupData[],
    puts: 0,
    skipRestoreSave: false,
    onBeforePut: null as null | (() => void),
    /** runs after each safety copy has been saved (the person edits while it is being saved) */
    onSave: null as null | (() => void),
  }
  const deps: ApplyDeps = {
    getDevice: () => w.device,
    applyDevice: (d) => {
      w.device = d
      w.applied.push(d)
    },
    verifyDevice: async (d) => w.deviceVerifies && same(w.device, d),
    saveRestorePoint: async (reason, d) => {
      if (!w.skipRestoreSave) await saveRestorePoint(reason, d)
      w.onSave?.()
    },
    listRestorePoints,
    cloudGet: async () => {
      if (w.down) throw new Error("offline")
      if (w.staleReadBackOnce && w.previous) {
        w.staleReadBackOnce = false
        return { data: w.previous.text, rev: w.previous.rev, updatedAt: 1 }
      }
      const s = w.staleReadBack && w.previous ? w.previous : w.store
      return s ? { data: s.text, rev: s.rev, updatedAt: 1 } : null
    },
    cloudPut: async (_owner, text, expectedRev) => {
      if (w.down) return { ok: false, reason: "unavailable" }
      if (w.failPutOnce) {
        const why = w.failPutOnce
        w.failPutOnce = false
        if (why === "closed") throw new Error("the browser was closed")
        return { ok: false, reason: "unavailable" }
      }
      w.onBeforePut?.()
      w.onBeforePut = null
      if ((w.store?.rev ?? null) !== expectedRev) return { ok: false, reason: "conflict" }
      w.puts++
      w.previous = w.store
      w.store = { rev: (w.store?.rev ?? 0) + 1, text }
      return { ok: true, rev: w.store.rev }
    },
  }
  const cloudRead = (): CloudRead => (w.down ? { kind: "unavailable" } : w.store ? { kind: "doc", doc: { data: w.store.text, rev: w.store.rev, updatedAt: 1 } } : { kind: "none" })
  const plan = (accountId = "acct-1", dataOwner: string | null = null): Plan => planFirstSignIn({ device: w.device, cloud: cloudRead(), accountId, dataOwner })
  const stored = () => (w.store ? JSON.parse(w.store.text).data : null)
  return { w, deps, plan, stored }
}
const offerOf = (p: Plan): Offer => {
  if (p.kind !== "choose") throw new Error("expected a choice, got " + p.kind)
  return p.offer
}

// ---- 1. anonymous user with local data, empty account -----------------------------------------------------------------
describe("1. local data, empty account", () => {
  it("no account copy at all: this device's data simply becomes the account's copy, without asking", () => {
    expect(world({ device: DEVICE, account: null }).plan()).toEqual({ kind: "upload", rev: null })
  })
  it("an account copy that exists but holds nothing is the same: nothing is replaced, so nothing is asked", () => {
    expect(world({ device: DEVICE, account: emptyData(), rev: 4 }).plan()).toEqual({ kind: "upload", rev: 4 })
  })
})

// ---- 2. anonymous user with local data, existing account data ---------------------------------------------------------
describe("2. local data and existing account data", () => {
  it("asks, recommends merging, and shows an accurate comparison", () => {
    const offer = offerOf(world({ device: DEVICE, account: ACCOUNT }).plan())
    expect(offer.recommended).toBe("merge")
    expect(offer.foreign).toBe(false)
    const c = offer.comparison
    expect(c.device).toMatchObject({ subjects: 2, marks: 3, tasks: 1, tags: 0 })
    expect(c.account).toMatchObject({ subjects: 2, marks: 3, tasks: 1, tags: 1 })
    expect(c.both).toMatchObject({ subjects: 1 }) // DBMS, matched by name although the ids differ
    expect(c.onlyDevice).toMatchObject({ subjects: 1, tasks: 1 }) // Anatomy, Viva
    expect(c.onlyAccount).toMatchObject({ subjects: 1, tasks: 1, tags: 1 }) // Pharmacology, Lab record, core
    expect(c.identical).toBe(false)
    expect(offer.options.map((o) => [o.choice, o.enabled])).toEqual([["merge", true], ["device", true], ["cloud", true]])
  })
  it("nothing is applied or written while the person is deciding", () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    x.plan()
    expect(x.w.applied).toEqual([])
    expect(x.w.puts).toBe(0)
  })
})

// ---- 3 and 4. empty device / both empty -------------------------------------------------------------------------------
describe("3. empty device, existing account data", () => {
  it("the account's copy is taken without asking (there is nothing here to lose)", () => {
    const p = world({ device: emptyData(), account: ACCOUNT, rev: 7 }).plan()
    expect(p.kind).toBe("take-account")
    expect(p.kind === "take-account" && p.rev).toBe(7)
  })
})
describe("4. both empty", () => {
  it("no copy, or an empty copy: connect quietly", () => {
    expect(world({ device: emptyData(), account: null }).plan()).toEqual({ kind: "nothing", rev: null })
    expect(world({ device: emptyData(), account: emptyData(), rev: 2 }).plan()).toEqual({ kind: "nothing", rev: 2 })
  })
})

// ---- 5. identical ------------------------------------------------------------------------------------------------------
describe("5. identical records on both sides", () => {
  it("is adopted without asking and without a warning", () => {
    const p = world({ device: DEVICE, account: DEVICE, rev: 3 }).plan()
    expect(p.kind).toBe("adopt")
  })
  it("the same data with a different id for the same subject is still one subject (no prompt needed)", () => {
    const same2 = data([sub("zzz", "dbms", [["2026-10-01", "P"], ["2026-10-02", "P"]]), sub("d2", "Anatomy", [["2026-10-01", "A"]])], { tasks: [task("t1", "Viva")] })
    expect(compareData(DEVICE, same2).onlyDevice.subjects).toBe(0)
  })
})

// ---- 6. conflicts ------------------------------------------------------------------------------------------------------
describe("6. conflicting attendance and subject identity", () => {
  const dev = data([sub("d1", "DBMS", [["2026-10-02", "P"]])])
  const acc = data([sub("a1", "DBMS", [["2026-10-02", "A"]])])
  it("the same class marked differently is reported by name, not as a mystery count", () => {
    const c = compareData(dev, acc)
    expect(c.conflicts).toBeGreaterThan(0)
    expect(c.conflictItems).toEqual([{ kind: "subject", name: "DBMS" }])
  })
  it("merging keeps this device's mark, loses nothing, and saves the account's copy so the other mark is recoverable", async () => {
    const x = world({ device: dev, account: acc })
    const r = await applyChoice("merge", offerOf(x.plan()), "acct-1", false, x.deps)
    expect(r.ok).toBe(true)
    expect(x.w.device.subjects[0].log).toEqual([{ d: "2026-10-02", s: "P" }])
    const points = await listRestorePoints()
    expect(points.some((p) => p.reason.includes("account"))).toBe(true)
    expect(points.some((p) => p.data.subjects[0].log?.[0].s === "A")).toBe(true) // the other value survives
  })
  it("distinct subjects are never merged just because their names are similar", () => {
    const m = mergeData(null, data([sub("d1", "Maths", [["2026-10-01", "P"]])]), data([sub("a1", "Mathematics", [["2026-10-01", "P"]])]))
    expect(m.data.subjects.map((s) => s.name).sort()).toEqual(["Mathematics", "Maths"])
    expect(compareData(data([sub("d1", "Maths")]), data([sub("a1", "Mathematics")])).both.subjects).toBe(0)
  })
  it("the same subject (same name, different ids) is one subject and its marks are combined once", async () => {
    const x = world({ device: data([sub("d1", "DBMS", [["2026-10-01", "P"]])]), account: data([sub("a1", "DBMS", [["2026-10-01", "P"], ["2026-10-02", "P"]])]) })
    const r = await applyChoice("merge", offerOf(x.plan()), "acct-1", false, x.deps)
    expect(r.ok).toBe(true)
    expect(x.w.device.subjects).toHaveLength(1)
    expect(x.w.device.subjects[0].log).toHaveLength(2)
    expect(x.w.device.subjects[0].attended).toBe(2)
  })
  it("a mate is matched by account id even if the names differ, and conflicting favour counts are reported", () => {
    const a = data([], { mates: [mate("m1", "Arjun", { uid: "u-arjun", covered: 2 })] })
    const b = data([], { mates: [mate("m9", "A.", { uid: "u-arjun", covered: 3 })] })
    expect(compareData(a, b).both.mates).toBe(1)
  })
})

// ---- 7. account unavailable --------------------------------------------------------------------------------------------
describe("7. the account cannot be read", () => {
  it("is never treated as an empty account: nothing is uploaded or replaced", () => {
    const p = world({ device: DEVICE, account: ACCOUNT }).plan()
    expect(p.kind).toBe("choose")
    const x = world({ device: DEVICE, account: ACCOUNT })
    x.w.down = true
    expect(x.plan()).toEqual({ kind: "unavailable" })
    // an empty device does not take "nothing" either
    const y = world({ device: emptyData(), account: ACCOUNT })
    y.w.down = true
    expect(y.plan().kind).toBe("unavailable")
  })
  it("a stored copy that cannot be parsed is also not an empty one", () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const bad: CloudRead = { kind: "doc", doc: { data: "{not json", rev: 2, updatedAt: 1 } }
    expect(planFirstSignIn({ device: DEVICE, cloud: bad, accountId: "a", dataOwner: null })).toEqual({ kind: "unreadable" })
    expect(x.w.puts).toBe(0)
  })
  it("choosing while the account is unreachable changes nothing on the device and writes nothing", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    x.w.down = true
    for (const c of ["merge", "device", "cloud"] as Choice[]) {
      const r = await applyChoice(c, offer, "acct-1", true, x.deps)
      expect(r.ok).toBe(false)
      expect(!r.ok && r.reason).toBe("unavailable")
    }
    expect(x.w.device).toEqual(DEVICE)
    expect(x.w.applied).toEqual([])
    expect(x.w.puts).toBe(0)
  })
})

// ---- 8. offline and retry ----------------------------------------------------------------------------------------------
describe("8. offline operation and retry", () => {
  it("an upload that fails is not complete; retrying completes it exactly once", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    x.w.failPutOnce = "unavailable"
    const first = await applyChoice("merge", offer, "acct-1", false, x.deps)
    expect(first.ok).toBe(false)
    expect(x.w.puts).toBe(0) // nothing reached the account, and the result is not reported as done
    const second = await applyChoice("merge", offerOf(x.plan()), "acct-1", false, x.deps)
    expect(second.ok).toBe(true)
    expect(x.w.puts).toBe(1)
    expect(second.ok && same(x.stored(), second.data)).toBe(true)
  })
  it("the device's data is intact and usable after a failure (nothing was deleted)", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    x.w.failPutOnce = "unavailable"
    await applyChoice("merge", offer, "acct-1", false, x.deps)
    for (const s of DEVICE.subjects) expect(x.w.device.subjects.some((d) => d.name === s.name)).toBe(true) // everything of this device is still here
  })
})

// ---- 9. closure midway -------------------------------------------------------------------------------------------------
describe("9. the browser closes midway", () => {
  it("after the merge was applied here but before it reached the account: the next start finds both copies and finishes the same result", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    x.w.failPutOnce = "closed" // the page dies during the upload
    const dead = await applyChoice("merge", offer, "acct-1", false, x.deps)
    expect(dead.ok).toBe(false)
    expect(x.w.store?.rev).toBe(1) // the account's copy was not touched
    // a new session: the device holds the merged data, the account the old copy
    const next = offerOf(x.plan())
    expect(next.recommended).toBe("merge")
    const done = await applyChoice("merge", next, "acct-1", false, x.deps)
    expect(done.ok).toBe(true)
    // the same result as an uninterrupted run, with no duplicate subject, mark or deadline
    const clean = world({ device: DEVICE, account: ACCOUNT })
    const ref = await applyChoice("merge", offerOf(clean.plan()), "acct-1", false, clean.deps)
    expect(done.ok && ref.ok && same(done.data, ref.data)).toBe(true)
    expect(x.w.device.subjects).toHaveLength(3)
    expect(x.w.device.tasks).toHaveLength(2)
  })
  it("a crash before anything is applied leaves the device exactly as it was", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    x.deps.saveRestorePoint = async () => {
      throw new Error("closed while saving the safety copy")
    }
    const r = await applyChoice("merge", offer, "acct-1", false, x.deps)
    expect(r.ok).toBe(false)
    expect(x.w.device).toEqual(DEVICE)
    expect(x.w.puts).toBe(0)
  })
})

// ---- 10. idempotence ---------------------------------------------------------------------------------------------------
describe("10. repeated merges never duplicate", () => {
  it("merging, then merging again, changes nothing and writes nothing the second time", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const a = await applyChoice("merge", offerOf(x.plan()), "acct-1", false, x.deps)
    expect(a.ok).toBe(true)
    const putsAfterFirst = x.w.puts
    const snapshot = x.w.device
    const p2 = x.plan()
    expect(p2.kind).toBe("adopt") // both sides already say the same thing
    const b = await applyChoice("merge", { ...offerOf(planFirstSignIn({ device: x.w.device, cloud: { kind: "doc", doc: { data: x.w.store!.text, rev: x.w.store!.rev, updatedAt: 1 } }, accountId: "z", dataOwner: "q" })) }, "acct-1", false, x.deps)
    expect(b.ok).toBe(true)
    expect(x.w.puts).toBe(putsAfterFirst)
    expect(x.w.device).toEqual(snapshot)
  })
  it("running the same merge three times from the same starting point gives one result and one write", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    const results = []
    for (let i = 0; i < 3; i++) results.push(await applyChoice("merge", offer, "acct-1", false, x.deps))
    expect(results.every((r) => r.ok)).toBe(true)
    expect(x.w.puts).toBe(1)
    expect(x.w.device.subjects).toHaveLength(3)
    expect(x.w.device.subjects.find((s) => s.name === "DBMS")?.log).toHaveLength(3) // 01, 02, 03 Oct, each once
  })
  it("another device saving first makes the write conflict; the merge is redone on top of it and nothing is lost", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    x.w.onBeforePut = () => {
      const other = mergeData(null, ACCOUNT, data([sub("o1", "Physiology", [["2026-10-04", "P"]])])).data
      x.w.store = { rev: 2, text: buildBackup(other, false) } // a third device saved while we were working
    }
    const r = await applyChoice("merge", offer, "acct-1", false, x.deps)
    expect(r.ok).toBe(true)
    const names = x.w.device.subjects.map((s) => s.name).sort()
    expect(names).toEqual(["Anatomy", "DBMS", "Pharmacology", "Physiology"])
  })
})

// ---- 11. restore points: creation and real recovery --------------------------------------------------------------------
describe("11. restore points are really created and really recover", () => {
  it("'use the account's data' keeps this device's data first and the saved copy restores it exactly", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const r = await applyChoice("cloud", offerOf(x.plan()), "acct-1", true, x.deps)
    expect(r.ok && r.restorePoints.length).toBe(1)
    expect(same(x.w.device, ACCOUNT)).toBe(true)
    const [p] = await listRestorePoints()
    expect(same(p.data, DEVICE)).toBe(true)
    // recovery: apply the saved point (this is what Settings > Restore points does)
    x.deps.applyDevice(p.data)
    expect(same(x.w.device, DEVICE)).toBe(true)
  })
  it("'use this device's data' keeps the account's copy first, so the removed records can be brought back", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const r = await applyChoice("device", offerOf(x.plan()), "acct-1", true, x.deps)
    expect(r.ok).toBe(true)
    expect(same(x.stored(), DEVICE)).toBe(true)
    const [p] = await listRestorePoints()
    expect(same(p.data, ACCOUNT)).toBe(true)
    expect(p.data.subjects.some((s) => s.name === "Pharmacology")).toBe(true)
  })
  it("if the safety copy cannot be confirmed, NOTHING is changed (the order is protect, then change)", async () => {
    for (const choice of ["merge", "device", "cloud"] as Choice[]) {
      const x = world({ device: DEVICE, account: ACCOUNT })
      x.w.skipRestoreSave = true // the save silently does nothing; reading it back finds no copy
      const r = await applyChoice(choice, offerOf(x.plan()), "acct-1", true, x.deps)
      expect(r.ok, choice).toBe(false)
      expect(!r.ok && r.reason, choice).toBe("restore-point-failed")
      expect(x.w.device, choice).toEqual(DEVICE)
      expect(x.w.puts, choice).toBe(0)
      expect(x.w.store?.rev, choice).toBe(1)
    }
  })
  it("the same device data is not saved twice (an identical newest point is reused and still counts as verified)", async () => {
    await saveRestorePoint("earlier", DEVICE)
    const x = world({ device: DEVICE, account: ACCOUNT })
    const r = await applyChoice("cloud", offerOf(x.plan()), "acct-1", true, x.deps)
    expect(r.ok).toBe(true)
    expect(await listRestorePoints()).toHaveLength(1)
  })
})

// ---- 12. existing Google-account data ----------------------------------------------------------------------------------
describe("12. existing Google-account data", () => {
  it("is never assumed to replace the data on this device", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    expect(offerOf(x.plan()).recommended).toBe("merge")
    const r = await applyChoice("merge", offerOf(x.plan()), "acct-1", false, x.deps)
    expect(r.ok).toBe(true)
    for (const s of DEVICE.subjects) expect(x.w.device.subjects.some((d) => d.name === s.name)).toBe(true)
    for (const s of ACCOUNT.subjects) expect(x.w.device.subjects.some((d) => d.name === s.name)).toBe(true)
  })
})

// ---- 13. account switching and isolation -------------------------------------------------------------------------------
describe("13. account switching keeps accounts apart", () => {
  it("data tied to another account is never combined into this one without a choice, even when this account is empty", () => {
    for (const account of [null, emptyData(), ACCOUNT]) {
      const p = world({ device: DEVICE, account }).plan("bob", "alice")
      expect(p.kind, String(account && "has data")).toBe("choose")
      expect(offerOf(p).foreign).toBe(true)
    }
  })
  it("with an empty account the merge option is not offered, and using the device's data needs an explicit confirmation", async () => {
    const x = world({ device: DEVICE, account: null })
    const offer = offerOf(x.plan("bob", "alice"))
    const by = (c: Choice) => offer.options.find((o) => o.choice === c)!
    expect(by("merge").enabled).toBe(false)
    expect(by("cloud").enabled).toBe(false)
    expect(by("device")).toMatchObject({ enabled: true, destructive: true })
    expect(offer.recommended).toBeNull()
    const refused = await applyChoice("device", offer, "bob", false, x.deps)
    expect(!refused.ok && refused.reason).toBe("needs-confirmation")
    expect(x.w.puts).toBe(0) // alice's data did not reach bob's account
  })
  it("with data in the account, the recommendation is to use the account's own data, and doing so leaves none of the other account's records on this device", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan("bob", "alice"))
    expect(offer.recommended).toBe("cloud")
    const r = await applyChoice("cloud", offer, "bob", true, x.deps)
    expect(r.ok).toBe(true)
    expect(x.w.device.subjects.map((s) => s.name).sort()).toEqual(["DBMS", "Pharmacology"])
    expect(x.w.device.tasks.map((t) => t.title)).toEqual(["Lab record"])
    expect(x.w.puts).toBe(0) // nothing from this device was written to the account
  })
  it("the same account signing back in is not treated as foreign, and an anonymous device (no owner) is not either", () => {
    expect(offerOf(world({ device: DEVICE, account: ACCOUNT }).plan("alice", "alice")).foreign).toBe(false)
    expect(offerOf(world({ device: DEVICE, account: ACCOUNT }).plan("alice", null)).foreign).toBe(false)
    expect(world({ device: emptyData(), account: ACCOUNT }).plan("bob", "alice").kind).toBe("take-account") // nothing of alice's is left to protect
  })
})

// ---- bare connections are not user data, but ledger history is --------------------------------------------------------------
describe("mates: connections the app re-creates versus history only this device has", () => {
  const bare = [mate("m1", "Zoe", { uid: "u-zoe" }), mate("m2", "Ryan", { uid: "u-ryan" })]
  it("a fresh device that only holds accepted connections is empty for this purpose (the account's data is taken, nothing is asked)", () => {
    expect(hasUserData(data([], { mates: bare }))).toBe(false)
    expect(world({ device: data([], { mates: bare }), account: ACCOUNT, rev: 3 }).plan().kind).toBe("take-account")
  })
  it("the same connections on one side only do not make two otherwise identical copies 'different'", () => {
    expect(world({ device: data(DEVICE.subjects, { tasks: DEVICE.tasks, mates: bare }), account: DEVICE, rev: 2 }).plan().kind).toBe("adopt")
  })
  it("a mate with favour history IS user data: it is never dropped silently and it is asked about", () => {
    const withHistory = [mate("m1", "Zoe", { uid: "u-zoe", covered: 2, coveredLog: ["2026-10-01", "2026-10-02"] })]
    expect(hasUserData(data([], { mates: withHistory }))).toBe(true)
    expect(world({ device: data([], { mates: withHistory }), account: ACCOUNT }).plan().kind).toBe("choose")
    for (const m of [mate("a", "A", { repaid: 1 }), mate("b", "B", { repaidLog: ["2026-10-01"] }), mate("c", "C", { coveredPings: ["2026-10-01|p1:k"] })]) {
      expect(hasUserData(data([], { mates: [m] })), m.name).toBe(true)
    }
  })
  it("choosing 'use my account's data' on a device that has a mate with history keeps that history in a restore point", async () => {
    const withHistory = [mate("m1", "Zoe", { uid: "u-zoe", covered: 2, coveredLog: ["2026-10-01", "2026-10-02"] })]
    const x = world({ device: data([sub("d1", "DBMS")], { mates: withHistory }), account: ACCOUNT })
    const r = await applyChoice("cloud", offerOf(x.plan()), "acct-1", true, x.deps)
    expect(r.ok).toBe(true)
    const [p] = await listRestorePoints()
    expect(p.data.mates[0].covered).toBe(2)
  })
  it("bare connections still travel with a merge (the decision ignores them, the merge does not)", async () => {
    const x = world({ device: data(DEVICE.subjects, { mates: bare }), account: ACCOUNT })
    const r = await applyChoice("merge", offerOf(x.plan()), "acct-1", false, x.deps)
    expect(r.ok && r.data.mates.map((m) => m.name).sort()).toEqual(["Ryan", "Zoe"])
  })
})

// ---- 14. destructive options need explicit confirmation ----------------------------------------------------------------
describe("14. replacement needs an explicit confirmation", () => {
  it("both replacing options are marked destructive and refuse to run unconfirmed; merging is not and does not ask", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    expect(offer.options.map((o) => [o.choice, o.destructive])).toEqual([["merge", false], ["device", true], ["cloud", true]])
    for (const c of ["device", "cloud"] as Choice[]) {
      const r = await applyChoice(c, offer, "acct-1", false, x.deps)
      expect(!r.ok && r.reason).toBe("needs-confirmation")
    }
    expect(x.w.device).toEqual(DEVICE)
    expect(x.w.puts).toBe(0)
    expect(x.w.applied).toEqual([])
    expect((await listRestorePoints()).length).toBe(0)
    expect((await applyChoice("merge", offer, "acct-1", false, x.deps)).ok).toBe(true)
  })
  it("'use this device's data' refuses if the account changed after the comparison was shown (it only replaces what was shown)", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    x.w.store = { rev: 2, text: buildBackup(mergeData(null, ACCOUNT, data([sub("n1", "New", [["2026-10-05", "P"]])])).data, false) }
    const r = await applyChoice("device", offer, "acct-1", true, x.deps)
    expect(!r.ok && r.reason).toBe("changed-elsewhere")
    expect(x.w.store?.rev).toBe(2)
    expect(x.w.puts).toBe(0)
  })
  it("tags or reminders alone ARE held by a restore point now, so replacing them is offered, protected and recoverable", async () => {
    const onlyTags = data([], { tags: ["core"], reminders: [] })
    expect(hasUserData(onlyTags)).toBe(true)
    expect(restorable(onlyTags)).toBe(true)
    expect(restorable(data([], { reminders: [{ id: "r", day: 1, startTime: "09:00", endTime: "10:00", subjectName: "X", notifyOffset: 5, notifyWhen: "before" }] }))).toBe(true)
    const x = world({ device: onlyTags, account: ACCOUNT })
    const offer = offerOf(x.plan())
    expect(offer.options.find((o) => o.choice === "cloud")!.enabled).toBe(true)
    const r = await applyChoice("cloud", offer, "acct-1", true, x.deps)
    expect(r.ok).toBe(true)
    const [p] = await listRestorePoints()
    expect(p.data.tags).toEqual(["core"]) // what was replaced can be got back
  })
})

// ---- 15. success only after verification -------------------------------------------------------------------------------
describe("15. complete only after the result is verified", () => {
  it("a write that is not confirmed by reading the stored copy back is not reported as done", async () => {
    for (const choice of ["merge", "device"] as Choice[]) {
      const x = world({ device: DEVICE, account: ACCOUNT })
      x.w.staleReadBack = true // the store answers the write but reads back the old copy
      const r = await applyChoice(choice, offerOf(x.plan()), "acct-1", true, x.deps)
      expect(r.ok, choice).toBe(false)
      expect(!r.ok && r.reason, choice).toBe("verify-failed")
    }
  })
  it("retries a transient stale read after a successful write and only completes after the new copy is confirmed", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    x.w.staleReadBackOnce = true
    const r = await applyChoice("device", offerOf(x.plan()), "acct-1", true, x.deps)
    expect(r.ok).toBe(true)
    expect(x.w.puts).toBe(1) // retry verification only; never duplicate the write
    expect(x.stored()).toEqual(DEVICE)
  })
  it("replacing this device's data is not done until this device's storage holds it", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    x.w.deviceVerifies = false
    const r = await applyChoice("cloud", offerOf(x.plan()), "acct-1", true, x.deps)
    expect(!r.ok && r.reason).toBe("apply-failed")
    expect((await listRestorePoints()).some((p) => same(p.data, DEVICE))).toBe(true) // and the previous data is recoverable
  })
  it("a successful result carries the data that was verified and the revision it is stored at", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const r = await applyChoice("merge", offerOf(x.plan()), "acct-1", false, x.deps)
    expect(r.ok && r.rev).toBe(2)
    expect(r.ok && same(r.data, x.stored())).toBe(true)
  })
})

// ---- the comparison is the engine's, and there is only one engine -------------------------------------------------------
describe("one merge engine, one backup mechanism", () => {
  it("the counts always agree with what a merge actually produces", () => {
    const pairs: [FullBackupData, FullBackupData][] = [
      [DEVICE, ACCOUNT],
      [ACCOUNT, DEVICE],
      [DEVICE, DEVICE],
      [data([sub("a", "A", [["2026-10-01", "P"]])]), data([sub("b", "A", [["2026-10-01", "A"], ["2026-10-02", "P"]]), sub("c", "C")], { tags: ["x"] })],
      [data([], { mates: [mate("m", "Zoe")] }), data([sub("s", "S")], { mates: [mate("n", "zoe"), mate("o", "Ava")] })],
    ]
    for (const [a, b] of pairs) {
      const c = compareData(a, b)
      const merged = countsOf(mergeData(null, a, b).data)
      for (const k of Object.keys(merged) as (keyof typeof merged)[]) {
        expect(c.onlyDevice[k] + c.onlyAccount[k] + c.both[k], k).toBe(merged[k])
        expect(c.both[k] + c.onlyDevice[k], k).toBe(c.device[k])
        expect(c.both[k] + c.onlyAccount[k], k).toBe(c.account[k])
      }
    }
  })
  it("the new module defines no merge of its own and no backup storage of its own", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib", "signin-reconcile.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(src).toMatch(/from "\.\/merge"/)
    expect(src).toMatch(/mergeData\(null,/)
    expect(src).not.toMatch(/function\s+(merge|mergeList|mergeSet|mergeObject)\b|indexedDB|localStorage|dbSet|dbGet/)
    expect(src).not.toMatch(/firebase|supabase|fetch\(/i) // it never talks to a backend itself: every read and write goes through the injected cloud functions
  })
  it("it never inspects anything but the app's own backup data", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib", "signin-reconcile.ts"), "utf8")
    expect(src).not.toMatch(/drive|gmail|contacts|googleapis/i)
  })
})

// ---- 16. the person edits while the safety copy is being saved ------------------------------------------------------------------
describe("16. an edit made while the safety copy is saved is never overwritten", () => {
  const editOnce = (x: ReturnType<typeof world>) => {
    let done = false
    x.w.onSave = () => {
      if (done) return
      done = true
      x.w.device = { ...x.w.device, tags: [...x.w.device.tags, "edited-meanwhile"] }
    }
  }
  const editEveryTime = (x: ReturnType<typeof world>) => {
    let n = 0
    x.w.onSave = () => void (x.w.device = { ...x.w.device, tags: [...x.w.device.tags, `edit-${n++}`] })
  }

  it("merge: the edit survives on the device AND in the account's copy, and the retry's own safety copy holds it", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    editOnce(x)
    const r = await applyChoice("merge", offer, "acct-1", false, x.deps)
    expect(r.ok).toBe(true)
    expect(x.w.device.tags).toContain("edited-meanwhile")
    expect(x.stored().tags).toContain("edited-meanwhile")
    const points = await listRestorePoints()
    expect(points.some((p) => p.data.tags.includes("edited-meanwhile"))).toBe(true) // what was about to be replaced can be got back
  })

  it("cloud: the first, stale copy is not relied on; a fresh copy holding the edit is saved before anything is replaced", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    editOnce(x)
    const r = await applyChoice("cloud", offer, "acct-1", true, x.deps)
    expect(r.ok).toBe(true)
    expect(x.w.applied).toHaveLength(1) // replaced once, after the fresh copy
    const points = await listRestorePoints()
    expect(points[0].data.tags).toContain("edited-meanwhile")
    expect(x.w.device.tags).not.toContain("edited-meanwhile") // the account's data replaced it, as chosen, with the edit recoverable
  })

  it.each(["merge", "cloud"] as const)("%s: if the data keeps changing, three attempts end in 'device-changed' with nothing replaced or uploaded", async (choice) => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const offer = offerOf(x.plan())
    editEveryTime(x)
    const r = await applyChoice(choice, offer, "acct-1", true, x.deps)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe("device-changed")
    expect(!r.ok && r.message).toBe("Your data changed while the safety copy was being saved, so nothing was replaced. Try again.")
    expect(x.w.applied).toHaveLength(0)
    expect(x.w.puts).toBe(0)
    expect(x.w.device.tags.length).toBeGreaterThanOrEqual(3) // every edit is still there
  })

  it("device-changed keeps the prompt open (it is not 'changed-elsewhere'), with the reason shown, and the person can try again", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const prompts = new PromptController(() => {})
    prompts.show(offerOf(x.plan()))
    let rebuilt = 0
    let finalized = 0
    const env: ChoiceEnv = {
      prompts,
      accountId: () => "acct-1",
      paused: () => false,
      deps: x.deps,
      deviceReplaced: () => {},
      finalize: () => void finalized++,
      rebuild: async () => void rebuilt++,
    }
    editEveryTime(x)
    const msg = await runChoice(env, "cloud", true)
    expect(msg).toMatch(/changed while the safety copy was being saved/)
    expect(prompts.current).not.toBeNull()
    expect(prompts.current?.working).toBe(false)
    expect(prompts.current?.error).toBe(msg)
    expect(rebuilt).toBe(0)
    expect(finalized).toBe(0)
    x.w.onSave = null // the edits stop: trying again works
    expect(await runChoice(env, "cloud", true)).toBeNull()
    expect(finalized).toBe(1)
  })

  it("merge: if applying the merged data did not stick on this device, nothing is uploaded and nothing is finalized (apply-failed)", async () => {
    const x = world({ device: DEVICE, account: ACCOUNT })
    const prompts = new PromptController(() => {})
    prompts.show(offerOf(x.plan()))
    let finalized = 0
    const env: ChoiceEnv = { prompts, accountId: () => "acct-1", paused: () => false, deps: x.deps, deviceReplaced: () => {}, finalize: () => void finalized++, rebuild: async () => {} }
    x.w.deviceVerifies = false
    const msg = await runChoice(env, "merge", false)
    expect(msg).toMatch(/Couldn’t finish saving on this device/)
    expect(x.w.puts).toBe(0)
    expect(finalized).toBe(0)
    expect(x.stored().subjects.map((s: Subject) => s.name).sort()).toEqual(["DBMS", "Pharmacology"]) // the account's copy is untouched
    const direct = world({ device: DEVICE, account: ACCOUNT })
    direct.w.deviceVerifies = false
    const r = await applyChoice("merge", offerOf(direct.plan()), "acct-1", false, direct.deps)
    expect(!r.ok && r.reason).toBe("apply-failed")
    expect(direct.w.puts).toBe(0)
  })
})
