import type { Ping } from "./types"
import { daysUntil } from "./attendance"

/** A ping nobody answered within this many days is treated as expired: it stops asking and shows as "no reply" */
export const PING_EXPIRES_DAYS = 3
/** Pings older than this are deleted by the person who sent them, so history stays short */
export const PING_HISTORY_DAYS = 30

/** How many whole days ago the classes were (0 = today) */
export const daysSince = (date: string) => -daysUntil(date)

/** The mate has replied (whether or not the asker's device has applied it yet) */
export const isAnswered = (p: Ping) => p.status === "answered" || p.status === "processed"

/** Firestore timestamps arrive as objects ({seconds} / toMillis()); a write still pending is null; tests and demos use numbers */
export function msOf(ts: unknown): number | null {
  if (typeof ts === "number") return ts
  if (typeof ts === "object" && ts !== null && !Array.isArray(ts)) {
    const t = ts as { toMillis?: () => number; seconds?: number }
    if (typeof t.toMillis === "function") return t.toMillis()
    if (typeof t.seconds === "number") return t.seconds * 1000
  }
  return null
}

/**
 * A request nobody answered in time. The server decides this from its own clock (a Ping lives 3 days from the moment it
 * was created, and cannot be answered after); this follows it when the Ping carries that time, and otherwise (a Ping
 * just written, not yet confirmed) counts from the class day.
 */
export const isExpired = (p: Ping) => {
  if (p.status !== "asking") return false
  const made = msOf(p.createdAt)
  return made !== null ? Date.now() > made + PING_EXPIRES_DAYS * 86_400_000 : daysSince(p.date) > PING_EXPIRES_DAYS
}

/** The most classes one Ping can ask about (the server's rules have a limit on how much they can check at once) */
export const MAX_PING_ITEMS = 8

/** "Today", "Yesterday", "3 days ago" */
export function whenLabel(date: string) {
  const n = daysSince(date)
  if (n <= 0) return "Today"
  if (n === 1) return "Yesterday"
  return `${n} days ago`
}
