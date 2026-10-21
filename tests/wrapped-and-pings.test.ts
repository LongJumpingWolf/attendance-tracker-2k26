import { describe, expect, it } from "vitest"
import { computeWrapped, lastWeekInfo } from "@/lib/wrapped"
import { isExpired } from "@/lib/pings"
import { localDate } from "@/lib/attendance"
import type { Mate, Ping, Subject } from "@/lib/types"

const subject: Subject = {
  id: "1", name: "DBMS", attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [],
  log: [
    { d: "2026-09-14", s: "P" }, { d: "2026-09-15", s: "P" }, { d: "2026-09-16", s: "P" },
    { d: "2026-09-17", s: "A" }, { d: "2026-09-21", s: "P" },
  ],
}
const mates: Mate[] = [{ id: "a", name: "Arjun", covered: 2, repaid: 0, coveredLog: ["2026-09-15", "2026-09-16"] }]

describe("weekly wrapped", () => {
  it("covers the last finished Monday to Sunday week", () => {
    const monday = new Date(2026, 8, 21)
    expect(lastWeekInfo([subject], monday)).toEqual({ key: "2026-09-14", hasData: true })
    const w = computeWrapped([subject], mates, monday)
    expect(w).toMatchObject({ rangeLabel: "Sep 14 – 20", isCurrent: false, attended: 3, missed: 1, pct: 75, streak: 3 })
    expect(w.coverHero).toEqual({ name: "Arjun", count: 2 })
  })

  it("shows this week so far when last week is empty", () => {
    const sunday = new Date(2026, 8, 20) // last week (Sep 7-13) has nothing
    expect(computeWrapped([subject], mates, sunday).isCurrent).toBe(true)
  })

  it("uses the current Monday-to-Saturday week for the Saturday release", () => {
    const saturday = new Date(2026, 8, 19) // Saturday 19 Sep 2026
    const info = lastWeekInfo([subject], saturday)
    expect(info).toEqual({ key: "2026-09-14", hasData: true })
    const wrapped = computeWrapped([subject], mates, saturday)
    expect(wrapped).toMatchObject({ rangeLabel: "Sep 14 – 19", isCurrent: true, attended: 3, missed: 1 })
  })
})

describe("ping expiry", () => {
  const base: Ping = { id: "p", from: "a", to: "b", fromName: "A", toName: "B", participants: ["a", "b"], date: localDate(), items: [], status: "asking" }
  const daysAgo = (n: number) => localDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - n))
  it("expires unanswered pings after three days, never answered ones", () => {
    expect(isExpired({ ...base, date: daysAgo(2) })).toBe(false)
    expect(isExpired({ ...base, date: daysAgo(4) })).toBe(true)
    expect(isExpired({ ...base, date: daysAgo(10), status: "answered" })).toBe(false)
  })

  it("expires share-link Pings by their explicit 24-hour expiry rather than the direct-Ping 3-day lifetime", () => {
    const now = Date.now()
    expect(isExpired({ ...base, shareLink: true, createdAt: now - 23 * 60 * 60_000, expiresAt: now + 60_000 })).toBe(false)
    expect(isExpired({ ...base, shareLink: true, createdAt: now - 23 * 60 * 60_000, expiresAt: now - 1 })).toBe(true)
    expect(isExpired({ ...base, shareLink: true, status: "answered", expiresAt: now - 1 })).toBe(false)
  })
})
