import { afterEach, describe, expect, it, vi } from "vitest"
import { classesOn, dayClasses, futureClassDates } from "@/lib/attendance"
import { DEFAULT_HOLIDAYS, holidaysForDate } from "@/lib/holidays"
import { mergeData } from "@/lib/merge"
import type { ScheduleOverride, Slot, Subject } from "@/lib/types"

const WED = new Date(2026, 9, 7, 10, 0)
const DATE = "2026-10-07"
const slot = (day: number, start: string, end: string): Slot => ({ day, start, end, kind: "Lecture" })
const subject = (id: string, name: string, slots: Slot[], over: Partial<Subject> = {}): Subject => ({
  id, name, slots, attended: 3, missed: 1, requirement: 75, glowColor: "#000000", tags: [], ...over,
})
const empty = { subjects: [] as Subject[], tasks: [], tags: [], mates: [], reminders: [] }

afterEach(() => vi.useRealTimers())

describe("date-specific timetable controls", () => {
  const peds = subject("peds", "Pediatrics", [slot(3, "09:00", "10:00")])
  const ent = subject("ent", "ENT", [slot(4, "11:00", "12:00")])

  it("a finite sleep hides only dates through its inclusive end date and keeps marks", () => {
    const sleeping = { ...peds, sleeping: true, sleepUntil: DATE, log: [{ d: DATE, s: "P" as const, t: "09:00" }] }
    expect(dayClasses([sleeping], WED)).toEqual([])
    expect(dayClasses([sleeping], new Date(2026, 9, 14, 10, 0))).toHaveLength(1)
    expect(sleeping.attended).toBe(3)
    expect(sleeping.log).toHaveLength(1)
  })

  it("keeps future forecast dates after a finite sleep ends", () => {
    vi.useFakeTimers()
    vi.setSystemTime(WED)
    const sleeping = { ...peds, sleeping: true, sleepUntil: "2026-10-10" }
    expect(futureClassDates(sleeping, 14)).toContain("2026-10-14")
    expect(futureClassDates({ ...peds, sleeping: true, sleepUntil: "forever" }, 14)).toEqual([])
  })

  it("cancellation stays visible to Calendar but is excluded from Today and scan candidates", () => {
    const override: ScheduleOverride = { id: "cancel-1", date: DATE, originalSubjectId: peds.id, start: "09:00", kind: "cancelled" }
    expect(classesOn([peds], WED, [override])).toMatchObject([{ cancelled: true, subject: { id: "peds" } }])
    expect(dayClasses([peds], WED, [override])).toEqual([])
  })

  it("substitutes another subject into the original slot for one date only", () => {
    const override: ScheduleOverride = { id: "sub-1", date: DATE, originalSubjectId: peds.id, start: "09:00", kind: "substitute", substituteSubjectId: ent.id }
    const result = dayClasses([peds, ent], WED, [override])
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({ subject: { id: "ent" }, slot: { start: "09:00" }, originalSubjectId: "peds" })
    expect(dayClasses([peds, ent], new Date(2026, 9, 14, 10, 0), [override]).map((c) => c.subject.id)).toContain("peds")
  })
})

describe("2026 holidays", () => {
  it("includes all 25 supplied observances and keeps multiple holidays on one date", () => {
    expect(DEFAULT_HOLIDAYS).toHaveLength(25)
    expect(holidaysForDate("2026-05-01").map((h) => h.name)).toEqual(["Maharashtra Day", "Buddha Purnima"])
    expect(holidaysForDate("2026-08-15").map((h) => h.name)).toEqual(["Independence Day", "Parsi New Year (Shahenshahi)"])
  })

  it("shows a range holiday on every inclusive date", () => {
    const holiday = { id: "college-break", date: "2026-11-01", endDate: "2026-11-05", name: "College break" }
    expect(holidaysForDate("2026-11-01", [holiday]).some((h) => h.id === holiday.id)).toBe(true)
    expect(holidaysForDate("2026-11-05", [holiday]).some((h) => h.id === holiday.id)).toBe(true)
    expect(holidaysForDate("2026-11-06", [holiday]).some((h) => h.id === holiday.id)).toBe(false)
  })
})

describe("cross-device merging", () => {
  it("deduplicates a custom holiday created independently on two devices", () => {
    const local = { id: "phone", date: "2026-12-25", name: "College Holiday" }
    const remote = { id: "laptop", date: "2026-12-25", name: " college   holiday " }
    const result = mergeData(null, { ...empty, holidays: [local] }, { ...empty, holidays: [remote] })
    expect(result.data.holidays).toHaveLength(1)
  })

  it("deduplicates the same slot override by slot key and flags conflicting edits", () => {
    const cancellation: ScheduleOverride = { id: "phone", date: DATE, originalSubjectId: "peds", start: "09:00", kind: "cancelled" }
    const same = { ...cancellation, id: "laptop" }
    expect(mergeData(null, { ...empty, scheduleOverrides: [cancellation] }, { ...empty, scheduleOverrides: [same] }).data.scheduleOverrides).toHaveLength(1)
    const substitute: ScheduleOverride = { ...cancellation, id: "other", kind: "substitute", substituteSubjectId: "ent" }
    const conflict = mergeData(null, { ...empty, scheduleOverrides: [cancellation] }, { ...empty, scheduleOverrides: [substitute] })
    expect(conflict.conflicts).toBeGreaterThan(0)
    expect(conflict.data.scheduleOverrides).toHaveLength(1)
  })
})
