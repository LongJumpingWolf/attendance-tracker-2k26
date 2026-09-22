import type { Ping } from "./types"
import { daysUntil } from "./attendance"

/** A ping nobody answered within this many days is treated as expired: it stops asking and shows as "no reply" */
export const PING_EXPIRES_DAYS = 3
/** Pings older than this are deleted by the person who sent them, so history stays short */
export const PING_HISTORY_DAYS = 30

/** How many whole days ago the classes were (0 = today) */
export const daysSince = (date: string) => -daysUntil(date)

export const isExpired = (p: Ping) => p.status === "asking" && daysSince(p.date) > PING_EXPIRES_DAYS

/** "Today", "Yesterday", "3 days ago" */
export function whenLabel(date: string) {
  const n = daysSince(date)
  if (n <= 0) return "Today"
  if (n === 1) return "Yesterday"
  return `${n} days ago`
}
