/**
 * Phase 8 (local only): the Realtime wire transport and the sync watcher, against stand-ins (a scripted WebSocket and a fake store).
 * The same code runs against the real local stack in tests/local-supabase/realtime-e2e.test.ts. Nothing here touches a network,
 * and Realtime stays behind NEXT_PUBLIC_SUPABASE_REALTIME, which is off by default and never set in production.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import type { StoredSync, Subscription } from "@/lib/backend/contracts"
import { parseRealtimeFlag, realtimeEnabled } from "@/lib/backend/flags"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createPhoenixRealtimeTransport, type WebSocketLike } from "@/lib/backend/supabase/realtime-transport"
import type { ChannelStatus, RealtimeTransport } from "@/lib/backend/supabase/realtime-session"
import { createSyncWatcher } from "@/lib/backend/supabase/sync-watch"

const ROOT = path.resolve(import.meta.dirname, "..")
const CONFIG = { url: "http://127.0.0.1:54321", publishableKey: "sb_publishable_test_key" }

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// ---- a scripted WebSocket ------------------------------------------------------------------------------------------------------
class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = []
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  sent: { topic: string; event: string; payload: Record<string, unknown>; ref: string | null }[] = []
  closed = false
  constructor(public url: string) {
    FakeSocket.all.push(this)
  }
  send(data: string) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.closed = true
    this.readyState = 3
  }
  // server side
  open() {
    this.readyState = 1
    this.onopen?.({})
  }
  push(frame: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  serverClose() {
    this.readyState = 3
    this.onclose?.({})
  }
  find(event: string) {
    return this.sent.filter((f) => f.event === event)
  }
  /** the server accepts the join and confirms the change stream */
  accept(confirm = true) {
    const join = this.find("phx_join")[0]
    this.push({ topic: join.topic, event: "phx_reply", ref: join.ref, payload: { status: "ok", response: {} } })
    if (confirm) this.push({ topic: join.topic, event: "system", ref: null, payload: { status: "ok", extension: "postgres_changes", message: "Subscribed to PostgreSQL" } })
  }
  get topic() {
    return this.find("phx_join")[0]?.topic
  }
}
beforeEach(() => {
  FakeSocket.all = []
})
const last = () => FakeSocket.all[FakeSocket.all.length - 1]

function transport(extra: Partial<Parameters<typeof createPhoenixRealtimeTransport>[0]> = {}) {
  return createPhoenixRealtimeTransport({ config: CONFIG, table: "syncs", filter: "uid=eq.userA", socket: (u) => new FakeSocket(u), heartbeatMs: 1000, reconnectMinMs: 100, reconnectMaxMs: 800, readyMs: 2000, ...extra })
}
function listen(t: RealtimeTransport) {
  const statuses: ChannelStatus[] = []
  let changes = 0
  const off = t.subscribe({ onStatus: (s) => void statuses.push(s), onChange: () => void changes++ })
  return { statuses, changes: () => changes, off }
}

describe("the wire transport", () => {
  it("connects to the realtime endpoint (ws for loopback http), joins ONE table with ONE owner's filter and the token", () => {
    const t = transport()
    t.setAuth("tok-1")
    listen(t)
    const s = last()
    expect(s.url).toBe("ws://127.0.0.1:54321/realtime/v1/websocket?apikey=sb_publishable_test_key&vsn=1.0.0")
    s.open()
    const join = s.find("phx_join")[0]
    expect(join.payload.access_token).toBe("tok-1")
    expect((join.payload.config as { postgres_changes: unknown[] }).postgres_changes).toEqual([{ event: "*", schema: "public", table: "syncs", filter: "uid=eq.userA" }])
  })

  it("'subscribed' is reported only when the change stream is confirmed, not when the join is merely accepted", () => {
    const t = transport()
    const l = listen(t)
    const s = last()
    s.open()
    s.accept(false)
    expect(l.statuses).toEqual([])
    s.push({ topic: s.topic, event: "system", ref: null, payload: { status: "ok", extension: "postgres_changes" } })
    expect(l.statuses).toEqual(["subscribed"])
  })

  it("a joined channel whose change stream never confirms starts over instead of claiming to be live", () => {
    const t = transport()
    const l = listen(t)
    const s = last()
    s.open()
    s.accept(false)
    vi.advanceTimersByTime(2000)
    expect(l.statuses).toEqual(["error"])
    expect(s.closed).toBe(true)
    vi.advanceTimersByTime(100)
    expect(FakeSocket.all).toHaveLength(2) // reconnecting
    l.off()
  })

  it("a database change tells the caller to read again (the payload is never used as data)", () => {
    const t = transport()
    const l = listen(t)
    const s = last()
    s.open()
    s.accept()
    s.push({ topic: s.topic, event: "postgres_changes", ref: null, payload: { ids: [1], data: { record: { data: "secret blob" } } } })
    expect(l.changes()).toBe(1)
  })

  it("events for other topics are ignored", () => {
    const t = transport()
    const l = listen(t)
    const s = last()
    s.open()
    s.accept()
    s.push({ topic: "realtime:someone-else", event: "postgres_changes", ref: null, payload: {} })
    expect(l.changes()).toBe(0)
  })

  it("a token change reaches the joined channel; before the join it is part of the join", () => {
    const t = transport()
    listen(t)
    const s = last()
    t.setAuth("early")
    s.open()
    expect(s.find("phx_join")[0].payload.access_token).toBe("early")
    s.accept()
    t.setAuth("refreshed")
    expect(s.find("access_token").map((f) => f.payload.access_token)).toContain("refreshed")
  })

  it("socket closed by the network: 'closed', a reconnect after the backoff, a re-join with the LATEST token, 'subscribed' again", () => {
    const t = transport()
    t.setAuth("one")
    const l = listen(t)
    const s1 = last()
    s1.open()
    s1.accept()
    expect(l.statuses).toEqual(["subscribed"])
    s1.serverClose()
    expect(l.statuses).toEqual(["subscribed", "closed"])
    t.setAuth("two") // refreshed while down
    expect(FakeSocket.all).toHaveLength(1)
    vi.advanceTimersByTime(100)
    const s2 = last()
    expect(s2).not.toBe(s1)
    s2.open()
    expect(s2.find("phx_join")[0].payload.access_token).toBe("two")
    s2.accept()
    expect(l.statuses).toEqual(["subscribed", "closed", "subscribed"])
  })

  it("repeated failures back off (capped) and a success resets the delay", () => {
    const t = transport()
    listen(t)
    const delays: number[] = []
    let n = FakeSocket.all.length
    for (let i = 0; i < 5; i++) {
      last().serverClose()
      let waited = 0
      while (FakeSocket.all.length === n && waited < 5000) {
        vi.advanceTimersByTime(50)
        waited += 50
      }
      delays.push(waited)
      n = FakeSocket.all.length
    }
    expect(delays[1]).toBeGreaterThan(delays[0] - 1)
    expect(Math.max(...delays)).toBeLessThanOrEqual(850)
    last().open()
    last().accept()
    last().serverClose()
    let waited = 0
    const before = FakeSocket.all.length
    while (FakeSocket.all.length === before) {
      vi.advanceTimersByTime(50)
      waited += 50
    }
    expect(waited).toBeLessThanOrEqual(150) // back to the first delay
  })

  it("a join the server refuses is an 'error', then retried", () => {
    const t = transport()
    const l = listen(t)
    const s = last()
    s.open()
    const join = s.find("phx_join")[0]
    s.push({ topic: join.topic, event: "phx_reply", ref: join.ref, payload: { status: "error", response: { reason: "Unauthorized" } } })
    expect(l.statuses).toEqual(["error"])
    vi.advanceTimersByTime(100)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it("heartbeats are sent; one that is never answered drops the dead socket and reconnects", () => {
    const t = transport()
    const l = listen(t)
    const s = last()
    s.open()
    s.accept()
    vi.advanceTimersByTime(1000)
    expect(s.find("heartbeat")).toHaveLength(1)
    s.push({ topic: "phoenix", event: "phx_reply", ref: "x", payload: { status: "ok" } })
    vi.advanceTimersByTime(1000)
    expect(s.find("heartbeat")).toHaveLength(2) // answered: the connection is alive
    vi.advanceTimersByTime(1000) // the second one was never answered
    expect(l.statuses).toEqual(["subscribed", "closed"])
    expect(s.closed).toBe(true)
    vi.advanceTimersByTime(100)
    expect(FakeSocket.all).toHaveLength(2)
  })

  it("unsubscribe leaves the channel, closes the socket, clears every timer and never reconnects", () => {
    const t = transport()
    const l = listen(t)
    const s = last()
    s.open()
    s.accept()
    l.off()
    expect(s.find("phx_leave")).toHaveLength(1)
    expect(s.closed).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    s.serverClose() // a late event from the old socket changes nothing
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(l.statuses).toEqual(["subscribed"])
    l.off() // twice is harmless
  })

  it("unsubscribing while reconnecting cancels the reconnect", () => {
    const t = transport()
    const l = listen(t)
    last().serverClose()
    l.off()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.all).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a socket that cannot even be created is reported and retried, never thrown", () => {
    let fail = true
    const t = createPhoenixRealtimeTransport({ config: CONFIG, table: "syncs", filter: "uid=eq.u", reconnectMinMs: 100, socket: (u) => { if (fail) throw new Error("blocked"); return new FakeSocket(u) } })
    const l = listen(t)
    expect(l.statuses).toEqual(["error"])
    fail = false
    vi.advanceTimersByTime(100)
    expect(FakeSocket.all).toHaveLength(1)
    l.off()
  })

  it("refuses an unsafe URL, table or filter", () => {
    expect(() => createPhoenixRealtimeTransport({ config: { url: "http://evil.example.com", publishableKey: "k" }, table: "syncs", filter: "uid=eq.u" })).toThrow()
    expect(() => createPhoenixRealtimeTransport({ config: CONFIG, table: "syncs; drop", filter: "uid=eq.u" })).toThrow()
    expect(() => createPhoenixRealtimeTransport({ config: CONFIG, table: "syncs", filter: "uid=eq.u,other=eq.x" })).toThrow()
    expect(() => createPhoenixRealtimeTransport({ config: { url: "https://x.supabase.co", publishableKey: "k&x=1" }, table: "syncs", filter: "uid=eq.u" })).toThrow()
  })
})

// ---- the watcher ---------------------------------------------------------------------------------------------------------------
function rig(opts: { pollMs?: number } = {}) {
  const store = new Map<string, StoredSync>()
  const fetched: string[] = []
  let failFetch = false
  const transports = new Map<string, { setAuth: string[]; handlers: Set<{ onStatus(s: ChannelStatus): void; onChange(): void }>; unsubscribed: number; subscribes: number }>()
  const tokenListeners = new Set<(t: string | null) => void>()
  let token: string | null = "tok-A"
  const bridge = {
    ensureAuthenticated: async () => ({ status: token ? "authenticated" : "unauthorized" }) as never,
    getToken: async () => token,
    onToken: (l: (t: string | null) => void) => (tokenListeners.add(l), () => void tokenListeners.delete(l)),
  }
  const watch = createSyncWatcher({
    bridge,
    pollMs: opts.pollMs ?? 1000,
    fetchSync: async (o) => {
      fetched.push(o)
      if (failFetch) throw new Error("offline")
      return store.get(o) ?? null
    },
    createTransport: (owner) => {
      const rec = { setAuth: [] as string[], handlers: new Set<{ onStatus(s: ChannelStatus): void; onChange(): void }>(), unsubscribed: 0, subscribes: 0 }
      transports.set(owner, rec)
      return {
        setAuth: (t) => void rec.setAuth.push(String(t)),
        subscribe: (h) => {
          rec.subscribes++
          rec.handlers.add(h)
          return () => {
            rec.unsubscribed++
            rec.handlers.delete(h)
          }
        },
      } satisfies RealtimeTransport
    },
  })
  const put = (owner: string, rev: number, data = `d${rev}`) => store.set(owner, { data, rev, updatedAt: rev })
  const emit = (owner: string, s: ChannelStatus) => transports.get(owner)!.handlers.forEach((h) => h.onStatus(s))
  const change = (owner: string) => transports.get(owner)!.handlers.forEach((h) => h.onChange())
  const sub = () => {
    const docs: number[] = []
    const states: boolean[] = []
    const s: Subscription<StoredSync> = { onData: (d) => void docs.push(d.rev), onState: (l) => void states.push(l) }
    return { docs, states, s }
  }
  return {
    watch, put, emit, change, sub, store, fetched, transports,
    failFetch: (b: boolean) => (failFetch = b),
    setToken(t: string | null) {
      token = t
      tokenListeners.forEach((l) => l(t))
    },
  }
}
const settle = () => vi.advanceTimersByTimeAsync(0)

describe("the sync watcher", () => {
  it("reads at once, subscribes, and re-reads after EVERY subscribed (first and after each reconnect)", async () => {
    const r = rig()
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    expect(c.docs).toEqual([1])
    const before = r.fetched.length
    r.emit("A", "subscribed")
    await settle()
    expect(r.fetched.length).toBe(before + 1) // refetch on the first subscribe
    r.put("A", 2) // changed while the socket is dead
    r.emit("A", "closed")
    await settle()
    r.emit("A", "subscribed") // re-joined: no event was replayed, so the re-read is what converges
    await settle()
    expect(c.docs).toEqual([1, 2])
    off()
  })

  it("socket killed, document mutated, socket restored: converges even if no event ever arrives", async () => {
    const r = rig({ pollMs: 600_000 })
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.emit("A", "subscribed")
    await settle()
    r.emit("A", "closed")
    r.put("A", 5)
    await vi.advanceTimersByTimeAsync(5000)
    r.emit("A", "subscribed")
    await settle()
    expect(c.docs).toEqual([1, 5])
    expect(c.states).toEqual([false, true, false, true])
    off()
  })

  it("a change event triggers a read; the same revision is never delivered twice; older revisions are dropped", async () => {
    const r = rig()
    r.put("A", 3)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.emit("A", "subscribed")
    await settle()
    r.change("A")
    await settle()
    r.change("A")
    await settle()
    expect(c.docs).toEqual([3])
    r.put("A", 4)
    r.change("A")
    await settle()
    r.put("A", 2) // a stale read
    r.change("A")
    await settle()
    expect(c.docs).toEqual([3, 4])
    off()
  })

  it("a burst of events during a read costs exactly one more read", async () => {
    const r = rig()
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.emit("A", "subscribed")
    await settle()
    const base = r.fetched.length
    r.put("A", 2)
    for (let i = 0; i < 20; i++) r.change("A")
    await settle()
    expect(r.fetched.length - base).toBeLessThanOrEqual(2)
    expect(c.docs).toEqual([1, 2])
    off()
  })

  it("two watchers of one account share ONE channel; the second starts from the current copy; each revision reaches each watcher once", async () => {
    const r = rig()
    r.put("A", 1)
    const c1 = r.sub()
    const c2 = r.sub()
    const off1 = r.watch("A", c1.s)
    await settle()
    r.emit("A", "subscribed")
    await settle()
    const off2 = r.watch("A", c2.s)
    expect(r.transports.get("A")!.subscribes).toBe(1)
    expect(c2.docs).toEqual([1])
    expect(c2.states).toEqual([true])
    r.put("A", 2)
    r.change("A")
    await settle()
    expect(c1.docs).toEqual([1, 2])
    expect(c2.docs).toEqual([1, 2])
    off1()
    expect(r.transports.get("A")!.unsubscribed).toBe(0) // still wanted
    r.put("A", 3)
    r.change("A")
    await settle()
    expect(c2.docs).toEqual([1, 2, 3])
    expect(c1.docs).toEqual([1, 2])
    off2()
    expect(r.transports.get("A")!.unsubscribed).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
    off1()
    off2() // unsubscribing twice changes nothing
  })

  it("polls while the channel is not live, stops when it is live, and starts again when it drops", async () => {
    const r = rig({ pollMs: 1000 })
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.put("A", 2)
    await vi.advanceTimersByTimeAsync(1000) // not live yet: the poll finds it
    expect(c.docs).toEqual([1, 2])
    r.emit("A", "subscribed")
    await settle()
    const live = r.fetched.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.fetched.length).toBe(live) // live: no polling
    r.emit("A", "closed")
    r.put("A", 3)
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.docs).toEqual([1, 2, 3]) // dropped: polling again
    off()
    const stopped = r.fetched.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.fetched.length).toBe(stopped)
  })

  it("keeps polling while Realtime never comes up, and an unreachable store neither throws nor stops the poll", async () => {
    const r = rig({ pollMs: 500 })
    const c = r.sub()
    const off = r.watch("A", c.s)
    r.failFetch(true)
    await vi.advanceTimersByTimeAsync(2000)
    r.failFetch(false)
    r.put("A", 1)
    await vi.advanceTimersByTimeAsync(500)
    expect(c.docs).toEqual([1])
    expect(c.states.includes(true)).toBe(false)
    off()
  })

  it("a refetch after 'subscribed' that FAILS is retried while live, without waiting for another event (Task A)", async () => {
    const r = rig({ pollMs: 1000 })
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    expect(c.docs).toEqual([1])
    r.failFetch(true) // the read made right after the subscribe fails ...
    r.put("A", 2) // ... for a change that happened around the subscription: no event will ever announce it
    r.emit("A", "subscribed")
    await settle()
    expect(c.docs).toEqual([1])
    r.failFetch(false) // the store is reachable again; nothing else happens
    await vi.advanceTimersByTimeAsync(20_000)
    expect(c.docs).toEqual([1, 2])
    off()
  })

  it("the retry backs off (no storm), stops after the first success, delivers once, and leaves no timer behind", async () => {
    const r = rig({ pollMs: 8000 })
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.emit("A", "subscribed")
    await settle()
    r.failFetch(true)
    r.put("A", 2)
    r.change("A")
    await settle()
    const base = r.fetched.length
    await vi.advanceTimersByTimeAsync(60_000)
    const attempts = r.fetched.length - base
    expect(attempts).toBeGreaterThan(2) // it keeps trying ...
    expect(attempts).toBeLessThan(15) // ... but backs off
    r.failFetch(false)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(c.docs).toEqual([1, 2])
    const done = r.fetched.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.fetched.length).toBe(done) // live and healthy: no polling, no retrying
    off()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a retry pending when the channel drops or the last watcher leaves does not outlive it", async () => {
    const r = rig({ pollMs: 1000 })
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.emit("A", "subscribed")
    r.failFetch(true)
    r.change("A")
    await settle()
    off()
    expect(vi.getTimerCount()).toBe(0)
    const n = r.fetched.length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(r.fetched.length).toBe(n)
  })

  it("sign-out drops the channel (token cleared) and polling takes over; signing back in re-subscribes", async () => {
    const r = rig({ pollMs: 1000 })
    r.put("A", 1)
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.emit("A", "subscribed")
    await settle()
    r.setToken(null)
    await settle()
    expect(r.transports.get("A")!.unsubscribed).toBe(1)
    expect(r.transports.get("A")!.setAuth).toContain("null")
    expect(c.states.at(-1)).toBe(false)
    r.setToken("tok-A2")
    await settle()
    expect(r.transports.get("A")!.subscribes).toBe(2)
    expect(r.transports.get("A")!.setAuth.at(-1)).toBe("tok-A2")
    off()
  })

  it("a token refresh reaches the transport (setAuth) without re-opening the channel", async () => {
    const r = rig()
    const c = r.sub()
    const off = r.watch("A", c.s)
    await settle()
    r.emit("A", "subscribed")
    r.setToken("tok-refreshed")
    await settle()
    expect(r.transports.get("A")!.setAuth.at(-1)).toBe("tok-refreshed")
    expect(r.transports.get("A")!.subscribes).toBe(1)
    off()
  })

  it("account switch: the old account's channel is removed and the new account gets its own, filtered to itself, with no cross-delivery", async () => {
    const r = rig()
    r.put("A", 1)
    r.put("B", 7)
    const cA = r.sub()
    const offA = r.watch("A", cA.s)
    await settle()
    r.emit("A", "subscribed")
    await settle()
    offA() // the app tears down A's watcher ...
    r.setToken("tok-B") // ... the bridge moves to B ...
    const cB = r.sub()
    const offB = r.watch("B", cB.s)
    await settle()
    r.emit("B", "subscribed")
    await settle()
    expect(r.transports.get("A")!.unsubscribed).toBe(1)
    expect(r.transports.get("B")!.subscribes).toBe(1)
    expect(cB.docs).toEqual([7])
    r.put("A", 2)
    r.put("B", 8)
    r.change("B")
    await settle()
    expect(cB.docs).toEqual([7, 8])
    expect(cA.docs).toEqual([1]) // A's old watcher hears nothing more
    offB()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("a watcher that throws does not stop the others", async () => {
    const r = rig()
    r.put("A", 1)
    const good = r.sub()
    const off1 = r.watch("A", { onData: () => { throw new Error("boom") } })
    const off2 = r.watch("A", good.s)
    await settle()
    r.put("A", 2)
    r.change("A")
    await settle()
    expect(good.docs).toEqual([1, 2])
    off1()
    off2()
  })
})

// ---- wiring and the flag ---------------------------------------------------------------------------------------------------------
describe("the adapter, the flag and the wiring", () => {
  it("without realtime wiring, watch behaves exactly as before: not live, no-op unsubscribe", () => {
    const be = createSupabaseBackend({})
    const states: [boolean, unknown][] = []
    const off = be.sync.watch("u", { onData: vi.fn(), onState: (l, e) => void states.push([l, e]) })
    expect(states[0][0]).toBe(false)
    expect(() => off()).not.toThrow()
  })

  it("with wiring the adapter's watch is the shared watcher over its own sync.get", async () => {
    const calls: string[] = []
    const be = createSupabaseBackend({
      transport: {
        rpc: async () => ({ data: null, error: null }),
        select: async (t) => (calls.push(t), { data: [{ uid: "u", data: "blob", rev: 4, updated_at: 9 }], error: null }),
      },
      guard: async () => "x".repeat(40),
      realtime: { bridge: { ensureAuthenticated: async () => ({ status: "unauthorized" }) as never, getToken: async () => null, onToken: () => () => {} }, createTransport: () => ({ setAuth: () => {}, subscribe: () => () => {} }), pollMs: 1000 },
    })
    const docs: StoredSync[] = []
    const off = be.sync.watch("u", { onData: (d) => void docs.push(d) })
    await settle()
    expect(docs).toEqual([{ data: "blob", rev: 4, updatedAt: 9 }])
    expect(calls).toContain("syncs")
    off()
  })

  it("the flag is off unless exactly 'true'", () => {
    for (const v of [undefined, "", "false", "1", "yes", "TRUEE"]) expect(parseRealtimeFlag(v)).toBe(false)
    for (const v of ["true", " TRUE "]) expect(parseRealtimeFlag(v)).toBe(true)
    expect(realtimeEnabled()).toBe(false) // not set in this environment
  })

  it("the app wires it only inside the supabase branch, behind the flag; Firebase stays the default and nothing in app/hooks/components imports it", () => {
    const idx = fs.readFileSync(path.join(ROOT, "lib/backend/index.ts"), "utf8")
    expect(idx).toMatch(/if \(!realtimeEnabled\(\)\) return undefined/)
    expect(idx).toMatch(/kind === "supabase"\s*\?\s*createSupabaseBackend\(\{[\s\S]*realtime: buildRealtime\(\)/)
    expect(idx).toMatch(/if \(!v \|\| v === "firebase"\) return "firebase"/)
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const users = ["app", "components", "hooks"].flatMap(walk).filter((f) => /realtime-transport|sync-watch|realtime-session/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    expect(users).toEqual([])
  })

  it("the migration only adds the table to the Realtime publication (no policy, grant or schema change) and is idempotent", () => {
    const sql = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261011000100_realtime_syncs.sql"), "utf8")
    const code = sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    expect(code).toMatch(/alter publication supabase_realtime add table public\.syncs/)
    expect(code).toMatch(/not exists \(select 1 from pg_publication_tables/)
    expect(code).not.toMatch(/create policy|grant |revoke |alter table|create table|drop /i)
  })
})
