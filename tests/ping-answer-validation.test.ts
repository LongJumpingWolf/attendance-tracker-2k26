import { describe, expect, it } from "vitest"
import { answerItems } from "@/lib/pings"
import type { PingItem } from "@/lib/types"

const items: PingItem[] = [
  { key: "a", subjectId: "anatomy", name: "Anatomy", answer: null },
  { key: "b", subjectId: "physiology", name: "Physiology", answer: null },
]

describe("Ping answer validation", () => {
  it("rejects a partial answer instead of turning unanswered classes into No", () => {
    expect(answerItems(items, { a: "yes" })).toEqual({ ok: false, missing: ["Physiology"] })
  })
  it("rejects an empty Ping", () => {
    expect(answerItems([], {})).toEqual({ ok: false, missing: ["No classes selected"] })
  })
  it("preserves an explicit yes/no for each class", () => {
    expect(answerItems(items, { a: "yes", b: "no" })).toEqual({ ok: true, items: [
      { ...items[0], answer: "yes" }, { ...items[1], answer: "no" },
    ] })
  })
})
