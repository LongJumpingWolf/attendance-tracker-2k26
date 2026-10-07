import { describe, expect, it } from "vitest"
import { applyPingResult, favourId, resultIsSaved } from "@/lib/ping-apply"
import { markFor, withSet } from "@/lib/attendance"
import { mergeData } from "@/lib/merge"
import type { Mate, Ping, Subject } from "@/lib/types"

const DATE = "2026-10-06"
const subject = (over: Partial<Subject> = {}): Subject => ({
  id: "dbms", name: "DBMS", attended: 4, missed: 1, requirement: 75, glowColor: "#000", tags: [],
  slots: [{ day: 2, start: "09:00", end: "10:00", kind: "Lecture" }, { day: 2, start: "14:00", end: "15:00", kind: "Practical" }], ...over,
})
const item = (key: string, t: string | undefined, answer: "yes" | "no" | null, subjectId = "dbms") => ({ key, subjectId, name: "DBMS", ...(t ? { t } : {}), answer })
const ping = (items: Ping["items"], over: Partial<Ping> = {}): Ping => ({
  id: "ping-1", from: "me", to: "rahul-uid", fromName: "Me", toName: "Rahul", participants: ["me", "rahul-uid"], date: DATE, items, status: "answered", ...over,
})
const rahul: Mate = { id: "m1", name: "Rahul", uid: "rahul-uid", covered: 0, repaid: 0 }

describe("when a Ping becomes a favour", () => {
  it("19. a yes on a class that wasn't marked marks it present and creates exactly one favour", () => {
    const r = applyPingResult([subject()], [rahul], ping([item("dbms@09:00", "09:00", "yes")]))
    const s = r.subjects[0]
    expect(markFor(s, DATE, "09:00")).toBe("P")
    expect(s.attended).toBe(5)
    expect(s.log?.[0]).toMatchObject({ d: DATE, s: "P", t: "09:00", k: "Lecture", by: "Rahul" })
    expect(r.mates[0]).toMatchObject({ covered: 1, coveredLog: [DATE], coveredPings: [favourId(ping([]), "dbms@09:00")] })
    expect(r.helped).toHaveLength(1)
  })

  it("19. a yes on a class marked Absent turns it present (that is the point of asking) and counts one favour", () => {
    const absent = withSet(subject(), DATE, "A", { t: "09:00" })
    const r = applyPingResult([absent], [rahul], ping([item("dbms@09:00", "09:00", "yes")]))
    expect(markFor(r.subjects[0], DATE, "09:00")).toBe("P")
    expect(r.subjects[0].missed).toBe(absent.missed - 1) // moved across, not added on top
    expect(r.subjects[0].attended).toBe(absent.attended + 1)
    expect(r.mates[0].covered).toBe(1)
  })

  it("18. a class that was already Present creates no favour and changes nothing", () => {
    const present = withSet(subject(), DATE, "P", { t: "09:00" })
    const r = applyPingResult([present], [rahul], ping([item("dbms@09:00", "09:00", "yes")]))
    expect(r.subjects).toEqual([present])
    expect(r.mates).toEqual([rahul])
    expect(r.helped).toEqual([])
    expect(r.skipped).toEqual([{ key: "dbms@09:00", reason: "already-present" }])
  })

  it("a no changes nothing", () => {
    const r = applyPingResult([subject()], [rahul], ping([item("dbms@09:00", "09:00", "no")]))
    expect(r.subjects[0]).toEqual(subject())
    expect(r.mates).toEqual([rahul])
  })

  it("a mix counts only the classes that actually got help", () => {
    const present = withSet(subject(), DATE, "P", { t: "14:00" })
    const r = applyPingResult(
      [present],
      [rahul],
      ping([item("dbms@09:00", "09:00", "yes"), item("dbms@14:00", "14:00", "yes"), item("x", undefined, "no")]),
    )
    expect(r.helped).toHaveLength(1) // the 9:00 class; 14:00 was already present
    expect(r.mates[0].covered).toBe(1)
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["already-present", "no"])
  })

  it("21. a deleted subject creates no favour", () => {
    const r = applyPingResult([], [rahul], ping([item("gone@09:00", "09:00", "yes", "gone")]))
    expect(r.helped).toEqual([])
    expect(r.mates).toEqual([rahul])
    expect(r.skipped[0].reason).toBe("subject-missing")
  })

  it("21. a class that is no longer on the timetable creates no favour and marks nothing", () => {
    const moved = subject({ slots: [{ day: 2, start: "11:00", end: "12:00" }] })
    const r = applyPingResult([moved], [rahul], ping([item("dbms@09:00", "09:00", "yes")]))
    expect(r.helped).toEqual([])
    expect(r.subjects[0].log).toBeUndefined()
    expect(r.skipped[0].reason).toBe("class-missing")
  })

  it("a subject with no timetable can still be covered (one record for the day)", () => {
    const untimed = subject({ slots: undefined })
    const r = applyPingResult([untimed], [rahul], ping([item("dbms@", undefined, "yes")]))
    expect(markFor(r.subjects[0], DATE, "")).toBe("P")
    expect(r.mates[0].covered).toBe(1)
  })
})

describe("20. the same Ping applied twice is one favour", () => {
  const p = ping([item("dbms@09:00", "09:00", "yes"), item("dbms@14:00", "14:00", "yes")])

  it("running it again changes nothing", () => {
    const once = applyPingResult([subject()], [rahul], p)
    const twice = applyPingResult(once.subjects, once.mates, p)
    expect(twice.subjects).toEqual(once.subjects)
    expect(twice.mates).toEqual(once.mates)
    expect(twice.helped).toEqual([])
    expect(once.mates[0].covered).toBe(2) // one favour per class helped, once
    expect(twice.skipped.map((s) => s.reason)).toEqual(["already-applied", "already-applied"])
  })

  it("it does not undo a change the person made afterwards (a recovery re-run must not flip it back)", () => {
    const once = applyPingResult([subject()], [rahul], p)
    const edited = once.subjects.map((s) => withSet(s, DATE, "A", { t: "09:00" })) // they fixed it by hand
    const again = applyPingResult(edited, once.mates, p)
    expect(markFor(again.subjects[0], DATE, "09:00")).toBe("A")
    expect(again.mates[0].covered).toBe(2)
  })

  it("10. a crash after applying but before finishing: running recovery again is harmless", () => {
    const first = applyPingResult([subject()], [rahul], p)
    // the app "restarts" with what was saved, and applies the still-answered Ping again
    const recovered = applyPingResult(JSON.parse(JSON.stringify(first.subjects)), JSON.parse(JSON.stringify(first.mates)), p)
    expect(recovered.mates[0].covered).toBe(2)
    expect(recovered.subjects[0].attended).toBe(first.subjects[0].attended)
    expect(recovered.subjects[0].log).toHaveLength(2)
  })
})

describe("who the favour belongs to", () => {
  it("an unconnected mate with the same name takes the account, keeping their history", () => {
    const manual: Mate = { id: "m9", name: "rahul", covered: 3, repaid: 1, coveredLog: ["2026-09-01"] }
    const r = applyPingResult([subject()], [manual], ping([item("dbms@09:00", "09:00", "yes")]))
    expect(r.mates).toHaveLength(1)
    expect(r.mates[0]).toMatchObject({ id: "m9", uid: "rahul-uid", covered: 4, repaid: 1 })
  })

  it("a stranger to the ledger is added", () => {
    const r = applyPingResult([subject()], [], ping([item("dbms@09:00", "09:00", "yes")]))
    expect(r.mates).toEqual([expect.objectContaining({ uid: "rahul-uid", name: "Rahul", covered: 1 })])
  })

  it("a different person with the same name who IS connected is not confused with them", () => {
    const other: Mate = { id: "m2", name: "Rahul", uid: "someone-else", covered: 5, repaid: 0 }
    const r = applyPingResult([subject()], [other], ping([item("dbms@09:00", "09:00", "yes")]))
    expect(r.mates).toHaveLength(2)
    expect(r.mates.find((m) => m.uid === "someone-else")?.covered).toBe(5)
  })
})

describe("11. recovery needs the result to really be saved", () => {
  const p = ping([item("dbms@09:00", "09:00", "yes")])

  it("is saved only when the saved copy shows the class and the favour", () => {
    const r = applyPingResult([subject()], [rahul], p)
    expect(resultIsSaved({ subjects: r.subjects, mates: r.mates }, r, p)).toBe(true)
    expect(resultIsSaved({ subjects: [subject()], mates: r.mates }, r, p)).toBe(false) // the attendance never reached disk
    expect(resultIsSaved({ subjects: r.subjects, mates: [rahul] }, r, p)).toBe(false) // the favour never reached disk
    expect(resultIsSaved({ subjects: [], mates: [] }, r, p)).toBe(false)
  })

  it("an answer with nothing to apply is trivially saved", () => {
    const none = ping([item("dbms@09:00", "09:00", "no")])
    const r = applyPingResult([subject()], [rahul], none)
    expect(resultIsSaved({ subjects: [subject()], mates: [rahul] }, r, none)).toBe(true)
  })
})

describe("12. two devices that both applied the same Ping still end with one favour", () => {
  const p = ping([item("dbms@09:00", "09:00", "yes")])
  const base = { subjects: [subject()], tasks: [], tags: [], mates: [rahul], reminders: [] }

  it("merges to one", () => {
    const a = applyPingResult(base.subjects, base.mates, p)
    const b = applyPingResult(base.subjects, base.mates, p) // the other device, applying the same answer
    const merged = mergeData(base, { ...base, subjects: a.subjects, mates: a.mates }, { ...base, subjects: b.subjects, mates: b.mates }).data
    expect(merged.mates[0].covered).toBe(1)
    expect(merged.mates[0].coveredLog).toEqual([DATE])
    expect(merged.mates[0].coveredPings).toHaveLength(1)
    expect(merged.subjects[0].attended).toBe(5) // and one attendance mark
    expect(merged.subjects[0].log).toHaveLength(1)
  })

  it("two different Pings applied on two devices are two favours", () => {
    const p2 = ping([item("dbms@14:00", "14:00", "yes")], { id: "ping-2" })
    const a = applyPingResult(base.subjects, base.mates, p)
    const b = applyPingResult(base.subjects, base.mates, p2)
    const merged = mergeData(base, { ...base, subjects: a.subjects, mates: a.mates }, { ...base, subjects: b.subjects, mates: b.mates }).data
    expect(merged.mates[0].covered).toBe(2)
    expect(merged.mates[0].coveredPings).toHaveLength(2)
  })
})
