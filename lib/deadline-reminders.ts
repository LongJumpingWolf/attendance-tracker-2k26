import type { Task } from "./types"

const DAY_MS = 24 * 60 * 60 * 1000

function dayOrdinal(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const timestamp = Date.UTC(year, month - 1, day)
  const normalized = new Date(timestamp)
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) return null
  return timestamp / DAY_MS
}

/** Local-date arithmetic that does not shift around daylight-saving transitions. */
export function dateAfterDays(date: string, amount: number): string | null {
  const ordinal = dayOrdinal(date)
  if (ordinal === null || !Number.isFinite(amount)) return null
  const shifted = new Date((ordinal + Math.trunc(amount)) * DAY_MS)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0")
  const day = String(shifted.getUTCDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export interface DeadlineReminder {
  task: Task
  /** Positive = days until due; zero = due today; negative = overdue. */
  daysUntilDue: number
}

/**
 * Return unresolved deadline reminders active on a specific local date.
 * A reminder starts its selected number of days before the due date and stays
 * visible daily until resolved; snoozing hides it only until its selected date.
 */
export function deadlineRemindersForDate(tasks: Task[], today: string): DeadlineReminder[] {
  const todayOrdinal = dayOrdinal(today)
  if (todayOrdinal === null) return []

  return tasks
    .flatMap((task): DeadlineReminder[] => {
      if (task.done) return []
      const remindDays = task.remindDaysBefore ?? 1
      if (!Number.isFinite(remindDays) || remindDays < 0) return []
      const dueOrdinal = dayOrdinal(task.dueDate)
      if (dueOrdinal === null) return []
      const snoozedUntil = task.remindAgainOn ? dayOrdinal(task.remindAgainOn) : null
      if (snoozedUntil !== null && todayOrdinal < snoozedUntil) return []
      const daysUntilDue = dueOrdinal - todayOrdinal
      if (daysUntilDue > remindDays) return []
      return [{ task, daysUntilDue }]
    })
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue || a.task.title.localeCompare(b.task.title) || a.task.id.localeCompare(b.task.id))
}
