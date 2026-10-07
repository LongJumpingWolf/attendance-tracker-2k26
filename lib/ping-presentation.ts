/**
 * What the person has been SHOWN, kept apart from where a Ping is in its life.
 *
 * A Ping's business state lives on the Ping itself in Firestore: asking -> answered -> processed. That is the source of
 * truth and is never changed here. This module only decides which Ping to put in front of the person next, and
 * remembers (on this device) which ones they have already dealt with, so the same Ping is never shown twice.
 *
 *   incoming  = a Ping someone sent you that is still waiting for your answer   (you are `to`)
 *   result    = the answer to a Ping you sent                                   (you are `from`)
 *
 * A Ping can be fully processed while its result has never been shown: the result is found next time the app opens.
 */
import type { Ping } from "./types"
import { PING_EXPIRES_DAYS, daysSince, isAnswered, isExpired, msOf } from "./pings"

export { msOf }

export type PingEventKind = "incoming" | "result"
export interface PingEvent {
  kind: PingEventKind
  ping: Ping
}

/** id -> when the person finished with it (answered it / acknowledged the result) */
export interface Presented {
  incoming: Record<string, number>
  result: Record<string, number>
}

export const PRESENTED_KEY = "pingPresented"
const KEEP_MS = 60 * 86_400_000
const DAY_MS = 86_400_000

export const emptyPresented = (): Presented => ({ incoming: {}, result: {} })

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v)

/** Reads the saved record, dropping entries older than two months. Anything unreadable starts fresh. */
export function loadPresented(now = Date.now()): Presented {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(PRESENTED_KEY)
    if (!raw) return emptyPresented()
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed)) return emptyPresented()
    const clean = (v: unknown) =>
      isRecord(v) ? Object.fromEntries(Object.entries(v).filter(([, at]) => typeof at === "number" && now - at < KEEP_MS)) : {}
    return { incoming: clean(parsed.incoming) as Record<string, number>, result: clean(parsed.result) as Record<string, number> }
  } catch {
    return emptyPresented()
  }
}

export function savePresented(p: Presented) {
  try {
    localStorage.setItem(PRESENTED_KEY, JSON.stringify(p))
  } catch {
    /* not remembered: at worst a finished Ping is offered again until the app reloads */
  }
}

const involves = (p: Ping, me: string) => Array.isArray(p.participants) && p.participants.includes(me)

/** A request waiting for my answer: I am the one asked, it is still asking, and it hasn't expired */
export const isActionableIncoming = (p: Ping, me: string) => involves(p, me) && p.to === me && p.status === "asking" && !isExpired(p)

/** The answer to my own Ping, recent enough to be worth a screen of its own (older ones are just in the history) */
export function isPresentableResult(p: Ping, me: string, nowMs: number) {
  if (!involves(p, me) || p.from !== me || !isAnswered(p)) return false
  const at = msOf(p.respondedAt)
  return at !== null ? nowMs - at <= PING_EXPIRES_DAYS * DAY_MS : daysSince(p.date) <= PING_EXPIRES_DAYS + 1
}

const order = (a: Ping, b: Ping) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

interface Options {
  nowMs?: number
  /** A Ping the person opened on purpose (a notification, a link): it goes first */
  focusId?: string | null
  /** The Ping already on screen: it stays there while it is still waiting, so a newcomer never replaces it mid-read */
  activeId?: string | null
  /** Ping ids put off for this visit ("Later"): skipped until the app is opened again, unless asked for by id */
  deferred?: ReadonlySet<string>
}

/**
 * The one Ping to show now, or null. Requests that need an answer come before results; within each, the older class
 * date first, then the id, so the order never depends on how the data happened to arrive.
 */
export function nextEvent(pings: Ping[], me: string | null, presented: Presented, opts: Options = {}): PingEvent | null {
  if (!me) return null
  const nowMs = opts.nowMs ?? Date.now()
  const seen = new Set<string>()
  const unique = pings.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)))
  const incoming = unique.filter((p) => isActionableIncoming(p, me) && !presented.incoming[p.id]).sort(order)
  const results = unique.filter((p) => isPresentableResult(p, me, nowMs) && !presented.result[p.id]).sort(order)
  const queue: PingEvent[] = [
    ...incoming.map((ping) => ({ kind: "incoming" as const, ping })),
    ...results.map((ping) => ({ kind: "result" as const, ping })),
  ]
  if (opts.focusId) {
    const asked = queue.find((e) => e.ping.id === opts.focusId)
    if (asked) return asked
  }
  if (opts.activeId) {
    const current = queue.find((e) => e.ping.id === opts.activeId && !opts.deferred?.has(e.ping.id))
    if (current) return current
  }
  return queue.find((e) => !opts.deferred?.has(e.ping.id)) ?? null
}

/** How many Pings still need the person: requests waiting for an answer, and answers they haven't seen yet */
export function pendingCount(pings: Ping[], me: string | null, presented: Presented, nowMs = Date.now()): number {
  if (!me) return 0
  const seen = new Set<string>()
  let n = 0
  for (const p of pings) {
    if (seen.has(p.id)) continue
    seen.add(p.id)
    if (isActionableIncoming(p, me) && !presented.incoming[p.id]) n++
    else if (isPresentableResult(p, me, nowMs) && !presented.result[p.id]) n++
  }
  return n
}

export type FocusFailure = "missing" | "answered" | "expired" | "waiting" | "seen"
export type FocusResult = { ok: true; event: PingEvent } | { ok: false; reason: FocusFailure }

/**
 * Checks a Ping someone asked to open by id (from a notification or a link) before it is shown: it has to exist, I have
 * to be one of its two people, and it has to still be something to act on or to see. Anything else is refused.
 */
export function resolveFocus(pings: Ping[], me: string | null, id: string, presented: Presented): FocusResult {
  const p = pings.find((x) => x.id === id)
  if (!me || !p || !involves(p, me)) return { ok: false, reason: "missing" } // the same answer whether it exists or not
  if (p.to === me) {
    if (p.status !== "asking" || presented.incoming[id]) return { ok: false, reason: "answered" }
    if (isExpired(p)) return { ok: false, reason: "expired" }
    return { ok: true, event: { kind: "incoming", ping: p } }
  }
  if (p.from === me) {
    if (!isAnswered(p)) return { ok: false, reason: "waiting" }
    if (presented.result[id]) return { ok: false, reason: "seen" }
    return { ok: true, event: { kind: "result", ping: p } }
  }
  return { ok: false, reason: "missing" }
}

export const FOCUS_MESSAGES: Record<FocusFailure, string> = {
  missing: "That Ping isn't available.",
  answered: "That Ping has already been answered.",
  expired: "That Ping has expired.",
  waiting: "They haven't answered that Ping yet.",
  seen: "You've already seen that answer.",
}

/** The wording of a result: who answered, and what it means for the classes asked about */
export function resultSummary(p: Ping) {
  const yes = p.items.filter((i) => i.answer === "yes").length
  const total = p.items.length
  const kind: "all" | "some" | "none" = yes === total ? "all" : yes === 0 ? "none" : "some"
  const headline = kind === "all" ? `${p.toName} marked you PRESENT` : kind === "none" ? `${p.toName} did not cover you` : `${p.toName} covered ${yes} of ${total} classes`
  return { yes, total, kind, headline }
}
