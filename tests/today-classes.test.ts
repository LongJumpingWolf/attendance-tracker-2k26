import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { classesOn, dayClasses, dayProgress, markFor, slotMeta, withSet } from "@/lib/attendance"
import { dbGet, dbSet } from "@/lib/db"
import { mergeData } from "@/lib/merge"
import type { Slot, Subject } from "@/lib/types"

// Wednesday 7 Oct 2026 (getDay() === 3) and Thursday 8 Oct 2026 (4)
const WED = new Date(2026, 9, 7, 10, 0)
const THU = new Date(2026, 9, 8, 10, 0)
const DATE = "2026-10-07"

const slot = (day: number, start: string, end: string, kind?: string): Slot => ({ day, start, end, ...(kind ? { kind } : {}) })
const subject = (id: string, name: string, slots?: Slot[], over: Partial<Subject> = {}): Subject => ({
  id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], ...(slots ? { slots } : {}), ...over,
})

describe("Today lists only real classes", () => {
  const scheduledToday = subject("a", "Pharmacology", [slot(3, "09:00", "10:00", "Lecture")])
  const otherDay = subject("b", "Anatomy", [slot(4, "11:00", "12:00")]) // Thursday only
  const noTimetable = subject("c", "Ethics") // no slots at all

  it("does not list a subject that is not scheduled today", () => {
    const names = dayClasses([scheduledToday, otherDay, noTimetable], WED).map((c) => c.subject.name)
    expect(names).not.toContain("Anatomy")
  })

  it("does not list a subject with no timetable", () => {
    expect(dayClasses([scheduledToday, otherDay, noTimetable], WED).map((c) => c.subject.name)).toEqual(["Pharmacology"])
  })

  it("lists a scheduled subject", () => {
    const [c] = dayClasses([scheduledToday], WED)
    expect(c.subject.id).toBe("a")
    expect(c.slot.start).toBe("09:00")
    expect(c.state).toBeNull()
  })

  it("lists the same subject's lectures as separate classes, each marked on its own", () => {
    const twice = subject("d", "Biochem", [slot(3, "09:00", "10:00"), slot(3, "14:00", "15:00", "Practical")])
    let s = twice
    expect(dayClasses([s], WED)).toHaveLength(2)
    s = withSet(s, DATE, "P", slotMeta(s.slots![0]))
    const after = dayClasses([s], WED)
    expect(after.map((c) => c.state)).toEqual(["P", null]) // the afternoon lecture is still unmarked
    s = withSet(s, DATE, "A", slotMeta(s.slots![1]))
    expect(dayClasses([s], WED).map((c) => c.state)).toEqual(["P", "A"])
    expect(s.attended).toBe(1)
    expect(s.missed).toBe(1)
  })

  it("lists a class once even if the timetable holds it twice", () => {
    const dup = subject("e", "Dup", [slot(3, "09:00", "10:00"), slot(3, "09:00", "10:00")])
    expect(classesOn([dup], WED)).toHaveLength(1)
  })

  it("counts only unmarked real classes, not every subject", () => {
    const subjects = [scheduledToday, otherDay, noTimetable, subject("f", "Physio", [slot(3, "13:00", "14:00")])]
    expect(dayProgress(dayClasses(subjects, WED))).toEqual({ total: 2, toMark: 2, allDone: false })
    const marked = subjects.map((s) => (s.id === "a" ? withSet(s, DATE, "P", slotMeta(s.slots![0])) : s))
    expect(dayProgress(dayClasses(marked, WED))).toEqual({ total: 2, toMark: 1, allDone: false })
  })

  it("is all done once every real class is marked, however many other subjects exist", () => {
    const subjects = [scheduledToday, otherDay, noTimetable]
    const marked = subjects.map((s) => (s.id === "a" ? withSet(s, DATE, "A", slotMeta(s.slots![0])) : s))
    expect(dayProgress(dayClasses(marked, WED))).toEqual({ total: 1, toMark: 0, allDone: true })
  })

  it("a day with no classes is not 'all done'", () => {
    expect(dayProgress(dayClasses([otherDay, noTimetable], WED))).toEqual({ total: 0, toMark: 0, allDone: false })
  })

  it("a subject on its other day is listed then, not today", () => {
    expect(dayClasses([otherDay], THU).map((c) => c.subject.id)).toEqual(["b"])
  })
})

describe("a class is counted once", () => {
  const base = subject("a", "Pharmacology", [slot(3, "09:00", "10:00", "Lecture")])
  const meta = slotMeta(base.slots![0])

  it("marking the same class present twice (a double tap) counts one", () => {
    const once = withSet(base, DATE, "P", meta)
    const twice = withSet(once, DATE, "P", meta)
    expect(twice).toBe(once) // nothing changed at all
    expect(twice.attended).toBe(1)
    expect(twice.log).toHaveLength(1)
  })

  it("changing a mark moves the count instead of adding another", () => {
    const p = withSet(base, DATE, "P", meta)
    const a = withSet(p, DATE, "A", meta)
    expect(a.attended).toBe(0)
    expect(a.missed).toBe(1)
    expect(a.log).toHaveLength(1)
  })

  it("Today and Subject Detail write the very same record for a class", () => {
    // Both screens derive the mark details with slotMeta(slot) from the class's slot, then call withSet
    const fromToday = withSet(base, DATE, "P", slotMeta(dayClasses([base], WED)[0].slot))
    const fromDetail = withSet(base, DATE, "P", slotMeta(classesOn([base], WED)[0].slot))
    expect(fromDetail).toEqual(fromToday)
    // and marking from one then the other is still one count
    const both = withSet(fromToday, DATE, "P", slotMeta(classesOn([fromToday], WED)[0].slot))
    expect(both.attended).toBe(1)
    expect(both.log).toHaveLength(1)
  })

  it("a class marked on Today shows as marked from Subject Detail", () => {
    const s = withSet(base, DATE, "P", meta)
    expect(markFor(s, DATE, classesOn([s], WED)[0].slot.start)).toBe("P")
  })

  it("re-rendering or reopening does not add a mark: reading is pure", () => {
    const s = withSet(base, DATE, "P", meta)
    const first = dayClasses([s], WED)
    const again = dayClasses([s], WED)
    expect(again).toEqual(first)
    expect(s.log).toHaveLength(1)
  })

  it("two devices marking the same class merge into one record (realtime / sync)", () => {
    const synced = { subjects: [base], tasks: [], tags: [], mates: [], reminders: [] }
    const a = withSet(base, DATE, "P", meta)
    const merged = mergeData(synced, { ...synced, subjects: [a] }, { ...synced, subjects: [a] }).data.subjects[0]
    expect(merged.attended).toBe(1)
    expect(merged.log).toHaveLength(1)
  })
})

describe("marking works offline and survives a restart", () => {
  const m = new Map<string, string>()
  beforeEach(() => {
    m.clear()
    vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) })
    vi.stubGlobal("navigator", { onLine: false }) // no connection at all
  })
  afterEach(() => vi.unstubAllGlobals())

  it("marking needs no network and is still there on the next launch", async () => {
    const base = subject("a", "Pharmacology", [slot(3, "09:00", "10:00")])
    const marked = withSet(base, DATE, "P", slotMeta(base.slots![0]))
    await dbSet("subjects", [marked]) // what the app does after every change
    const reopened = await dbGet<Subject[]>("subjects") // a fresh launch reads only what was stored
    expect(markFor(reopened![0], DATE, "09:00")).toBe("P")
    expect(reopened![0].attended).toBe(1)
  })
})
