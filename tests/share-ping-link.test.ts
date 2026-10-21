import { describe, expect, it } from "vitest"
import { shareableAppOrigin, shareablePingOrigin } from "@/lib/share-ping-link"
import { SHARE_PING_TTL_MS } from "@/lib/pings"

describe("shareable Ping link origin", () => {
  it.each([
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://192.168.1.20:3000",
    "http://10.0.0.8:3000",
    "http://172.16.0.5:3000",
    "http://[::1]:3000",
    "https://[fd00::1]",
    "https://[fe80::1]",
    "http://attendance.local:3000",
  ])("refuses local/private origin %s", (origin) => {
    const result = shareablePingOrigin(origin)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/localhost|private network|public HTTPS/i)
  })

  it("accepts a public HTTPS deployment origin and strips any path", () => {
    expect(shareablePingOrigin("https://tracker.example.org/subpath")).toEqual({ ok: true, origin: "https://tracker.example.org" })
  })

  it("rejects a public non-HTTPS origin", () => {
    const result = shareablePingOrigin("http://tracker.example.org")
    expect(result.ok).toBe(false)
  })
})


describe("configured public app origin", () => {
  it("uses a public HTTPS origin for local sender previews", () => {
    expect(shareableAppOrigin("http://localhost:3000", "https://attendance-preview.vercel.app")).toEqual({ ok: true, origin: "https://attendance-preview.vercel.app" })
  })

  it("still refuses a private configured origin", () => {
    expect(shareableAppOrigin("http://localhost:3000", "http://192.168.1.4:3000").ok).toBe(false)
  })

  it("uses the current public HTTPS origin when no override is configured", () => {
    expect(shareableAppOrigin("https://attendance.example.com")).toEqual({ ok: true, origin: "https://attendance.example.com" })
  })
})


describe("one-day share-link lifetime", () => {
  it("is exactly 24 hours", () => {
    expect(SHARE_PING_TTL_MS).toBe(24 * 60 * 60 * 1000)
  })
})
