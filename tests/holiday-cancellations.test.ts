import { describe, expect, it, vi } from "vitest"
import { holidayCancellations, isHolidayCancellation } from "@/lib/holidays"
import { classesOn, futureClassDates } from "@/lib/attendance"
import type { Holiday, ScheduleOverride, Subject } from "@/lib/types"

const sub = (id: string, slots: Subject["slots"]): Subject => ({ id, name: id, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [], slots })
// 2026-11-10 is a Tuesday and Diwali (Balipratipada) in the built-in list; 2026-11-09 is a Monday with no holiday
const today = new Date(2026, 10, 9)
const tuesday = { day: 2, start: "09:00", end: "10:00" }
const monday = { day: 1, start: "09:00", end: "10:00" }

describe("holidays cancel classes", () => {
  it("cancels the weekly classes that fall on a holiday and leaves other days alone", () => {
    const out = holidayCancellations([sub("a", [tuesday, monday])], [], [], today, 5)
    expect(out.map((o) => o.date)).toEqual(["2026-11-10"]) // Diwali, a Tuesday; the Monday is no holiday
    expect(out[0]).toMatchObject({ originalSubjectId: "a", start: "09:00", kind: "cancelled" })
    expect(isHolidayCancellation(out[0])).toBe(true)
  })

  it("includes the person's own holidays, with ranges", () => {
    const mine: Holiday[] = [{ id: "h", date: "2026-11-02", endDate: "2026-11-04", name: "Break" }]
    const out = holidayCancellations([sub("a", [monday, tuesday, { day: 3, start: "11:00", end: "12:00" }])], mine, [], today, 10)
    expect(out.map((o) => o.date)).toContain("2026-11-02")
    expect(out.map((o) => o.date)).toContain("2026-11-03")
    expect(out.map((o) => o.date)).toContain("2026-11-04")
  })

  it("leaves alone a class the person already changed that day", () => {
    const own = [{ date: "2026-11-10", originalSubjectId: "a", start: "09:00" }]
    expect(holidayCancellations([sub("a", [tuesday])], [], own, today, 5)).toEqual([])
    expect(holidayCancellations([sub("a", [tuesday]), sub("b", [tuesday])], [], own, today, 5).map((o) => o.originalSubjectId)).toEqual(["b"])
  })

  it("makes every screen that understands cancelled classes treat the holiday as a day without class", () => {
    const subjects = [sub("a", [tuesday])]
    const virtual = holidayCancellations(subjects, [], [], today, 5)
    const diwali = new Date(2026, 10, 10)
    expect(classesOn(subjects, diwali, []).filter((c) => !c.cancelled)).toHaveLength(1) // without the setting, the class is there
    expect(classesOn(subjects, diwali, virtual).filter((c) => !c.cancelled)).toHaveLength(0)
    expect(classesOn(subjects, diwali, virtual).filter((c) => c.cancelled)).toHaveLength(1)
  })

  it("keeps the planner's forecast free of holiday classes", () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 10, 9, 10, 0))
    try {
      const subjects = [sub("a", [tuesday])]
      const virtual: ScheduleOverride[] = holidayCancellations(subjects, [], [], new Date(), 40)
      expect(futureClassDates(subjects[0], 14, []).includes("2026-11-10")).toBe(true)
      expect(futureClassDates(subjects[0], 14, virtual).includes("2026-11-10")).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("makes nothing for subjects without a timetable", () => {
    expect(holidayCancellations([sub("a", undefined), sub("b", [])], [], [], today, 30)).toEqual([])
  })
})
