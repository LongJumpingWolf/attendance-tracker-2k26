/**
 * The small calculations the developer analytics page relies on, kept apart from the page so they can be checked.
 * Everything uses the developer's local calendar (the page's labels, weekday and hour charts already do), so a day,
 * a week and "N days later" mean the same thing in every number.
 */

/** The middle value of an ascending list; for an even count, the average of the two middle values. null for none. */
export function median(sortedAscending: number[]): number | null {
  const n = sortedAscending.length
  if (n === 0) return null
  const mid = Math.floor(n / 2)
  return n % 2 === 1 ? sortedAscending[mid]! : (sortedAscending[mid - 1]! + sortedAscending[mid]!) / 2
}

const pad = (n: number) => String(n).padStart(2, "0")

/** YYYY-MM-DD of a moment on the local calendar */
export function localDayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Local midnight at the start of the Monday of the week containing `ms` */
export function startOfLocalWeek(ms: number): number {
  const d = new Date(ms)
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  midnight.setDate(midnight.getDate() - ((midnight.getDay() + 6) % 7))
  return midnight.getTime()
}

export interface EventCoverage {
  /** More events exist than were loaded, so older ones are missing */
  truncated: boolean
  /** The oldest moment the loaded events can speak for: everything since then is complete. null when nothing is missing or nothing is loaded. */
  completeSinceMs: number | null
}

/**
 * Events are loaded newest first up to a cap. Past the cap the oldest are not loaded, so counts for a window reaching back
 * further than the oldest loaded event are too low, and "first seen" dates are too late. This says where the data is complete from.
 */
export function eventCoverage(timesMs: number[], truncated: boolean): EventCoverage {
  const valid = timesMs.filter((t) => t > 0)
  if (!truncated || valid.length === 0) return { truncated: false, completeSinceMs: null }
  return { truncated: true, completeSinceMs: Math.min(...valid) }
}

/** Whether a window starting at `windowStartMs` reaches back past what was loaded */
export const windowIsIncomplete = (coverage: EventCoverage, windowStartMs: number) => coverage.truncated && coverage.completeSinceMs !== null && windowStartMs < coverage.completeSinceMs

// ---------------------------------------------------------------------------------------------------------------------
// Link analytics (WhatsApp Pings and Mate invites)
// ---------------------------------------------------------------------------------------------------------------------
import type { ProductLinkEvent, ProductLinkSource } from "./link-analytics"
import type { ProductUsageEvent } from "./usage-analytics"

export const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000

export type AnalyticsRow = {
  key: string
  source: ProductLinkSource
  linkId: string
  ownerUid: string
  fromName: string
  recipientName: string
  createdAtMs: number
  openedAtMs: number
  completedAtMs: number
  opens: number
  created: boolean
  used: boolean
  answered: boolean
}

export const stampMs = (v: ProductLinkEvent["createdAt"] | ProductUsageEvent["createdAt"]): number => {
  if (v && typeof v === "object" && "toDate" in v && typeof v.toDate === "function") return v.toDate().getTime()
  if (v instanceof Date) return v.getTime()
  return 0
}

const rate = (n: number, d: number) => (d > 0 ? `${Math.round((n / d) * 100)}%` : "—")

/** One row per link, from the events in scope. A link's opens are the opens recorded in the window. */
export function buildLinkRows(scope: ProductLinkEvent[]): AnalyticsRow[] {
  const map = new Map<string, AnalyticsRow>()
  for (const e of scope) {
    const key = `${e.source}:${e.linkId}`
    let row = map.get(key)
    if (!row) {
      row = { key, source: e.source, linkId: e.linkId, ownerUid: e.ownerUid, fromName: e.fromName || "Unknown", recipientName: e.recipientName || "", createdAtMs: 0, openedAtMs: 0, completedAtMs: 0, opens: 0, created: false, used: false, answered: false }
      map.set(key, row)
    }
    if (e.fromName) row.fromName = e.fromName
    if (e.recipientName) row.recipientName = e.recipientName
    const at = stampMs(e.createdAt)
    if (e.kind === "created") {
      row.created = true
      row.createdAtMs = at
    } else if (!row.createdAtMs && at) {
      row.createdAtMs = at
    }
    if (e.kind === "opened") {
      row.opens += 1
      if (!row.openedAtMs || at < row.openedAtMs) row.openedAtMs = at
    }
    if (e.kind === "used") {
      row.used = true
      if (!row.completedAtMs || at < row.completedAtMs) row.completedAtMs = at
    }
    if (e.kind === "answered") {
      row.answered = true
      if (!row.completedAtMs || at < row.completedAtMs) row.completedAtMs = at
    }
  }
  return [...map.values()].sort((a, b) => b.createdAtMs - a.createdAtMs)
}

/** The headline link numbers. Funnel figures count links created in the window; "opens" counts every open event in it. */
export function computeLinkMetrics(rows: AnalyticsRow[], scope: ProductLinkEvent[]) {
  const createdRows = rows.filter((r) => r.created)
  const invites = createdRows.filter((r) => r.source === "mate-invite")
  const pings = createdRows.filter((r) => r.source === "share-ping")
  const openedCreatedRows = createdRows.filter((r) => r.opens > 0)
  const invitedUsed = invites.filter((r) => r.used)
  const pingAnswered = pings.filter((r) => r.answered)
  const completed = createdRows.filter((r) => (r.used || r.answered) && r.completedAtMs >= r.createdAtMs && r.completedAtMs > 0)
  const durations = completed.map((r) => r.completedAtMs - r.createdAtMs).filter((n) => n >= 0 && n <= NINETY_DAYS_MS).sort((a, b) => a - b)
  const averageCompletionMs = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : null
  const owners = new Map<string, { name: string; uid: string; links: number; opens: number; completed: number }>()
  for (const r of createdRows) {
    const existing = owners.get(r.ownerUid) || { name: r.fromName || "Unknown", uid: r.ownerUid, links: 0, opens: 0, completed: 0 }
    existing.links += 1
    existing.opens += r.opens
    if (r.used || r.answered) existing.completed += 1
    if (r.fromName) existing.name = r.fromName
    owners.set(r.ownerUid, existing)
  }
  const senders = [...owners.values()].sort((a, b) => b.links - a.links || b.completed - a.completed)
  const openedLinks = openedCreatedRows.length
  const avgOpens = openedCreatedRows.length ? openedCreatedRows.reduce((n, r) => n + r.opens, 0) / openedCreatedRows.length : 0
  return {
    eventCount: scope.length,
    created: createdRows.length,
    opens: scope.filter((e) => e.kind === "opened").length,
    openedLinks,
    invites: invites.length,
    used: invitedUsed.length,
    pings: pings.length,
    answered: pingAnswered.length,
    sharers: owners.size,
    repeatSharers: senders.filter((s) => s.links > 1).length,
    avgOpens,
    inviteOpenRate: rate(invites.filter((r) => r.opens > 0).length, invites.length),
    inviteUseRate: rate(invitedUsed.length, invites.length),
    pingOpenRate: rate(pings.filter((r) => r.opens > 0).length, pings.length),
    pingAnswerRate: rate(pingAnswered.length, pings.length),
    overallOpenRate: rate(openedLinks, createdRows.length),
    overallCompletionRate: rate(createdRows.filter((r) => r.used || r.answered).length, createdRows.length),
    averageCompletionMs,
    medianCompletionMs: median(durations),
    senders,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Usage analytics
// ---------------------------------------------------------------------------------------------------------------------

/** Distinct people with at least one event in the last `durationMs` */
export function uniqueUsersWithin(events: ProductUsageEvent[], durationMs: number, now: number): number {
  const users = new Set<string>()
  for (const e of events) {
    const at = stampMs(e.createdAt)
    if (at > 0 && at >= now - durationMs && at <= now) users.add(e.actorUid)
  }
  return users.size
}

/** People, sessions and repeat visitors in the events given (already limited to the window). Repeat = active on 2+ local days. */
export function computeUsageCore(usageScope: ProductUsageEvent[]) {
  const actors = new Set<string>()
  const sessions = new Set<string>()
  const activeDays = new Map<string, Set<string>>()
  const counts = new Map<string, number>()
  for (const e of usageScope) {
    actors.add(e.actorUid)
    sessions.add(e.sessionId)
    const day = localDayKey(stampMs(e.createdAt))
    const days = activeDays.get(e.actorUid) || new Set<string>()
    days.add(day)
    activeDays.set(e.actorUid, days)
    counts.set(e.event, (counts.get(e.event) || 0) + 1)
  }
  return {
    activeUsers: actors.size,
    sessions: sessions.size,
    repeatUsers: [...activeDays.values()].filter((days) => days.size >= 2).length,
    counts,
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Accounts and the analytics choice
// ---------------------------------------------------------------------------------------------------------------------

export interface OptInSplit {
  /** Every account the app knows of: those with a profile, plus any that sent usage events */
  accounts: number
  /** Accounts that opted in and have used the app within the loaded events */
  optedIn: number
  /** Known accounts that never sent a usage event: they declined, or have not opened the app since analytics began (or in the last 90 days) */
  notOptedIn: number
  /** Share of known accounts that opted in, 0-100, or null when there are no accounts */
  optInRate: number | null
}

/**
 * Nothing is recorded from someone who declines, so the split is inferred, not counted: an account is "opted in" if it has
 * sent a usage event (only possible after opting in), and every other known account is counted as not opted in. The known
 * accounts are the profiles the app keeps (anyone who used Mates, plus the named accounts) together with the opted-in accounts.
 */
export function computeOptInSplit(accountIds: string[], optedInIds: string[]): OptInSplit {
  const known = new Set<string>([...accountIds, ...optedInIds])
  const optedIn = new Set(optedInIds)
  const accounts = known.size
  return {
    accounts,
    optedIn: optedIn.size,
    notOptedIn: accounts - optedIn.size,
    optInRate: accounts > 0 ? Math.round((optedIn.size / accounts) * 100) : null,
  }
}
