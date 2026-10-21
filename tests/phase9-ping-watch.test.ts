/**
 * Phase 9 slice (local only): live lists of Pings and connections for the Supabase adapter, by polling the normal RLS-checked read.
 * Stand-in transport; the same adapter runs against the real local stack in tests/local-supabase/ping-e2e.test.ts.
 * Firebase stays the default backend; this path exists only when the adapter is given `watchPollMs` (behind NEXT_PUBLIC_SUPABASE_REALTIME).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createPollWatcher } from "@/lib/backend/supabase/poll-watch"
import type { Ping } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")
const ME = "m".repeat(28)
const MATE = "t".repeat(28)
const STRANGER = "s".repeat(28)

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const settle = () => vi.advanceTimersByTimeAsync(0)

const row = (over: Record<string, unknown> = {}) => ({
  id: "ping-0001-aaaa",
  from_uid: ME,
  to_uid: MATE,
  from_name: "Me",
  to_name: "Mate",
  request_id: "req-1",
  class_date: "2026-10-12",
  items: [{ key: "k", subjectId: "s", name: "Maths", t: "09:00", answer: null }],
  status: "asking",
  created_at: "2026-10-12T04:00:00Z",
  responded_at: null,
  claimed_by: null,
  claimed_at: null,
  ...over,
})

function rig(rows: () => Record<string, unknown>[], opts: { pollMs?: number } = {}) {
  const reads: string[] = []
  let fail = false
  const be = createSupabaseBackend({
    transport: {
      rpc: async () => ({ data: null, error: null }),
      select: async (table) => {
        reads.push(table)
        if (fail) throw new Error("offline")
        return { data: rows(), error: null }
      },
    },
    guard: async () => "x".repeat(40),
    watchPollMs: opts.pollMs ?? 1000,
  })
  return { be, reads, setFail: (b: boolean) => (fail = b) }
}
const collect = () => {
  const lists: Ping[][] = []
  const states: boolean[] = []
  return { lists, states, sub: { onData: (l: Ping[]) => void lists.push(l), onState: (v: boolean) => void states.push(v) } }
}

describe("Ping and connection lists by polling", () => {
  it("maps stored rows to Pings (ids, participants, status, times, lease) and delivers them once", async () => {
    const r = rig(() => [row({ status: "answered", responded_at: "2026-10-12T05:00:00Z", claimed_by: "device-1", claimed_at: "2026-10-12T05:01:00Z" })])
    const c = collect()
    const off = r.be.pings.watch(ME, c.sub)
    await settle()
    expect(c.lists).toHaveLength(1)
    expect(c.lists[0][0]).toMatchObject({
      id: "ping-0001-aaaa", from: ME, to: MATE, fromName: "Me", toName: "Mate", participants: [ME, MATE], requestId: "req-1", date: "2026-10-12", status: "answered", claimedBy: "device-1",
    })
    expect(c.lists[0][0].createdAt).toBe(Date.parse("2026-10-12T04:00:00Z"))
    expect(c.lists[0][0].respondedAt).toBe(Date.parse("2026-10-12T05:00:00Z"))
    expect(c.states).toEqual([false, true])
    off()
  })

  it("delivers only when the list CHANGED; an unchanged poll costs the app nothing", async () => {
    let status = "asking"
    const r = rig(() => [row({ status })])
    const c = collect()
    const off = r.be.pings.watch(ME, c.sub)
    await settle()
    await vi.advanceTimersByTimeAsync(5000)
    expect(c.lists).toHaveLength(1)
    expect(r.reads.length).toBeGreaterThan(3) // it did keep reading
    status = "answered"
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.lists.map((l) => l[0].status)).toEqual(["asking", "answered"])
    off()
  })

  it("never delivers a Ping that does not involve the watching account", async () => {
    const r = rig(() => [row(), row({ id: "ping-9999-zzzz", from_uid: STRANGER, to_uid: MATE })])
    const c = collect()
    const off = r.be.pings.watch(ME, c.sub)
    await settle()
    expect(c.lists[0].map((p) => p.id)).toEqual(["ping-0001-aaaa"])
    off()
  })

  it("two watchers of one account share one poller, and the second starts from the current list", async () => {
    const r = rig(() => [row()])
    const c1 = collect()
    const c2 = collect()
    const off1 = r.be.pings.watch(ME, c1.sub)
    await settle()
    const readsAfterFirst = r.reads.length
    const off2 = r.be.pings.watch(ME, c2.sub)
    expect(c2.lists).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.reads.length - readsAfterFirst).toBe(1) // one read per tick, not two
    off1()
    await vi.advanceTimersByTimeAsync(1000)
    expect(r.reads.length - readsAfterFirst).toBe(2) // still polling for the remaining watcher
    off2()
    expect(vi.getTimerCount()).toBe(0)
    const n = r.reads.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(r.reads.length).toBe(n)
  })

  it("an unreachable store keeps the last list, reports not-live, recovers on its own, and never throws", async () => {
    let status = "asking"
    const r = rig(() => [row({ status })])
    const c = collect()
    const off = r.be.pings.watch(ME, c.sub)
    await settle()
    r.setFail(true)
    status = "answered"
    await vi.advanceTimersByTimeAsync(3000)
    expect(c.states.at(-1)).toBe(false)
    expect(c.lists).toHaveLength(1)
    r.setFail(false)
    await vi.advanceTimersByTimeAsync(1000)
    expect(c.states.at(-1)).toBe(true)
    expect(c.lists.at(-1)![0].status).toBe("answered")
    off()
  })

  it("account switch: a different account gets its own poller; the old one stops when its watcher leaves", async () => {
    const rowsFor = { [ME]: [row()], [MATE]: [row({ id: "ping-0002-bbbb", from_uid: MATE, to_uid: STRANGER })] } as Record<string, Record<string, unknown>[]>
    let who = ME
    const r = rig(() => rowsFor[who])
    const a = collect()
    const offA = r.be.pings.watch(ME, a.sub)
    await settle()
    offA()
    who = MATE
    const b = collect()
    const offB = r.be.pings.watch(MATE, b.sub)
    await settle()
    expect(a.lists.flat().map((p) => p.id)).toEqual(["ping-0001-aaaa"])
    expect(b.lists.flat().map((p) => p.id)).toEqual(["ping-0002-bbbb"])
    offB()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("connections are watched the same way", async () => {
    const r = rig(() => [{ id: "c1", from_uid: ME, to_uid: MATE, from_name: "Me", to_name: "Mate", status: "accepted", created_at: "2026-10-01T00:00:00Z", responded_at: null }])
    const got: string[][] = []
    const off = r.be.connections.watch(ME, { onData: (l) => void got.push(l.map((x) => x.id)) })
    await settle()
    expect(got).toEqual([["c1"]])
    off()
  })

  it("without the option nothing is polled: watch reports not-live exactly as before", () => {
    const be = createSupabaseBackend({})
    const states: boolean[] = []
    const off = be.pings.watch(ME, { onData: vi.fn(), onState: (l) => void states.push(l) })
    expect(states).toEqual([false])
    off()
  })

  it("the generic watcher: a watcher that throws does not stop the others; unsubscribing twice is harmless", async () => {
    const w = createPollWatcher<{ id: string }>({ read: async () => [{ id: "x" }], involves: () => true, pollMs: 1000 })
    const got: number[] = []
    const o1 = w("u", { onData: () => { throw new Error("boom") } })
    const o2 = w("u", { onData: (l) => void got.push(l.length) })
    await settle()
    expect(got).toEqual([1])
    o1()
    o1()
    o2()
    expect(vi.getTimerCount()).toBe(0)
  })

  it("the app turns it on only together with the Realtime flag, inside the supabase branch", () => {
    const idx = fs.readFileSync(path.join(ROOT, "lib/backend/index.ts"), "utf8")
    expect(idx).toMatch(/watchPollMs: realtimeEnabled\(\) \? 5_000 : undefined/)
  })
})
