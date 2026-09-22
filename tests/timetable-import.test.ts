import { describe, expect, it } from "vitest"
import { applyImport, cleanAnswer, findIssues, normalizeTime, parseTimetable, resolveImport } from "@/lib/timetable-import"
import type { Subject } from "@/lib/types"

const paste = 'Sure!\n```json\n{"subjects":[{"name":"Physics","requirement":null,"slots":[{"day":"Monday","start":"9am","end":"10:00","type":"lab"},{"day":"Tues","start":"11:00","end":null},{"day":null,"start":"14:00","end":"15:00"}]},{"name":null,"slots":[{"day":"Fri","start":"0900","end":"1000"}],},{"name":"Maths","requirement":80,"slots":[]}]}\n```'

describe("timetable import", () => {
  it("reads messy pastes: chatter, trailing commas, 12h times, day words", () => {
    const r = parseTimetable(paste)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.subjects[0].slots[0]).toEqual({ day: 1, start: "09:00", end: "10:00", kind: "Practical" })
    expect(r.subjects[1].slots[0].start).toBe("09:00")
  })

  it("rejects things that are not a timetable", () => {
    expect(parseTimetable("hello").ok).toBe(false)
    expect(parseTimetable("").ok).toBe(false)
  })

  it("normalises times and rejects impossible ones", () => {
    expect(normalizeTime("9:30 pm")).toBe("21:30")
    expect(normalizeTime("12am")).toBe("00:00")
    expect(normalizeTime("25:00")).toBeNull()
  })

  it("asks only for what is missing and drops skipped slots without inventing anything", () => {
    const r = parseTimetable(paste)
    if (!r.ok) throw new Error("parse failed")
    const issues = findIssues(r.subjects)
    expect(issues.map((i) => i.id)).toEqual(["0:1:end", "0:2:day", "1:name", "requirement"])
    const res = resolveImport(r.subjects, { "0:1:end": cleanAnswer("end", "12:00") as string, requirement: 75 })
    expect(res.subjects.map((s) => s.name)).toEqual(["Physics", "Maths"])
    expect(res.subjects[0].slots).toHaveLength(2) // the day-less slot was skipped
    expect(res.notes.length).toBe(2)
  })

  it("keeps attendance of existing subjects and reports exactly what changed", () => {
    const existing: Subject[] = [
      { id: "a", name: "Physics", attended: 4, missed: 1, requirement: 75, glowColor: "#000", tags: [], slots: [{ day: 1, start: "09:00", end: "10:00" }, { day: 3, start: "11:00", end: "12:00" }] },
    ]
    const r = applyImport(existing, [{ name: "physics", requirement: 80, requirementKnown: true, slots: [{ day: 1, start: "09:00", end: "10:00" }, { day: 5, start: "14:00", end: "15:00" }] }])
    expect(r.subjects[0].attended).toBe(4)
    expect(r.summary.updated[0]).toMatchObject({ changed: true, requirementFrom: 75, requirementTo: 80 })
    expect(r.summary.added).toHaveLength(0)
  })
})
