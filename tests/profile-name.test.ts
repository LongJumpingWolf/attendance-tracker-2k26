import { beforeEach, describe, expect, it } from "vitest"
import { clearLiveNames, isPlaceholderName, liveNames, placeholderName, realName, resolveProfileName } from "@/lib/profile-name"

const UID = "abcdefgh12345678"
const found = (name: string | null) => async () => name
const none = async () => ""

describe("the generated Mate- label", () => {
  it("differs for every fresh anonymous account, so it must never be saved or published as a name", () => {
    expect(placeholderName("aaaaaaaa11111111")).not.toBe(placeholderName("bbbbbbbb22222222"))
    expect(isPlaceholderName(placeholderName("aaaaaaaa11111111"))).toBe(true)
    expect(realName("Mate-ABCD1234")).toBe("")
    expect(realName("  Aditya ")).toBe("Aditya")
    expect(realName("Mateo")).toBe("Mateo")
  })
})

describe("which name an account uses on a device", () => {
  it("a signed-in account takes its cloud profile name over a stale one on this device", async () => {
    expect(await resolveProfileName(UID, { local: "Old", lookup: found("Aditya"), recover: none })).toEqual({ name: "Aditya", publish: true })
  })

  it("a new browser takes the name from the profile, not a generated Mate- label", async () => {
    expect(await resolveProfileName(UID, { local: "", authName: "Google Name", lookup: found("Aditya"), recover: none })).toEqual({ name: "Aditya", publish: true })
  })

  it("a placeholder saved by an earlier version is ignored, never carried over", async () => {
    expect(await resolveProfileName(UID, { local: "Mate-OLDANON1", authName: "Aditya", lookup: found(null), recover: none })).toEqual({ name: "Aditya", publish: true })
  })

  it("heals a profile that was overwritten with a placeholder, from the Google name", async () => {
    expect(await resolveProfileName(UID, { local: "", authName: "Aditya", lookup: found("Mate-ZZZZ9999"), recover: none })).toEqual({ name: "Aditya", publish: true })
  })

  it("heals it from the name used in the account's own connection requests when nothing else is left", async () => {
    expect(await resolveProfileName(UID, { local: "", lookup: found("Mate-ZZZZ9999"), recover: async () => "Aditya" })).toEqual({ name: "Aditya", publish: true })
  })

  it("an anonymous account leads with this device's name", async () => {
    expect(await resolveProfileName(UID, { local: "Me", anonymous: true, lookup: found("Other"), recover: none })).toEqual({ name: "Me", publish: true })
  })

  it("the placeholder is only shown, and the account stays unnamed", async () => {
    expect(await resolveProfileName(UID, { local: "", lookup: found(null), recover: none })).toEqual({ name: placeholderName(UID), publish: true })
  })

  it("does not publish a placeholder over a name it could not read", async () => {
    const offline = async () => { throw new Error("offline") }
    expect(await resolveProfileName(UID, { local: "", lookup: offline, recover: none })).toEqual({ name: placeholderName(UID), publish: false })
  })
})

describe("mates' names come from their profile, not the copy in a request", () => {
  beforeEach(() => clearLiveNames())

  it("returns real profile names and leaves out placeholders and unreadable ones", async () => {
    const names: Record<string, string> = { a: "Asha", b: "Mate-QQQQ1111" }
    const lookup = async (uid: string) => { if (uid === "c") throw new Error("denied"); return names[uid] ?? null }
    expect(await liveNames(["a", "b", "c", "a"], lookup)).toEqual({ a: "Asha" })
  })

  it("does not read the same profile again within a few minutes", async () => {
    let reads = 0
    const lookup = async () => { reads++; return "Asha" }
    await liveNames(["a"], lookup, 1000)
    await liveNames(["a"], lookup, 2000)
    expect(reads).toBe(1)
  })
})
