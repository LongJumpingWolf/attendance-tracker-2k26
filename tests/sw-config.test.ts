import { describe, expect, it } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { SHELL_CACHE, SW_URL } from "@/lib/sw-config"

const read = (rel: string) => fs.readFileSync(path.join(__dirname, "..", rel), "utf8")

describe("the service worker's address and cache", () => {
  it("the worker and the app agree on the cache name (otherwise the first-launch copy is saved where the worker never looks)", () => {
    expect(read("public/sw.js")).toContain(`const SHELL = '${SHELL_CACHE}'`)
  })

  it("every place that registers the worker uses the one shared address", () => {
    for (const rel of ["app/page.tsx", "lib/firebase.ts", "lib/notifications.ts", "components/offline-shell.tsx"]) {
      const text = read(rel)
      expect(text, rel).not.toMatch(/register\(\s*["'`]\/sw\.js/)
      expect(text, rel).toContain("SW_URL")
    }
    expect(SW_URL).toBe("/sw.js?v=8")
  })

  it("only the home page is kept as the offline shell, and a scan link works offline", () => {
    const sw = read("public/sw.js")
    expect(sw).toMatch(/path === '\/'\) cache\.put\(PAGE_KEY/)
    expect(sw).toMatch(/path === '\/scan'\) return Response\.redirect/)
  })
})
