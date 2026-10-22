import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readMateAlias, writeMateAlias } from "@/lib/mate-aliases"

let values: Map<string, string>

beforeEach(() => {
  values = new Map()
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("private per-user Mate aliases", () => {
  it("trims and normalizes whitespace before saving", () => {
    expect(writeMateAlias("owner-a", "mate-1", "  Aditya   from   anatomy  ")).toBe(true)
    expect(readMateAlias("owner-a", "mate-1")).toBe("Aditya from anatomy")
  })

  it("keeps aliases isolated by the local user's account", () => {
    writeMateAlias("owner-a", "mate-1", "My lab partner")
    expect(readMateAlias("owner-a", "mate-1")).toBe("My lab partner")
    expect(readMateAlias("owner-b", "mate-1")).toBeUndefined()
  })

  it("bounds aliases to 48 characters and rejects blank or missing identities", () => {
    expect(writeMateAlias("owner-a", "mate-1", "x".repeat(70))).toBe(true)
    expect(readMateAlias("owner-a", "mate-1")).toBe("x".repeat(48))
    expect(writeMateAlias("owner-a", "mate-2", "   ")).toBe(false)
    expect(writeMateAlias("", "mate-2", "A mate")).toBe(false)
    expect(writeMateAlias("owner-a", "", "A mate")).toBe(false)
  })

  it("ignores corrupt local storage instead of breaking the Mates screen", () => {
    values.set("mateAliases:owner-a", "{")
    expect(readMateAlias("owner-a", "mate-1")).toBeUndefined()
    expect(writeMateAlias("owner-a", "mate-1", "New label")).toBe(true)
    expect(readMateAlias("owner-a", "mate-1")).toBe("New label")
  })
})
