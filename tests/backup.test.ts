import { describe, expect, it } from "vitest"
import { buildBackup, parseFullBackup } from "@/lib/backup"
import type { Mate, Subject } from "@/lib/types"
import type { ScheduleEntry } from "@/lib/reminders"

const subject: Subject = {
  id: "1", name: "DBMS", attended: 5, missed: 1, requirement: 75, glowColor: "#000", tags: ["Theory"],
  slots: [{ day: 1, start: "09:00", end: "10:00", kind: "Lecture" }, { day: 3, start: "14:00", end: "15:30" }],
  log: [{ d: "2026-09-14", s: "P", t: "09:00", by: "Zoe" }], plan: { "2026-09-28": "skip" },
}
const mate: Mate = { id: "m", name: "Zoe", covered: 2, repaid: 1, coveredLog: ["2026-09-14"] }
const reminder: ScheduleEntry = { id: "r", day: 1, startTime: "09:00", endTime: "10:00", subjectName: "DBMS", notifyOffset: 10, notifyWhen: "before" }

describe("full backup", () => {
  it("restores exactly what was saved", () => {
    const data = { subjects: [subject], tasks: [], tags: ["Theory"], mates: [mate], reminders: [reminder] }
    const back = parseFullBackup(buildBackup(data))
    expect(back.ok && back.data).toEqual(data)
  })

  it("rejects files that are not a backup, or are from a newer app", () => {
    expect(parseFullBackup("nope").ok).toBe(false)
    expect(parseFullBackup('{"app":"other","data":{}}').ok).toBe(false)
    const text = buildBackup({ subjects: [], tasks: [], tags: [], mates: [], reminders: [] })
    expect(parseFullBackup(text.replace('"version": 1', '"version": 9')).ok).toBe(false)
  })
})
