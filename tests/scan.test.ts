import { describe, expect, it } from "vitest"
import { pickScanTarget } from "@/lib/scan"
import type { Subject } from "@/lib/types"

// Monday 21 Sep 2026
const at = (h: number, m = 0) => new Date(2026, 8, 21, h, m)
const subj = (id: string, name: string, start: string, end: string, log: Subject["log"] = []): Subject => ({
  id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log,
  slots: [{ day: 1, start, end, kind: "Lecture" }],
})
const anatomy = subj("a", "Anatomy", "09:00", "10:00")
const physio = subj("p", "Physiology", "10:00", "11:00")

describe("pickScanTarget", () => {
  it("marks the class in progress", () => {
    const r = pickScanTarget([anatomy, physio], at(9, 30))
    expect(r.kind === "mark" && r.target.subject.name).toBe("Anatomy")
  })

  it("takes the class that just ended, and the one about to start", () => {
    const ended = pickScanTarget([anatomy], at(10, 10))
    expect(ended.kind === "mark" && ended.target.subject.id).toBe("a")
    const soon = pickScanTarget([anatomy], at(8, 50))
    expect(soon.kind === "mark" && soon.target.subject.id).toBe("a")
  })

  it("prefers the class in progress over one that just ended", () => {
    const r = pickScanTarget([anatomy, physio], at(10, 5))
    expect(r.kind === "mark" && r.target.subject.name).toBe("Physiology")
  })

  it("asks when classes overlap", () => {
    const clash = subj("c", "Clash", "09:30", "10:30")
    const r = pickScanTarget([anatomy, clash], at(9, 45))
    expect(r.kind === "choose" && r.reason).toBe("several")
  })

  it("never marks twice", () => {
    const marked = subj("a", "Anatomy", "09:00", "10:00", [{ d: "2026-09-21", s: "P", t: "09:00" }])
    const r = pickScanTarget([marked], at(9, 30))
    expect(r.kind).toBe("already")
  })

  it("offers today's unmarked classes rather than guessing when nothing is near", () => {
    const r = pickScanTarget([anatomy], at(15, 0))
    expect(r.kind === "choose" && r.reason).toBe("none")
  })

  it("says when there is nothing to do", () => {
    expect(pickScanTarget([], at(9)).kind).toBe("idle")
    expect(pickScanTarget([{ ...anatomy, slots: [{ day: 3, start: "09:00", end: "10:00" }] }], at(9)).kind).toBe("idle")
  })
})
