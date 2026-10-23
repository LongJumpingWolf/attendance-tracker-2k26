import { describe, expect, it, vi } from "vitest"

const { makeHandlers, pushAllowance, PUSH_LIMIT, PUSH_WINDOW_MS } = require("../functions/ping-handlers.js") as {
  makeHandlers: (d: {
    getToken: (uid: string) => Promise<string | null>
    deleteToken: (uid: string) => Promise<void>
    send: (m: Record<string, unknown>) => Promise<void>
    allowPush?: (from: string, to: string) => Promise<boolean>
    log?: { error: (...a: unknown[]) => void }
  }) => { onCreated: (p: Record<string, unknown>, id: string) => Promise<string> }
  pushAllowance: (stored: { start: number; count: number } | null, now: number) => { allowed: boolean; next: { start: number; count: number } }
  PUSH_LIMIT: number
  PUSH_WINDOW_MS: number
}

describe("how many notifications one person can send another", () => {
  it("allows a few, then holds the rest back until the window passes", () => {
    let stored: { start: number; count: number } | null = null
    const results: boolean[] = []
    for (let n = 0; n < PUSH_LIMIT + 3; n++) {
      const r = pushAllowance(stored, 1_000 + n)
      results.push(r.allowed)
      stored = r.next
    }
    expect(results.slice(0, PUSH_LIMIT).every(Boolean)).toBe(true)
    expect(results.slice(PUSH_LIMIT)).toEqual([false, false, false])
  })

  it("starts counting again once the window has passed", () => {
    const full = { start: 1_000, count: PUSH_LIMIT }
    expect(pushAllowance(full, 1_000 + PUSH_WINDOW_MS - 1).allowed).toBe(false)
    expect(pushAllowance(full, 1_000 + PUSH_WINDOW_MS)).toEqual({ allowed: true, next: { start: 1_000 + PUSH_WINDOW_MS, count: 1 } })
  })

  it("does not count a held-back one, so the window still ends on time", () => {
    const full = { start: 1_000, count: PUSH_LIMIT }
    expect(pushAllowance(full, 2_000).next).toEqual({ start: 1_000, count: PUSH_LIMIT })
  })

  it("treats missing or damaged stored counts as a fresh start", () => {
    expect(pushAllowance(null, 5).allowed).toBe(true)
    expect(pushAllowance({ start: "x", count: 99 } as never, 5).allowed).toBe(true)
  })
})

describe("the new-Ping handler with the limit", () => {
  const ping = { from: "asha", to: "rahul", fromName: "Asha", toName: "Rahul", status: "asking", items: [] }
  const make = (allowPush?: (f: string, t: string) => Promise<boolean>) => {
    const send = vi.fn(async () => {})
    const errors: unknown[][] = []
    const h = makeHandlers({ getToken: async () => "tok", deleteToken: async () => {}, send, allowPush, log: { error: (...a) => void errors.push(a) } })
    return { h, send, errors }
  }

  it("sends the notification when allowed, and not when held back (the Ping itself is untouched either way)", async () => {
    const allowed = make(async () => true)
    expect(await allowed.h.onCreated(ping, "p1")).toBe("sent")
    const held = make(async () => false)
    expect(await held.h.onCreated(ping, "p2")).toBe("throttled")
    expect(held.send).not.toHaveBeenCalled()
  })

  it("asks about this sender and this recipient", async () => {
    const asked: string[] = []
    const { h } = make(async (f, t) => (asked.push(`${f}>${t}`), true))
    await h.onCreated(ping, "p1")
    expect(asked).toEqual(["asha>rahul"])
  })

  it("a counter that breaks never silences real Pings", async () => {
    const { h, send, errors } = make(async () => {
      throw new Error("firestore down")
    })
    expect(await h.onCreated(ping, "p1")).toBe("sent")
    expect(send).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(1)
  })

  it("works exactly as before with no limit configured", async () => {
    const { h } = make()
    expect(await h.onCreated(ping, "p1")).toBe("sent")
    expect(await h.onCreated({ ...ping, status: "answered" }, "p1")).toBe("ignored")
  })
})
