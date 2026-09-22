import type { Subject } from "./types"

/** Test subjects are recognisable by this id prefix, so they can be replaced or removed without touching real ones */
export const TEST_PREFIX = "scantest-"
export const isTestSubject = (s: Subject) => s.id.startsWith(TEST_PREFIX)

const clamp = (m: number) => Math.max(0, Math.min(23 * 60 + 59, Math.round(m)))
const hm = (m: number) => `${String(Math.floor(clamp(m) / 60)).padStart(2, "0")}:${String(clamp(m) % 60).padStart(2, "0")}`

/** Minutes from now: [start, end] */
const PLAN: { id: string; name: string; color: string; at: [number, number]; kind: string }[] = [
  { id: "anatomy", name: "Test · Anatomy", color: "#0a84ff", at: [-15, 45], kind: "Lecture" }, // in progress: a scan marks this
  { id: "physiology", name: "Test · Physiology", color: "#30d158", at: [-130, -70], kind: "Lecture" }, // ended long ago
  { id: "biochem", name: "Test · Biochemistry", color: "#ff9f0a", at: [60, 120], kind: "Practical" }, // later today
  { id: "pathology", name: "Test · Pathology", color: "#bf5af2", at: [180, 240], kind: "Lecture" },
]

/** A clashing class, to see the "which class is this?" picker */
const OVERLAP = { id: "pharmacology", name: "Test · Pharmacology", color: "#ff375f", at: [-5, 55] as [number, number], kind: "Tutorial" }

/** A small timetable built around the current time, so a scan right now has something to match */
export function buildTestSubjects(now: Date, withOverlap = false): Subject[] {
  const nowMin = now.getHours() * 60 + now.getMinutes()
  return (withOverlap ? [...PLAN, OVERLAP] : PLAN).map((p) => ({
    id: TEST_PREFIX + p.id,
    name: p.name,
    attended: 18,
    missed: 3,
    requirement: 75,
    glowColor: p.color,
    tags: ["Test"],
    slots: [{ day: now.getDay(), start: hm(nowMin + p.at[0]), end: hm(nowMin + p.at[1]), kind: p.kind }],
    log: [],
  }))
}
