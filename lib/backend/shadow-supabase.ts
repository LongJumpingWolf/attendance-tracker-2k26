/**
 * The real shadow writer (Phase 6B): mirrors what Firebase has ALREADY confirmed to Supabase, best effort.
 *
 * Firebase is the only authority. This writer is never awaited by the application (lib/backend/shadow-backend.ts fires it
 * after the Firebase result is known), never throws, never retries into the user's path, and never reads anything back.
 * Whatever happens here is recorded as a short diagnostic event (no data, no tokens, no names) and nothing else.
 *
 * What it mirrors, and how:
 *   syncBlob   `sync_put(expected = rev - 1, data, updatedAt)`: the opaque text exactly as Firebase stored it; a stored
 *              copy at rev - 1 becomes rev, identical to Firebase. A missing or stale copy answers "conflict" (the initial
 *              import and reconciliation, not this writer, bring it level).
 *   profile    `upsert_profile`
 *   invite     `create_invite` with the SAME token / `delete_invite`
 *   pushToken  `save_push_token` / `delete_push_token` (device "legacy": the client is still one token per account)
 * What it deliberately does NOT mirror (recorded as `skipped`): connections and Pings. `send_request` generates its own id,
 * so it cannot keep Firebase's request id, and the plan (section 15) forbids replaying Ping calls against Supabase's own
 * state machine. They need a service-side upsert-of-current-state, which does not exist yet.
 *
 * Safety rules enforced here:
 *  - the account is always the Supabase JWT `sub`; no owner is ever sent. The write is skipped if the payload's account is
 *    not the current Firebase user (an account switch in flight must never write to the wrong account);
 *  - one write at a time per key, in order, so revision N + 1 can never overtake N; at most `maxQueue` wait per key;
 *  - after an authorization failure the writer pauses (`cooldownMs`) instead of hammering the bootstrap endpoint;
 *  - every call has a timeout, including the authorization step.
 */
import { fromPostgresError } from "./errors"
import { redactUid, shadowDiagnostics as defaultDiagnostics, type ShadowDiagnostics, type ShadowDomain, type ShadowEvent } from "./shadow-diagnostics"
import type { ShadowConnection, ShadowInvite, ShadowPing, ShadowProfile, ShadowPushToken, ShadowSyncBlob, ShadowWriter } from "./shadow"
import type { SupabaseConfig, SupabaseGuard } from "./supabase/guard"

export interface SupabaseShadowDeps {
  guard: SupabaseGuard
  config: () => SupabaseConfig | null
  /** The current Firebase user's uid, or null */
  currentUid: () => string | null
  fetchFn?: typeof fetch
  /** Per request, and for the authorization step. Default 8000 ms. */
  timeoutMs?: number
  /** Pause after an authorization failure. Default 60000 ms. */
  cooldownMs?: number
  /** Most writes waiting per key. Default 20. */
  maxQueue?: number
  now?: () => number
  diagnostics?: ShadowDiagnostics
}

type Step = { outcome: ShadowEvent["outcome"]; reason?: string; status?: number }

class StepError extends Error {
  constructor(
    readonly reason: string,
    readonly outcome: ShadowEvent["outcome"] = "failed",
    readonly status?: number,
  ) {
    super(reason)
  }
}

const CONFLICT = new Set(["40001", "23505", "55000"])

export function createSupabaseShadowWriter(deps: SupabaseShadowDeps): ShadowWriter {
  const fetchFn = deps.fetchFn ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const timeoutMs = deps.timeoutMs ?? 8000
  const cooldownMs = deps.cooldownMs ?? 60_000
  const maxQueue = deps.maxQueue ?? 20
  const now = deps.now ?? Date.now
  const diag = deps.diagnostics ?? defaultDiagnostics
  let authFailedAt: number | null = null
  const lanes = new Map<string, { tail: Promise<void>; waiting: number }>()

  const withTimeout = <T>(p: Promise<T>, reason: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new StepError(reason)), timeoutMs)
      p.then(
        (v) => (clearTimeout(t), resolve(v)),
        (e) => (clearTimeout(t), reject(e)),
      )
    })

  /** One PostgREST RPC. Resolves to the parsed JSON, or throws a StepError carrying only a fixed reason word. */
  async function rpc(fn: string, args: Record<string, unknown>, token: string): Promise<unknown> {
    const config = deps.config()
    if (!config) throw new StepError("not-configured", "skipped")
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), timeoutMs)
    try {
      let res: Response
      let text: string
      // Raced against the abort signal, so a fetch that ignores `signal` still cannot hang the lane
      const aborted = new Promise<never>((_, reject) => ctl.signal.addEventListener("abort", () => reject(new StepError("timeout"))))
      aborted.catch(() => {})
      try {
        const read = (async () => {
          const r = await fetchFn(`${config.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
            method: "POST",
            headers: { apikey: config.publishableKey, authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(args),
            signal: ctl.signal,
          })
          return { r, t: await r.text() }
        })()
        read.catch(() => {})
        const got = await Promise.race([read, aborted])
        res = got.r
        text = got.t
      } catch (e) {
        if (e instanceof StepError) throw e
        throw new StepError(ctl.signal.aborted || (e as { name?: string })?.name === "AbortError" ? "timeout" : "unavailable")
      }
      if (res.ok) {
        try {
          return text ? JSON.parse(text) : null
        } catch {
          return null
        }
      }
      let code: string | undefined
      try {
        code = (JSON.parse(text) as { code?: string }).code
      } catch {
        /* not JSON */
      }
      if (code && CONFLICT.has(code)) throw new StepError("conflict", "conflict", res.status)
      if (res.status === 401 || res.status === 403 || fromPostgresError({ code }).kind === "unauthorized") throw new StepError("unauthorized", "failed", res.status)
      if (res.status === 429) throw new StepError("rate-limited", "failed", res.status)
      throw new StepError(res.status >= 500 ? "http-5xx" : "http-4xx", "failed", res.status)
    } finally {
      clearTimeout(timer)
    }
  }

  async function authorize(): Promise<string> {
    if (authFailedAt !== null && now() - authFailedAt < cooldownMs) throw new StepError("cooldown", "skipped")
    try {
      const token = await withTimeout(deps.guard(), "timeout")
      authFailedAt = null
      return token
    } catch (e) {
      if (e instanceof StepError) {
        authFailedAt = now()
        throw e
      }
      authFailedAt = now()
      const code = (e as { code?: string })?.code
      if (code === "supabase-not-configured") throw new StepError("not-configured", "skipped")
      throw new StepError((e as { kind?: string })?.kind === "unavailable" ? "unavailable" : "unauthorized")
    }
  }

  /** Runs `job` in its lane, in order. Always resolves; the result is only a diagnostic record. */
  function enqueue(domain: ShadowDomain, op: string, key: string, uid: string | null, job: (token: string) => Promise<Step | void>, needsAccount = true): Promise<void> {
    const lane = lanes.get(key) ?? { tail: Promise.resolve(), waiting: 0 }
    lanes.set(key, lane)
    const who = redactUid(uid)
    const event = (outcome: ShadowEvent["outcome"], started: number, extra: { reason?: string; status?: number } = {}) => {
      try {
        diag.record({ at: now(), domain, op, who, outcome, ms: Math.max(0, now() - started), ...extra })
      } catch {
        /* diagnostics must never matter */
      }
    }
    if (lane.waiting >= maxQueue) {
      event("dropped", now(), { reason: "queue-full" })
      return Promise.resolve()
    }
    lane.waiting++
    lane.tail = lane.tail
      .then(async () => {
        const started = now()
        try {
          if (needsAccount && (uid === null || deps.currentUid() !== uid)) throw new StepError("identity-mismatch", "skipped")
          const token = await authorize()
          const step = (await job(token)) ?? { outcome: "ok" as const }
          event(step.outcome, started, { reason: step.reason, status: step.status })
        } catch (e) {
          if (e instanceof StepError) event(e.outcome, started, { reason: e.reason, status: e.status })
          else event("failed", started, { reason: "unexpected" })
        }
      })
      .catch(() => {})
      .finally(() => {
        lane.waiting--
        if (lane.waiting === 0) lanes.delete(key)
      })
    return lane.tail
  }

  const skipped = (domain: ShadowDomain, op: string, reason: string): Promise<void> => {
    try {
      diag.record({ at: now(), domain, op, who: "none", outcome: "skipped", reason, ms: 0 })
    } catch {
      /* ignore */
    }
    return Promise.resolve()
  }

  return {
    active: true,

    syncBlob(w: ShadowSyncBlob) {
      if (!Number.isInteger(w.rev) || w.rev < 1) return skipped("sync", "put", "invalid-rev")
      return enqueue("sync", "put", `sync:${w.owner}`, w.owner, async (token) => {
        // expected = rev - 1: the stored copy moves from rev - 1 to rev, exactly as Firebase did. The owner is the JWT sub, not an argument.
        const got = await rpc("sync_put", { p_expected_rev: w.rev - 1, p_data: w.data, p_updated_at: w.updatedAt ?? now() }, token)
        return typeof got === "number" && got !== w.rev ? { outcome: "conflict", reason: "rev-drift" } : { outcome: "ok" }
      })
    },

    profile(w: ShadowProfile) {
      return enqueue("profile", "save", `profile:${w.uid}`, w.uid, async (token) => void (await rpc("upsert_profile", { p_name: w.name }, token)))
    },

    invite(w: ShadowInvite) {
      if (w.op === "create") {
        return enqueue("invite", "create", `invite:${w.token}`, w.uid, async (token) => void (await rpc("create_invite", { p_token: w.token, p_owner_name: w.name, p_minutes: w.minutes }, token)))
      }
      return enqueue("invite", "remove", `invite:${w.token}`, null, async (token) => void (await rpc("delete_invite", { p_token: w.token }, token)), false)
    },

    pushToken(w: ShadowPushToken) {
      if (w.op === "save") {
        return enqueue("pushToken", "save", `push:${w.uid}`, w.uid, async (token) => void (await rpc("save_push_token", { p_token: w.token, p_device_id: "legacy" }, token)))
      }
      return enqueue("pushToken", "remove", `push:${w.uid}`, w.uid, async (token) => void (await rpc("delete_push_token", { p_device_id: "legacy" }, token)))
    },

    // Not mirrored in Phase 6B (no id-preserving RPC; Ping state is never replayed). Recorded so the gap is visible.
    connection: (w: ShadowConnection) => skipped("connection", w.op, "unsupported"),
    ping: (w: ShadowPing) => skipped("ping", w.op, "unsupported"),
  }
}
