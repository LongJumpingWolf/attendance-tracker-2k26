/**
 * Timetable import. Reading a photo of a timetable is done by ChatGPT (or any vision model): the user gets the
 * prompt below, uploads their photo, and pastes the JSON it returns. This file parses that paste leniently,
 * finds whatever is missing, and turns the answers into subjects.
 *
 * Nothing is invented: a slot missing its day or times is dropped if the user skips it, and optional
 * details (class type) are simply left blank and not shown.
 */
import type { Slot, Subject } from "./types"

export const DEFAULT_REQUIREMENT = 75

const SUBJECT_COLORS = ["#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#ff9f0a", "#64d2ff"]

/** The text the user copies into ChatGPT together with a photo of their timetable */
export const IMPORT_PROMPT = `I'm attaching a photo of my college timetable. Read it carefully and turn it into JSON for an attendance app.

Reply with ONE code block containing only JSON in exactly this shape, and nothing outside the code block:

\`\`\`json
{
  "subjects": [
    {
      "name": "Database Systems",
      "requirement": null,
      "slots": [
        { "day": "Mon", "start": "09:00", "end": "10:00", "type": "Lecture" },
        { "day": "Wed", "start": "11:00", "end": "13:00", "type": "Practical" }
      ]
    }
  ]
}
\`\`\`

Rules:
- One entry per subject. Put every time that subject appears (each day and time) in its "slots" list.
- "day" must be one of: Mon, Tue, Wed, Thu, Fri, Sat, Sun.
- "start" and "end" are 24-hour HH:MM, for example 09:00 or 14:30.
- "type" must be Lecture, Practical or Tutorial. Labs are Practical. Use null if the timetable doesn't say.
- "requirement" is the minimum attendance percentage as a number (75 for 75%), but only if it is printed on the timetable. Otherwise null.
- If any detail is not visible or you are not sure, use null. Never guess or invent anything.
- Use the subject's full name if it is printed, otherwise the code exactly as printed.
- Ignore breaks, lunch and free periods.
- If one cell lists two subjects (for example alternating weeks), add both as separate subjects.
- The result must be valid JSON: double quotes, no comments, no trailing commas.`

/* ---------- parsing ---------- */

export interface DraftSlot {
  day: number | null
  start: string | null
  end: string | null
  kind: string | null
}

export interface DraftSubject {
  name: string | null
  requirement: number | null
  slots: DraftSlot[]
}

export type ParseResult = { ok: true; subjects: DraftSubject[] } | { ok: false; error: string }

const DAYS: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

export function normalizeDay(v: unknown): number | null {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 6) return v
  if (typeof v !== "string") return null
  const t = v.trim().toLowerCase()
  if (!t) return null
  if (/^[0-6]$/.test(t)) return Number(t)
  if (t === "th" || t === "thur" || t === "thurs") return 4
  return DAYS[t.slice(0, 3)] ?? null
}

/** "9", "9am", "9:30 pm", "0930", "14:30", "14.30" -> "HH:MM", or null when it can't be read */
export function normalizeTime(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.trim().toLowerCase().replace(/\./g, ":")
  if (!t) return null
  let m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/.exec(t) ?? /^(\d{1,2})()\s*(am|pm)$/.exec(t)
  if (!m && /^\d{4}$/.test(t)) m = [t, t.slice(0, 2), t.slice(2), ""] as unknown as RegExpExecArray
  if (!m) return null
  let h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  const ap = m[3]
  if (ap === "pm" && h < 12) h += 12
  if (ap === "am" && h === 12) h = 0
  if (h > 23 || min > 59) return null
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`
}

export function normalizeKind(v: unknown): string | null {
  if (typeof v !== "string") return null
  const t = v.toLowerCase()
  if (/lab|pract/.test(t)) return "Practical"
  if (/tut/.test(t)) return "Tutorial"
  if (/lec|theory/.test(t)) return "Lecture"
  return null
}

function normalizeRequirement(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN
  return Number.isFinite(n) && n >= 1 && n <= 100 ? Math.round(n) : null
}

/** Pulls the JSON out of whatever was pasted: a code block, a code block plus chatter, or bare JSON */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  let body = (fenced ? fenced[1] : text).trim()
  const first = body.search(/[{[]/)
  const last = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"))
  if (first !== -1 && last > first) body = body.slice(first, last + 1)
  return body
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, "$1")
}

export function parseTimetable(text: string): ParseResult {
  if (!text.trim()) return { ok: false, error: "Paste the code block ChatGPT gave you first." }
  let data: unknown
  try {
    data = JSON.parse(extractJson(text))
  } catch {
    return { ok: false, error: "That doesn't look like the code block. Copy everything inside it, then paste again." }
  }
  const list = Array.isArray(data) ? data : (data as { subjects?: unknown })?.subjects
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "No subjects were found in that." }

  const subjects: DraftSubject[] = list
    .filter((x): x is Record<string, unknown> => typeof x === "object" && x !== null)
    .map((x) => {
      const name = typeof x.name === "string" && x.name.trim() ? x.name.trim().slice(0, 60) : null
      const rawSlots = Array.isArray(x.slots) ? x.slots : []
      const seen = new Set<string>()
      const slots: DraftSlot[] = []
      for (const r of rawSlots) {
        if (typeof r !== "object" || r === null) continue
        const o = r as Record<string, unknown>
        const slot: DraftSlot = {
          day: normalizeDay(o.day),
          start: normalizeTime(o.start),
          end: normalizeTime(o.end),
          kind: normalizeKind(o.type ?? o.kind),
        }
        const key = `${slot.day}|${slot.start}|${slot.end}`
        if (seen.has(key)) continue
        seen.add(key)
        slots.push(slot)
      }
      return { name, requirement: normalizeRequirement(x.requirement), slots }
    })
  if (subjects.length === 0) return { ok: false, error: "No subjects were found in that." }
  return { ok: true, subjects }
}

/* ---------- what's missing ---------- */

export type IssueField = "name" | "day" | "start" | "end" | "requirement"

export interface Issue {
  id: string
  field: IssueField
  subject: number
  slot?: number
  /** The question shown to the user */
  question: string
  /** What happens if they skip it */
  ifSkipped: string
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

const describeSlot = (s: DraftSlot) =>
  [s.day !== null ? DAY_NAMES[s.day] : null, s.start && s.end ? `${s.start}–${s.end}` : s.start ? `from ${s.start}` : s.end ? `until ${s.end}` : null]
    .filter(Boolean)
    .join(" ")

/**
 * Everything that is needed but wasn't in the paste, in the order it will be asked.
 * Attendance requirement is asked once for all subjects that lack it, and only if any do.
 */
export function findIssues(subjects: DraftSubject[]): Issue[] {
  const issues: Issue[] = []
  subjects.forEach((s, i) => {
    const label = s.name ?? `Subject ${i + 1}`
    if (s.name === null) {
      issues.push({
        id: `${i}:name`,
        field: "name",
        subject: i,
        question: `What is subject ${i + 1} called?${s.slots.length ? ` (it has ${s.slots.length} class${s.slots.length === 1 ? "" : "es"})` : ""}`,
        ifSkipped: "This subject won't be added.",
      })
    }
    s.slots.forEach((slot, j) => {
      const what = describeSlot(slot)
      const who = what ? `${label} (${what})` : `${label}, class ${j + 1}`
      if (slot.day === null)
        issues.push({ id: `${i}:${j}:day`, field: "day", subject: i, slot: j, question: `Which day is ${who}?`, ifSkipped: "This class won't appear on your timetable." })
      if (slot.start === null)
        issues.push({ id: `${i}:${j}:start`, field: "start", subject: i, slot: j, question: `What time does ${who} start?`, ifSkipped: "This class won't appear on your timetable." })
      if (slot.end === null)
        issues.push({ id: `${i}:${j}:end`, field: "end", subject: i, slot: j, question: `What time does ${who} end?`, ifSkipped: "This class won't appear on your timetable." })
    })
  })
  if (subjects.some((s) => s.requirement === null)) {
    issues.push({
      id: "requirement",
      field: "requirement",
      subject: -1,
      question: "What is the minimum attendance your college asks for?",
      ifSkipped: `${DEFAULT_REQUIREMENT}% will be used. You can change it per subject later.`,
    })
  }
  return issues
}

/** Checks one typed answer. Returns the cleaned value, or null when it isn't valid for that field. */
export function cleanAnswer(field: IssueField, raw: string): string | number | null {
  const v = raw.trim()
  if (!v) return null
  if (field === "name") return v.slice(0, 60)
  if (field === "day") return normalizeDay(v)
  if (field === "requirement") return normalizeRequirement(v.replace("%", ""))
  return normalizeTime(v)
}

/* ---------- resolving ---------- */

export interface FinalSubject {
  name: string
  requirement: number
  /** true when the requirement came from the timetable or the user, not the default */
  requirementKnown: boolean
  slots: Slot[]
}

export interface Resolved {
  subjects: FinalSubject[]
  /** Human-readable notes about anything left out */
  notes: string[]
}

/** Combine the paste with the user's answers (missing key = skipped) into subjects ready to add */
export function resolveImport(drafts: DraftSubject[], answers: Record<string, string | number>): Resolved {
  const notes: string[] = []
  const globalReq = typeof answers.requirement === "number" ? answers.requirement : null
  const subjects: FinalSubject[] = []

  drafts.forEach((d, i) => {
    const name = d.name ?? (typeof answers[`${i}:name`] === "string" ? (answers[`${i}:name`] as string) : null)
    if (!name) {
      notes.push(`Subject ${i + 1} was left out because it has no name.`)
      return
    }
    const slots: Slot[] = []
    d.slots.forEach((s, j) => {
      const day = s.day ?? (typeof answers[`${i}:${j}:day`] === "number" ? (answers[`${i}:${j}:day`] as number) : null)
      const start = s.start ?? (typeof answers[`${i}:${j}:start`] === "string" ? (answers[`${i}:${j}:start`] as string) : null)
      const end = s.end ?? (typeof answers[`${i}:${j}:end`] === "string" ? (answers[`${i}:${j}:end`] as string) : null)
      if (day === null || start === null || end === null) {
        notes.push(`One ${name} class is missing its ${[day === null && "day", start === null && "start time", end === null && "end time"].filter(Boolean).join(" and ")}, so it isn't on your timetable.`)
        return
      }
      if (end <= start) {
        notes.push(`One ${name} class ends before it starts, so it isn't on your timetable.`)
        return
      }
      slots.push({ day, start, end, ...(s.kind ? { kind: s.kind } : {}) })
    })
    slots.sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))
    const requirement = d.requirement ?? globalReq
    subjects.push({ name, requirement: requirement ?? DEFAULT_REQUIREMENT, requirementKnown: requirement !== null, slots })
  })
  return { subjects, notes }
}

/* ---------- adding to the app ---------- */

const key = (n: string) => n.trim().toLowerCase().replace(/\s+/g, " ")

export interface ImportSummary {
  added: { id: string; name: string; slots: Slot[] }[]
  updated: { id: string; name: string; before: Slot[]; after: Slot[]; requirementFrom?: number; requirementTo?: number; changed: boolean }[]
  /** Anything left out, in plain words */
  notes: string[]
}

/**
 * Adds new subjects; a subject that already exists keeps its attendance and gets the imported timetable.
 * Returns the new list, counts, and a summary of exactly what changed for the review screen.
 */
export function applyImport(existing: Subject[], incoming: FinalSubject[], notes: string[] = []) {
  const next = [...existing]
  const summary: ImportSummary = { added: [], updated: [], notes }
  const stamp = Date.now()
  incoming.forEach((inc, i) => {
    const at = next.findIndex((s) => key(s.name) === key(inc.name))
    if (at !== -1) {
      const cur = next[at]
      const before = cur.slots ?? []
      const after = inc.slots.length ? inc.slots : before
      const requirementChanged = inc.requirementKnown && inc.requirement !== cur.requirement
      next[at] = { ...cur, slots: after, ...(inc.requirementKnown ? { requirement: inc.requirement } : {}) }
      summary.updated.push({
        id: cur.id,
        name: cur.name,
        before,
        after,
        ...(requirementChanged ? { requirementFrom: cur.requirement, requirementTo: inc.requirement } : {}),
        changed: slotKey(before) !== slotKey(after) || requirementChanged,
      })
      return
    }
    const id = `${stamp}${i}`
    next.push({
      id,
      name: inc.name,
      attended: 0,
      missed: 0,
      requirement: inc.requirement,
      glowColor: SUBJECT_COLORS[(existing.length + summary.added.length) % SUBJECT_COLORS.length],
      tags: [],
      slots: inc.slots,
    })
    summary.added.push({ id, name: inc.name, slots: inc.slots })
  })
  return { subjects: next, added: summary.added.length, updated: summary.updated.length, summary }
}

const slotKey = (slots: Slot[]) => slots.map((x) => `${x.day}|${x.start}|${x.end}`).sort().join(";")

/** Which of the incoming subjects already exist (for the review screen) */
export const isExisting = (existing: Subject[], name: string) => existing.some((s) => key(s.name) === key(name))
