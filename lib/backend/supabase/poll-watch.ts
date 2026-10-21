/**
 * Live lists (Pings, connections) for the Supabase adapter by polling, Phase 9 slice. Postgres Changes cannot filter "from me OR to me"
 * in one subscription and the tables are not in the Realtime publication (that would be a configuration migration), so this uses the
 * plan's polling floor: the same RLS-checked read the app already makes, repeated while somebody is watching.
 *
 *  - one poller per (kind, uid), however many callers watch it; a new watcher starts from the latest list;
 *  - a list is delivered only when it CHANGED (compared by content), so an unchanged poll costs the app nothing;
 *  - rows that do not involve the requested account are dropped before delivery (defence in depth on top of RLS);
 *  - a failed read keeps the last list, reports not-live, and is tried again on the next tick (no backoff storm: the tick is the pace);
 *  - cleanup: the last watcher leaving clears the timer; nothing runs afterwards.
 */
import type { Subscription, Unsubscribe } from "../contracts"

export interface PollWatchDeps<T> {
  /** The normal read of this account's list */
  read(uid: string): Promise<T[]>
  /** Does this item involve `uid`? Items that do not are never delivered. */
  involves(item: T, uid: string): boolean
  pollMs?: number
}

interface Entry<T> {
  subs: Set<Subscription<T[]>>
  timer: ReturnType<typeof setInterval> | undefined
  last: string | null
  lastList: T[] | null
  live: boolean
  reading: boolean
  closed: boolean
}

export function createPollWatcher<T>(deps: PollWatchDeps<T>): (uid: string, sub: Subscription<T[]>) => Unsubscribe {
  const pollMs = deps.pollMs ?? 5_000
  const entries = new Map<string, Entry<T>>()

  async function tick(uid: string, e: Entry<T>) {
    if (e.closed || e.reading) return
    e.reading = true
    try {
      let list: T[]
      try {
        list = (await deps.read(uid)).filter((x) => deps.involves(x, uid))
      } catch {
        if (!e.closed && e.live) {
          e.live = false
          for (const s of [...e.subs]) s.onState?.(false)
        }
        return
      }
      if (e.closed) return
      if (!e.live) {
        e.live = true
        for (const s of [...e.subs]) s.onState?.(true)
      }
      const sig = JSON.stringify(list)
      if (sig === e.last) return
      e.last = sig
      e.lastList = list
      for (const s of [...e.subs]) {
        try {
          s.onData(list)
        } catch {
          /* a watcher's own error must not stop the others */
        }
      }
    } finally {
      e.reading = false
    }
  }

  return (uid, sub) => {
    let e = entries.get(uid)
    if (!e) {
      const entry: Entry<T> = { subs: new Set([sub]), timer: undefined, last: null, lastList: null, live: false, reading: false, closed: false }
      entries.set(uid, entry)
      sub.onState?.(false)
      entry.timer = setInterval(() => void tick(uid, entry), pollMs)
      void tick(uid, entry)
      e = entry
    } else {
      e.subs.add(sub)
      sub.onState?.(e.live)
      if (e.lastList) {
        try {
          sub.onData(e.lastList)
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
        clearInterval(mine.timer)
        mine.timer = undefined
        if (entries.get(uid) === mine) entries.delete(uid)
      }
    }
  }
}
