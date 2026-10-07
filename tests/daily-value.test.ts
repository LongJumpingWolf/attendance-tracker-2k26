import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { classVerdict, dayClasses, entryFor, getAttendance, markFor, markWithUndo, restoreMark, skipVerdict, slotMeta, withSet } from "@/lib/attendance"
import { dbGet, dbSet } from "@/lib/db"
import { mergeData } from "@/lib/merge"
import type { Slot, Subject } from "@/lib/types"

const WED = new Date(2026, 9, 7, 10, 0) // Wednesday 7 Oct 2026 (day 3)
const TODAY = "2026-10-07"
const YESTERDAY = "2026-10-06" // Tuesday (day 2)
const OLDER = "2026-09-15" // Tuesday (day 2), three weeks earlier

const everyDay = (...times: [string, string, string?][]): Slot[] =>
  [0, 1, 2, 3, 4, 5, 6].flatMap((day) => times.map(([start, end, kind]) => ({ day, start, end, ...(kind ? { kind } : {}) })))
const subject = (id: string, name: string, attended: number, missed: number, slots?: Slot[], requirement = 75): Subject => ({
  id, name, attended, missed, requirement, glowColor: "#000", tags: [], ...(slots ? { slots } : {}),
})
const pct = (s: Subject) => getAttendance(s.attended, s.missed, s.requirement).pct
const lecture = (s: Subject, n: number) => slotMeta(s.slots![n])
const classesOfSubjectOn = (s: Subject, date: Date) => dayClasses([s], date)

describe("percentage updates from the same marks", () => {
  it("Present raises it straight away", () => {
    const s = subject("a", "Pharm", 8, 2, everyDay(["09:00", "10:00"])) // 80%
    expect(classVerdict(s).pct).toBe(80)
    const { next } = markWithUndo(s, TODAY, "P", lecture(s, 0))
    expect(classVerdict(next).pct).toBe(82) // 9 of 11
    expect(next.attended + next.missed).toBe(11)
  })

  it("Absent lowers it straight away", () => {
    const s = subject("a", "Pharm", 8, 2, everyDay(["09:00", "10:00"]))
    const { next } = markWithUndo(s, TODAY, "A", lecture(s, 0))
    expect(classVerdict(next).pct).toBe(73) // 8 of 11
  })

  it("two lectures of one subject each move it, in order", () => {
    let s = subject("a", "Pharm", 8, 2, everyDay(["09:00", "10:00"], ["14:00", "15:00", "Practical"]))
    s = markWithUndo(s, TODAY, "P", lecture(s, 0)).next
    expect(pct(s)).toBe(82) // 9/11
    s = markWithUndo(s, TODAY, "A", lecture(s, 1)).next
    expect(pct(s)).toBe(75) // 9/12
  })

  it("shows no percentage rather than a misleading 0% before anything is marked", () => {
    const v = classVerdict(subject("a", "New", 0, 0, everyDay(["09:00", "10:00"])))
    expect(v.pct).toBeNull()
    expect(v.kind).toBe("nodata")
  })
})

describe("the verdict comes from the existing skip rule and tracks the marks", () => {
  it("is the rule the skip widget used: not below the minimum with a skip to spare = skip", () => {
    expect(skipVerdict(getAttendance(9, 1, 75))).toBe("skip")
    expect(skipVerdict(getAttendance(3, 1, 75))).toBe("attend") // exactly at the edge, no skip to spare
    expect(skipVerdict(getAttendance(1, 3, 75))).toBe("attend")
    expect(skipVerdict(getAttendance(0, 0, 75))).toBe("nodata")
    expect(skipVerdict(getAttendance(1, 0, 0))).toBe("skip") // no minimum set
  })

  it("moves from SAFE TO SKIP to MUST ATTEND to ATTEND TO REACH TARGET as absences are marked", () => {
    let s = subject("a", "Pharm", 9, 1, everyDay(["09:00", "10:00"], ["11:00", "12:00"], ["14:00", "15:00"], ["16:00", "17:00"]))
    const label = () => classVerdict(s).label
    expect(label()).toBe("SAFE TO SKIP") // 90%, 2 skips to spare
    s = markWithUndo(s, TODAY, "A", lecture(s, 0)).next
    expect(label()).toBe("SAFE TO SKIP") // 82%, 1 skip left
    s = markWithUndo(s, TODAY, "A", lecture(s, 1)).next
    expect(label()).toBe("MUST ATTEND") // 75%, none left
    s = markWithUndo(s, TODAY, "A", lecture(s, 2)).next
    expect(label()).toBe("ATTEND TO REACH TARGET") // 69%, below 75%
    expect(classVerdict(s).detail).toMatch(/Attend next \d+/)
  })

  it("goes back up when a mark is corrected to present", () => {
    let s = subject("a", "Pharm", 9, 3, everyDay(["09:00", "10:00"])) // 75%, at the edge
    expect(classVerdict(s).kind).toBe("must")
    s = withSet(s, TODAY, "P", lecture(s, 0))
    s = withSet(s, TODAY, "P", lecture(s, 0)) // same again changes nothing
    expect(classVerdict(s).pct).toBe(77)
  })
})

describe("past days can be marked and corrected", () => {
  const s0 = subject("a", "Biochem", 5, 1, everyDay(["09:00", "10:00", "Lecture"], ["14:00", "15:00", "Practical"]))

  it("the timetable gives the classes for yesterday", () => {
    expect(classesOfSubjectOn(s0, new Date(2026, 9, 6)).map((c) => c.slot.start)).toEqual(["09:00", "14:00"])
  })

  it("yesterday can be marked and then corrected", () => {
    let s = withSet(s0, YESTERDAY, "P", lecture(s0, 0))
    expect(markFor(s, YESTERDAY, "09:00")).toBe("P")
    expect(pct(s)).toBe(Math.round((6 / 7) * 100)) // 6 of 7
    s = withSet(s, YESTERDAY, "A", lecture(s0, 0)) // correct it
    expect(markFor(s, YESTERDAY, "09:00")).toBe("A")
    expect(s.attended).toBe(5)
    expect(s.missed).toBe(2)
  })

  it("an older date can be edited the same way", () => {
    let s = withSet(s0, OLDER, "A", lecture(s0, 1))
    expect(markFor(s, OLDER, "14:00")).toBe("A")
    s = withSet(s, OLDER, null, lecture(s0, 1)) // leave it unmarked after all
    expect(markFor(s, OLDER, "14:00")).toBeNull()
    expect(s.attended).toBe(5)
    expect(s.missed).toBe(1)
  })

  it("two lectures on a past date are separate records", () => {
    let s = withSet(s0, OLDER, "P", lecture(s0, 0))
    s = withSet(s, OLDER, "A", lecture(s0, 1))
    expect(dayClasses([s], new Date(2026, 8, 15)).map((c) => c.state)).toEqual(["P", "A"])
    s = withSet(s, OLDER, null, lecture(s0, 0)) // clearing the first leaves the second
    expect(dayClasses([s], new Date(2026, 8, 15)).map((c) => c.state)).toEqual([null, "A"])
  })

  it("editing a past mark changes the calculated attendance and the verdict", () => {
    let s = subject("a", "Pharm", 9, 1, everyDay(["09:00", "10:00"])) // 90%
    const before = classVerdict(s)
    s = withSet(s, OLDER, "A", lecture(s, 0)) // an absence discovered for three weeks ago
    expect(classVerdict(s).pct).toBe(82)
    expect(classVerdict(s).pct).not.toBe(before.pct)
  })

  it("a day with no classes has nothing to mark", () => {
    const tueOnly = subject("t", "TuesdayOnly", 0, 0, [{ day: 2, start: "09:00", end: "10:00" }])
    expect(dayClasses([tueOnly], new Date(2026, 9, 7))).toEqual([]) // Wednesday
  })
})

describe("Undo reverts exactly the class that was marked", () => {
  const base = () => subject("a", "Pharm", 4, 0, everyDay(["09:00", "10:00"], ["14:00", "15:00"]))

  it("Present then Undo leaves the class unmarked and the counts as before", () => {
    const s = base()
    const { next, undo } = markWithUndo(s, TODAY, "P", lecture(s, 0))
    const back = undo(next)
    expect(markFor(back, TODAY, "09:00")).toBeNull()
    expect(back.attended).toBe(4)
    expect(back.log ?? []).toHaveLength(0)
  })

  it("Absent then Undo does the same", () => {
    const s = base()
    const { next, undo } = markWithUndo(s, TODAY, "A", lecture(s, 0))
    expect(next.missed).toBe(1)
    const back = undo(next)
    expect(markFor(back, TODAY, "09:00")).toBeNull()
    expect(back.missed).toBe(0)
  })

  it("changing a mark and undoing returns the PREVIOUS mark, not unmarked", () => {
    let s = base()
    s = withSet(s, TODAY, "P", lecture(s, 0))
    const { next, undo } = markWithUndo(s, TODAY, "A", lecture(s, 0))
    expect(markFor(next, TODAY, "09:00")).toBe("A")
    const back = undo(next)
    expect(markFor(back, TODAY, "09:00")).toBe("P")
    expect(back.attended).toBe(5)
    expect(back.missed).toBe(0)
  })

  it("two lectures of one subject: undoing the first leaves the second marked", () => {
    const s = base()
    const first = markWithUndo(s, TODAY, "P", lecture(s, 0))
    const second = markWithUndo(first.next, TODAY, "P", lecture(s, 1))
    const afterUndo = first.undo(second.next) // undo lecture 1 AFTER lecture 2 was marked
    expect(markFor(afterUndo, TODAY, "09:00")).toBeNull()
    expect(markFor(afterUndo, TODAY, "14:00")).toBe("P")
    expect(afterUndo.attended).toBe(5)
  })

  it("rapid marking, then undoing a middle one, touches only that one", () => {
    const s = subject("a", "Pharm", 4, 0, everyDay(["09:00", "10:00"], ["11:00", "12:00"], ["14:00", "15:00"]))
    const m1 = markWithUndo(s, TODAY, "P", lecture(s, 0))
    const m2 = markWithUndo(m1.next, TODAY, "A", lecture(s, 1))
    const m3 = markWithUndo(m2.next, TODAY, "P", lecture(s, 2))
    const result = m2.undo(m3.next)
    expect(markFor(result, TODAY, "09:00")).toBe("P")
    expect(markFor(result, TODAY, "11:00")).toBeNull()
    expect(markFor(result, TODAY, "14:00")).toBe("P")
    expect(result.attended).toBe(6)
    expect(result.missed).toBe(0)
  })

  it("undoing a past-date correction restores that past record only", () => {
    let s = base()
    s = withSet(s, OLDER, "P", lecture(s, 0))
    const { next, undo } = markWithUndo(s, OLDER, "A", lecture(s, 0))
    s = withSet(next, TODAY, "P", lecture(s, 1)) // something else happens meanwhile
    const back = undo(s)
    expect(markFor(back, OLDER, "09:00")).toBe("P")
    expect(markFor(back, TODAY, "14:00")).toBe("P")
  })

  it("keeps who covered the class when an undo restores a covered mark", () => {
    let s = base()
    s = withSet(s, TODAY, "P", { ...lecture(s, 0), by: "Arjun" })
    const { next, undo } = markWithUndo(s, TODAY, "A", lecture(s, 0))
    expect(entryFor(undo(next), TODAY, "09:00")?.by).toBe("Arjun")
  })

  it("restoreMark on an unmarked previous state removes the record", () => {
    const s = base()
    const marked = withSet(s, TODAY, "P", lecture(s, 0))
    expect(markFor(restoreMark(marked, TODAY, "09:00", null), TODAY, "09:00")).toBeNull()
  })
})

describe("older untimed marks are preserved", () => {
  const withLegacy = (): Subject => ({
    ...subject("a", "Pharm", 5, 1, everyDay(["09:00", "10:00"])),
    log: [{ d: TODAY, s: "P" }, { d: YESTERDAY, s: "A" }], // saved with no class time, by the old Subject Detail
  })

  it("marking and undoing a real class never removes them", () => {
    const s = withLegacy()
    const { next, undo } = markWithUndo(s, TODAY, "P", lecture(s, 0))
    expect(markFor(next, TODAY, "")).toBe("P")
    expect(markFor(next, TODAY, "09:00")).toBe("P")
    const back = undo(next)
    expect(back.log).toEqual(s.log)
    expect(back.attended).toBe(s.attended)
  })

  it("are not listed as classes and are not given a made-up slot", () => {
    const s = withLegacy()
    expect(dayClasses([s], WED).map((c) => c.slot.start)).toEqual(["09:00"])
    expect(dayClasses([s], WED)[0].state).toBeNull() // the untimed mark does not mark the real class
    expect(s.log!.every((e) => e.t === undefined)).toBe(true)
  })

  it("survive a merge with another device untouched", () => {
    const s = withLegacy()
    const synced = { subjects: [s], tasks: [], tags: [], mates: [], reminders: [] }
    const other = { ...synced, subjects: [withSet(s, TODAY, "P", lecture(s, 0))] }
    const merged = mergeData(synced, synced, other).data.subjects[0]
    expect(merged.log!.filter((e) => !e.t)).toHaveLength(2)
  })

  it("can only be removed by explicitly clearing them", () => {
    const s = withLegacy()
    const cleared = withSet(s, TODAY, null, {})
    expect(markFor(cleared, TODAY, "")).toBeNull()
    expect(markFor(cleared, YESTERDAY, "")).toBe("A") // the other one is still there
  })
})

describe("realtime and storage", () => {
  it("a mark that arrives from another device recalculates the percentage and verdict", () => {
    const local = subject("a", "Pharm", 9, 1, everyDay(["09:00", "10:00"], ["11:00", "12:00"], ["14:00", "15:00"]))
    const synced = { subjects: [local], tasks: [], tags: [], mates: [], reminders: [] }
    expect(classVerdict(local).kind).toBe("skip")
    // the other device marks two absences and syncs
    const theirs = withSet(withSet(local, TODAY, "A", lecture(local, 0)), TODAY, "A", lecture(local, 1))
    const merged = mergeData(synced, synced, { ...synced, subjects: [theirs] }).data.subjects[0]
    expect(classVerdict(merged).pct).toBe(75)
    expect(classVerdict(merged).kind).toBe("must")
  })

  describe("on this device", () => {
    const m = new Map<string, string>()
    beforeEach(() => {
      m.clear()
      vi.stubGlobal("localStorage", { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) })
      vi.stubGlobal("navigator", { onLine: false })
    })
    afterEach(() => vi.unstubAllGlobals())

    it("works with no connection, and a reload keeps the result of marking and of undoing", async () => {
      const s = subject("a", "Pharm", 4, 0, everyDay(["09:00", "10:00"], ["14:00", "15:00"]))
      const first = markWithUndo(s, TODAY, "P", lecture(s, 0))
      const second = markWithUndo(first.next, TODAY, "A", lecture(s, 1))
      await dbSet("subjects", [second.next])
      let reopened = (await dbGet<Subject[]>("subjects"))![0]
      expect(classVerdict(reopened).pct).toBe(Math.round((5 / 6) * 100))
      const undone = first.undo(reopened) // offline undo of the first class
      await dbSet("subjects", [undone])
      reopened = (await dbGet<Subject[]>("subjects"))![0]
      expect(markFor(reopened, TODAY, "09:00")).toBeNull()
      expect(markFor(reopened, TODAY, "14:00")).toBe("A")
      expect(reopened.attended).toBe(4)
      expect(reopened.missed).toBe(1)
    })
  })
})
