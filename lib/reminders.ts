/**
 * Class reminders: a small local schedule ("10 minutes before Biology on Mondays"). It lives in localStorage and is
 * checked by the app itself (hooks/use-notifications.ts), so a reminder only appears while the app is open.
 */
import type { Slot, Subject } from "./types"
import { formatTime, toMin } from "./attendance"

export interface ScheduleEntry {
  id: string
  /** Immutable subject ID when linked to a subject; optional for older/manual reminder records. */
  subjectId?: string
  /** 0 = Sunday ... 6 = Saturday */
  day: number
  /** "HH:MM" (24h) */
  startTime: string
  endTime: string
  subjectName: string
  /** Minutes */
  notifyOffset: number
  /** before the class starts, or after it ends */
  notifyWhen: "before" | "after"
}

export const SCHEDULE_KEY = "notificationSchedule"
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
/** The week as shown on screen: Monday first */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

/** Validate persisted/imported reminders before the scheduler or editor uses them. Older entries get safe defaults. */
export function normalizeScheduleEntry(value: unknown): ScheduleEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const validTime = (time: unknown): time is string => typeof time === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)
  if (typeof raw.id !== "string" || !raw.id.trim()) return null
  if (!Number.isInteger(raw.day) || (raw.day as number) < 0 || (raw.day as number) > 6) return null
  if (!validTime(raw.startTime) || !validTime(raw.endTime) || toMin(raw.endTime) <= toMin(raw.startTime)) return null
  const notifyOffset = typeof raw.notifyOffset === "number" && Number.isFinite(raw.notifyOffset) && raw.notifyOffset >= 0 && raw.notifyOffset <= 240
    ? raw.notifyOffset
    : 10
  return {
    id: raw.id,
    ...(typeof raw.subjectId === "string" && raw.subjectId.trim() ? { subjectId: raw.subjectId } : {}),
    day: raw.day as number,
    startTime: raw.startTime,
    endTime: raw.endTime,
    subjectName: typeof raw.subjectName === "string" && raw.subjectName.trim() ? raw.subjectName : "Class",
    notifyOffset,
    notifyWhen: raw.notifyWhen === "after" ? "after" : "before",
  }
}

export function loadSchedule(): ScheduleEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.map(normalizeScheduleEntry).filter((entry): entry is ScheduleEntry => entry !== null)
      : []
  } catch {
    return []
  }
}

export function saveSchedule(list: ScheduleEntry[]) {
  try {
    const normalized = list.map(normalizeScheduleEntry).filter((entry): entry is ScheduleEntry => entry !== null)
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(normalized))
  } catch {
    /* storage full or blocked: the in-memory list still works this session */
  }
}

/** The clock time the reminder goes off, as "h:mm AM/PM" */
export function notifyClock(e: Pick<ScheduleEntry, "startTime" | "endTime" | "notifyOffset" | "notifyWhen">) {
  const base = e.notifyWhen === "before" ? toMin(e.startTime) - e.notifyOffset : toMin(e.endTime) + e.notifyOffset
  const m = ((base % 1440) + 1440) % 1440
  return formatTime(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`)
}

/** "10 min before it starts" / "5 min after it ends" */
export const describeReminder = (e: Pick<ScheduleEntry, "notifyOffset" | "notifyWhen">) =>
  e.notifyOffset === 0
    ? e.notifyWhen === "before"
      ? "When it starts"
      : "When it ends"
    : `${e.notifyOffset} min ${e.notifyWhen === "before" ? "before it starts" : "after it ends"}`

/** One reminder per timetable slot, 10 minutes before each class starts */
export function entriesFromTimetable(subjects: Subject[], existing: ScheduleEntry[]): ScheduleEntry[] {
  const out: ScheduleEntry[] = []
  const stamp = Date.now()
  const validExisting = existing.map(normalizeScheduleEntry).filter((entry): entry is ScheduleEntry => entry !== null)
  subjects.forEach((s, i) => {
    ;(s.slots ?? []).forEach((slot: Slot, j) => {
      const dup = [...validExisting, ...out].some((e) =>
        e.day === slot.day && e.startTime === slot.start &&
        (e.subjectId ? e.subjectId === s.id : e.subjectName === s.name),
      )
      if (dup) return
      const candidate = normalizeScheduleEntry({
        id: `${stamp}-${i}-${j}`,
        subjectId: s.id,
        day: slot.day,
        startTime: slot.start,
        endTime: slot.end,
        subjectName: s.name,
        notifyOffset: 10,
        notifyWhen: "before",
      })
      if (candidate) out.push(candidate)
    })
  })
  return out
}
