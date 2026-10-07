import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resilient } from "@/lib/realtime"
import { pack, unpack } from "@/lib/cloud-sync"
import { buildBackup, parseFullBackup } from "@/lib/backup"

describe("realtime fails gracefully", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("restarts a dead listener with a growing delay and reports live again", () => {
    const starts: Array<{ ok: () => void; fail: (e: unknown) => void }> = []
    const states: boolean[] = []
    const off = resilient((h) => {
      starts.push(h)
      return () => {}
    }, (live) => states.push(live))
    expect(starts).toHaveLength(1)
    starts[0].fail(new Error("network"))
    expect(states).toEqual([false])
    vi.advanceTimersByTime(3000)
    expect(starts).toHaveLength(2) // retried after 3s
    starts[1].fail(new Error("network"))
    vi.advanceTimersByTime(3000)
    expect(starts).toHaveLength(2) // second wait is longer (6s)
    vi.advanceTimersByTime(3000)
    expect(starts).toHaveLength(3)
    starts[2].ok()
    expect(states.at(-1)).toBe(true)
    off()
  })

  it("does not loop on errors that retrying can't fix, and stops when asked", () => {
    let n = 0
    const off = resilient((h) => {
      n++
      h.fail({ code: "permission-denied" })
      return () => {}
    })
    vi.advanceTimersByTime(600_000)
    expect(n).toBe(1)
    off()
    const c = vi.fn()
    const off2 = resilient((h) => {
      setTimeout(() => h.fail(new Error("x")), 1)
      return c
    })
    off2()
    vi.advanceTimersByTime(600_000)
    expect(c).toHaveBeenCalled()
  })
})

describe("stored payload", () => {
  const big = Array.from({ length: 3650 }, (_, i) => ({ d: `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, s: "P" as const, t: `${8 + (i % 10)}:00`, k: "Lecture" }))
  const text = buildBackup(
    { subjects: [{ id: "s", name: "DBMS", attended: 3650, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: big }], tasks: [], tags: [], mates: [], reminders: [] },
    false,
  )

  it("round-trips and is far smaller than the plain text", async () => {
    const packed = await pack(text)
    expect(packed.length).toBeLessThan(text.length / 5)
    expect(await unpack(packed)).toBe(text)
    expect(parseFullBackup(await unpack(packed)).ok).toBe(true)
  })

  it("still reads data that was stored uncompressed by earlier versions", async () => {
    expect(await unpack(text)).toBe(text)
  })
})
