import { afterEach, describe, expect, it, vi } from "vitest"
import { entriesFromTimetable, loadSchedule, normalizeScheduleEntry, saveSchedule, SCHEDULE_KEY } from "@/lib/reminders"
import type { Subject } from "@/lib/types"

const entry = (patch: Record<string, unknown> = {}) => ({
  id: "reminder-1",
  day: 1,
  startTime: "09:00",
  endTime: "10:00",
  subjectName: "Physiology",
  notifyOffset: 10,
  notifyWhen: "before",
  ...patch,
})

afterEach(() => vi.unstubAllGlobals())

const subject = (id: string, name: string): Subject => ({
  id,
  name,
  slots: [{ day: 1, start: "09:00", end: "10:00", kind: "Lecture" }],
  attended: 0,
  missed: 0,
  requirement: 75,
  glowColor: "#000000",
  tags: [],
})

describe("reminder data validation", () => {
  it("keeps valid legacy reminder records and supplies safe defaults", () => {
    expect(normalizeScheduleEntry(entry({ notifyOffset: undefined, notifyWhen: "invalid" }))).toMatchObject({
      id: "reminder-1", day: 1, startTime: "09:00", endTime: "10:00", subjectName: "Physiology", notifyOffset: 10, notifyWhen: "before",
    })
  })

  it("rejects malformed reminders without throwing", () => {
    for (const value of [null, [], {}, entry({ day: 9 }), entry({ startTime: "9am" }), entry({ endTime: "08:00" }), entry({ id: "" })]) {
      expect(normalizeScheduleEntry(value)).toBeNull()
    }
  })


  it("loads old valid reminders and ignores malformed rows without throwing", () => {
    const stored = [entry({ notifyOffset: undefined, notifyWhen: undefined }), null, entry({ id: "bad", day: 9 })]
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", { getItem: (key: string) => key === SCHEDULE_KEY ? JSON.stringify(stored) : null })
    expect(loadSchedule()).toEqual([expect.objectContaining({ id: "reminder-1", notifyOffset: 10, notifyWhen: "before" })])
  })

  it("normalizes records when saving the schedule", () => {
    const values: Record<string, string> = {}
    vi.stubGlobal("window", {})
    vi.stubGlobal("localStorage", { setItem: (key: string, value: string) => { values[key] = value } })
    saveSchedule([entry({ notifyOffset: -1 }) as never])
    expect(JSON.parse(values[SCHEDULE_KEY])).toEqual([expect.objectContaining({ notifyOffset: 10, notifyWhen: "before" })])
  })

  it("preserves immutable subject IDs through reminder generation and matches after rename", () => {
    const old = subject("subject-a", "Physiology")
    const generated = entriesFromTimetable([old], [])
    expect(generated).toHaveLength(1)
    expect(generated[0].subjectId).toBe("subject-a")
    const renamed = subject("subject-a", "Human Physiology")
    expect(entriesFromTimetable([renamed], generated)).toHaveLength(0)
  })

  it("does not bind a same-named new subject to a reminder belonging to another subject ID", () => {
    const first = subject("subject-a", "Physiology")
    const second = subject("subject-b", "Physiology")
    const existing = [normalizeScheduleEntry(entry({ subjectId: first.id }))!]
    const generated = entriesFromTimetable([first, second], existing)
    expect(generated).toHaveLength(1)
    expect(generated[0].subjectId).toBe(second.id)
  })

  it("avoids creating duplicate reminders from duplicate recurring slots", () => {
    const s = subject("subject-a", "Physiology")
    s.slots = [...s.slots!, ...s.slots!]
    const generated = entriesFromTimetable([s], [])
    expect(generated).toHaveLength(1)
  })
})
