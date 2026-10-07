import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  vi.resetModules()
})
afterEach(() => vi.unstubAllGlobals())

const load = () => import("@/lib/ping-id")

describe("one id per logical Ping", () => {
  it("14/15. the same request gets the same id on every retry until the send is confirmed", async () => {
    const { idFor, logicalKey } = await load()
    const key = logicalKey("me", "rahul", "2026-10-06", ["a@09:00", "b@14:00"])
    const first = idFor(key)
    expect(idFor(key)).toBe(first) // a retry after a timeout
    expect(idFor(key)).toBe(first) // a double tap
    expect(first).toMatch(/^[A-Za-z0-9_-]{8,64}$/) // what the server accepts as an id
  })

  it("17. it survives a reload or the browser closing during the send", async () => {
    const a = await load()
    const key = a.logicalKey("me", "rahul", "2026-10-06", ["a@09:00"])
    const before = a.idFor(key)
    vi.resetModules() // the page reloads: nothing but localStorage is left
    const b = await load()
    expect(b.idFor(key)).toBe(before)
  })

  it("the order the classes were picked in doesn't matter", async () => {
    const { logicalKey } = await load()
    expect(logicalKey("me", "r", "d", ["a", "b"])).toBe(logicalKey("me", "r", "d", ["b", "a"]))
  })

  it("a different request is a different Ping", async () => {
    const { idFor, logicalKey } = await load()
    const a = idFor(logicalKey("me", "rahul", "2026-10-06", ["a"]))
    expect(idFor(logicalKey("me", "rahul", "2026-10-06", ["a", "b"]))).not.toBe(a)
    expect(idFor(logicalKey("me", "rahul", "2026-10-07", ["a"]))).not.toBe(a)
    expect(idFor(logicalKey("me", "neha", "2026-10-06", ["a"]))).not.toBe(a)
  })

  it("once the send is confirmed, asking again is a new Ping", async () => {
    const { idFor, forget, logicalKey } = await load()
    const key = logicalKey("me", "rahul", "2026-10-06", ["a"])
    const first = idFor(key)
    forget(key)
    expect(idFor(key)).not.toBe(first)
  })

  it("an old unconfirmed id is not kept forever", async () => {
    const { idFor, logicalKey } = await load()
    const key = logicalKey("me", "rahul", "2026-10-06", ["a"])
    const first = idFor(key, 1_000)
    expect(idFor(key, 1_000 + 3_600_000)).toBe(first) // an hour later: same
    vi.resetModules()
    const fresh = await load()
    expect(fresh.idFor(key, 1_000 + 25 * 3_600_000)).not.toBe(first) // a day later: a new request
  })

  it("works when storage is blocked: still stable within the visit", async () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked") }, setItem: () => { throw new Error("blocked") }, removeItem: () => {} })
    const { idFor, logicalKey } = await load()
    const key = logicalKey("me", "rahul", "d", ["a"])
    expect(idFor(key)).toBe(idFor(key))
  })
})
