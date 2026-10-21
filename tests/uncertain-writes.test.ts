/**
 * Writes whose result is unknown, and what a stored copy at revision N means to a device that sent a write against revision R.
 * Every case runs the real code of lib/signin-reconcile.ts (ledger, putTracked, decideIngest, the ingestor), lib/merge.ts and
 * lib/restore-points.ts against a stand-in store that enforces the same compare-and-set contract as Firestore, the dev route and
 * Supabase (new revision = expected + 1, null/0 = nothing stored). `Device` below wires them the way hooks/use-cloud-sync.ts does;
 * the hook itself needs a DOM, so its wiring is pinned by source checks at the end. All state is created per test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { buildBackup, parseFullBackup, type FullBackupData } from "@/lib/backup"
import type { PutResult } from "@/lib/cloud-sync"
import { mergeData, same } from "@/lib/merge"
import { listRestorePoints, saveRestorePoint } from "@/lib/restore-points"
import {
  createIngestor,
  decideIngest,
  digestText,
  emptyData,
  isRev,
  MAX_MARKERS,
  normalizeRev,
  parseMarkers,
  putTracked,
  WriteLedger,
  type BaseRecord,
  type MarkerStore,
  type MergeWhy,
  type WriteMarker,
} from "@/lib/signin-reconcile"
import type { Mate, Subject } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")

beforeEach(() => {
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-01T10:00:00Z"))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const tick = () => vi.setSystemTime(new Date(Date.now() + 1000)) // every copy sent gets its own exportedAt, so its text is its own

const sub = (id: string, name: string): Subject => ({ id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [] })
const mate = (covered: number): Mate => ({ id: "m1", name: "Arjun", covered, repaid: 0 })
const data = (over: Partial<FullBackupData> = {}): FullBackupData => ({ ...emptyData(), ...over })

// ---- the stand-in store: the compare-and-set contract ------------------------------------------------------------------------

class Store {
  rev = 0
  text: string | null = null
  puts = 0
  lastText: string | null = null
  /** next put: "apply-then-lose" lands but answers "unavailable"; "lose" never lands and answers "unavailable"; "hang" never answers */
  next: "apply-then-lose" | "lose" | null = null
  get doc() {
    return this.text === null ? null : { data: this.text, rev: this.rev, updatedAt: 1 }
  }
  put = async (_owner: string, text: string, expected: number | null): Promise<PutResult> => {
    const mode = this.next
    this.next = null
    if (mode === "lose") return { ok: false, reason: "unavailable" }
    if ((this.text === null ? null : this.rev) !== expected) return { ok: false, reason: "conflict" }
    this.puts++
    this.lastText = text
    this.rev = (expected ?? 0) + 1
    this.text = text
    return mode === "apply-then-lose" ? { ok: false, reason: "unavailable" } : { ok: true, rev: this.rev }
  }
  /** another device saves (it has read the current copy, so it is conditional on the current revision) */
  other(d: FullBackupData) {
    tick()
    this.rev += 1
    this.text = buildBackup(d, false)
  }
}

/** The markers' storage: survives a "restart" because it is plain data, and can be told to fail */
class Disk implements MarkerStore {
  value: unknown = undefined
  failSave = false
  async load() {
    return structuredClone(this.value)
  }
  async save(list: WriteMarker[]) {
    if (this.failSave) throw new Error("cannot store")
    this.value = structuredClone(list)
  }
}

interface Persisted {
  rev: string | number | null
  base: BaseRecord | null
  data: FullBackupData
  markers: Disk
}

/** One browser, wired like the hook: revision and base recorded together (base first), markers cleared after the revision is recorded */
class Device {
  rev: number | null
  revCorrupt = false
  base: BaseRecord | null
  data: FullBackupData
  ledger: WriteLedger
  notices: string[] = []
  lastWhy: MergeWhy | undefined
  adopted = 0
  merges = 0
  pending = false
  ingestor: ReturnType<typeof createIngestor>
  constructor(
    public store: Store,
    public disk: Disk,
    start: { rev: string | number | null; base: BaseRecord | null; data: FullBackupData },
  ) {
    const rv = normalizeRev(start.rev)
    if (rv.ok) this.rev = rv.rev
    else {
      this.rev = null
      this.revCorrupt = true
    }
    this.base = start.base
    this.data = start.data
    this.ledger = new WriteLedger(disk)
    this.ingestor = createIngestor({
      ledger: this.ledger,
      getRev: () => this.rev,
      revCorrupt: () => this.revCorrupt,
      loadBase: async () => this.base,
      merge: async (cloud, rev, base, why) => {
        this.merges++
        this.lastWhy = why
        const before = this.data
        if (why) {
          await saveRestorePoint("Before reconciling after an uncertain sync", before)
          await saveRestorePoint("Your other browser's copy", cloud)
          this.notices.push(why)
        }
        const merged = mergeData(base, before, cloud).data
        this.data = merged
        this.base = { rev, data: cloud } // the base first ...
        this.rev = rev // ... then the revision
        this.pending = !same(merged, cloud)
        return !same(merged, before)
      },
      adoptLanded: async (cloud, rev) => {
        this.adopted++
        this.base = { rev, data: cloud }
        this.rev = rev
        this.pending = !same(this.data, cloud)
      },
      revRecovered: () => {
        this.revCorrupt = false
      },
    })
  }
  /** what a restart finds on the disk */
  persisted(): Persisted {
    return { rev: this.rev, base: this.base, data: this.data, markers: this.disk }
  }
  restart(): Device {
    return new Device(this.store, this.disk, { rev: this.rev, base: this.base, data: this.data })
  }
  async push() {
    tick()
    const sent = this.data
    return putTracked(this.ledger, this.store.put, "u", buildBackup(sent, false), this.rev, async (rev) => {
      this.base = { rev, data: sent }
      this.rev = rev
      this.pending = false
    })
  }
  async pull(source: "pull" | "live" = "pull") {
    const doc = this.store.doc
    if (!doc) throw new Error("nothing stored")
    return this.ingestor.ingest(doc, source)
  }
  markers = () => this.ledger.list()
}

/** both start at revision 1 holding `base`, with one favour count */
function world(covered = 0) {
  const store = new Store()
  const baseData = data({ subjects: [sub("s1", "DBMS")], mates: [mate(covered)] })
  tick()
  store.rev = 1
  store.text = buildBackup(baseData, false)
  const mk = (d: FullBackupData) => new Device(store, new Disk(), { rev: 1, base: { rev: 1, data: baseData }, data: d })
  return { store, baseData, mk }
}
const covered = (d: FullBackupData) => d.mates[0]?.covered

// ---- the contract ------------------------------------------------------------------------------------------------------------

describe("the compare-and-set contract every revision rule below relies on", () => {
  it("is what every backend enforces: create = revision 1, update = old + 1, null (Supabase: 0) = nothing stored", () => {
    const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8")
    expect(rules).toMatch(/request\.resource\.data\.rev == 1/)
    expect(rules).toMatch(/request\.resource\.data\.rev == resource\.data\.rev \+ 1/)
    expect(fs.readFileSync(path.join(ROOT, "lib/backend/firebase/index.ts"), "utf8")).toMatch(/if \(rev !== expectedRev\) return \{ ok: false, reason: "conflict" \}[\s\S]*const next = \(rev \?\? 0\) \+ 1/)
    expect(fs.readFileSync(path.join(ROOT, "app/api/dev-sync/[owner]/route.ts"), "utf8")).toMatch(/rev: \(current\?\.rev \?\? 0\) \+ 1/)
    const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261007130500_security_sync_push_rpc.sql"), "utf8")
    expect(sql).toMatch(/p_expected_rev = 0 then[\s\S]*values \(me, p_data, 1,/)
    expect(sql).toMatch(/set data = p_data, rev = rev \+ 1[\s\S]*where uid = me and rev = p_expected_rev/)
  })

  it("the stand-in store behaves the same way", async () => {
    const s = new Store()
    expect(await s.put("u", "a", null)).toEqual({ ok: true, rev: 1 })
    expect(await s.put("u", "b", null)).toEqual({ ok: false, reason: "conflict" })
    expect(await s.put("u", "b", 1)).toEqual({ ok: true, rev: 2 })
    expect(await s.put("u", "c", 1)).toEqual({ ok: false, reason: "conflict" })
  })
})

describe("revisions are validated before they reach arithmetic", () => {
  it("accepts nothing-recorded (as 0 in arithmetic, but still sent as null) and non-negative integers", () => {
    expect(normalizeRev(null)).toEqual({ ok: true, rev: null })
    expect(normalizeRev(undefined)).toEqual({ ok: true, rev: null })
    expect(normalizeRev("")).toEqual({ ok: true, rev: null })
    expect(normalizeRev("0")).toEqual({ ok: true, rev: 0 })
    expect(normalizeRev("17")).toEqual({ ok: true, rev: 17 })
    expect(normalizeRev(4)).toEqual({ ok: true, rev: 4 })
  })
  it.each(["NaN", "-1", "1.5", "abc", "1e3", " 4", "4 ", "99999999999999999999", NaN, Infinity, -1, 2.5, {}, [], true])("rejects %p instead of letting it poison the arithmetic", (bad) => {
    expect(normalizeRev(bad)).toEqual({ ok: false })
  })
  it("isRev", () => {
    expect([0, 1, 12].every(isRev)).toBe(true)
    expect([NaN, -1, 1.2, "3", null, Infinity].some(isRev)).toBe(false)
  })
  it("a write is never sent against a revision that is not valid", async () => {
    const store = new Store()
    const ledger = new WriteLedger(new Disk())
    for (const bad of [NaN, -1, 1.5, Infinity]) {
      expect(await putTracked(ledger, store.put, "u", "x", bad as number)).toEqual({ ok: false, reason: "unavailable" })
    }
    expect(store.puts).toBe(0)
    expect(await ledger.list()).toEqual([]) // nothing was sent, so nothing is in doubt
  })
  it("a success that breaks the contract (not exactly expected + 1) is not believed: the marker stays", async () => {
    const ledger = new WriteLedger(new Disk())
    const lie = async (): Promise<PutResult> => ({ ok: true, rev: 9 })
    expect(await putTracked(ledger, lie, "u", "x", 2)).toEqual({ ok: false, reason: "unavailable" })
    expect((await ledger.list()).map((m) => m.expectedRev)).toEqual([2])
    const nan = async (): Promise<PutResult> => ({ ok: true, rev: NaN })
    expect((await putTracked(ledger, nan, "u", "y", null)).ok).toBe(false)
  })
  it("'no revision yet' is sent as null, recorded as 0", async () => {
    const seen: (number | null)[] = []
    const ledger = new WriteLedger(new Disk())
    await putTracked(ledger, async (_o, _t, e) => (seen.push(e), { ok: true, rev: 1 }), "u", "x", null)
    expect(seen).toEqual([null])
  })
})

// ---- the four outcomes -------------------------------------------------------------------------------------------------------

describe("D1: a write conditional on revision R, read back at revision N", () => {
  it("N == R: the write did not land and nothing came after: nothing changes, the marker stays", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "lose"
    expect((await a.push()).ok).toBe(false)
    const out = await a.pull()
    expect(out).toEqual({ kind: "unchanged" })
    expect(a.merges + a.adopted).toBe(0)
    expect(covered(a.data)).toBe(2)
    expect((await a.markers()).length).toBe(1) // a late arrival of that request is still recognised
    expect(w.store.rev).toBe(1)
  })

  it("N == R + 1 with exactly the text we sent: it landed, so it is adopted and nothing is merged (the favours are not counted twice)", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    // the problem this prevents: the usual three-way merge over the old base counts our own two favours again
    expect(covered(mergeData(w.baseData, a.data, a.data).data)).toBe(4) // base 0 + our 2 + the stored 2
    w.store.next = "apply-then-lose"
    expect((await a.push()).ok).toBe(false)
    expect(w.store.rev).toBe(2)
    const out = await a.pull()
    expect(out).toEqual({ kind: "landed" })
    expect(a.merges).toBe(0)
    expect(covered(a.data)).toBe(2)
    expect(a.rev).toBe(2)
    expect(a.base?.rev).toBe(2)
    expect(a.pending).toBe(false)
    expect(await a.markers()).toEqual([])
  })

  it("N == R + 1 with other text: ours did not land and someone else's did; with a base PROVEN to be revision R, the normal three-way merge runs", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "lose"
    await a.push()
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)] })) // another device logged one favour on top of the same base
    const out = await a.pull()
    expect(out).toMatchObject({ kind: "merged", why: undefined })
    expect(covered(a.data)).toBe(3) // both devices' favours, each counted once
    expect(a.notices).toEqual([])
    expect(await a.markers()).toEqual([])
    expect(a.pending).toBe(true) // the merge holds something the store lacks: it is sent next
  })

  it("N == R + 1 with other text but a base that is NOT proven to be revision R: the cautious merge, with restore points and a notice", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    a.base = { rev: 0, data: w.baseData } // recorded for a different revision than the one we wrote against
    w.store.next = "lose"
    await a.push()
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    const out = await a.pull()
    expect(out).toMatchObject({ kind: "merged", why: "unproven-base" })
    expect(covered(a.data)).toBe(2) // larger side, never added: nothing counted twice
    expect(a.notices).toEqual(["unproven-base"])
    const points = await listRestorePoints()
    expect(points.length).toBeGreaterThan(0)
    expect(await a.markers()).toEqual([])
  })

  it("N >= R + 2: content alone cannot say whether ours landed, so no base is used, restore points are saved and the person is told", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "apply-then-lose" // ours landed at revision 2 ...
    await a.push()
    // ... then another device merged it and added one favour of its own: revision 3 holds three favours
    const theirs = data({ subjects: w.baseData.subjects, mates: [mate(3)] })
    w.store.other(theirs)
    expect(w.store.rev).toBe(3)
    // the unsafe way (base = the old copy) would give 0 + 2 + 3 = 5
    expect(covered(mergeData(w.baseData, a.data, theirs).data)).toBe(5)
    const out = await a.pull()
    expect(out).toMatchObject({ kind: "merged", why: "ambiguous-write" })
    expect(covered(a.data)).toBe(3)
    expect(a.notices).toEqual(["ambiguous-write"])
    expect((await listRestorePoints()).map((p) => p.reason)).toContain("Before reconciling after an uncertain sync")
    expect(await a.markers()).toEqual([])
  })

  it("N >= R + 2 when ours did NOT land: still the cautious merge, and our favours are kept", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "lose"
    await a.push()
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)], tags: ["x"] }))
    expect(await a.pull()).toMatchObject({ kind: "merged", why: "ambiguous-write" })
    expect(covered(a.data)).toBe(2)
    expect(a.data.tags).toEqual(["x"])
  })
})

describe("D1: the sent text is compared exactly, never as parsed objects", () => {
  // The same data written another way: parse-equal (key order, spacing), so same() calls them identical, but not the text we sent
  const reserialise = (text: string) => JSON.stringify(JSON.parse(text), null, 1)

  it("a stored copy that parses to the same data but is a different text did NOT come from our write", () => {
    const sent = buildBackup(data({ subjects: [sub("s1", "DBMS")], mates: [mate(2)] }), false)
    const stored = reserialise(sent)
    expect(stored).not.toBe(sent)
    const a = parseFullBackup(sent)
    const b = parseFullBackup(stored)
    expect(a.ok && b.ok && same(a.data, b.data)).toBe(true) // what object comparison would have concluded
    const d = decideIngest({ stored: { rev: 4, text: stored }, localRev: 3, base: { rev: 3 }, markers: [{ id: "w", sentText: sent, expectedRev: 3, at: 0 }], source: "pull" })
    expect(d.kind).toBe("merge") // not "landed"
    const exact = decideIngest({ stored: { rev: 4, text: sent }, localRev: 3, base: { rev: 3 }, markers: [{ id: "w", sentText: sent, expectedRev: 3, at: 0 }], source: "pull" })
    expect(exact.kind).toBe("landed")
  })

  it("the same text at the wrong revision is not 'landed' either", () => {
    const sent = "T"
    for (const N of [3, 5]) {
      const d = decideIngest({ stored: { rev: N, text: sent }, localRev: 3, base: { rev: 3 }, markers: [{ id: "w", sentText: sent, expectedRev: 3, at: 0 }], source: "pull" })
      expect(d.kind === "landed").toBe(false)
    }
  })

  it("through the whole path: an equal-by-parsing copy written by someone else is merged, not adopted", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "apply-then-lose"
    await a.push()
    const sent = w.store.lastText!
    w.store.text = reserialise(sent) // the same revision, the same data, written another way (not the text we sent)
    const out = await a.pull()
    expect(out.kind).toBe("merged")
    expect(a.adopted).toBe(0)
  })
})

describe("D1: two devices, deletions, retries", () => {
  it("two devices independently add one favour each to the same counter: both are counted, once", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    const b = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    expect((await a.push()).ok).toBe(true)
    const r = await b.push() // B still thinks the store is at revision 1
    expect(r).toEqual({ ok: false, reason: "conflict" })
    expect(await b.markers()).toEqual([]) // a conflict is a definite answer: this write cannot have landed
    expect(await b.pull()).toMatchObject({ kind: "merged" })
    expect(covered(b.data)).toBe(2)
    expect((await b.push()).ok).toBe(true)
    expect(await a.pull()).toMatchObject({ kind: "merged" })
    expect(covered(a.data)).toBe(2)
  })

  it("a deletion on one side is kept by the normal merge; the cautious merge may bring the item back (the safe direction) and says so", async () => {
    const w = world(0)
    const a = w.mk(w.baseData)
    const b = w.mk(data({ subjects: [], mates: w.baseData.mates })) // B deleted DBMS
    expect((await b.push()).ok).toBe(true)
    await a.pull()
    expect(a.data.subjects).toEqual([]) // proven base: the deletion propagates

    // the same situation where A's base cannot be proven
    const w2 = world(0)
    const a2 = w2.mk(w2.baseData)
    const b2 = w2.mk(data({ subjects: [], mates: w2.baseData.mates }))
    await b2.push()
    a2.base = { rev: 0, data: w2.baseData }
    expect(await a2.pull()).toMatchObject({ kind: "merged", why: "unproven-base" })
    expect(a2.data.subjects.map((s) => s.name)).toEqual(["DBMS"])
    expect(a2.notices).toEqual(["unproven-base"])
  })

  it("a retry after a write that had landed: the conflict is settled by recognising our first text, not by merging our own change into itself", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "apply-then-lose"
    expect((await a.push()).ok).toBe(false) // landed at 2, answer lost
    const retry = await a.push() // retried against revision 1: the store is at 2
    expect(retry).toEqual({ ok: false, reason: "conflict" })
    expect((await a.markers()).length).toBe(1) // only the retry's own marker was cleared; the first is still in doubt
    expect(await a.pull()).toEqual({ kind: "landed" })
    expect(covered(a.data)).toBe(2)
    expect(a.merges).toBe(0)
    expect(await a.markers()).toEqual([])
    expect(a.pending).toBe(false)
  })

  it("a retry that goes through clears the older markers (a success at revision R proves none of them landed)", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "lose"
    await a.push()
    w.store.next = "lose"
    await a.push()
    expect((await a.markers()).length).toBe(2)
    expect((await a.push()).ok).toBe(true)
    expect(await a.markers()).toEqual([])
    expect(w.store.rev).toBe(2)
  })

  it("several tries in doubt: whichever of them landed is the one recognised", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    w.store.next = "lose"
    await a.push()
    a.data = data({ subjects: w.baseData.subjects, mates: [mate(3)] })
    w.store.next = "apply-then-lose"
    await a.push() // the second try landed
    a.data = data({ subjects: w.baseData.subjects, mates: [mate(4)] }) // and more was done since
    expect(await a.pull()).toEqual({ kind: "landed" })
    expect(a.data.mates[0].covered).toBe(4) // nothing of the later work was thrown away
    expect(a.pending).toBe(true) // and it is still to be sent
    expect(a.base?.data.mates[0].covered).toBe(3)
  })
})

describe("D1: a crash while a write is in flight", () => {
  it("the marker is on disk BEFORE the request is made", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    let onDiskDuringRequest: unknown
    const spy = async (o: string, t: string, e: number | null) => {
      onDiskDuringRequest = structuredClone(a.disk.value)
      return w.store.put(o, t, e)
    }
    tick()
    await putTracked(a.ledger, spy, "u", buildBackup(a.data, false), a.rev)
    expect(onDiskDuringRequest).toHaveLength(1)
    expect((onDiskDuringRequest as WriteMarker[])[0]).toMatchObject({ expectedRev: 1 })
  })

  it("the tab dies after the request landed: the restarted device finds the marker and recognises its own write", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    // the request is applied, then everything dies before any answer is processed
    const dying = async (o: string, t: string, e: number | null) => {
      await w.store.put(o, t, e)
      throw new Error("tab closed")
    }
    tick()
    await putTracked(a.ledger, dying, "u", buildBackup(a.data, false), a.rev)
    expect(w.store.rev).toBe(2)
    const b = a.restart() // a new process: only the disk survives
    expect((await b.markers()).length).toBe(1)
    expect(await b.pull()).toEqual({ kind: "landed" })
    expect(covered(b.data)).toBe(2)
    expect(await b.markers()).toEqual([])
  })

  it("the tab dies BEFORE the request is applied: after restart the store is simply unchanged, and a normal push then settles the marker", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    const never = async (): Promise<PutResult> => {
      throw new Error("tab closed")
    }
    tick()
    await putTracked(a.ledger, never, "u", buildBackup(a.data, false), a.rev)
    const b = a.restart()
    expect(await b.pull()).toEqual({ kind: "unchanged" })
    expect((await b.markers()).length).toBe(1)
    expect((await b.push()).ok).toBe(true)
    expect(await b.markers()).toEqual([])
  })

  it("the tab dies and someone else saved meanwhile: the restarted device is cautious, not wrong", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    const never = async (): Promise<PutResult> => {
      throw new Error("tab closed")
    }
    tick()
    await putTracked(a.ledger, never, "u", buildBackup(a.data, false), a.rev)
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    const b = a.restart()
    expect(await b.pull()).toMatchObject({ kind: "merged" }) // N == R + 1, other text, base proven: ordinary merge
    expect(covered(b.data)).toBe(3)
  })

  it("a write that cannot be written down is not made", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    a.disk.failSave = true
    const before = w.store.puts
    expect(await a.push()).toEqual({ ok: false, reason: "unavailable" })
    expect(w.store.puts).toBe(before)
  })

  it("markers survive restarts and the list is capped without forgetting that something is in doubt", async () => {
    const disk = new Disk()
    const l = new WriteLedger(disk)
    for (let i = 0; i < MAX_MARKERS + 4; i++) await l.begin(`t${i}`, 5)
    const list = await new WriteLedger(disk).list() // a new ledger over the same disk
    expect(list.length).toBeLessThanOrEqual(MAX_MARKERS)
    expect(list.some((m) => m.ambiguous)).toBe(true)
    expect(list.filter((m) => !m.ambiguous).map((m) => m.digest)).toContain(await digestText(`t${MAX_MARKERS + 3}`))
  })

  it("unreadable or old-format markers make the next read cautious instead of being dropped", () => {
    expect(parseMarkers(undefined)).toEqual([])
    expect(parseMarkers("junk")[0]).toMatchObject({ ambiguous: true })
    const old = parseMarkers([{ subjects: [], tasks: [], tags: [], mates: [], reminders: [] }]) // the earlier format: whole copies
    expect(old).toHaveLength(1)
    expect(old[0].ambiguous).toBe(true)
    const mixed = parseMarkers([{ id: "a", sentText: "x", expectedRev: 2, at: 1 }, { id: 3 }])
    expect(mixed.map((m) => !!m.ambiguous)).toEqual([false, true])
    const d = decideIngest({ stored: { rev: 2, text: "q" }, localRev: 1, base: { rev: 1 }, markers: old, source: "pull" })
    expect(d).toMatchObject({ kind: "merge", useBase: false, why: "ambiguous-write" })
  })
})

describe("D1: base and revision that do not correspond, a damaged revision, a store behind us", () => {
  it("no write in doubt but the base is recorded at a different revision than the one we hold: cautious", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    a.base = { rev: 0, data: w.baseData } // e.g. a crash between recording the base and the revision
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    expect(await a.pull()).toMatchObject({ kind: "merged", why: "unproven-base" })
    expect(covered(a.data)).toBe(1)
  })

  it("a base recorded before revisions were kept with it is still trusted when no write is in doubt (as before) but not when one is", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    a.base = { rev: null, data: w.baseData }
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    expect(await a.pull()).toMatchObject({ kind: "merged", why: undefined })
    expect(covered(a.data)).toBe(2)

    const w2 = world(0)
    const a2 = w2.mk(data({ subjects: w2.baseData.subjects, mates: [mate(1)] }))
    a2.base = { rev: null, data: w2.baseData }
    w2.store.next = "lose"
    await a2.push()
    w2.store.other(data({ subjects: w2.baseData.subjects, mates: [mate(1)] }))
    expect(await a2.pull()).toMatchObject({ kind: "merged", why: "unproven-base" })
  })

  it.each(["NaN", "-3", "1.5", "banana"])("a damaged recorded revision (%p) is discarded; the next read rebuilds cautiously and recovers", async (bad) => {
    const w = world(0)
    const a = new Device(w.store, new Disk(), { rev: bad, base: { rev: 1, data: w.baseData }, data: data({ subjects: w.baseData.subjects, mates: [mate(2)] }) })
    expect(a.rev).toBeNull()
    expect(a.revCorrupt).toBe(true)
    const out = await a.pull()
    expect(out).toMatchObject({ kind: "merged", why: "corrupt-rev" })
    expect(a.rev).toBe(1) // a valid revision again
    expect(Number.isNaN(a.rev)).toBe(false)
    expect(a.revCorrupt).toBe(false)
    expect(covered(a.data)).toBe(2)
    expect(a.notices).toEqual(["corrupt-rev"])
    expect((await a.push()).ok).toBe(true) // synchronisation works again
  })

  it("the stored copy is BEHIND the revision recorded here: rebaselined from a fresh read, once, without a loop", async () => {
    const w = world(0)
    w.store.rev = 3
    const a = w.mk(data({ subjects: [...w.baseData.subjects, sub("s2", "Anatomy")], mates: [mate(2)] }))
    a.rev = 7 // this device remembers revision 7; the store (restored or reset) is at 3
    a.base = { rev: 7, data: w.baseData }
    expect(await a.pull("live")).toEqual({ kind: "ignored" }) // a listener snapshot may just be older than our latest write
    expect(a.merges).toBe(0)
    const out = await a.pull("pull")
    expect(out).toMatchObject({ kind: "merged", why: "remote-behind" })
    expect(a.rev).toBe(3)
    expect(a.data.subjects.map((s) => s.name).sort()).toEqual(["Anatomy", "DBMS"])
    expect(a.notices).toEqual(["remote-behind"])
    expect((await listRestorePoints()).length).toBeGreaterThan(0)
    expect((await a.push()).ok).toBe(true) // expected 3 now: it lands instead of conflicting for ever
    expect(w.store.rev).toBe(4)
    expect(await a.pull()).toEqual({ kind: "unchanged" })
  })
})

describe("D1: ingest is serialised", () => {
  it("a pull and a listener event arriving together cannot both consume the same marker", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "apply-then-lose"
    await a.push()
    const [x, y] = await Promise.all([a.pull("pull"), a.pull("live")])
    expect([x.kind, y.kind].sort()).toEqual(["landed", "unchanged"])
    expect(a.adopted).toBe(1)
    expect(a.merges).toBe(0)
    expect(covered(a.data)).toBe(2)
    expect(await a.markers()).toEqual([])
  })

  it("the same for a merge: it runs once, the second sees the revision the first recorded", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "lose"
    await a.push()
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(1)] }))
    const outs = await Promise.all([a.pull(), a.pull(), a.pull("live")])
    expect(outs.filter((o) => o.kind === "merged")).toHaveLength(1)
    expect(a.merges).toBe(1)
    expect(covered(a.data)).toBe(3) // not 4, not 5
  })

  it("jobs never overlap, and a failing job does not block the next", async () => {
    const log: string[] = []
    let n = 0
    const ledger = new WriteLedger(new Disk())
    const ing = createIngestor({
      ledger,
      getRev: () => 0,
      revCorrupt: () => false,
      loadBase: async () => null,
      merge: async () => {
        const id = ++n
        log.push(`start${id}`)
        await new Promise((r) => setTimeout(r, 1))
        log.push(`end${id}`)
        if (id === 1) throw new Error("not protected")
        return false
      },
      adoptLanded: async () => {},
    })
    const doc = { data: buildBackup(data(), false), rev: 1 }
    const outs = await Promise.all([ing.ingest(doc), ing.ingest(doc)])
    expect(outs[0]).toEqual({ kind: "failed", reason: "unprotected" })
    expect(outs[1].kind).toBe("merged")
    expect(log).toEqual(["start1", "end1", "start2", "end2"])
  })

  it("a safety copy that cannot be saved leaves the markers in place and replaces nothing", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "apply-then-lose"
    await a.push()
    w.store.other(data({ subjects: w.baseData.subjects, mates: [mate(3)] }))
    const before = a.data
    const broken = createIngestor({
      ledger: a.ledger,
      getRev: () => a.rev,
      revCorrupt: () => false,
      loadBase: async () => a.base,
      merge: async () => {
        throw new Error("restore point could not be saved")
      },
      adoptLanded: async () => {},
    })
    const out = await broken.ingest(w.store.doc!, "pull")
    expect(out).toEqual({ kind: "failed", reason: "unprotected" })
    expect(a.data).toBe(before)
    expect((await a.markers()).length).toBe(1)
  })
})

describe("the hook uses all of this", () => {
  const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
  it("records base and revision together, base first, and clears markers only through the ingestor / putTracked", () => {
    expect(hook).toMatch(/await dbSet\(BASE2_KEY, \{ rev, data: d \}\)/)
    expect(hook).toMatch(/await setBase\(cloud, rev\) \/\/ the base first, then the revision it is at\s*revRef\.current = rev/)
    expect(hook).toMatch(/putTracked\(ledger, boundedPut, owner,/)
    expect(hook).not.toMatch(/Number\(rev\)/) // no unvalidated Number(...) of a stored revision
  })
  it("validates the stored revision and sends the listener's snapshots as 'live'", () => {
    expect(hook).toMatch(/normalizeRev\(read\(REV_KEY\)\)/)
    expect(hook).toMatch(/ingest\(doc, "live", can\)/)
  })
})

describe("markers keep a digest, not the text", () => {
  it("a marker is small, holds no copy of the data, and still tells our exact text from any other at R+1", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "apply-then-lose"
    await a.push()
    const stored = a.disk.value as WriteMarker[]
    expect(stored).toHaveLength(1)
    expect(stored[0].sentText).toBeUndefined()
    expect(stored[0].digest).toMatch(/^sha256:\d+:[0-9a-f]{64}$/)
    expect(JSON.stringify(stored).length).toBeLessThan(300)
    expect(JSON.stringify(stored).length).toBeLessThan(w.store.lastText!.length) // the point of the change
    expect(await a.pull()).toEqual({ kind: "landed" }) // exact payload recognised from the digest alone
  })

  it("the same data written differently (or one character off) at R+1 is NOT recognised as ours", async () => {
    for (const mutate of [(t: string) => t + " ", (t: string) => t.replace("DBMS", "DBMs"), (t: string) => JSON.stringify(JSON.parse(t), null, 2)]) {
      const w = world(0)
      const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
      w.store.next = "apply-then-lose"
      await a.push()
      w.store.text = mutate(w.store.lastText!)
      const out = await a.pull()
      expect(out.kind).toBe("merged")
      expect(a.adopted).toBe(0)
    }
  })

  it("the digest includes the length, so texts of different length can never match", async () => {
    const a = await digestText("abc")
    const b = await digestText("abcd")
    expect(a?.split(":")[1]).toBe("3")
    expect(b?.split(":")[1]).toBe("4")
    expect(await digestText("abc")).toBe(a)
  })

  it("markers written before digests existed (they hold the whole text) are still read and still settle exactly", () => {
    const legacy = [{ id: "old", sentText: "TEXT", expectedRev: 3, at: 1 }]
    const parsed = parseMarkers(legacy)
    expect(parsed).toEqual(legacy)
    expect(decideIngest({ stored: { rev: 4, text: "TEXT" }, localRev: 3, base: { rev: 3 }, markers: parsed, source: "pull" }).kind).toBe("landed")
    expect(decideIngest({ stored: { rev: 4, text: "TEXT2" }, localRev: 3, base: { rev: 3 }, markers: parsed, source: "pull" }).kind).toBe("merge")
  })

  it("through the whole path: an old marker with the text, on disk, from before this version, is honoured after a restart", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    tick()
    const text = buildBackup(a.data, false)
    a.disk.value = [{ id: "old", sentText: text, expectedRev: 1, at: 1 }]
    w.store.rev = 2
    w.store.text = text
    expect(await a.restart().pull()).toEqual({ kind: "landed" })
  })

  it("new and old markers can sit side by side; a success clears both kinds", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    a.disk.value = [{ id: "old", sentText: "x", expectedRev: 1, at: 1 }]
    const b = a.restart()
    w.store.next = "lose"
    await b.push()
    expect((await b.markers()).map((m) => (m.digest ? "digest" : "text")).sort()).toEqual(["digest", "text"])
    expect((await b.push()).ok).toBe(true)
    expect(await b.markers()).toEqual([])
  })

  it("a marker is never cleared by anything but a settled outcome: deferral, failure to protect and 'unchanged' keep it", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    w.store.next = "lose"
    await a.push()
    expect(await a.pull()).toEqual({ kind: "unchanged" })
    expect((await a.markers()).length).toBe(1)
    const deferred = await a.ingestor.ingest(w.store.doc!, "pull", () => false)
    expect(deferred).toEqual({ kind: "failed", reason: "deferred" })
    expect((await a.markers()).length).toBe(1)
  })

  it("storage that refuses the marker: the write is not made (the digest is stored and read back like the text was)", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    a.disk.failSave = true
    expect(await a.push()).toEqual({ ok: false, reason: "unavailable" })
    expect(w.store.puts).toBe(0)
  })

  it("without crypto.subtle a lighter digest is used and settles the same way; a SHA-256 marker that cannot be compared is treated as in doubt, never as 'not ours'", async () => {
    const w = world(0)
    const a = w.mk(data({ subjects: w.baseData.subjects, mates: [mate(2)] }))
    const real = globalThis.crypto
    vi.stubGlobal("crypto", {})
    try {
      w.store.next = "apply-then-lose"
      await a.push()
      expect((a.disk.value as WriteMarker[])[0].digest).toMatch(/^fnv:/)
    } finally {
      vi.stubGlobal("crypto", real)
    }
    expect(await a.pull()).toEqual({ kind: "landed" }) // computed with the marker's own kind of digest, even though SHA-256 is back

    const w2 = world(0)
    const b = w2.mk(data({ subjects: w2.baseData.subjects, mates: [mate(2)] }))
    w2.store.next = "apply-then-lose"
    await b.push()
    const marker = (b.disk.value as WriteMarker[])[0]
    const d = decideIngest({ stored: { rev: 2, text: w2.store.text!, digests: {} }, localRev: 1, base: { rev: 1 }, markers: [marker], source: "pull" }) // cannot compute sha256 now
    expect(d).toMatchObject({ kind: "merge", useBase: false, why: "ambiguous-write" })
  })
})
