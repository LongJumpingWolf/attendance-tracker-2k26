import { describe, expect, it } from "vitest"
import { isPushServiceUnavailable, pushSetupMessage, resolveFirebaseVapidKey } from "@/lib/push-config"

describe("Firebase Web Push configuration", () => {
  it("prefers the documented key and accepts the legacy env name", () => {
    expect(resolveFirebaseVapidKey("  primary  ", "legacy")).toBe("primary")
    expect(resolveFirebaseVapidKey("", " legacy ")).toBe("legacy")
    expect(resolveFirebaseVapidKey(undefined, "legacy")).toBe("legacy")
  })

  it("returns null rather than passing an empty VAPID key to Firebase", () => {
    expect(resolveFirebaseVapidKey(undefined, undefined)).toBeNull()
    expect(resolveFirebaseVapidKey("  ", " ")).toBeNull()
  })

  it("classifies the push-service AbortError as a recoverable optional failure", () => {
    const error = Object.assign(new Error("Registration failed - push service error"), { name: "AbortError" })
    expect(isPushServiceUnavailable(error)).toBe(true)
    expect(pushSetupMessage(error)).toMatch(/could not register for alerts after the app closes/i)
    expect(pushSetupMessage(error)).toMatch(/local reminders while College Tracker is open/i)
    expect(pushSetupMessage(error)).toMatch(/enable Google services for push messaging/i)
    expect(pushSetupMessage(error)).toMatch(/fully restart the browser/i)
  })

  it("does not classify unrelated permission/API errors as a push-service outage", () => {
    expect(isPushServiceUnavailable(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }))).toBe(false)
    const other = pushSetupMessage(Object.assign(new Error("bad VAPID"), { code: "messaging/invalid-vapid-key" }))
    expect(other).toMatch(/Background alert setup could not be completed on this device/i)
    expect(other).not.toMatch(/brave|Google services/i)
  })
})
