import { describe, expect, it } from "vitest"
import { mustWaitToApply, UNAPPLIED_GRACE_DAYS } from "@/lib/ping-unapplied"
import { applyPingResult } from "@/lib/ping-apply"
import { localDate } from "@/lib/attendance"
import type { Ping, Subject } from "@/lib/types"

const daysAgo = (n: number) => localDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - n))
const ping = (o: Partial<Ping> = {}): Ping => ({
  id: "p", from: "me", to: "mate", fromName: "Me", toName: "Rahul", participants: ["me", "mate"], date: daysAgo(0), status: "answered",
  items: [{ key: "s1@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer: "yes" }], ...o,
})
const maths: Subject = { id: "s1", name: "Maths", attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [], slots: [{ day: 1, start: "09:00", end: "10:00" }] }

describe("an answer this device cannot apply yet", () => {
  it("waits when a yes is for a subject this device doesn't have (a new browser)", () => {
    const outcome = applyPingResult([], [], ping())
    expect(outcome.skipped.map((s) => s.reason)).toContain("subject-missing")
    expect(mustWaitToApply(ping(), outcome)).toBe(true)
  })

  it("waits when the class time is missing, but not for a no", () => {
    const noTime = applyPingResult([{ ...maths, slots: [] }], [], ping())
    expect(mustWaitToApply(ping(), noTime)).toBe(true)
    const no = ping({ items: [{ key: "s1@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer: "no" }] })
    expect(mustWaitToApply(no, applyPingResult([], [], no))).toBe(false)
  })

  it("does not wait when the answer was applied or is simply already marked", () => {
    expect(mustWaitToApply(ping(), applyPingResult([maths], [], ping()))).toBe(false)
  })

  it("gives up after the grace period, so a subject deleted on purpose doesn't retry forever", () => {
    const old = ping({ date: daysAgo(UNAPPLIED_GRACE_DAYS + 1) })
    expect(mustWaitToApply(old, applyPingResult([], [], old))).toBe(false)
    const recent = ping({ date: daysAgo(UNAPPLIED_GRACE_DAYS) })
    expect(mustWaitToApply(recent, applyPingResult([], [], recent))).toBe(true)
  })
})
