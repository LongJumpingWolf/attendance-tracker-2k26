import type { Ping } from "./types"
import { daysUntil } from "./attendance"

/** Direct in-app Pings without an answer are expired after this many days. Share-link Pings use expiresAt instead. */
export const PING_EXPIRES_DAYS = 3
/** One-time WhatsApp/share-link Pings expire after 24 hours. */
export const SHARE_PING_TTL_MS = 24 * 60 * 60 * 1000
/** Pings older than this are deleted by the person who sent them, so history stays short */
export const PING_HISTORY_DAYS = 30

/** How many whole days ago the classes were (0 = today) */
export const daysSince = (date: string) => -daysUntil(date)

/** The mate has replied (whether or not the asker's device has applied it yet) */
export const isAnswered = (p: Ping) => p.status === "answered" || p.status === "processed" || p.status === "dismissed"

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
  if (p.shareLink) {
    const expiresAt = msOf(p.expiresAt)
    if (expiresAt !== null) return Date.now() >= expiresAt
  }
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

/** Validate a Ping's answer map before any server write; missing answers must never silently become "no". */
export function answerItems(items: Ping["items"], answers: Record<string, "yes" | "no" | undefined>):
  | { ok: true; items: Ping["items"] }
  | { ok: false; missing: string[] } {
  const missing = items.filter((item) => answers[item.key] !== "yes" && answers[item.key] !== "no").map((item) => item.name)
  if (items.length === 0 || missing.length > 0) return { ok: false, missing: missing.length > 0 ? missing : ["No classes selected"] }
  return { ok: true, items: items.map((item) => ({ ...item, answer: answers[item.key]! })) }
}
