/**
 * Backend selection: Firebase is the default and stays the default; an invalid setting fails closed; Supabase can only be
 * reached through the one selector. Also a static check that Firestore is only touched inside the adapter.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)

import { getBackend, resolveBackendKind, setBackendForTests } from "@/lib/backend"
import { BackendError } from "@/lib/backend/errors"

afterEach(() => {
  vi.unstubAllEnvs()
  setBackendForTests(null)
})

describe("which backend is selected", () => {
  it("defaults to firebase when nothing is set (no Supabase credentials are needed or consulted)", () => {
    expect(resolveBackendKind(undefined)).toBe("firebase")
    expect(resolveBackendKind("")).toBe("firebase")
    expect(resolveBackendKind("  ")).toBe("firebase")
    expect(getBackend().kind).toBe("firebase")
  })

  it("firebase stays firebase even when Supabase variables are present", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.invalid")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "not-a-real-key")
    expect(getBackend().kind).toBe("firebase")
  })

  it("accepts the two supported modes, ignoring case and spaces", () => {
    expect(resolveBackendKind("firebase")).toBe("firebase")
    expect(resolveBackendKind("Supabase")).toBe("supabase")
    expect(resolveBackendKind(" SUPABASE ")).toBe("supabase")
  })

  it("an unknown value fails closed with an explicit error, never a silent fallback", () => {
    for (const bad of ["supabse", "both", "true", "1"]) {
      expect(() => resolveBackendKind(bad)).toThrow(BackendError)
      expect(() => resolveBackendKind(bad)).toThrow(/Unknown backend/)
    }
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabse")
    expect(() => getBackend()).toThrow(/Unknown backend/)
  })

  it("selecting supabase yields the inactive skeleton: every call is refused, nothing is sent", async () => {
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase")
    const be = getBackend()
    expect(be.kind).toBe("supabase")
    await expect(be.sync.get("owner")).rejects.toMatchObject({ code: "supabase-not-configured" })
    await expect(be.pings.create({ id: "ping-AB-00000001", from: { uid: "a", name: "A" }, to: { uid: "b", name: "B" }, date: "2026-10-06", items: [], requestId: "r" })).rejects.toMatchObject({ kind: "unauthorized" })
  })

  it("is memoised per kind and follows a change of setting", () => {
    const first = getBackend()
    expect(getBackend()).toBe(first)
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase")
    expect(getBackend()).not.toBe(first)
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "firebase")
    expect(getBackend().kind).toBe("firebase")
  })

  it("a test can install a backend and remove it again", () => {
    const first = getBackend()
    const stub = { ...first, kind: "supabase" as const }
    setBackendForTests(stub)
    expect(getBackend()).toBe(stub)
    setBackendForTests(null)
    expect(getBackend().kind).toBe("firebase")
  })
})

describe("the architecture holds: UI/domain -> repository -> adapter", () => {
  const ROOT = path.resolve(import.meta.dirname, "..")
  const files = (dir: string): string[] =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.posix.join(dir, e.name)
      return e.isDirectory() ? files(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : []
    })
  const all = ["app", "components", "hooks", "lib"].flatMap(files)
  const text = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8")

  it("runtime Firestore imports stay in the adapter, bootstrap, and Firebase-only integrations", () => {
    const re = /import\s+(type\s+)?(?:\{[^}]*\}|\*\s+as\s+\w+|\w+)\s+from\s+["']firebase\/firestore["']/g
    const runtime = all.filter((f) => [...text(f).matchAll(re)].some((m) => !m[1]))
    expect(runtime.sort()).toEqual([
      "components/feedback-reply-watcher.tsx",
      "components/share-ping-page.tsx",
      "lib/backend/firebase/index.ts",
      "lib/feedback.ts",
      "lib/firebase.ts",
      "lib/use-social.ts",
    ])
  })

  it("no application file refers to a Firestore collection path", () => {
    const hits = all
      .filter((f) => !f.startsWith("lib/backend/"))
      .filter((f) => /\b(?:collection|doc)\(\s*\w+\s*,\s*["'](?:users|invites|requests|pings|pushTokens|syncs)["']/.test(text(f)))
    expect(hits).toEqual([])
  })

  it("the contracts import no backend library at all", () => {
    for (const f of ["lib/backend/contracts.ts", "lib/backend/errors.ts"]) expect(text(f), f).not.toMatch(/from\s+["'](?:firebase|@supabase)/)
  })

  it("no file outside lib/backend imports the Supabase adapter or any Supabase package", () => {
    const hits = all.filter((f) => !f.startsWith("lib/backend/")).filter((f) => /from\s+["'][^"']*(?:backend\/supabase|@supabase\/)/.test(text(f)))
    expect(hits).toEqual([])
  })

  it("the backend setting is read in exactly one place, and nothing branches on the backend kind elsewhere", () => {
    const readers = all.filter((f) => /NEXT_PUBLIC_BACKEND/.test(text(f)))
    expect(readers).toEqual(["lib/backend/index.ts"])
    const branching = all.filter((f) => !f.startsWith("lib/backend/")).filter((f) => /\.kind\s*[=!]==?\s*["'](?:firebase|supabase)["']|backend.*===\s*["']supabase["']/.test(text(f)))
    expect(branching).toEqual([])
  })

  it("the hook that owns sync still imports only the same five names, so its orchestration is untouched", () => {
    expect(text("hooks/use-cloud-sync.ts")).toMatch(/import \{ cloudGet, cloudKind, cloudPut, watchCloud, type CloudDoc \} from "@\/lib\/cloud-sync"/)
  })
})
