import { describe, expect, it } from "vitest"
import { mergeData } from "@/lib/merge"
import type { FullBackupData } from "@/lib/backup"
import type { Subject } from "@/lib/types"

const sub = (over: Partial<Subject> = {}): Subject => ({
  id: "s1", name: "DBMS", attended: 10, missed: 2, requirement: 75, glowColor: "#000", tags: [],
  log: [{ d: "2026-10-01", s: "P" }, { d: "2026-10-02", s: "P" }, { d: "2026-10-03", s: "A" }],
  ...over,
})
const data = (subjects: Subject[], extra: Partial<FullBackupData> = {}): FullBackupData => ({ subjects, tasks: [], tags: [], mates: [], reminders: [], ...extra })
const mark = (s: Subject, d: string, st: "P" | "A"): Subject => ({
  ...s, attended: s.attended + (st === "P" ? 1 : 0), missed: s.missed + (st === "A" ? 1 : 0), log: [...(s.log ?? []), { d, s: st }],
})

describe("three-way merge", () => {
  const base = data([sub()])

  it("returns the stored copy untouched when nothing changed here", () => {
    const remote = data([mark(sub(), "2026-10-04", "P")])
    const r = mergeData(base, base, remote)
    expect(r.data).toEqual(remote)
    expect(r.conflicts).toBe(0)
  })

  it("keeps marks made offline on both devices and adds the counts", () => {
    const local = data([mark(sub(), "2026-10-05", "P")])
    const remote = data([mark(sub(), "2026-10-04", "A")])
    const r = mergeData(base, local, remote)
    const s = r.data.subjects[0]
    expect(s.log).toHaveLength(5)
    expect(s.attended).toBe(11)
    expect(s.missed).toBe(3)
    expect(r.conflicts).toBe(0)
  })

  it("does not count the same mark twice when both devices made it", () => {
    const both = mark(sub(), "2026-10-04", "P")
    const r = mergeData(base, data([both]), data([both]))
    expect(r.data.subjects[0].attended).toBe(11)
    expect(r.data.subjects[0].log).toHaveLength(4)
  })

  it("flags a real clash, keeps this device's value and loses nothing else", () => {
    const local = data([mark(sub(), "2026-10-04", "P")])
    const remote = data([mark(sub(), "2026-10-04", "A")])
    const r = mergeData(base, local, remote)
    expect(r.conflicts).toBe(1)
    expect(r.data.subjects[0].log?.find((e) => e.d === "2026-10-04")?.s).toBe("P")
    expect(r.data.subjects[0].attended).toBe(11)
    expect(r.data.subjects[0].missed).toBe(2)
  })

  it("keeps new subjects from both sides and honours an untouched deletion", () => {
    const other = sub({ id: "s2", name: "OS" })
    const b = data([sub(), other])
    const local = data([sub(), other, sub({ id: "s3", name: "CN" })]) // added CN
    const remote = data([sub()]) // deleted OS
    const r = mergeData(b, local, remote)
    expect(r.data.subjects.map((s) => s.id)).toEqual(["s1", "s3"])
  })

  it("keeps a subject that was deleted on one side but edited on the other", () => {
    const b = data([sub()])
    const local = data([sub({ requirement: 80 })])
    const r = mergeData(b, local, data([]))
    expect(r.data.subjects).toHaveLength(1)
    expect(r.data.subjects[0].requirement).toBe(80)
    expect(r.conflicts).toBe(1)
  })

  it("merges favour counters from two devices", () => {
    const mate = { id: "m", name: "Arjun", covered: 1, repaid: 0, coveredLog: ["2026-10-01"] }
    const b = data([], { mates: [mate] })
    const local = data([], { mates: [{ ...mate, covered: 2, coveredLog: ["2026-10-01", "2026-10-02"] }] })
    const remote = data([], { mates: [{ ...mate, repaid: 1, repaidLog: ["2026-10-03"] }] })
    const m = mergeData(b, local, remote).data.mates[0]
    expect(m).toMatchObject({ covered: 2, repaid: 1, coveredLog: ["2026-10-01", "2026-10-02"], repaidLog: ["2026-10-03"] })
  })

  it("without a base, matches the same subject by name and never double counts", () => {
    const local = data([sub({ id: "local-1" })])
    const remote = data([mark(sub({ id: "remote-9" }), "2026-10-04", "P")])
    const r = mergeData(null, local, remote)
    expect(r.data.subjects).toHaveLength(1)
    expect(r.data.subjects[0].id).toBe("local-1")
    expect(r.data.subjects[0].attended).toBe(11)
    expect(r.data.subjects[0].log).toHaveLength(4)
  })

  it("without a base, a device with data and an account with different subjects ends with all of them", () => {
    const r = mergeData(null, data([sub({ id: "a", name: "Maths" })]), data([sub({ id: "b", name: "Physics" })]))
    expect(r.data.subjects.map((s) => s.name).sort()).toEqual(["Maths", "Physics"])
  })

  it("merging an already merged copy changes nothing (devices never ping-pong)", () => {
    const local = data([mark(sub(), "2026-10-05", "P")])
    const remote = data([mark(sub(), "2026-10-04", "A")])
    const once = mergeData(base, local, remote).data
    expect(mergeData(once, once, once).data).toEqual(once)
    expect(mergeData(remote, once, remote).data).toEqual(once)
  })
})
