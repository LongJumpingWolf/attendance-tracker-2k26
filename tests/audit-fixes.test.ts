import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { futureClassDates } from "@/lib/attendance"
import { buildBackup, parseFullBackup } from "@/lib/backup"
import { emptyData } from "@/lib/signin-reconcile"
import { mergeData } from "@/lib/merge"
import type { ScheduleOverride, Subject } from "@/lib/types"

const sub = (o: Partial<Subject> = {}): Subject => ({ id: "s", name: "Maths", attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [], ...o })

describe("the forecast of future classes", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date(2026, 9, 21, 10, 0)) // Wednesday 21 Oct 2026
  })
  afterEach(() => vi.useRealTimers())

  const monday = sub({ slots: [{ day: 1, start: "09:00", end: "10:00" }] })
  const cancel = (date: string, start = "09:00"): ScheduleOverride => ({ id: `o-${date}`, date, originalSubjectId: "s", start, kind: "cancelled" })

  it("lists the subject's weekdays, starting tomorrow", () => {
    expect(futureClassDates(monday, 14)).toEqual(["2026-10-26", "2026-11-02"])
  })

  it("leaves out a day when its class was cancelled, so it is not counted or plannable", () => {
    expect(futureClassDates(monday, 14, [cancel("2026-10-26")])).toEqual(["2026-11-02"])
  })

  it("keeps a day when only one of two classes that day was cancelled", () => {
    const two = sub({ slots: [{ day: 1, start: "09:00", end: "10:00" }, { day: 1, start: "11:00", end: "12:00" }] })
    expect(futureClassDates(two, 14, [cancel("2026-10-26")])).toEqual(["2026-10-26", "2026-11-02"])
    expect(futureClassDates(two, 14, [cancel("2026-10-26"), cancel("2026-10-26", "11:00")])).toEqual(["2026-11-02"])
  })

  it("ignores a cancellation for a different subject", () => {
    expect(futureClassDates(monday, 14, [{ ...cancel("2026-10-26"), originalSubjectId: "other" }])).toEqual(["2026-10-26", "2026-11-02"])
  })
})

describe("a backup with damaged lists is repaired on the way in", () => {
  const file = (subject: unknown) => buildBackup({ ...emptyData(), subjects: [subject as Subject] }, false)

  it("fills in missing tags and drops a log, slots or plan of the wrong shape instead of storing it", () => {
    const parsed = parseFullBackup(file({ id: "a", name: "Maths", attended: 1, missed: 0, requirement: 75, log: {}, slots: "x", plan: [] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const s = parsed.data.subjects[0]
    expect(s.tags).toEqual([])
    expect(s.log).toEqual([])
    expect(s.slots).toEqual([])
    expect(s.plan).toEqual({})
    expect(s.glowColor).toBeTruthy()
  })

  it("keeps only valid entries inside each list", () => {
    const parsed = parseFullBackup(file({
      id: "a", name: "Maths", attended: 1, missed: 0, requirement: 75, glowColor: "#fff", tags: ["x", 3, null],
      log: [{ d: "2026-10-01", s: "P" }, { d: "2026-10-02", s: "Q" }, "junk"],
      slots: [{ day: 1, start: "09:00", end: "10:00" }, { day: 9, start: "09:00", end: "10:00" }],
      plan: { "2026-11-01": "skip", "2026-11-02": "maybe" },
    }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const s = parsed.data.subjects[0]
    expect(s.tags).toEqual(["x"])
    expect(s.log).toEqual([{ d: "2026-10-01", s: "P" }])
    expect(s.slots).toEqual([{ day: 1, start: "09:00", end: "10:00" }])
    expect(s.plan).toEqual({ "2026-11-01": "skip" })
  })

  it("leaves a healthy subject exactly as it was", () => {
    const healthy = sub({ id: "a", tags: ["core"], slots: [{ day: 2, start: "10:00", end: "11:00", kind: "Lecture" }], log: [{ d: "2026-10-01", s: "P", t: "10:00" }], plan: { "2026-11-03": "attend" }, attended: 3, missed: 1 })
    const parsed = parseFullBackup(file(healthy))
    expect(parsed.ok && parsed.data.subjects[0]).toEqual(healthy)
  })
})

describe("the first merge keeps exceptions and reminders attached to the subject they matched", () => {
  it("a remote subject that matches a local one by name takes the local id everywhere it is named", () => {
    const local = { ...emptyData(), subjects: [sub({ id: "L1", name: "Maths" })] }
    const remote = {
      ...emptyData(),
      subjects: [sub({ id: "R1", name: "maths" })],
      scheduleOverrides: [{ id: "o1", date: "2026-11-02", originalSubjectId: "R1", start: "09:00", kind: "substitute", substituteSubjectId: "R1" } as ScheduleOverride],
      reminders: [{ id: "r1", subjectId: "R1", day: 1, startTime: "09:00", endTime: "10:00", subjectName: "Maths" } as never],
    }
    const merged = mergeData(null, local, remote).data
    expect(merged.subjects.map((s) => s.id)).toEqual(["L1"])
    expect(merged.scheduleOverrides?.[0]).toMatchObject({ originalSubjectId: "L1", substituteSubjectId: "L1" })
    expect(merged.reminders[0].subjectId).toBe("L1")
  })
})
