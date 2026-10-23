import type { Holiday, ScheduleOverride, Subject } from "./types"

/** Owner-supplied 2026 observances; duplicate dates are intentional. */
export const DEFAULT_HOLIDAYS: Holiday[] = [
  ["2026-01-26", "Republic Day"], ["2026-02-15", "Mahashivratri"],
  ["2026-02-19", "Chhatrapati Shivaji Maharaj Jayanti"], ["2026-03-03", "Holi (Second Day)"],
  ["2026-03-19", "Gudhi Padwa"], ["2026-03-22", "Ramzan Eid (Eid-ul-Fitr / Shawwal-1)"],
  ["2026-03-26", "Ram Navami"], ["2026-03-31", "Mahavir Janma Kalyanak"],
  ["2026-04-03", "Good Friday"], ["2026-04-14", "Dr. Babasaheb Ambedkar Jayanti"],
  ["2026-05-01", "Maharashtra Day"], ["2026-05-01", "Buddha Purnima"],
  ["2026-05-28", "Bakri Eid (Eid-ul-Zuha)"], ["2026-06-26", "Muharram"],
  ["2026-08-15", "Independence Day"], ["2026-08-15", "Parsi New Year (Shahenshahi)"],
  ["2026-08-26", "Eid-e-Milad"], ["2026-09-14", "Ganesh Chaturthi"],
  ["2026-10-02", "Mahatma Gandhi Jayanti"], ["2026-10-20", "Dussehra (Vijayadashami)"],
  ["2026-11-08", "Diwali Amavasya (Lakshmi Pujan)"], ["2026-11-10", "Diwali (Balipratipada)"],
  ["2026-11-11", "Bhaubeej (Bhai Dooj)"], ["2026-11-24", "Guru Nanak Jayanti"],
  ["2026-12-25", "Christmas"],
].map(([date, name], i) => ({ id: `default-holiday-${date}-${i}`, date, name }))

export function isHolidayOnDate(holiday: Holiday, date: string): boolean {
  return holiday.date <= date && (holiday.endDate ?? holiday.date) >= date
}

export function holidaysForDate(date: string, custom: Holiday[] = []): Holiday[] {
  return [...DEFAULT_HOLIDAYS, ...custom].filter((h) => isHolidayOnDate(h, date))
}

/** How far either side of today holidays are turned into cancelled classes (views only ever look at nearby dates) */
export const HOLIDAY_CANCEL_WINDOW_DAYS = 400

const pad = (n: number) => String(n).padStart(2, "0")
const keyOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

/**
 * "Holidays cancel classes": a cancelled-class exception for every weekly class that falls on a holiday (the built-in
 * list plus the person's own), so every screen that already understands cancelled classes (Today, the calendar, the
 * planner, reminders, scanning) treats a holiday as a day without class. They are made on the fly for display and never
 * saved or synced. A class the person already changed by hand that day (cancelled, or a substitute) is left as they set it.
 */
export function holidayCancellations(
  subjects: Pick<Subject, "id" | "slots">[],
  customHolidays: Holiday[],
  existing: Pick<ScheduleOverride, "date" | "originalSubjectId" | "start">[] = [],
  today = new Date(),
  windowDays = HOLIDAY_CANCEL_WINDOW_DAYS,
): ScheduleOverride[] {
  const slotted = subjects.filter((s) => (s.slots?.length ?? 0) > 0)
  if (slotted.length === 0) return []
  const taken = new Set(existing.map((o) => `${o.date}|${o.originalSubjectId}|${o.start}`))
  const out: ScheduleOverride[] = []
  for (let i = -windowDays; i <= windowDays; i++) {
    const day = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i)
    const date = keyOf(day)
    if (holidaysForDate(date, customHolidays).length === 0) continue
    for (const s of slotted) {
      for (const slot of s.slots ?? []) {
        if (slot.day !== day.getDay() || taken.has(`${date}|${s.id}|${slot.start}`)) continue
        out.push({ id: `holiday:${date}:${s.id}:${slot.start}`, date, originalSubjectId: s.id, start: slot.start, kind: "cancelled" })
      }
    }
  }
  return out
}

/** Whether an exception came from a holiday rather than from the person */
export const isHolidayCancellation = (o: Pick<ScheduleOverride, "id">) => o.id.startsWith("holiday:")
