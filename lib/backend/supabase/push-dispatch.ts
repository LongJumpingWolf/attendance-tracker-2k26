/**
 * Sending the push for a Ping event (Phase 10, LOCAL LOGIC ONLY). Pure: everything outside the decision is passed in (the authoritative
 * Ping read, the token store, the sender, the outbox of already-handled events, the clock), so it is tested with fakes. Nothing here can
 * send a real notification, reads no secret, and is not deployed: a later Edge Function (needs the owner's approval and a hosted secret)
 * would call `dispatchPingEvent` from a database trigger or webhook.
 *
 * Rules (each is a test in tests/phase10-push-dispatch.test.ts):
 *  - the RECIPIENT comes from the Ping row read fresh from the database, never from the event: "incoming" goes to `to_uid`, "result" to
 *    `from_uid`. An event can only say which Ping and which kind;
 *  - an event is handled at most once: a claim on `ping:<id>:<kind>` is taken before sending. A duplicate delivery of the same event
 *    sends nothing. A transient failure releases the claim and retries with bounded backoff; success, "no token", a removed dead token
 *    and giving up keep it;
 *  - a stale event is dropped: an "incoming" for a Ping that is no longer asking, a "result" for one that is not answered yet, a Ping
 *    past its 3-day life (database created_at), a Ping that is gone;
 *  - a dead token (not registered / invalid) is deleted for THAT device only, and never retried;
 *  - the text is generic (who, never class / subject / date) and identical to the Firebase messages (ping-push-messages.ts);
 *  - tokens are per device in the schema, but the client still stores ONE token per account (device_id "legacy"). This sends to whatever
 *    tokens the store returns; it does not make multi-device real.
 */
import { answeredMessage, incomingMessage, type PushMessage } from "./ping-push-messages"

export type PingEventKind = "incoming" | "result"

export interface PingRecord {
  id: string
  from_uid: string
  to_uid: string
  from_name?: string | null
  to_name?: string | null
  status: "asking" | "answered" | "processed"
  items?: unknown
  /** the database clock, as epoch ms or an ISO string; null on legacy rows */
  created_at: number | string | null
}

export interface DeviceToken {
  deviceId: string
  token: string
}

export interface Outbox {
  /** true if this call took the claim; false if the event was already claimed (handled or in flight) */
  claim(key: string): Promise<boolean>
  release(key: string): Promise<void>
  /** how many attempts this event has had */
  attempts(key: string): Promise<number>
  recordAttempt(key: string): Promise<number>
}

export interface PushDeps {
  /** The authoritative Ping, read now. null when it no longer exists. */
  getPing(id: string): Promise<PingRecord | null>
  tokens(uid: string): Promise<DeviceToken[]>
  deleteToken(uid: string, deviceId: string): Promise<void>
  /** Sends one message to one token; rejects with an error carrying a `code` */
  send(message: PushMessage & { token: string }): Promise<void>
  outbox: Outbox
  now(): number
}

export type DispatchOutcome =
  | { status: "sent"; sent: number; removed: number }
  | { status: "no-token" }
  | { status: "token-removed"; removed: number }
  | { status: "duplicate" }
  | { status: "gone" }
  | { status: "stale" }
  | { status: "expired" }
  | { status: "no-recipient" }
  | { status: "retry"; attempt: number; delayMs: number }
  | { status: "gave-up"; attempts: number }

export const DEAD_TOKEN_CODES = ["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]
export const PING_LIFETIME_MS = 3 * 24 * 3600 * 1000
export const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 60_000

/** 1 s, 2 s, 4 s, ... capped at 60 s */
export const backoffMs = (attempt: number): number => Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1))

const toMs = (v: number | string | null): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null
  const t = typeof v === "string" ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}

const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? "")

export const eventKey = (pingId: string, kind: PingEventKind) => `ping:${pingId}:${kind}`

/** One attempt. Never throws: every failure is an outcome. */
export async function dispatchPingEvent(deps: PushDeps, event: { pingId: string; kind: PingEventKind }): Promise<DispatchOutcome> {
  if (typeof event?.pingId !== "string" || (event.kind !== "incoming" && event.kind !== "result")) return { status: "stale" }
  let ping: PingRecord | null
  try {
    ping = await deps.getPing(event.pingId)
  } catch {
    return retryOrGiveUp(deps, eventKey(event.pingId, event.kind), false) // cannot read the record now: try again, send nothing
  }
  if (!ping) return { status: "gone" }
  if (event.kind === "incoming" ? ping.status !== "asking" : ping.status === "asking") return { status: "stale" }
  const created = toMs(ping.created_at)
  if (created === null || deps.now() >= created + PING_LIFETIME_MS || created > deps.now() + 24 * 3600 * 1000) return { status: "expired" }

  const recipient = event.kind === "incoming" ? ping.to_uid : ping.from_uid // from the record, never from the event
  if (!recipient) return { status: "no-recipient" }
  const message = event.kind === "incoming" ? incomingMessage({ fromName: ping.from_name }, ping.id) : answeredMessage({ toName: ping.to_name, items: ping.items }, ping.id)

  const key = eventKey(ping.id, event.kind)
  if (!(await deps.outbox.claim(key))) return { status: "duplicate" }

  let tokens: DeviceToken[]
  try {
    tokens = await deps.tokens(recipient)
  } catch {
    return retryOrGiveUp(deps, key, true)
  }
  if (tokens.length === 0) return { status: "no-token" } // they never turned alerts on: the Ping is waiting when they open the app

  let sent = 0
  let removed = 0
  let transient = 0
  for (const t of tokens) {
    try {
      await deps.send({ token: t.token, ...message })
      sent++
    } catch (e) {
      if (DEAD_TOKEN_CODES.includes(codeOf(e))) {
        try {
          await deps.deleteToken(recipient, t.deviceId)
          removed++
        } catch {
          transient++ // could not remove it now: the dead token is found again next time
        }
      } else transient++
    }
  }
  if (sent > 0) return { status: "sent", sent, removed }
  if (transient === 0) return { status: "token-removed", removed }
  return retryOrGiveUp(deps, key, true)
}

async function retryOrGiveUp(deps: PushDeps, key: string, claimed: boolean): Promise<DispatchOutcome> {
  const attempt = await deps.outbox.recordAttempt(key)
  if (attempt >= MAX_ATTEMPTS) return { status: "gave-up", attempts: attempt } // a claim, if held, stays: no further sends for this event
  if (claimed) await deps.outbox.release(key) // so the retry can claim it again
  return { status: "retry", attempt, delayMs: backoffMs(attempt) }
}

/** Runs dispatchPingEvent until it settles, waiting the backoff between attempts. `sleep` is injected (tests pass a fake). */
export async function runPingEvent(deps: PushDeps, event: { pingId: string; kind: PingEventKind }, sleep: (ms: number) => Promise<void>): Promise<DispatchOutcome> {
  for (;;) {
    const out = await dispatchPingEvent(deps, event)
    if (out.status !== "retry") return out
    await sleep(out.delayMs)
  }
}

/** An in-memory outbox (tests, and the shape a database-backed one must have) */
export function createMemoryOutbox(): Outbox & { claimed: Set<string>; counts: Map<string, number> } {
  const claimed = new Set<string>()
  const counts = new Map<string, number>()
  return {
    claimed,
    counts,
    async claim(key) {
      if (claimed.has(key)) return false
      claimed.add(key)
      return true
    },
    async release(key) {
      claimed.delete(key)
    },
    async attempts(key) {
      return counts.get(key) ?? 0
    },
    async recordAttempt(key) {
      const n = (counts.get(key) ?? 0) + 1
      counts.set(key, n)
      return n
    },
  }
}
