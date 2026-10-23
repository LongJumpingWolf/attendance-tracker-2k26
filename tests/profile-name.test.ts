import { describe, expect, it } from "vitest"
import { placeholderName, resolveProfileName } from "@/lib/profile-name"

const UID = "abcdefgh12345678"
const found = (name: string | null) => async () => name

describe("which name a signed-in account uses on a device", () => {
  it("keeps the name saved on this device", async () => {
    expect(await resolveProfileName(UID, "Aditya", null, found("Other"))).toEqual({ name: "Aditya", publish: true })
  })

  it("a new browser takes the name from the account's profile, not a generated Mate- label", async () => {
    expect(await resolveProfileName(UID, "", "Google Name", found("Aditya"))).toEqual({ name: "Aditya", publish: true })
  })

  it("falls back to the signed-in account's name when the profile only holds the placeholder", async () => {
    expect(await resolveProfileName(UID, "", "Aditya", found(placeholderName(UID)))).toEqual({ name: "Aditya", publish: true })
  })

  it("uses the placeholder only for an account that has never had a name", async () => {
    expect(await resolveProfileName(UID, "", null, found(null))).toEqual({ name: placeholderName(UID), publish: true })
  })

  it("does not publish a placeholder over a name it could not read", async () => {
    const offline = async () => { throw new Error("offline") }
    expect(await resolveProfileName(UID, "", null, offline)).toEqual({ name: placeholderName(UID), publish: false })
  })
})
