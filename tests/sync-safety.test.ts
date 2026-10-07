import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DOC_LIMIT_BYTES, cloudPut, firestoreDocBytes, pack, unpack } from "@/lib/cloud-sync"
import { buildBackup, parseFullBackup, type FullBackupData } from "@/lib/backup"
import { dbGet, dbSet } from "@/lib/db"
import { mergeData } from "@/lib/merge"
import { deleteRestorePoint, listRestorePoints, saveRestorePoint } from "@/lib/restore-points"
import type { Subject } from "@/lib/types"

/** A tiny stand-in for the browser's storage. Node has no IndexedDB, so lib/db.ts uses its localStorage fallback here. */
function stubStorage() {
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  return m
}

const sub = (over: Partial<Subject> = {}): Subject => ({
  id: "s1", name: "DBMS", attended: 2, missed: 0, requirement: 75, glowColor: "#000", tags: [],
  log: [{ d: "2026-10-01", s: "P" }, { d: "2026-10-02", s: "P" }], ...over,
})
const data = (subjects: Subject[], extra: Partial<FullBackupData> = {}): FullBackupData => ({ subjects, tasks: [], tags: [], mates: [], reminders: [], ...extra })

describe("document size protection", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("counts Firestore's own overhead, not just the text", () => {
    const text = "x".repeat(1000)
    expect(firestoreDocBytes("owner123", text)).toBeGreaterThan(1000 + 32)
    expect(DOC_LIMIT_BYTES).toBeLessThan(1_048_576)
  })

  it("rejects an oversized compressed document before sending anything", async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal("fetch", fetchSpy)
    // Random text does not compress, so even gzipped it stays far over the limit
    const noise = Array.from({ length: 1_000_000 }, () => String.fromCharCode(33 + Math.floor(Math.random() * 90))).join("")
    const packed = await pack(noise)
    expect(firestoreDocBytes("owner123", packed)).toBeGreaterThan(DOC_LIMIT_BYTES)
    const r = await cloudPut("owner123", noise, 3)
    expect(r).toEqual({ ok: false, reason: "too-large" })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it("lets a normal, even multi-year, backup through", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ rev: 4 }), { status: 200 })))
    const log = Array.from({ length: 3650 * 3 }, (_, i) => ({ d: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, s: "P" as const, t: `${8 + (i % 10)}:00`, k: "Lecture" }))
    const text = buildBackup(data([sub({ log })]), false)
    expect(await cloudPut("owner123", text, 3)).toEqual({ ok: true, rev: 4 })
  })

  it("still reads a document stored uncompressed by an earlier version", async () => {
    const plain = buildBackup(data([sub()]), false)
    const parsed = parseFullBackup(await unpack(plain))
    expect(parsed.ok && parsed.data.subjects[0].name).toBe("DBMS")
    const compressed = parseFullBackup(await unpack(await pack(plain)))
    expect(compressed.ok && compressed.data.subjects[0].name).toBe("DBMS")
  })
})

describe("data on this device", () => {
  beforeEach(() => void stubStorage())
  afterEach(() => vi.unstubAllGlobals())

  it("an offline edit is still there after a restart (a fresh read of storage)", async () => {
    await dbSet("subjects", [sub()])
    await dbSet("subjects", [sub({ attended: 3, log: [...(sub().log ?? []), { d: "2026-10-03", s: "P" }] })]) // the offline edit
    const afterRestart = await dbGet<Subject[]>("subjects") // a new session knows nothing but what is stored
    expect(afterRestart?.[0].attended).toBe(3)
    expect(afterRestart?.[0].log).toHaveLength(3)
  })
})

describe("restore points", () => {
  beforeEach(() => void stubStorage())
  afterEach(() => vi.unstubAllGlobals())

  it("keeps every point, however many, until the person deletes one", async () => {
    for (let i = 0; i < 25; i++) await saveRestorePoint(`point ${i}`, data([sub({ attended: i + 1 })]))
    expect(await listRestorePoints()).toHaveLength(25)
    const [newest] = await listRestorePoints()
    await deleteRestorePoint(newest.id)
    expect(await listRestorePoints()).toHaveLength(24)
  })

  it("skips empty data and an exact repeat of the newest point", async () => {
    await saveRestorePoint("empty", data([]))
    await saveRestorePoint("a", data([sub()]))
    await saveRestorePoint("a again", data([sub()]))
    expect(await listRestorePoints()).toHaveLength(1)
  })

  it("holds subjects, marks, deadlines, mates, tags and reminders so a restore brings them all back", async () => {
    const full = data([sub()], {
      tasks: [{ id: "t1", title: "Viva", dueDate: "2026-11-01" }],
      tags: ["core"],
      mates: [{ id: "m1", name: "Arjun", covered: 2, repaid: 1 }],
      reminders: [{ id: "r1", day: 1, startTime: "09:00", endTime: "10:00", subjectName: "DBMS" } as never],
    })
    await saveRestorePoint("everything", full)
    const [p] = await listRestorePoints()
    expect(p.data).toEqual(full)
  })
})

describe("restoring an older backup while newer cloud data exists", () => {
  // base = last synced copy, cloud = what another device has done since, restored = the old backup put back on this device
  const marks = (n: number) => Array.from({ length: n }, (_, i) => ({ d: `2026-10-${String(i + 1).padStart(2, "0")}`, s: "P" as const }))
  const base = data([sub({ attended: 5, log: marks(5) }), sub({ id: "s2", name: "OS", attended: 1, log: marks(1) })])
  const cloud = data([sub({ attended: 6, log: [...marks(5), { d: "2026-10-06", s: "P" }] }), sub({ id: "s2", name: "OS", attended: 1, log: marks(1) })])
  const restored = data([sub({ attended: 2, log: marks(2) })]) // the older backup: fewer marks, and no OS

  it("does not let the newer cloud copy undo the restore, and loses nothing the other device added", () => {
    const { data: merged } = mergeData(base, restored, cloud)
    const dbms = merged.subjects.find((s) => s.id === "s1")!
    // marks the restore removed stay removed...
    expect(dbms.log?.map((e) => e.d)).not.toContain("2026-10-03")
    expect(dbms.log?.map((e) => e.d)).not.toContain("2026-10-05")
    // ...but the mark only the other device made is kept, never silently dropped
    expect(dbms.log?.map((e) => e.d)).toContain("2026-10-06")
    expect(dbms.attended).toBe(3)
    // the subject the restore removed stays removed, since the other device never touched it
    expect(merged.subjects.find((s) => s.id === "s2")).toBeUndefined()
  })

  it("merging again changes nothing, so the result is not overwritten on the next sync", () => {
    const { data: once } = mergeData(base, restored, cloud)
    expect(mergeData(cloud, once, cloud).data).toEqual(once)
  })
})
