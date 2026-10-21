import { describe, expect, it } from "vitest"
import { describeSocialAuthError } from "@/lib/social-auth-errors"

describe("localhost social-auth diagnostics", () => {
  it("explains when anonymous sign-in is disabled", () => {
    expect(describeSocialAuthError({ code: "auth/operation-not-allowed", message: "operation not allowed" })).toContain("Anonymous sign-in is disabled")
  })

  it("directs an invalid API key to the matching local project configuration", () => {
    expect(describeSocialAuthError({ code: "auth/api-key-not-valid", message: "bad key" })).toContain("API key and project ID")
  })

  it("explains that localhost must be an authorized Firebase domain", () => {
    expect(describeSocialAuthError({ code: "auth/unauthorized-domain", message: "unauthorized" })).toContain("localhost")
  })

  it("explains emulator and environment checks after a sign-in timeout", () => {
    expect(describeSocialAuthError(new Error("Firebase sign-in timed out"))).toContain("NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST")
  })
})
