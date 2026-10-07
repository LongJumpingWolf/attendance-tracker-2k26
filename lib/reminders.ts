/**
 * Class reminders: a small local schedule ("10 minutes before Biology on Mondays"). It lives in localStorage and is
 * checked by the app itself (hooks/use-notifications.ts), so a reminder only appears while the app is open.
 */
import type { Slot, Subject } from "./types"
import { formatTime, toMin } from "./attendance"

export interface ScheduleEntry {
  id: string
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

export function loadSchedule(): ScheduleEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveSchedule(list: ScheduleEntry[]) {
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(list))
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
  subjects.forEach((s, i) => {
    ;(s.slots ?? []).forEach((slot: Slot, j) => {
      const dup = existing.some((e) => e.subjectName === s.name && e.day === slot.day && e.startTime === slot.start)
      if (dup) return
      out.push({ id: `${stamp}-${i}-${j}`, day: slot.day, startTime: slot.start, endTime: slot.end, subjectName: s.name, notifyOffset: 10, notifyWhen: "before" })
    })
  })
  return out
}
