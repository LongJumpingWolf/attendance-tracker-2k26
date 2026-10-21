/**
 * `sync.watch` for the Supabase adapter (Phase 8): the single stored sync document of one account, delivered live.
 *
 * Built on the Phase 6D session controller (setAuth before every subscribe, refetch after every subscribed, sign-out drops the
 * channel) and the wire transport (realtime-transport.ts). What this file adds:
 *
 *  - ONE session per owner however many callers watch it: a second `watch` of the same owner shares the channel and gets the current
 *    document, instead of opening a second socket and applying every change twice;
 *  - delivery goes only through `refresh` (a normal, RLS-checked read), never from the event payload, so a change that arrives while a read
 *    is running is coalesced into exactly one more read, and a document is delivered to each watcher once per revision (older or equal
 *    revisions are dropped: a refetch after a reconnect that finds nothing new delivers nothing);
 *  - the polling fallback: while the channel is NOT live (before it joins, after a drop, while signed out, when Realtime is unreachable)
 *    the same read runs every `pollMs`; it stops the moment the channel is live and starts again when it drops;
 *  - a read that FAILS while the channel is live is retried with backoff (1 s doubling up to the poll interval) until one succeeds: the
 *    channel being live does not mean the data is current, and a change made around the subscription is never announced by an event;
 *  - cleanup: when the last watcher leaves, the session stops (channel left, socket closed, token cleared) and the poll timer is cleared.
 *
 * It never throws into the app: a failed read just means the next poll (or the next event) tries again.
 */
import type { StoredSync, Subscription, Unsubscribe } from "../contracts"
import type { AuthBridge } from "../supabase-auth"
import { createRealtimeSession, type RealtimeSession, type RealtimeTransport } from "./realtime-session"

export interface SyncWatchDeps {
  bridge: Pick<AuthBridge, "ensureAuthenticated" | "getToken" | "onToken">
  /** A transport for ONE owner's document (its filter is that owner) */
  createTransport(owner: string): RealtimeTransport
  /** The normal read of the account's stored copy */
  fetchSync(owner: string): Promise<StoredSync | null>
  /** Fallback poll interval while the channel is not live; default 15 s (the same as the development store) */
  pollMs?: number
}

interface Entry {
  subs: Set<Subscription<StoredSync>>
  session: RealtimeSession
  live: boolean
  lastRev: number | null
  lastDoc: StoredSync | null
  fetching: boolean
  again: boolean
  poll: ReturnType<typeof setInterval> | undefined
  /** the last read failed and nothing newer has succeeded */
  failed: boolean
  retry: ReturnType<typeof setTimeout> | undefined
  retryMs: number
  closed: boolean
}

const RETRY_FIRST_MS = 1000

export function createSyncWatcher(deps: SyncWatchDeps): (owner: string, sub: Subscription<StoredSync>) => Unsubscribe {
  const pollMs = deps.pollMs ?? 15_000
  const entries = new Map<string, Entry>()

  async function refresh(owner: string, e: Entry): Promise<void> {
    if (e.closed) return
    if (e.fetching) {
      e.again = true // a change arrived while reading: one more read afterwards, not one per event
      return
    }
    e.fetching = true
    try {
      do {
        e.again = false
        let doc: StoredSync | null = null
        let ok = true
        try {
          doc = await deps.fetchSync(owner)
        } catch {
          ok = false // unreachable or unauthorized for now: retried (below), by the poll, or by the next event
        }
        if (e.closed) return
        e.failed = !ok
        if (ok) {
          clearTimeout(e.retry)
          e.retry = undefined
          e.retryMs = RETRY_FIRST_MS
        }
        if (doc && Number.isSafeInteger(doc.rev) && (e.lastRev === null || doc.rev > e.lastRev)) {
          e.lastRev = doc.rev
          e.lastDoc = doc
          for (const s of [...e.subs]) {
            try {
              s.onData(doc)
            } catch {
              /* a watcher's own error must not stop the others */
            }
          }
        }
      } while (e.again && !e.closed)
    } finally {
      e.fetching = false
    }
    // Live but the last read failed: the poll is off, so without this nothing would ever look again
    if (e.failed && e.live && !e.closed && !e.retry) {
      const wait = Math.min(e.retryMs, pollMs)
      e.retryMs = Math.min(e.retryMs * 2, pollMs)
      e.retry = setTimeout(() => {
        e.retry = undefined
        void refresh(owner, e)
      }, wait)
    }
  }

  function setLive(owner: string, e: Entry, live: boolean) {
    if (e.closed) return
    const changed = e.live !== live
    e.live = live
    if (!live) {
      clearTimeout(e.retry) // the poll covers a channel that is not live
      e.retry = undefined
    }
    if (live) {
      clearInterval(e.poll)
      e.poll = undefined
    } else if (!e.poll) {
      e.poll = setInterval(() => void refresh(owner, e), pollMs) // the fallback: same read, on a timer
    }
    if (changed) for (const s of [...e.subs]) s.onState?.(live)
  }

  return (owner, sub) => {
    let e = entries.get(owner)
    if (!e) {
      const entry: Entry = {
        subs: new Set(),
        session: undefined as unknown as RealtimeSession,
        live: false,
        lastRev: null,
        lastDoc: null,
        fetching: false,
        again: false,
        poll: undefined,
        failed: false,
        retry: undefined,
        retryMs: RETRY_FIRST_MS,
        closed: false,
      }
      entry.session = createRealtimeSession({
        bridge: deps.bridge,
        transport: deps.createTransport(owner),
        refetch: () => refresh(owner, entry),
        onChange: () => refresh(owner, entry),
        onState: (live) => setLive(owner, entry, live),
      })
      entries.set(owner, entry)
      entry.subs.add(sub)
      sub.onState?.(false)
      setLive(owner, entry, false) // polling from the start; the first `subscribed` turns it off
      void refresh(owner, entry) // the first read does not wait for the socket
      void entry.session.start()
      e = entry
    } else {
      e.subs.add(sub)
      sub.onState?.(e.live)
      if (e.lastDoc) {
        try {
          sub.onData(e.lastDoc) // a second watcher starts from the current copy; it shares the one channel
        } catch {
          /* its own error */
        }
      }
    }
    const mine = e
    let left = false
    return () => {
      if (left) return
      left = true
      mine.subs.delete(sub)
      if (mine.subs.size === 0 && !mine.closed) {
        mine.closed = true
        clearInterval(mine.poll)
        mine.poll = undefined
        clearTimeout(mine.retry)
        mine.retry = undefined
        mine.session.stop()
        if (entries.get(owner) === mine) entries.delete(owner)
      }
    }
  }
}
