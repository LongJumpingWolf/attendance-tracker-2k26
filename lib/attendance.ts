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

/** Classes happening on the given date, earliest first */
export function classesOn(subjects: Subject[], date: Date): ClassSlot[] {
  const day = date.getDay()
  return subjects
    .flatMap((subject) => (subject.slots || []).filter((slot) => slot.day === day).map((slot) => ({ subject, slot })))
    .sort((a, b) => toMin(a.slot.start) - toMin(b.slot.start))
}

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

/** Append a mark (allows several lectures of one subject on the same day) */
export function withMark(s: Subject, kind: "attended" | "missed", date: string, meta?: MarkMeta): Subject {
  const entry: LogEntry = { d: date, s: kind === "attended" ? "P" : "A", ...(meta?.t ? { t: meta.t } : {}), ...(meta?.k ? { k: meta.k } : {}), ...(meta?.by ? { by: meta.by } : {}) }
  const log = [...(s.log || []), entry].slice(-400)
  return kind === "attended" ? { ...s, attended: s.attended + 1, log } : { ...s, missed: s.missed + 1, log }
}

/** Set (or clear, with null) the status of one class on one date, keeping the counts consistent */
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
