/**
 * The real IndexedDB code (lib/db.ts, lib/restore-points.ts) against a small in-memory stand-in for IndexedDB, built here, per test.
 * No dependency, no browser, no real profile. Each test gets its own fake and its own copy of the modules: they are imported AFTER
 * indexedDB is stubbed and the module registry is reset, because lib/db.ts caches its open connection (and restore points cache a
 * queue) at module level, which would otherwise leak from one test into the next.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FullBackupData } from "@/lib/backup"

interface Faults {
  /** indexedDB.open reports an error */
  openError: boolean
  /** every readwrite transaction aborts with QuotaExceededError (nothing in it is stored) */
  quota: boolean
  /** every transaction aborts, reads included */
  txError: boolean
  /** writes are acknowledged (the transaction completes) but nothing is stored */
  dropWrites: boolean
}

function fakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>()
  const faults: Faults = { openError: false, quota: false, txError: false, dropWrites: false }
  const stats = { opens: 0, transactions: 0 }
  const factory = {
    open(name: string) {
      stats.opens++
      const req: { result?: unknown; error?: unknown; onsuccess?: () => void; onerror?: () => void; onupgradeneeded?: () => void; onblocked?: () => void } = {}
      setTimeout(() => {
        if (faults.openError) {
          req.error = new Error("open failed")
          req.onerror?.()
          return
        }
        const fresh = !stores.has(name)
        if (fresh) stores.set(name, new Map())
        const data = stores.get(name)!
        req.result = {
          createObjectStore: () => ({}),
          transaction: (_store: string, mode: "readonly" | "readwrite") => {
            stats.transactions++
            const ops: (() => void)[] = []
            const tx: { error?: unknown; oncomplete?: () => void; onerror?: () => void; onabort?: () => void; objectStore: () => unknown } = {
              objectStore: () => ({
                put: (value: unknown, key: string) => {
                  const r: { result?: unknown } = {}
                  ops.push(() => {
                    if (faults.quota) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" })
                    if (faults.dropWrites) return
                    data.set(key, structuredClone(value))
                    r.result = key
                  })
                  return r
                },
                get: (key: string) => {
                  const r: { result?: unknown } = {}
                  ops.push(() => {
                    r.result = data.has(key) ? structuredClone(data.get(key)) : undefined
                  })
                  return r
                },
                delete: (key: string) => {
                  const r: { result?: unknown } = {}
                  ops.push(() => {
                    if (faults.quota) throw Object.assign(new Error("quota"), { name: "QuotaExceededError" })
                    data.delete(key)
                  })
                  return r
                },
              }),
            }
            setTimeout(() => {
              try {
                if (faults.txError) throw new Error("transaction failed")
                for (const op of ops) op()
                tx.oncomplete?.()
              } catch (e) {
                tx.error = e
                tx.onabort?.()
              }
            }, 0)
            void mode
            return tx
          },
        }
        if (fresh) req.onupgradeneeded?.()
        req.onsuccess?.()
      }, 0)
      return req
    },
  }
  return { factory, stores, faults, stats }
}

/** localStorage stand-in that can refuse writes */
function fakeLocalStorage() {
  const m = new Map<string, string>()
  const fail = { writes: false }
  const ls = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (fail.writes) throw Object.assign(new Error("storage full"), { name: "QuotaExceededError" })
      m.set(k, v)
    },
    removeItem: (k: string) => void m.delete(k),
  }
  return { ls, m, fail }
}

const point = (n: number): FullBackupData => ({
  subjects: [{ id: `s${n}`, name: `Subject ${n}`, attended: n, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [] }],
  tasks: [],
  tags: [],
  mates: [],
  reminders: [],
})

/** A new fake, new storage, new copies of the modules: nothing survives from another test */
async function fresh(opts: { withIndexedDB?: boolean } = {}) {
  vi.resetModules()
  const idb = fakeIndexedDB()
  const local = fakeLocalStorage()
  vi.stubGlobal("localStorage", local.ls)
  if (opts.withIndexedDB !== false) vi.stubGlobal("indexedDB", idb.factory)
  else vi.stubGlobal("indexedDB", undefined)
  const db = await import("@/lib/db")
  const rp = await import("@/lib/restore-points")
  return { idb, local, db, rp }
}

beforeEach(() => vi.resetModules())
afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe("lib/db.ts against an in-memory IndexedDB", () => {
  it("stores, reads and deletes through IndexedDB, not localStorage", async () => {
    const { db, idb, local } = await fresh()
    await db.dbSet("k", { a: [1, 2] })
    expect(await db.dbGet("k")).toEqual({ a: [1, 2] })
    expect(idb.stores.get("college-tracker")?.get("k")).toEqual({ a: [1, 2] })
    expect(local.m.size).toBe(0)
    await db.dbDel("k")
    expect(await db.dbGet("k")).toBeUndefined()
  })

  it("one connection is opened and reused", async () => {
    const { db, idb } = await fresh()
    await Promise.all([db.dbSet("a", 1), db.dbSet("b", 2), db.dbGet("a")])
    expect(idb.stats.opens).toBe(1)
  })

  it("a transaction that fails on quota falls back to localStorage, so the write is not dropped", async () => {
    const { db, idb, local } = await fresh()
    idb.faults.quota = true
    await db.dbSet("k", { v: 1 })
    expect(idb.stores.get("college-tracker")?.has("k")).toBe(false)
    expect(JSON.parse(local.m.get("k")!)).toEqual({ v: 1 })
    expect(await db.dbGet("k")).toEqual({ v: 1 }) // still readable: the value lives in the fallback
  })

  it("an edit saved to the fallback while IndexedDB was failing is not hidden by the older IndexedDB value on the next read", async () => {
    const { db, idb } = await fresh()
    await db.dbSet("k", { v: 1 }) // saved normally
    idb.faults.quota = true
    await db.dbSet("k", { v: 2 }) // IndexedDB refuses: the newer value goes to localStorage
    idb.faults.quota = false
    expect(await db.dbGet("k")).toEqual({ v: 2 }) // before: the stale { v: 1 } came back and the edit was lost
    expect(await db.dbGet("k")).toEqual({ v: 2 }) // and it has moved into IndexedDB now
    expect(idb.stores.get("college-tracker")?.get("k")).toEqual({ v: 2 })
  })

  it("a later normal save is never outranked by an old fallback copy", async () => {
    const { db, idb, local } = await fresh()
    idb.faults.quota = true
    await db.dbSet("k", { v: 1 })
    idb.faults.quota = false
    await db.dbSet("k", { v: 2 })
    expect(local.m.has("k")).toBe(false)
    expect(await db.dbGet("k")).toEqual({ v: 2 })
  })

  it("when quota fails on BOTH, the write is lost silently by dbSet, which is why callers that need certainty read back", async () => {
    const { db, idb, local } = await fresh()
    idb.faults.quota = true
    local.fail.writes = true
    await expect(db.dbSet("k", { v: 1 })).resolves.toBeUndefined()
    expect(await db.dbGet("k")).toBeUndefined()
  })

  it("when IndexedDB cannot be opened, everything works from localStorage, and the failed open is not retried per call", async () => {
    const { db, idb, local } = await fresh()
    idb.faults.openError = true
    await db.dbSet("k", [1])
    expect(await db.dbGet("k")).toEqual([1])
    expect(JSON.parse(local.m.get("k")!)).toEqual([1])
    await db.dbDel("k")
    expect(local.m.has("k")).toBe(false)
    expect(idb.stats.opens).toBe(1)
  })

  it("with no IndexedDB at all (some private modes) the same", async () => {
    const { db, local } = await fresh({ withIndexedDB: false })
    await db.dbSet("k", "v")
    expect(await db.dbGet("k")).toBe("v")
    expect(local.m.get("k")).toBe('"v"')
  })

  it("a failing transaction on read falls back to localStorage", async () => {
    const { db, idb, local } = await fresh()
    local.m.set("k", JSON.stringify({ old: true }))
    idb.faults.txError = true
    expect(await db.dbGet("k")).toEqual({ old: true })
  })

  it("legacy localStorage values are moved into IndexedDB on first read, and removed only after being read back", async () => {
    const { db, idb, local } = await fresh()
    local.m.set("legacy", JSON.stringify({ n: 5 }))
    expect(await db.dbGet("legacy")).toEqual({ n: 5 })
    expect(idb.stores.get("college-tracker")?.get("legacy")).toEqual({ n: 5 })
    expect(local.m.has("legacy")).toBe(false)
  })

  it("a legacy value is KEPT in localStorage when the copy into IndexedDB fails", async () => {
    const { db, idb, local } = await fresh()
    local.m.set("legacy", JSON.stringify({ n: 5 }))
    idb.faults.quota = true
    expect(await db.dbGet("legacy")).toEqual({ n: 5 })
    expect(local.m.has("legacy")).toBe(true)
    expect(idb.stores.get("college-tracker")?.has("legacy")).toBe(false)
  })

  it("separate tests do not share a connection or data", async () => {
    const { idb, db } = await fresh()
    expect(idb.stores.size).toBe(0)
    expect(await db.dbGet("k")).toBeUndefined()
  })
})

describe("restore points on the in-memory IndexedDB", () => {
  it("overlapping saves are all kept, in order, none lost to a read-then-rewrite race", async () => {
    const { rp } = await fresh()
    await Promise.all(Array.from({ length: 10 }, (_, i) => rp.saveRestorePoint(`p${i}`, point(i + 1))))
    const all = await rp.listRestorePoints()
    expect(all).toHaveLength(10)
    expect(new Set(all.map((p) => p.reason)).size).toBe(10)
    expect(all.map((p) => p.reason)).toEqual(["p9", "p8", "p7", "p6", "p5", "p4", "p3", "p2", "p1", "p0"]) // newest first
  })

  it("a save whose transaction hits quota (and the fallback is full too) fails loudly, and the queue recovers for the next save", async () => {
    const { rp, idb, local } = await fresh()
    await rp.saveRestorePoint("first", point(1))
    idb.faults.quota = true
    local.fail.writes = true
    await expect(rp.saveRestorePoint("lost", point(2))).rejects.toBeInstanceOf(rp.RestorePointError)
    idb.faults.quota = false
    local.fail.writes = false
    await rp.saveRestorePoint("after", point(3))
    expect((await rp.listRestorePoints()).map((p) => p.reason)).toEqual(["after", "first"])
  })

  it("when IndexedDB cannot be opened, restore points are kept in localStorage and read back", async () => {
    const { rp, idb, local } = await fresh()
    idb.faults.openError = true
    await rp.saveRestorePoint("fallback", point(1))
    expect((await rp.listRestorePoints()).map((p) => p.reason)).toEqual(["fallback"])
    expect(local.m.has("restorePoints")).toBe(true)
  })

  it("with no IndexedDB and a full localStorage the save is refused, not claimed", async () => {
    const { rp, local } = await fresh({ withIndexedDB: false })
    local.fail.writes = true
    await expect(rp.saveRestorePoint("x", point(1))).rejects.toBeInstanceOf(rp.RestorePointError)
    expect(await rp.listRestorePoints()).toEqual([])
  })

  it("restore points that still live in localStorage from before IndexedDB are found and moved", async () => {
    const { rp, local, idb } = await fresh()
    const old = [{ id: "old1", at: 1, reason: "legacy", data: point(9) }]
    local.m.set("restorePoints", JSON.stringify(old))
    expect((await rp.listRestorePoints()).map((p) => p.id)).toEqual(["old1"])
    expect(idb.stores.get("college-tracker")?.has("restorePoints")).toBe(true)
    await rp.saveRestorePoint("new", point(1))
    expect((await rp.listRestorePoints()).map((p) => p.reason)).toEqual(["new", "legacy"]) // nothing from before was lost
  })

  it("an identical copy is not saved twice and an empty copy is never saved", async () => {
    const { rp } = await fresh()
    await rp.saveRestorePoint("a", point(1))
    await rp.saveRestorePoint("b", point(1))
    await rp.saveRestorePoint("empty", { subjects: [], tasks: [], tags: [], mates: [], reminders: [] })
    expect((await rp.listRestorePoints()).map((p) => p.reason)).toEqual(["a"])
  })

  it("a tags-only and a reminders-only copy are saved and read back through IndexedDB", async () => {
    const { rp } = await fresh()
    await rp.saveRestorePoint("tags", { subjects: [], tasks: [], tags: ["core"], mates: [], reminders: [] })
    await rp.saveRestorePoint("reminders", { subjects: [], tasks: [], tags: [], mates: [], reminders: [{ id: "r", day: 1, startTime: "09:00", endTime: "10:00", subjectName: "X", notifyOffset: 5, notifyWhen: "before" }] })
    const all = await rp.listRestorePoints()
    expect(all.map((p) => p.reason)).toEqual(["reminders", "tags"])
    expect(all[1].data.tags).toEqual(["core"])
  })

  it("a write the database acknowledges but does not keep is caught by the read-back: nothing is claimed", async () => {
    const { rp, idb } = await fresh()
    idb.faults.dropWrites = true
    await expect(rp.saveRestorePoint("x", point(1))).rejects.toBeInstanceOf(rp.RestorePointError)
    idb.faults.dropWrites = false
    await rp.saveRestorePoint("y", point(2)) // and the queue is still usable
    expect((await rp.listRestorePoints()).map((p) => p.reason)).toEqual(["y"])
  })

  it("an older point (no reminders list) stored in IndexedDB is read with empty lists and written back untouched", async () => {
    const { rp, idb } = await fresh()
    await (await import("@/lib/db")).dbSet("restorePoints", [{ id: "old", at: 1, reason: "legacy", data: { subjects: point(1).subjects, tasks: [] } }])
    const [p] = await rp.listRestorePoints()
    expect(p.remindersKnown).toBe(false)
    expect(p.data.reminders).toEqual([])
    await rp.saveRestorePoint("new", point(2))
    const raw = idb.stores.get("college-tracker")!.get("restorePoints") as { id: string; data: Record<string, unknown> }[]
    expect(raw.find((r) => r.id === "old")!.data).not.toHaveProperty("reminders")
  })

  it("persistence checks read the real store: dataPersisted is true only when IndexedDB holds the data, resetIsComplete only when it is gone", async () => {
    const { db, idb } = await fresh()
    const v = await import("@/lib/replace-verify")
    const wanted = { subjects: point(1).subjects, tasks: [], tags: ["t"], mates: [], reminders: [] }
    expect(await v.dataPersisted(wanted, 40, 10)).toBe(false)
    await db.dbSet("subjects", wanted.subjects)
    await db.dbSet("tasks", [])
    await db.dbSet("tags", ["t"])
    await db.dbSet("mates", [])
    expect(await v.dataPersisted(wanted, 40, 10)).toBe(true)
    expect(await v.resetIsComplete(40, 10)).toBe(false)
    for (const k of v.RESET_DB_KEYS) await db.dbDel(k)
    expect(await v.resetIsComplete(40, 10)).toBe(true)
    idb.faults.dropWrites = true
    await db.dbSet("subjects", wanted.subjects) // acknowledged, not kept
    expect(await v.dataPersisted(wanted, 40, 10)).toBe(false)
  })
})
