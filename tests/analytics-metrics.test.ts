import { describe, expect, it } from "vitest"
import { eventCoverage, localDayKey, median, startOfLocalWeek, windowIsIncomplete } from "@/lib/analytics-metrics"

describe("median", () => {
  it("is the middle value for an odd count and the average of the two middle values for an even count", () => {
    expect(median([5])).toBe(5)
    expect(median([1, 2, 9])).toBe(2)
    expect(median([1, 2, 3, 10])).toBe(2.5) // it used to report 3, the upper middle
    expect(median([10, 20])).toBe(15)
  })

  it("is null when there is nothing to measure", () => {
    expect(median([])).toBeNull()
  })
})

describe("days and weeks follow the local calendar", () => {
  it("a day key is the local date, not the UTC one", () => {
    const lateEvening = new Date(2026, 9, 24, 23, 30).getTime() // 24 Oct, 23:30 local
    const justAfterMidnight = new Date(2026, 9, 25, 0, 30).getTime()
    expect(localDayKey(lateEvening)).toBe("2026-10-24")
    expect(localDayKey(justAfterMidnight)).toBe("2026-10-25")
  })

  it("two visits an hour apart across local midnight are on two different days", () => {
    expect(localDayKey(new Date(2026, 9, 24, 23, 45).getTime())).not.toBe(localDayKey(new Date(2026, 9, 25, 0, 15).getTime()))
  })

  it("a week starts on Monday at local midnight", () => {
    const sunday = new Date(2026, 9, 25, 10, 0).getTime() // Sunday 25 Oct 2026
    const monday = new Date(2026, 9, 26, 0, 30).getTime()
    expect(new Date(startOfLocalWeek(sunday)).getDay()).toBe(1)
    expect(localDayKey(startOfLocalWeek(sunday))).toBe("2026-10-19")
    expect(localDayKey(startOfLocalWeek(monday))).toBe("2026-10-26")
    expect(new Date(startOfLocalWeek(monday)).getHours()).toBe(0)
  })
})

describe("what the loaded events can speak for", () => {
  const t = (day: number) => new Date(2026, 9, day).getTime()

  it("is complete when nothing was cut off", () => {
    expect(eventCoverage([t(1), t(2)], false)).toEqual({ truncated: false, completeSinceMs: null })
    expect(eventCoverage([], true)).toEqual({ truncated: false, completeSinceMs: null })
  })

  it("is complete only since the oldest loaded event when the newest N were loaded", () => {
    const cover = eventCoverage([t(20), t(10), t(15)], true)
    expect(cover).toEqual({ truncated: true, completeSinceMs: t(10) })
    expect(windowIsIncomplete(cover, t(5))).toBe(true) // a window reaching back before the oldest loaded event
    expect(windowIsIncomplete(cover, t(12))).toBe(false)
    expect(windowIsIncomplete({ truncated: false, completeSinceMs: null }, t(1))).toBe(false)
  })
})

import { buildLinkRows, computeLinkMetrics, computeUsageCore, uniqueUsersWithin } from "@/lib/analytics-metrics"
import type { ProductLinkEvent } from "@/lib/link-analytics"
import type { ProductUsageEvent } from "@/lib/usage-analytics"

const MIN = 60_000
const at = (day: number, hour = 12, minute = 0) => new Date(2026, 9, day, hour, minute)
const link = (kind: ProductLinkEvent["kind"], linkId: string, when: Date, o: Partial<ProductLinkEvent> = {}): ProductLinkEvent => ({
  id: `${kind}-${linkId}-${when.getTime()}-${Math.random()}`, source: "share-ping", linkId, kind, ownerUid: "alice", fromName: "Alice", recipientName: "Bob", createdAt: when, ...o,
})

describe("link numbers, worked out by hand", () => {
  // Four WhatsApp Pings from Alice and Cara, one Mate invite from Alice:
  //  p1 created 12:00, opened twice (12:05, 12:06), answered 12:30  -> 30 minutes to complete
  //  p2 created 12:00, opened once, never answered
  //  p3 created 12:00, never opened
  //  p4 (Cara) created 12:00, opened, answered 14:00                -> 120 minutes
  //  i1 invite created 12:00, opened, used 12:10                    -> 10 minutes
  const scope = [
    link("created", "p1", at(20, 12, 0)), link("opened", "p1", at(20, 12, 5)), link("opened", "p1", at(20, 12, 6)), link("answered", "p1", at(20, 12, 30)),
    link("created", "p2", at(20, 12, 0)), link("opened", "p2", at(20, 13, 0)),
    link("created", "p3", at(20, 12, 0)),
    link("created", "p4", at(20, 12, 0), { ownerUid: "cara", fromName: "Cara" }), link("opened", "p4", at(20, 12, 20), { ownerUid: "cara", fromName: "Cara" }), link("answered", "p4", at(20, 14, 0), { ownerUid: "cara", fromName: "Cara" }),
    link("created", "i1", at(20, 12, 0), { source: "mate-invite" }), link("opened", "i1", at(20, 12, 3), { source: "mate-invite" }), link("used", "i1", at(20, 12, 10), { source: "mate-invite" }),
  ]
  const rows = buildLinkRows(scope)
  const m = computeLinkMetrics(rows, scope)

  it("counts each link once, however many events it has", () => {
    expect(rows).toHaveLength(5)
    expect(rows.find((r) => r.linkId === "p1")).toMatchObject({ created: true, opens: 2, answered: true, used: false })
  })

  it("counts links, opens and completions", () => {
    expect(m).toMatchObject({ created: 5, invites: 1, pings: 4, used: 1, answered: 2, opens: 5, openedLinks: 4, eventCount: 13 })
    expect(m.avgOpens).toBeCloseTo(5 / 4)
  })

  it("rates are of the links created", () => {
    expect(m.pingOpenRate).toBe("75%") // p1, p2, p4 of 4
    expect(m.pingAnswerRate).toBe("50%") // p1 and p4 of 4
    expect(m.inviteOpenRate).toBe("100%")
    expect(m.inviteUseRate).toBe("100%")
    expect(m.overallOpenRate).toBe("80%") // 4 of 5
    expect(m.overallCompletionRate).toBe("60%") // p1, p4, i1 of 5
  })

  it("times to completion: average and median of 30, 120 and 10 minutes", () => {
    expect(m.averageCompletionMs).toBeCloseTo(((30 + 120 + 10) / 3) * MIN)
    expect(m.medianCompletionMs).toBe(30 * MIN) // the middle of 10, 30, 120
  })

  it("senders: Alice made 4 links (3 pings and the invite), Cara 1; two senders, one repeat", () => {
    expect(m.sharers).toBe(2)
    expect(m.repeatSharers).toBe(1)
    expect(m.senders[0]).toMatchObject({ name: "Alice", links: 4, completed: 2, opens: 4 })
    expect(m.senders[1]).toMatchObject({ name: "Cara", links: 1, completed: 1, opens: 1 })
  })

  it("has no rates to give when there are no links", () => {
    const empty = computeLinkMetrics(buildLinkRows([]), [])
    expect(empty).toMatchObject({ created: 0, pingOpenRate: "—", overallCompletionRate: "—", averageCompletionMs: null, medianCompletionMs: null })
  })

  it("an answer or open whose link was created before the window is counted as an event, but not in the link funnel", () => {
    const partial = [link("opened", "old", at(20, 9)), link("answered", "old", at(20, 10)), link("created", "new", at(20, 11))]
    const pm = computeLinkMetrics(buildLinkRows(partial), partial)
    expect(pm.created).toBe(1)
    expect(pm.opens).toBe(1)
    expect(pm.answered).toBe(0)
  })
})

describe("usage numbers, worked out by hand", () => {
  const ev = (actorUid: string, sessionId: string, event: ProductUsageEvent["event"], when: Date): ProductUsageEvent => ({
    id: Math.random().toString(16).slice(2).padEnd(32, "0"), actorUid, sessionId, event, screen: "today", createdAt: when,
  })
  const now = at(24, 12).getTime()
  const events = [
    ev("u1", "s1", "app_open", at(24, 9)), ev("u1", "s1", "attendance_mark", at(24, 9, 5)),
    ev("u1", "s2", "app_open", at(23, 23, 30)), // u1 again, 23:30 the night before (a different local day)
    ev("u2", "s3", "app_open", at(22, 10)), ev("u2", "s3", "attendance_mark", at(22, 10, 1)),
    ev("u3", "s4", "app_open", at(10, 10)), // 14 days ago
    ev("u3", "s4", "attendance_mark", at(10, 10, 2)),
  ]

  it("daily, weekly and monthly active people are the distinct people in each window", () => {
    expect(uniqueUsersWithin(events, 24 * 60 * MIN, now)).toBe(1) // u1 only (24 Oct 09:00; 23 Oct 23:30 is 12.5 h ago, so also u1)
    expect(uniqueUsersWithin(events, 7 * 24 * 60 * MIN, now)).toBe(2) // u1, u2
    expect(uniqueUsersWithin(events, 30 * 24 * 60 * MIN, now)).toBe(3)
  })

  it("people, sessions and repeat visitors in a window", () => {
    const core = computeUsageCore(events)
    expect(core.activeUsers).toBe(3)
    expect(core.sessions).toBe(4)
    expect(core.repeatUsers).toBe(1) // u1 on two local days; u2 and u3 each on one
    expect(core.counts.get("app_open")).toBe(4)
    expect(core.counts.get("attendance_mark")).toBe(3)
  })

  it("an event after the moment of counting is not counted (clock skew), and an empty window is all zeros", () => {
    expect(uniqueUsersWithin([ev("u9", "s9", "app_open", at(25, 12))], 24 * 60 * MIN, now)).toBe(0)
    expect(computeUsageCore([])).toMatchObject({ activeUsers: 0, sessions: 0, repeatUsers: 0 })
  })
})

import { computeOptInSplit } from "@/lib/analytics-metrics"

describe("accounts and the analytics choice", () => {
  it("counts the accounts that sent usage events as opted in and the rest of the known accounts as not", () => {
    // five accounts have a profile; two of them (a, b) opted in
    expect(computeOptInSplit(["a", "b", "c", "d", "e"], ["a", "b"])).toEqual({ accounts: 5, optedIn: 2, notOptedIn: 3, optInRate: 40 })
  })

  it("an opted-in account with no profile still counts as an account, and is not counted twice", () => {
    expect(computeOptInSplit(["a", "b"], ["a", "z", "z"])).toEqual({ accounts: 3, optedIn: 2, notOptedIn: 1, optInRate: 67 })
  })

  it("everyone opted in, nobody opted in, and no accounts at all", () => {
    expect(computeOptInSplit(["a", "b"], ["a", "b"])).toMatchObject({ notOptedIn: 0, optInRate: 100 })
    expect(computeOptInSplit(["a", "b"], [])).toMatchObject({ optedIn: 0, notOptedIn: 2, optInRate: 0 })
    expect(computeOptInSplit([], [])).toEqual({ accounts: 0, optedIn: 0, notOptedIn: 0, optInRate: null })
  })
})
