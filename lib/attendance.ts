import type { Subject, Slot, LogEntry } from "./types"

export type AttendanceStatus = "new" | "safe" | "edge" | "risk"

export interface AttendanceInfo {
  total: number
  pct: number
  status: AttendanceStatus
  /** Classes that can still be skipped; null = no limit (requirement 0) */
  canSkip: number | null
  /** Classes to attend in a row to recover; null = impossible (requirement 100) */
  needed: number | null
  message: string
  /** Very short note for small tiles */
  short: string
}

/** System colours carry meaning: green = fine, orange = close, red = at risk. */
export const STATUS_STYLES: Record<AttendanceStatus, { label: string; text: string; tint: string; color: string }> = {
  new: { label: "New", text: "text-mute", tint: "bg-ink/10", color: "#8e8e93" },
  safe: { label: "On track", text: "text-mute", tint: "bg-good/15", color: "#34c759" },
  edge: { label: "Close", text: "text-mute", tint: "bg-ink/10", color: "#8e8e93" },
  risk: { label: "At risk", text: "text-bad", tint: "bg-bad/15", color: "#ff3b30" },
}

const plural = (n: number) => `${n} ${n === 1 ? "class" : "classes"}`
const skips = (n: number) => `${n} ${n === 1 ? "skip" : "skips"} available`

export function getAttendance(attended: number, missed: number, requirement: number): AttendanceInfo {
  const total = attended + missed
  const pct = total > 0 ? Math.round((attended / total) * 100) : 0
  const r = requirement / 100

  if (total === 0) {
    return { total, pct, status: "new", canSkip: null, needed: null, message: "No classes marked yet", short: "Not started" }
  }

  if (pct < requirement) {
    const needed = r >= 1 ? null : Math.max(1, Math.ceil((r * total - attended) / (1 - r) - 1e-9))
    return {
      total,
      pct,
      status: "risk",
      canSkip: 0,
      needed,
      message: needed === null ? "Can't get back to 100%" : `Attend the next ${plural(needed)} to recover`,
      short: needed === null ? "Below limit" : `Attend next ${needed}`,
    }
  }

  const canSkip = r <= 0 ? null : Math.max(0, Math.floor((attended - r * total) / r + 1e-9))
  if (canSkip === 0) {
    return { total, pct, status: "edge", canSkip, needed: null, message: "No skips left", short: "No skips left" }
  }
  return {
    total,
    pct,
    status: "safe",
    canSkip,
    needed: null,
    message: canSkip === null ? "No minimum set" : skips(canSkip),
    short: canSkip === null ? "No minimum" : skips(canSkip),
  }
}

/**
 * Can this class be skipped? This is the rule the "Can I skip tomorrow?" widget already used, moved here so every screen
 * reads the same answer: no marks yet, fine to skip (not below the minimum and a skip to spare), or must attend.
 */
export type SkipVerdict = "nodata" | "skip" | "attend"
export const skipVerdict = (info: AttendanceInfo): SkipVerdict =>
  info.total === 0 ? "nodata" : info.status !== "risk" && (info.canSkip === null || info.canSkip > 0) ? "skip" : "attend"

export interface ClassVerdict {
  kind: "skip" | "must" | "reach" | "nodata"
  label: string
  /** The existing short note, e.g. "2 skips available", "No skips left", "Attend next 3" */
  detail: string
  /** Current attendance %, or null when nothing is marked yet (so no misleading 0%) */
  pct: number | null
}

/** The answer to "can I afford to miss this class?" for a subject, from its current marks */
export function classVerdict(s: Subject): ClassVerdict {
  const info = getAttendance(s.attended, s.missed, s.requirement)
  const v = skipVerdict(info)
  if (v === "nodata") return { kind: "nodata", label: "NO MARKS YET", detail: "Mark a class to see where you stand", pct: null }
  if (v === "skip") return { kind: "skip", label: "SAFE TO SKIP", detail: info.short, pct: info.pct }
  if (info.status === "risk") return { kind: "reach", label: "ATTEND TO REACH TARGET", detail: info.short, pct: info.pct }
  return { kind: "must", label: "MUST ATTEND", detail: info.short, pct: info.pct }
}

/** A subject that needs a look: below its minimum, or exactly at it with no skip to spare */
export const needsAttention = (info: AttendanceInfo) => info.status === "risk" || info.status === "edge"

/** Sorts least safe first: how far each subject is from its minimum. Subjects with no marks yet go last. */
export const bySafety = (a: Subject, b: Subject) => {
  const gap = (s: Subject) => (s.attended + s.missed > 0 ? getAttendance(s.attended, s.missed, s.requirement).pct - s.requirement : 999)
  return gap(a) - gap(b)
}

/** The latest marks recorded for a subject, newest first (a mark with no class time sorts before the timed ones that day) */
export function recentMarks(s: Subject, n = 6): LogEntry[] {
  return [...(s.log || [])].sort((a, b) => (a.d === b.d ? (b.t ?? "").localeCompare(a.t ?? "") : a.d < b.d ? 1 : -1)).slice(0, n)
}

/** Total classes you could still skip across every subject */
export function skipBudget(subjects: Subject[]): number {
  return subjects.reduce((n, s) => n + (getAttendance(s.attended, s.missed, s.requirement).canSkip ?? 0), 0)
}

/* ---------- dates & times ---------- */

export const localDate = (d: Date = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`

/** "YYYY-MM-DD" strings are read as local dates (new Date() would treat them as UTC). */
export function parseLocalDate(dateStr: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(dateStr)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(dateStr)
}

export function daysUntil(dateStr: string): number {
  const due = parseLocalDate(dateStr)
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  due.setHours(0, 0, 0, 0)
  return Math.round((due.getTime() - today.getTime()) / 86400000)
}

/** Trailing countdown for a deadline: a big figure, a small unit and a colour */
export function countdown(days: number): { big: string; small: string; tone: string } {
  if (days < 0) return { big: String(Math.abs(days)), small: Math.abs(days) === 1 ? "day late" : "days late", tone: "text-bad" }
  if (days === 0) return { big: "Today", small: "", tone: "text-bad" }
  if (days === 1) return { big: "Tomorrow", small: "", tone: "text-ink" }
  return { big: String(days), small: "days", tone: days <= 3 ? "text-ink" : "text-mute" }
}

export const formatDayMonth = (dateStr: string) =>
  parseLocalDate(dateStr).toLocaleDateString("en-US", { month: "short", day: "numeric" })

export const formatShortDate = (dateStr: string) =>
  parseLocalDate(dateStr).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })

export const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"]
export const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

export const toMin = (t: string) => {
  const [h, m] = t.split(":").map(Number)
  return h * 60 + (m || 0)
}

export function formatTime(t: string) {
  const [h, m] = t.split(":").map(Number)
  return `${h % 12 || 12}:${String(m || 0).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`
}

/** "16:30" -> { time: "4:30", ap: "pm" } for stacked timetable labels */
export function timeParts(t: string) {
  const [h, m] = t.split(":").map(Number)
  return { time: `${h % 12 || 12}:${String(m || 0).padStart(2, "0")}`, ap: h >= 12 ? "pm" : "am" }
}

/* ---------- timetable ---------- */

export interface ClassSlot {
  subject: Subject
  slot: Slot
}

/** Classes happening on the given date, earliest first. Each (subject, start time) is one class, listed once. */
export function classesOn(subjects: Subject[], date: Date): ClassSlot[] {
  const day = date.getDay()
  const seen = new Set<string>()
  return subjects
    .flatMap((subject) => (subject.slots || []).filter((slot) => slot.day === day).map((slot) => ({ subject, slot })))
    .filter(({ subject, slot }) => {
      const key = `${subject.id}@${slot.start}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => toMin(a.slot.start) - toMin(b.slot.start))
}

/** A class on a given day, with its recorded state (null = not marked yet) */
export interface DayClass extends ClassSlot {
  key: string
  state: "P" | "A" | null
}

/**
 * What the Today screen is made of: only classes that are really on the timetable for that day, never a subject just
 * because it exists. A subject with no timetable, or none on this day, has no class today.
 */
export function dayClasses(subjects: Subject[], date: Date): DayClass[] {
  const d = localDate(date)
  return classesOn(subjects, date).map((c) => ({ ...c, key: `${c.subject.id}@${c.slot.start}`, state: markFor(c.subject, d, c.slot.start) }))
}

/** How many of the day's classes still need a mark, and whether the day is done (there were classes and none is left) */
export function dayProgress(classes: DayClass[]) {
  const toMark = classes.filter((c) => c.state === null).length
  return { total: classes.length, toMark, allDone: classes.length > 0 && toMark === 0 }
}

/** The mark details that tie a record to one class. Today and Subject Detail both use this, so they write the same record. */
export const slotMeta = (slot: Slot | null | undefined): MarkMeta | undefined =>
  slot ? { t: slot.start, ...(slot.kind ? { k: slot.kind } : {}) } : undefined

/* ---------- marking ---------- */

/** Status recorded for a date (and class start time, if the class has one). Latest entry wins. */
export function markFor(s: Subject, date: string, t = ""): "P" | "A" | null {
  const entries = (s.log || []).filter((x) => x.d === date && (x.t ?? "") === t)
  return entries.length ? entries[entries.length - 1].s : null
}

/** Who covered this class for you, if it was marked through a confirmed cover */
export function coveredBy(s: Subject, date: string, t = ""): string | null {
  const entries = (s.log || []).filter((x) => x.d === date && (x.t ?? "") === t)
  return entries.length ? (entries[entries.length - 1].by ?? null) : null
}

export interface MarkMeta {
  t?: string
  k?: string
  /** Name of the mate who covered this class for you */
  by?: string
}

/**
 * Set (or clear, with null) the status of one class on one date, keeping the counts consistent. A class is one
 * (date, start time): setting it again with the same status changes nothing, and changing it moves the count across
 * instead of adding another, so the same class can never be counted twice.
 */
export function withSet(s: Subject, date: string, status: "P" | "A" | null, meta?: MarkMeta): Subject {
  const t = meta?.t ?? ""
  const cur = markFor(s, date, t)
  if (cur === status) return s
  const log = [...(s.log || [])]
  let attended = s.attended
  let missed = s.missed
  for (let k = log.length - 1; k >= 0; k--) {
    if (log[k].d === date && (log[k].t ?? "") === t) {
      log.splice(k, 1)
      break
    }
  }
  if (cur === "P") attended = Math.max(0, attended - 1)
  if (cur === "A") missed = Math.max(0, missed - 1)
  if (status === "P") attended += 1
  if (status === "A") missed += 1
  if (status) log.push({ d: date, s: status, ...(meta?.t ? { t: meta.t } : {}), ...(meta?.k ? { k: meta.k } : {}), ...(meta?.by ? { by: meta.by } : {}) })
  return { ...s, attended, missed, log: log.slice(-400) }
}

/** The mark currently recorded for one class (date + start time), or null */
export function entryFor(s: Subject, date: string, t = ""): LogEntry | null {
  const entries = (s.log || []).filter((x) => x.d === date && (x.t ?? "") === t)
  return entries.length ? entries[entries.length - 1] : null
}

/** Puts one class back to what it was (a previous entry, or unmarked). Touches nothing else. */
export function restoreMark(s: Subject, date: string, t: string, prev: LogEntry | null): Subject {
  return withSet(s, date, prev ? prev.s : null, prev ? { t: prev.t, k: prev.k, by: prev.by } : { t })
}

/**
 * Marks one class and returns how to take exactly that back: the undo restores that class's own previous record, so
 * other classes of the same subject, marked before or after, are never touched.
 */
export function markWithUndo(s: Subject, date: string, status: "P" | "A" | null, meta?: MarkMeta) {
  const t = meta?.t ?? ""
  const prev = entryFor(s, date, t)
  return { next: withSet(s, date, status, meta), undo: (current: Subject) => restoreMark(current, date, t, prev) }
}

/* ---------- planning future lectures ---------- */

/** Dates (YYYY-MM-DD) of this subject's classes over the next `days` days, starting tomorrow */
export function futureClassDates(s: Subject, days = 35): string[] {
  const set = new Set((s.slots || []).map((x) => x.day))
  const out: string[] = []
  const now = new Date()
  for (let i = 1; i <= days; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i)
    if (set.has(d.getDay())) out.push(localDate(d))
  }
  return out
}

/** What your percentage becomes if you attend everything except the lectures you plan to skip */
export function projection(s: Subject, dates: string[]) {
  const plan = s.plan || {}
  const F = dates.length
  const skips = dates.filter((d) => plan[d] === "skip").length
  const total = s.attended + s.missed + F
  const pct = total ? Math.round(((s.attended + F - skips) / total) * 100) : 0
  const r = s.requirement / 100
  const maxSkips = Math.max(0, Math.min(F, Math.floor(s.attended + F - r * total + 1e-9)))
  return { F, skips, pct, maxSkips, ok: pct >= s.requirement }
}
