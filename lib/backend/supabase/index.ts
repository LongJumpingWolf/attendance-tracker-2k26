/**
 * The Supabase implementation of the backend contracts: a SKELETON. It is not active and nothing selects it by default.
 * Phase 6A added the authorization guard (guard.ts) and the Realtime token seam; there is still no client and no shadow write.
 *
 * What it is: the mapping from each contract operation to the Postgres functions and tables built in Phase 2B/3
 * (supabase/migrations, PHASE3_SECURITY_MATRIX.md), expressed against a tiny injected transport so tests can run it
 * without credentials or a network.
 *
 * What it is NOT: it has no client, no token exchange and no Firebase-to-Supabase identity bridge (decision 1, Phase 5).
 * Without a transport every operation fails with a clear "Supabase backend not configured/authorized" error, and
 * realtime is not implemented at all: a subscription reports that it is not live. It never contacts anything by itself.
 */
import type { FriendRequest } from "../../types"
import { BackendError, fromPostgresError, notConfigured } from "../errors"
import type { Backend, RealtimeAuth, CloudSyncStore, ConnectionStore, InviteStore, PingStore, ProfileStore, PushTokenStore, StoredSync, Subscription } from "../contracts"
import { randomToken } from "../token"
import type { SupabaseGuard } from "./guard"

export { readSupabaseConfig, readBuildSupabaseConfig, createSupabaseGuard, type SupabaseConfig, type SupabaseGuard } from "./guard"

export interface PostgrestResult<T> {
  data: T | null
  error: { code?: string; message: string } | null
}

/** The only two things the adapter needs from a Supabase client. A real client is wired in a later phase. */
export interface SupabaseTransport {
  rpc(fn: string, args?: Record<string, unknown>): Promise<PostgrestResult<unknown>>
  /** Rows of a table readable by the caller under RLS, optionally filtered by equality */
  select(table: string, eq?: Record<string, string>): Promise<PostgrestResult<Record<string, unknown>[]>>
  /** Optional: receives the bridge's Firebase token before each operation */
  setAccessToken?(token: string): void
  /** Optional: Supabase `realtime.setAuth(token)`. Required for Realtime to deliver anything (PHASE5_AUTH_SPIKE.md). null on sign-out. */
  setRealtimeAuth?(token: string | null): void
}

export interface SupabaseDeps {
  transport?: SupabaseTransport
  /** Asked before EVERY operation. The app always passes one (lib/backend/index.ts); without a transport nothing can be sent anyway. */
  guard?: SupabaseGuard
}

const ms = (v: unknown): number | null => {
  if (typeof v === "number") return v
  const t = typeof v === "string" ? Date.parse(v) : NaN
  return Number.isNaN(t) ? null : t
}

export function createSupabaseBackend({ transport, guard }: SupabaseDeps = {}): Backend {
  const need = (what: string): SupabaseTransport => {
    if (!transport) throw notConfigured(what)
    return transport
  }

  async function run<T>(what: string, go: (t: SupabaseTransport) => Promise<PostgrestResult<T>>): Promise<T | null> {
    const token = guard ? await guard() : null // flag, configuration and bridge token: refuses before anything is sent
    const t = need(what)
    if (token) t.setAccessToken?.(token)
    let res: PostgrestResult<T>
    try {
      res = await go(t)
    } catch (e) {
      throw new BackendError("unavailable", (e as Error)?.message ?? "network error", { cause: e }) // a transport failure, not a database answer
    }
    if (res.error) throw fromPostgresError(res.error)
    return res.data
  }
  const rpc = (fn: string, args?: Record<string, unknown>) => run(fn, (t) => t.rpc(fn, args))

  /** Not implemented in this phase: reports "not live" with the reason, and returns a no-op unsubscribe */
  const offline = <T>(sub: Subscription<T>) => {
    sub.onState?.(false, notConfigured("realtime is not implemented"))
    return () => {}
  }

  const sync: CloudSyncStore = {
    async get(_owner) {
      const rows = await run("syncs", (t) => t.select("syncs")) // RLS returns only the caller's row
      const r = rows?.[0]
      return r ? { data: r.data as string, rev: r.rev as number, updatedAt: Number(r.updated_at) } : null
    },
    async put(_owner, data, expectedRev) {
      // the owner is the JWT sub: it is deliberately not sent
      try {
        const rev = await rpc("sync_put", { p_expected_rev: expectedRev ?? 0, p_data: data, p_updated_at: Date.now() })
        return { ok: true, rev: rev as number }
      } catch (e) {
        if ((e as BackendError).code === "40001") return { ok: false, reason: "conflict" }
        throw e
      }
    },
    watch: (_owner, sub: Subscription<StoredSync>) => offline(sub),
  }

  const profiles: ProfileStore = {
    async save(_uid, name) {
      await rpc("upsert_profile", { p_name: name })
    },
    async getName(uid) {
      return ((await rpc("get_profile_name", { p_uid: uid })) as string | null) ?? null
    },
  }

  const invites: InviteStore = {
    async create(_uid, name, minutes) {
      const token = randomToken()
      const exp = await rpc("create_invite", { p_token: token, p_owner_name: name, p_minutes: minutes })
      return { token, expiresAt: ms(exp) ?? Date.now() + minutes * 60_000 }
    },
    async read(token) {
      const rows = (await rpc("get_invite", { p_token: token })) as Record<string, unknown>[] | null
      const r = rows?.[0]
      return r ? { owner: r.owner as string, ownerName: r.owner_name as string, expired: Boolean(r.expired), expiresAt: ms(r.expires_at) ?? 0 } : null
    },
    async remove(token) {
      await rpc("delete_invite", { p_token: token })
    },
  }

  const toRequest = (r: Record<string, unknown>): FriendRequest =>
    ({
      id: r.id as string,
      from: r.from_uid as string,
      to: r.to_uid as string,
      fromName: r.from_name as string,
      toName: r.to_name as string,
      participants: [r.from_uid as string, r.to_uid as string],
      status: r.status as FriendRequest["status"],
      createdAt: ms(r.created_at),
      respondedAt: ms(r.responded_at),
    }) as FriendRequest

  const connections: ConnectionStore = {
    watch: (_uid, sub) => offline(sub),
    async list(_uid) {
      const rows = await run("connections", (t) => t.select("connections")) // RLS: only the caller's own
      return (rows ?? []).map(toRequest)
    },
    async send(me, to) {
      return (await rpc("send_request", { p_to_uid: to.uid, p_from_name: me.name, p_to_name: to.name })) as string
    },
    async respond(id, status) {
      await rpc("respond_request", { p_id: id, p_status: status })
    },
    async remove(id) {
      await rpc("remove_request", { p_id: id })
    },
  }

  const pings: PingStore = {
    watch: (_uid, sub) => offline(sub),
    async create(p) {
      const r = await rpc("create_ping", {
        p_id: p.id,
        p_to_uid: p.to.uid,
        p_from_name: p.from.name,
        p_to_name: p.to.name,
        p_request_id: p.requestId,
        p_date: p.date,
        p_items: p.items,
      })
      return r === "existing" ? "existing" : "created"
    },
    async answer(id, items) {
      await rpc("answer_ping", { p_id: id, p_items: items })
    },
    async lease(id, deviceId) {
      return (await rpc("lease_ping", { p_id: id, p_device_id: deviceId })) === true
    },
    async finalize(id) {
      return (await rpc("finalize_ping", { p_id: id })) === "already" ? "already" : "processed"
    },
    async remove(id) {
      await rpc("remove_ping", { p_id: id })
    },
  }

  const pushTokens: PushTokenStore = {
    async save(_uid, token) {
      await rpc("save_push_token", { p_token: token, p_device_id: "legacy" }) // the client is still one-token-per-account (decision 3)
    },
    async remove(_uid) {
      await rpc("delete_push_token", { p_device_id: "legacy" })
    },
  }

  /** The seam for Realtime: the latest Firebase token is handed to Supabase `realtime.setAuth`. No subscription uses it yet. */
  const realtimeAuth: RealtimeAuth = {
    setToken(token) {
      transport?.setRealtimeAuth?.(token)
    },
  }

  return { kind: "supabase", sync, profiles, invites, connections, pings, pushTokens, realtimeAuth }
}
