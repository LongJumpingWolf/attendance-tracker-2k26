/**
 * The Supabase Realtime wire transport (Phase 8), written against the Phoenix-channels protocol Supabase Realtime speaks, because
 * no client package may be added. It implements `RealtimeTransport` for `createRealtimeSession` (realtime-session.ts), which owns the
 * two rules that matter (setAuth before every subscribe, refetch after every subscribed). This file only moves frames:
 *
 *   socket   wss://<project>/realtime/v1/websocket?apikey=<publishable key>&vsn=1.0.0   (JSON frames {topic,event,payload,ref})
 *   join     phx_join with the Postgres Changes filter for ONE table and ONE owner, and the current access token
 *   ready    "subscribed" is reported only when the server has confirmed that the database change stream for the filter is running
 *            (the system message "Subscribed to PostgreSQL"), NOT merely when the join was accepted: a change made between those two
 *            moments is neither delivered nor replayed, and the session's refetch (made on "subscribed") is what covers everything before
 *   events   postgres_changes -> onChange (the payload is NOT trusted as data: the caller refetches through the normal, RLS-checked read)
 *   health   a heartbeat every 25 s; a heartbeat that is not answered before the next one drops the socket
 *   drops    any close/error/phx_error/missed heartbeat -> status "closed"/"error", then reconnect with capped backoff and re-join with the
 *            LATEST token; every successful (re)join reports "subscribed" again, which makes the session refetch
 *   cleanup  unsubscribe leaves the channel, closes the socket, clears every timer and never reconnects
 *
 * It never throws into its caller, never logs a token, and refuses a URL that is not https (or loopback http).
 */
import type { Unsubscribe } from "../contracts"
import { safeOrigin } from "./transport"
import type { ChannelStatus, RealtimeTransport } from "./realtime-session"
import type { SupabaseConfig } from "./guard"

/** The part of WebSocket this file uses (so tests can supply a stand-in, and the real one is the platform's) */
export interface WebSocketLike {
  readyState: number
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  send(data: string): void
  close(code?: number, reason?: string): void
}
export type WebSocketFactory = (url: string) => WebSocketLike

export interface PhoenixRealtimeOptions {
  config: SupabaseConfig
  /** Postgres Changes source */
  table: string
  /** e.g. "uid=eq.<owner>": restricts events to one row key (RLS still applies on top) */
  filter: string
  schema?: string
  socket?: WebSocketFactory
  heartbeatMs?: number
  /** how long a joined channel may wait for the change stream to be confirmed before it starts over; default 10 s */
  readyMs?: number
  /** reconnect delays: first, and the cap (doubling in between) */
  reconnectMinMs?: number
  reconnectMaxMs?: number
}

const OPEN = 1

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/
const FILTER_RE = /^[a-z_][a-z0-9_]*=eq\.[A-Za-z0-9_-]{1,128}$/

export function createPhoenixRealtimeTransport(opts: PhoenixRealtimeOptions): RealtimeTransport {
  const origin = safeOrigin(opts.config.url)
  if (!NAME_RE.test(opts.table) || !FILTER_RE.test(opts.filter)) throw new Error("realtime: unsafe table or filter")
  const key = opts.config.publishableKey
  if (!key || /[\r\n&]/.test(key)) throw new Error("realtime: bad key")
  const url = `${origin.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(key)}&vsn=1.0.0`
  const make: WebSocketFactory = opts.socket ?? ((u) => new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(u))
  const heartbeatMs = opts.heartbeatMs ?? 25_000
  const readyMs = opts.readyMs ?? 10_000
  const minMs = opts.reconnectMinMs ?? 1000
  const maxMs = opts.reconnectMaxMs ?? 30_000
  const schema = opts.schema ?? "public"

  let token: string | null = null
  // the channels this transport currently serves (the session opens one at a time; a Set keeps unsubscribe of an old one harmless)
  const channels = new Set<() => void>() // each entry's "send the new token" function

  return {
    setAuth(next) {
      token = next
      for (const push of channels) push()
    },

    subscribe(handlers): Unsubscribe {
      let stopped = false
      let ws: WebSocketLike | null = null
      let joined = false // the join was accepted (the token can be refreshed on the channel)
      let ready = false // the change stream is confirmed running ("subscribed" has been reported)
      let readyTimer: ReturnType<typeof setTimeout> | undefined
      let attempt = 0
      let ref = 0
      let joinRef: string | null = null
      let hbTimer: ReturnType<typeof setInterval> | undefined
      let retryTimer: ReturnType<typeof setTimeout> | undefined
      let awaitingHeartbeat = false
      const topic = `realtime:sync-${Math.random().toString(36).slice(2, 10)}`

      const send = (frame: { topic: string; event: string; payload: unknown; ref?: string | null }) => {
        try {
          if (ws && ws.readyState === OPEN) ws.send(JSON.stringify({ join_ref: joinRef, ref: frame.ref ?? String(++ref), ...frame }))
        } catch {
          /* the close handler deals with a broken socket */
        }
      }
      const pushToken = () => {
        if (joined && token) send({ topic, event: "access_token", payload: { access_token: token } })
      }
      channels.add(pushToken)

      const clearTimers = () => {
        clearInterval(hbTimer)
        hbTimer = undefined
        clearTimeout(retryTimer)
        retryTimer = undefined
        clearTimeout(readyTimer)
        readyTimer = undefined
      }

      function drop(status: ChannelStatus) {
        if (stopped) return
        const s = ws
        ws = null
        clearInterval(hbTimer)
        hbTimer = undefined
        awaitingHeartbeat = false
        if (s) {
          s.onopen = s.onmessage = s.onclose = s.onerror = null // nothing more from a socket we have given up on
          try {
            s.close()
          } catch {
            /* already closed */
          }
        }
        joined = false
        ready = false
        clearTimeout(readyTimer)
        readyTimer = undefined
        handlers.onStatus(status)
        const delay = Math.min(maxMs, minMs * 2 ** Math.min(attempt, 10))
        attempt++
        clearTimeout(retryTimer)
        retryTimer = setTimeout(connect, delay)
      }

      function connect() {
        if (stopped) return
        let s: WebSocketLike
        try {
          s = make(url)
        } catch {
          drop("error")
          return
        }
        ws = s
        s.onopen = () => {
          if (stopped || ws !== s) return
          joinRef = String(++ref)
          send({
            topic,
            event: "phx_join",
            ref: joinRef,
            payload: {
              config: {
                broadcast: { ack: false, self: false },
                presence: { key: "" },
                postgres_changes: [{ event: "*", schema, table: opts.table, filter: opts.filter }],
                private: false,
              },
              access_token: token,
            },
          })
          clearInterval(hbTimer)
          hbTimer = setInterval(() => {
            if (stopped || ws !== s) return
            if (awaitingHeartbeat) return drop("closed") // the last heartbeat was never answered: the connection is dead
            awaitingHeartbeat = true
            send({ topic: "phoenix", event: "heartbeat", payload: {} })
          }, heartbeatMs)
        }
        s.onmessage = (ev) => {
          if (stopped || ws !== s) return
          let m: { topic?: string; event?: string; payload?: Record<string, unknown>; ref?: string | null }
          try {
            m = JSON.parse(String(ev.data))
          } catch {
            return
          }
          if (m.topic === "phoenix" && m.event === "phx_reply") {
            awaitingHeartbeat = false
            return
          }
          if (m.topic !== topic) return
          if (m.event === "phx_reply" && m.ref === joinRef) {
            const status = (m.payload as { status?: string } | undefined)?.status
            if (status === "ok") {
              joined = true
              pushToken() // the token may have changed between the join and its answer
              clearTimeout(readyTimer)
              readyTimer = setTimeout(() => drop("error"), readyMs) // joined but the change stream never confirmed: start over
            } else drop("error")
          } else if (m.event === "postgres_changes") {
            handlers.onChange()
          } else if (m.event === "phx_error" || m.event === "phx_close") {
            drop("closed")
          } else if (m.event === "system") {
            const p = m.payload as { status?: string; extension?: string } | undefined
            if (p?.status === "error") drop("error")
            else if (p?.status === "ok" && p.extension === "postgres_changes" && joined && !ready) {
              ready = true
              attempt = 0
              clearTimeout(readyTimer)
              readyTimer = undefined
              handlers.onStatus("subscribed")
            }
          }
        }
        s.onclose = () => {
          if (ws === s) drop("closed")
        }
        s.onerror = () => {
          if (ws === s) drop("error")
        }
      }

      connect()

      return () => {
        if (stopped) return
        stopped = true
        channels.delete(pushToken)
        clearTimers()
        const s = ws
        ws = null
        if (s) {
          try {
            if (s.readyState === OPEN) s.send(JSON.stringify({ topic, event: "phx_leave", payload: {}, ref: String(++ref), join_ref: joinRef }))
          } catch {
            /* closing anyway */
          }
          s.onopen = s.onmessage = s.onclose = s.onerror = null
          try {
            s.close()
          } catch {
            /* already closed */
          }
        }
        joined = false
        ready = false
      }
    },
  }
}
