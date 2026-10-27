import { describe, expect, it } from "vitest"
import { pickScanTarget } from "@/lib/scan"
import type { ScheduleOverride, Subject } from "@/lib/types"

// Monday 21 Sep 2026; fixed local dates keep attendance-log assertions deterministic.
const at = (h: number, m = 0, s = 0) => new Date(2026, 8, 21, h, m, s)
const subj = (
  id: string,
  name: string,
  start: string,
  end: string,
  log: Subject["log"] = [],
  day = 1,
): Subject => ({
  id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log,
  slots: [{ day, start, end, kind: "Lecture" }],
})
const anatomy = subj("a", "Anatomy", "09:00", "10:00")
const physio = subj("p", "Physiology", "10:00", "11:00")
const mark = (subject: Subject, status: "P" | "A", start = "09:00"): Subject => ({
  ...subject,
  log: [...(subject.log ?? []), { d: "2026-09-21", s: status, t: start }],
})

describe("pickScanTarget — normal timing windows", () => {
  it("marks the single class in progress", () => {
    const r = pickScanTarget([anatomy, physio], at(9, 30))
    expect(r.kind === "mark" && r.target.subject.name).toBe("Anatomy")
  })

  it("accepts a scan exactly at the scheduled start and treats the exact end as ended", () => {
    const start = pickScanTarget([anatomy], at(9, 0))
    expect(start.kind === "mark" && start.target.subject.id).toBe("a")
    const end = pickScanTarget([anatomy], at(10, 0))
    expect(end.kind === "mark" && end.target.subject.id).toBe("a")
  })

  it("accepts the just-ended window until 19:59, but not at 20:00", () => {
    const within = pickScanTarget([anatomy], at(10, 19, 59))
    expect(within.kind === "mark" && within.target.subject.id).toBe("a")
    const outside = pickScanTarget([anatomy], at(10, 20))
    expect(outside.kind === "choose" && outside.reason).toBe("none")
  })

  it("accepts a class starting in exactly 15 minutes, but not 16 minutes away", () => {
    const within = pickScanTarget([anatomy], at(8, 45))
    expect(within.kind === "mark" && within.target.subject.id).toBe("a")
    const outside = pickScanTarget([anatomy], at(8, 44))
    expect(outside.kind === "choose" && outside.reason).toBe("none")
  })

  it("prefers the in-progress class at a back-to-back boundary", () => {
    const r = pickScanTarget([anatomy, physio], at(10, 0))
    expect(r.kind === "mark" && r.target.subject.name).toBe("Physiology")
  })

  it("asks when two classes overlap during the same timing window", () => {
    const clash = subj("c", "Clash", "09:30", "10:30")
    const r = pickScanTarget([anatomy, clash], at(9, 45))
    expect(r.kind === "choose" && r.reason).toBe("several")
    expect(r.kind === "choose" && r.options.map((x) => x.subject.id)).toEqual(["a", "c"])
  })

  it("still confirms an overlapping class when the other candidate is already marked", () => {
    const clash = mark(subj("c", "Clash", "09:30", "10:30"), "P", "09:30")
    const r = pickScanTarget([anatomy, clash], at(9, 45))
    expect(r.kind).toBe("choose")
    if (r.kind === "choose") {
      expect(r.reason).toBe("several")
      expect(r.options.map((x) => x.subject.id)).toEqual(["a"])
    }
  })

  it("does not mark twice; a previous absence is not silently overwritten", () => {
    const present = pickScanTarget([mark(anatomy, "P")], at(9, 30))
    expect(present.kind).toBe("already")
    if (present.kind === "already") expect(present.status).toBe("P")
    const absent = pickScanTarget([mark(anatomy, "A")], at(9, 30))
    expect(absent.kind).toBe("already")
    if (absent.kind === "already") expect(absent.status).toBe("A")
  })

  it("offers today's unmarked classes instead of guessing when no time window fits", () => {
    const r = pickScanTarget([anatomy, physio], at(15, 0))
    expect(r.kind === "choose" && r.reason).toBe("none")
    expect(r.kind === "choose" && r.options.map((x) => x.subject.id)).toEqual(["a", "p"])
  })
})

describe("pickScanTarget — ambiguity and safe fallbacks", () => {
  it("asks instead of choosing the previous lecture when the next one starts soon", () => {
    const next = subj("b", "Biochemistry", "10:10", "11:10")
    const r = pickScanTarget([anatomy, next], at(10, 5))
    expect(r.kind).toBe("choose")
    if (r.kind === "choose") {
      expect(r.reason).toBe("ambiguous")
      expect(r.options.map((x) => x.subject.id)).toEqual(["a", "b"])
    }
  })

  it("still asks when one of the two ambiguous classes is already marked", () => {
    const next = subj("b", "Biochemistry", "10:10", "11:10")
    const r = pickScanTarget([mark(anatomy, "P"), next], at(10, 5))
    expect(r.kind).toBe("choose")
    if (r.kind === "choose") {
      expect(r.reason).toBe("ambiguous")
      expect(r.options.map((x) => x.subject.id)).toEqual(["b"])
    }
  })

  it("never asks if an in-progress lecture uniquely resolves a recently-ended/upcoming conflict", () => {
    const next = subj("b", "Biochemistry", "10:10", "11:10")
    const r = pickScanTarget([anatomy, physio, next], at(10, 5))
    expect(r.kind === "mark" && r.target.subject.id).toBe("p")
  })

  it("reports already marked when every candidate in the overlapping windows is marked", () => {
    const next = subj("b", "Biochemistry", "10:10", "11:10")
    const r = pickScanTarget([mark(anatomy, "P"), mark(next, "A", "10:10")], at(10, 5))
    expect(r.kind).toBe("already")
  })

  it("skips cancelled lectures", () => {
    const cancellation: ScheduleOverride = {
      id: "cancel-a", date: "2026-09-21", originalSubjectId: "a", start: "09:00", kind: "cancelled",
    }
    const r = pickScanTarget([anatomy], at(9, 30), [cancellation])
    expect(r).toEqual({ kind: "idle", reason: "no-classes" })
  })

  it("marks attendance against the original subject for a substituted lecture", () => {
    const cover = { ...subj("cover", "Cover subject", "12:00", "13:00"), slots: [] }
    const substitution: ScheduleOverride = {
      id: "cover-a", date: "2026-09-21", originalSubjectId: "a", start: "09:00",
      kind: "substitute", substituteSubjectId: "cover",
    }
    const r = pickScanTarget([anatomy, cover], at(9, 30), [substitution])
    expect(r.kind).toBe("mark")
    if (r.kind === "mark") {
      expect(r.target.subject.id).toBe("cover")
      expect(r.target.attendanceSubject?.id).toBe("a")
    }
  })

  it("distinguishes no subjects, no class today, and all classes already marked", () => {
    expect(pickScanTarget([], at(9))).toEqual({ kind: "idle", reason: "no-subjects" })
    expect(pickScanTarget([subj("tomorrow", "Tomorrow", "09:00", "10:00", [], 3)], at(9))).toEqual({
      kind: "idle", reason: "no-classes",
    })
    expect(pickScanTarget([mark(anatomy, "P")], at(15, 0))).toEqual({ kind: "idle", reason: "all-marked" })
  })
})
