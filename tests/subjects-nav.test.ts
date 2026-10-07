import { describe, expect, it } from "vitest"
import { bySafety, getAttendance, needsAttention, recentMarks } from "@/lib/attendance"
import type { Subject } from "@/lib/types"

const subject = (id: string, attended: number, missed: number, requirement = 75, extra: Partial<Subject> = {}): Subject => ({
  id, name: id, attended, missed, requirement, glowColor: "#000", tags: [], ...extra,
})
const info = (s: Subject) => getAttendance(s.attended, s.missed, s.requirement)

describe("the single Subjects list", () => {
  it("lists the least safe subject first and subjects with no marks last", () => {
    const safe = subject("safe", 9, 1) //  90% : +15
    const risk = subject("risk", 1, 3) //  25% : -50
    const edge = subject("edge", 3, 1) //  75% :   0
    const none = subject("none", 0, 0)
    expect([safe, none, edge, risk].sort(bySafety).map((s) => s.id)).toEqual(["risk", "edge", "safe", "none"])
  })

  it("flags subjects below the minimum or exactly at it, and nothing else", () => {
    expect(needsAttention(info(subject("a", 1, 3)))).toBe(true) // below
    expect(needsAttention(info(subject("b", 3, 1)))).toBe(true) // at the edge, no skips left
    expect(needsAttention(info(subject("c", 9, 1)))).toBe(false) // safe
    expect(needsAttention(info(subject("d", 0, 0)))).toBe(false) // nothing marked yet
  })

  it("keeps every subject: sorting never drops or duplicates one", () => {
    const all = ["a", "b", "c", "d", "e"].map((id, i) => subject(id, i, 5 - i))
    expect([...all].sort(bySafety).map((s) => s.id).sort()).toEqual(["a", "b", "c", "d", "e"])
  })
})

describe("attendance history on a subject", () => {
  const log = [
    { d: "2026-10-01", s: "P" as const, t: "09:00" },
    { d: "2026-10-03", s: "A" as const, t: "09:00" },
    { d: "2026-10-03", s: "P" as const, t: "14:00" },
    { d: "2026-09-20", s: "A" as const },
    { d: "2026-10-05", s: "P" as const },
  ]
  const s = subject("a", 3, 2, 75, { log })

  it("is newest first, later class first within a day", () => {
    expect(recentMarks(s, 10).map((e) => `${e.d} ${e.t ?? "-"}`)).toEqual(["2026-10-05 -", "2026-10-03 14:00", "2026-10-03 09:00", "2026-10-01 09:00", "2026-09-20 -"])
  })

  it("limits to the newest few, and includes older marks that have no class time", () => {
    expect(recentMarks(s, 2)).toHaveLength(2)
    expect(recentMarks(s, 10).some((e) => !e.t)).toBe(true)
  })

  it("never changes the log it reads", () => {
    const before = JSON.stringify(s.log)
    recentMarks(s, 3)
    expect(JSON.stringify(s.log)).toBe(before)
  })

  it("is empty for a subject with no marks", () => {
    expect(recentMarks(subject("n", 0, 0))).toEqual([])
  })
})
