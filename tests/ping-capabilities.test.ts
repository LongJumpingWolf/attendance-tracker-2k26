import { describe, expect, it } from "vitest"
import { canSendInAppPing, canUseInAppPing } from "@/lib/ping-capabilities"

describe("in-app Ping eligibility", () => {
  it("requires configured Firebase, a ready session, and a non-anonymous Google account", () => {
    expect(canUseInAppPing({ configured: true, ready: true, anonymous: false })).toBe(true)
    expect(canUseInAppPing({ configured: false, ready: true, anonymous: false })).toBe(false)
    expect(canUseInAppPing({ configured: true, ready: false, anonymous: false })).toBe(false)
    expect(canUseInAppPing({ configured: true, ready: true, anonymous: true })).toBe(false)
  })

  it("requires an accepted connection before a direct Ping can be sent", () => {
    expect(canSendInAppPing({ configured: true, ready: true, anonymous: false, connected: true })).toBe(true)
    expect(canSendInAppPing({ configured: true, ready: true, anonymous: false, connected: false })).toBe(false)
    expect(canSendInAppPing({ configured: true, ready: true, anonymous: true, connected: true })).toBe(false)
  })
})
