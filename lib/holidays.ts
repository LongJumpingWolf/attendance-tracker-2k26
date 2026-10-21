import type { Holiday } from "./types"

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
