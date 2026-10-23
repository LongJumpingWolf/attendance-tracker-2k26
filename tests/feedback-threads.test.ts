import { describe, expect, it } from "vitest"
import { FIX_CHECK_IN_AFTER_MS, buildThread, byActivity, devReplies, fixCheckInDue, isFirstReplyUnseen, isFollowUpUnseen, ticketState, ticketTitle, type TicketLike } from "@/lib/feedback-threads"

const DAY = 86_400_000
const t = (o: Partial<TicketLike> = {}): TicketLike => ({ kind: "bug", message: "It breaks", rating: null, status: "open", seenByUser: false, createdAt: 1_000, ...o })

describe("how many times the developer has answered", () => {
  it("counts older tickets that have a reply as one", () => {
    expect(devReplies(t())).toBe(0)
    expect(devReplies(t({ developerReply: "Fixed" }))).toBe(1)
    expect(devReplies(t({ developerReply: "  " }))).toBe(0)
    expect(devReplies(t({ developerReply: "Fixed", devReplyCount: 3 }))).toBe(3)
  })
})

describe("what gets the person's attention", () => {
  it("the first answer is the full-screen thank-you, once, until it is opened", () => {
    const first = t({ developerReply: "On it", devReplyCount: 1, status: "replied", seenByUser: false })
    expect(isFirstReplyUnseen(first)).toBe(true)
    expect(isFollowUpUnseen(first)).toBe(false)
    expect(isFirstReplyUnseen({ ...first, seenByUser: true })).toBe(false)
  })

  it("an older ticket's reply counts as a first answer, not a follow-up", () => {
    expect(isFirstReplyUnseen(t({ developerReply: "Thanks", status: "replied", seenByUser: false }))).toBe(true)
  })

  it("a later answer is a red dot, never the full-screen thank-you again", () => {
    const later = t({ developerReply: "On it", devReplyCount: 2, status: "replied", seenByUser: false })
    expect(isFollowUpUnseen(later)).toBe(true)
    expect(isFirstReplyUnseen(later)).toBe(false)
    expect(isFollowUpUnseen({ ...later, seenByUser: true })).toBe(false)
  })
})

describe("the state a ticket shows", () => {
  it("is waiting until answered, replied after, waiting again after the person writes, and closed when closed", () => {
    expect(ticketState(t())).toBe("waiting")
    expect(ticketState(t({ status: "replied", developerReply: "x", lastFrom: "developer" }))).toBe("replied")
    expect(ticketState(t({ status: "open", developerReply: "x", lastFrom: "user" }))).toBe("waiting")
    expect(ticketState(t({ status: "resolved", developerReply: "x" }))).toBe("closed")
  })
})

describe("the conversation", () => {
  it("reads the person's first message, the developer's first reply, then the rest in time order", () => {
    const ticket = t({ developerReply: "On it", createdAt: 1000, repliedAt: 2000 })
    const thread = buildThread(ticket, [
      { id: "b", from: "developer", text: "Fixed", at: 4000 },
      { id: "a", from: "user", text: "Thanks!", at: 3000 },
    ])
    expect(thread.map((m) => `${m.from}:${m.text}`)).toEqual(["user:It breaks", "developer:On it", "user:Thanks!", "developer:Fixed"])
  })

  it("a rating with no note starts empty, so the stars are the whole first message", () => {
    expect(buildThread(t({ kind: "rating", rating: 4, message: "" }), [])).toEqual([])
  })

  it("names a ticket by its first words, or by what it is", () => {
    expect(ticketTitle(t({ message: "x".repeat(100) })).length).toBeLessThanOrEqual(70)
    expect(ticketTitle(t({ kind: "rating", rating: 4, message: "" }))).toBe("Your rating: 4 of 5")
    expect(ticketTitle(t({ kind: "suggestion", message: "" }))).toBe("Feature request")
  })

  it("lists the most recently active first", () => {
    const rows = [t({ createdAt: 1 }), t({ createdAt: 2 }), t({ createdAt: 0, lastMessageAt: 9 })]
    expect(rows.sort(byActivity).map((r) => r.createdAt)).toEqual([0, 2, 1])
  })
})

describe("asking whether the fix worked", () => {
  const answered = t({ developerReply: "Fixed", devReplyCount: 1, status: "resolved", seenByUser: true, lastFrom: "developer", repliedAt: 0 })

  it("waits a day after the person read the reply", () => {
    expect(fixCheckInDue(answered, 1000, 1000 + FIX_CHECK_IN_AFTER_MS - 1)).toBe(false)
    expect(fixCheckInDue(answered, 1000, 1000 + FIX_CHECK_IN_AFTER_MS)).toBe(true)
  })

  it("falls back to when the developer replied if this device never saw it", () => {
    expect(fixCheckInDue({ ...answered, repliedAt: 5 }, null, 5 + DAY)).toBe(true)
  })

  it("asks once, only for bugs that were answered and read, and not while the developer waits on the person", () => {
    const now = 10 * DAY
    expect(fixCheckInDue({ ...answered, fixFeedback: "up" }, 0, now)).toBe(false)
    expect(fixCheckInDue({ ...answered, kind: "suggestion" }, 0, now)).toBe(false)
    expect(fixCheckInDue({ ...answered, developerReply: undefined, devReplyCount: 0 }, 0, now)).toBe(false)
    expect(fixCheckInDue({ ...answered, seenByUser: false }, 0, now)).toBe(false)
    expect(fixCheckInDue({ ...answered, lastFrom: "user" }, 0, now)).toBe(false)
  })
})
