import { localDate } from "./attendance"
import type { LogEntry, Mate, Subject, Task } from "./types"

/**
 * A realistic, ready-to-explore dataset for the "Try a demo" button in Settings — enough subjects, history,
 * deadlines and mates for every screen to look the way it would after a real term, not empty or placeholder-y.
 * Everything it creates is tagged with this prefix, so it can be told apart from real data and removed in one go.
 */
export const DEMO_PREFIX = "demo-"
export const isDemoId = (id: string) => id.startsWith(DEMO_PREFIX)

const clamp = (m: number) => Math.max(0, Math.min(23 * 60 + 59, Math.round(m)))
const hm = (m: number) => `${String(Math.floor(clamp(m) / 60)).padStart(2, "0")}:${String(clamp(m) % 60).padStart(2, "0")}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

/** Every past date (strictly before `now`) that fell on weekday `dow`, going back `weeks` full weeks */
function pastWeekdays(now: Date, dow: number, weeks: number): string[] {
  const out: string[] = []
  for (let back = 1; back <= weeks * 7; back++) {
    const d = addDays(now, -back)
    if (d.getDay() === dow) out.push(localDate(d))
  }
  return out
}

/** Builds `log` entries for those dates, attending in the given pattern (true = present), oldest first */
function history(dates: string[], time: string, kind: string, attend: boolean[]): LogEntry[] {
  return dates
    .slice()
    .reverse()
    .map((d, i) => ({ d, t: time, k: kind, s: attend[i % attend.length] ? "P" : "A" }) as LogEntry)
}

export interface DemoBundle {
  subjects: Subject[]
  tasks: Task[]
  tags: string[]
  mates: Mate[]
}

/** A full sample term, built around the current moment so the Today tab has something live to show right away */
export function buildDemoData(now: Date): DemoBundle {
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const today = now.getDay()
  const tomorrow = (today + 1) % 7
  const dayAfter = (today + 2) % 7
  const id = (s: string) => `${DEMO_PREFIX}${s}`

  // Three of today's classes, timed around this exact moment: one ended without a mark, one is happening right
  // now, and one is coming up — between them the Today tab shows its notice banner, its "NOW" card and its "UP
  // NEXT" card, whatever time of day the demo is opened.
  const anatomy: Subject = {
    id: id("anatomy"),
    name: "Anatomy",
    attended: 24,
    missed: 3,
    requirement: 75,
    glowColor: "#0a84ff",
    tags: ["Theory", "Core"],
    slots: [{ day: today, start: hm(nowMin - 70), end: hm(nowMin - 10), kind: "Lecture" }],
    log: history(pastWeekdays(now, today, 3), hm(nowMin - 70), "Lecture", [true, true, false, true, true, true, true, true, true]),
  }
  const physiology: Subject = {
    id: id("physiology"),
    name: "Physiology",
    attended: 19,
    missed: 6,
    requirement: 75,
    glowColor: "#30d158",
    tags: ["Theory"],
    slots: [{ day: today, start: hm(nowMin - 5), end: hm(nowMin + 55), kind: "Lecture" }],
    log: history(pastWeekdays(now, today, 3), hm(nowMin - 5), "Lecture", [true, false, true, true, false, true, true, true]),
  }
  const biochemistry: Subject = {
    id: id("biochemistry"),
    name: "Biochemistry",
    attended: 11,
    missed: 9,
    requirement: 75,
    glowColor: "#ff9f0a",
    tags: ["Practical"],
    slots: [{ day: today, start: hm(nowMin + 70), end: hm(nowMin + 130), kind: "Practical" }],
    log: history(pastWeekdays(now, today, 3), hm(nowMin + 70), "Practical", [false, true, false, true, false, false, true]),
  }

  // Two more on other days, so Subjects' by-timetable view and the week strip have more than one day on them
  const pharmacology: Subject = {
    id: id("pharmacology"),
    name: "Pharmacology",
    attended: 21,
    missed: 4,
    requirement: 75,
    glowColor: "#bf5af2",
    tags: ["Theory"],
    slots: [{ day: tomorrow, start: "09:00", end: "10:00", kind: "Lecture" }],
    log: history(pastWeekdays(now, tomorrow, 3), "09:00", "Lecture", [true, true, true, false, true, true, true]),
  }
  const pathology: Subject = {
    id: id("pathology"),
    name: "Pathology",
    attended: 14,
    missed: 5,
    requirement: 75,
    glowColor: "#ff375f",
    tags: ["Practical"],
    slots: [{ day: dayAfter, start: "14:00", end: "15:00", kind: "Practical" }],
    log: history(pastWeekdays(now, dayAfter, 3), "14:00", "Practical", [true, false, true, true, false, true]),
  }

  // One with no timetable at all, already marked for today — shows the "any time" case, and fills "Marked today"
  const microbiology: Subject = {
    id: id("microbiology"),
    name: "Microbiology",
    attended: 9,
    missed: 1,
    requirement: 75,
    glowColor: "#5e5ce6",
    tags: ["Elective"],
    slots: [],
    log: [{ d: localDate(now), s: "P" }],
  }

  // A couple of last week's marks came from a mate covering — ties the subject history, the mates leaderboard and
  // the weekly wrapped story together the same way a real cover would
  const coverDates = pastWeekdays(now, today, 1)
  if (coverDates[0]) {
    const first = anatomy.log!.find((e) => e.d === coverDates[0])
    if (first) {
      first.s = "P"
      first.by = "Zoe"
    }
  }

  const zoe: Mate = {
    id: id("zoe"),
    name: "Zoe",
    covered: 5,
    repaid: 3,
    coveredLog: [...(coverDates[0] ? [coverDates[0]] : []), ...pastWeekdays(now, tomorrow, 2)].slice(0, 5),
    repaidLog: pastWeekdays(now, dayAfter, 2).slice(0, 3),
  }
  const ryan: Mate = {
    id: id("ryan"),
    name: "Ryan",
    covered: 2,
    repaid: 2,
    coveredLog: pastWeekdays(now, dayAfter, 1).slice(0, 2),
    repaidLog: pastWeekdays(now, dayAfter, 1).slice(0, 2),
  }
  const ava: Mate = { id: id("ava"), name: "Ava", covered: 0, repaid: 0, coveredLog: [], repaidLog: [] }

  const tasks: Task[] = [
    { id: id("t1"), title: "Pathology mid-sem", dueDate: localDate(now), subjectId: pathology.id, remindDaysBefore: 1 },
    { id: id("t2"), title: "Anatomy practical file submission", dueDate: localDate(addDays(now, 3)), subjectId: anatomy.id, remindDaysBefore: 2 },
    { id: id("t3"), title: "Biochemistry assignment", dueDate: localDate(addDays(now, -2)), subjectId: biochemistry.id, remindDaysBefore: 1 },
    { id: id("t4"), title: "Microbiology viva prep", dueDate: localDate(addDays(now, -6)), subjectId: microbiology.id, done: true },
  ]

  return {
    subjects: [anatomy, physiology, biochemistry, pharmacology, pathology, microbiology],
    tasks,
    tags: ["Theory", "Core", "Practical", "Elective"],
    mates: [zoe, ryan, ava],
  }
}
