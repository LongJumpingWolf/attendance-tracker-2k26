import { describe, expect, it } from "vitest"

describe("security headers", () => {
  it("every page gets the headers that close doors without touching the app's own scripts", async () => {
    const config = (await import("../next.config.mjs")).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }
    const rules = await config.headers()
    const all = rules.find((r) => r.source === "/:path*")
    expect(all).toBeTruthy()
    const h = Object.fromEntries(all!.headers.map((x) => [x.key, x.value]))
    expect(h["X-Content-Type-Options"]).toBe("nosniff")
    expect(h["X-Frame-Options"]).toBe("DENY")
    expect(h["Referrer-Policy"]).toBe("strict-origin-when-cross-origin")
    expect(h["Content-Security-Policy"]).toContain("frame-ancestors 'none'")
    expect(h["Content-Security-Policy"]).toContain("object-src 'none'")
    // nothing here may restrict where scripts, styles, images or connections come from: that could break the app untested
    expect(h["Content-Security-Policy"]).not.toMatch(/script-src|default-src|connect-src|style-src|img-src/)
  })

  it("the service worker keeps its own headers", async () => {
    const config = (await import("../next.config.mjs")).default as { headers: () => Promise<{ source: string; headers: { key: string; value: string }[] }[]> }
    const sw = (await config.headers()).find((r) => r.source === "/sw.js")
    expect(sw?.headers.map((x) => x.key)).toEqual(expect.arrayContaining(["Content-Type", "Cache-Control", "Service-Worker-Allowed"]))
  })
})
