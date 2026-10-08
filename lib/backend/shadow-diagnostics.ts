/**
 * The migration-safe diagnostic record of shadow writes (Phase 6B). In memory only, bounded, and deliberately poor in
 * detail: it holds WHAT was attempted and HOW it ended, never the data. No sync blob, no name, no token, no full uid, no
 * Authorization header, no request or response body ever enters it.
 *
 * Persisting mismatches to the `shadow_mismatch` table and a developer panel are Phase 7; this is the local record the
 * shadow writer keeps until then, and what the tests read.
 */
export type ShadowDomain = "sync" | "profile" | "invite" | "pushToken" | "connection" | "ping"

export type ShadowOutcome =
  /** Supabase accepted it */
  | "ok"
  /** Supabase answered "your revision/state is not what I expected": the copy is behind or ahead of Firebase (reconciliation's job) */
  | "conflict"
  /** it was attempted and did not work: see `reason` */
  | "failed"
  /** deliberately not sent: see `reason` */
  | "skipped"
  /** discarded because too many were already waiting */
  | "dropped"

export interface ShadowEvent {
  at: number
  domain: ShadowDomain
  op: string
  /** The account, shortened: first four characters and ***. Never the full uid. */
  who: string
  outcome: ShadowOutcome
  /** A short fixed word (timeout, http-4xx, http-5xx, unavailable, unauthorized, rev-drift, cooldown, ...). Never a server message. */
  reason?: string
  /** HTTP status when there was one */
  status?: number
  ms: number
}

export interface ShadowDiagnostics {
  record(e: ShadowEvent): void
  snapshot(): { events: ShadowEvent[]; counts: Record<ShadowOutcome, number> }
  clear(): void
}

export const redactUid = (uid: string | null | undefined): string => (uid ? `${uid.slice(0, 4)}***` : "none")

export function createShadowDiagnostics(limit = 200, onEvent?: (e: ShadowEvent) => void): ShadowDiagnostics {
  let events: ShadowEvent[] = []
  const counts = (): Record<ShadowOutcome, number> => {
    const c: Record<ShadowOutcome, number> = { ok: 0, conflict: 0, failed: 0, skipped: 0, dropped: 0 }
    totals.forEach((v, k) => (c[k] = v))
    return c
  }
  const totals = new Map<ShadowOutcome, number>()
  return {
    record(e) {
      // copy only the known fields so nothing extra can ride along
      const safe: ShadowEvent = { at: e.at, domain: e.domain, op: e.op, who: e.who, outcome: e.outcome, ms: e.ms }
      if (e.reason) safe.reason = e.reason
      if (e.status !== undefined) safe.status = e.status
      events.push(safe)
      if (events.length > limit) events = events.slice(-limit)
      totals.set(e.outcome, (totals.get(e.outcome) ?? 0) + 1)
      try {
        onEvent?.(safe)
      } catch {
        /* a failing listener must not matter */
      }
    },
    snapshot: () => ({ events: events.map((e) => ({ ...e })), counts: counts() }),
    clear() {
      events = []
      totals.clear()
    },
  }
}

/** The one diagnostic record the app uses. Read it from a test or a developer tool; nothing in the UI reads it. */
export const shadowDiagnostics: ShadowDiagnostics = createShadowDiagnostics()
