/**
 * Phase 7 preparation: the real fetch-based Supabase transport, alone and through the adapter. Fakes only: no network, no
 * Supabase, no credentials. Nothing here enables a flag or selects the Supabase backend in production.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)

import { createFetchTransport, safeOrigin } from "@/lib/backend/supabase/transport"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createSupabaseGuard } from "@/lib/backend/supabase/guard"
import { BackendError } from "@/lib/backend/errors"
import { getBackend, setBackendForTests } from "@/lib/backend"

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  setBackendForTests(null)
})
const ROOT = path.resolve(import.meta.dirname, "..")
const URL_ = "https://proj.supabase.test"
const KEY = "sb_publishable_testkey_0123456789"
const TOKEN = "header.payload-part_1234567890.signature_part-1234567890"
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })

function make(responder: (url: string, init: RequestInit) => Response | Promise<Response>, over: { timeoutMs?: number; maxResponseChars?: number } = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchFn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return responder(url, init)
  })
  const t = createFetchTransport({ config: { url: URL_, publishableKey: KEY }, fetch: fetchFn as unknown as typeof fetch, ...over })
  t.setAccessToken?.(TOKEN)
  return { t, calls, fetchFn }
}
const headersOf = (init: RequestInit) => init.headers as Record<string, string>

describe("the URL is validated before anything is built", () => {
  it("accepts https origins and loopback http only", () => {
    expect(safeOrigin("https://proj.supabase.co")).toBe("https://proj.supabase.co")
    expect(safeOrigin("https://proj.supabase.co/")).toBe("https://proj.supabase.co")
    expect(safeOrigin("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321")
    expect(safeOrigin("http://localhost:54321")).toBe("http://localhost:54321")
    for (const bad of ["http://proj.supabase.co", "ftp://x.test", "javascript:alert(1)", "not a url", "", "https://user:pw@proj.supabase.co", "https://proj.supabase.co/rest/v1", "https://proj.supabase.co/?a=1", "https://proj.supabase.co/#x", "http://localhost.evil.test"]) {
      expect(() => safeOrigin(bad), bad).toThrow(BackendError)
    }
  })
  it("refuses a missing or header-injecting publishable key", () => {
    expect(() => createFetchTransport({ config: { url: URL_, publishableKey: "" } })).toThrow(BackendError)
    expect(() => createFetchTransport({ config: { url: URL_, publishableKey: "k\r\nx-evil: 1" } })).toThrow(BackendError)
  })
})

describe("requests", () => {
  it("rpc: POST to the exact path with only the expected headers and the JSON arguments as the body", async () => {
    const { t, calls } = make(() => json(2))
    await t.rpc("sync_put", { p_expected_rev: 1, p_data: "blob", p_updated_at: 5 })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`${URL_}/rest/v1/rpc/sync_put`)
    expect(calls[0].init.method).toBe("POST")
    expect(headersOf(calls[0].init)).toEqual({ apikey: KEY, authorization: `Bearer ${TOKEN}`, accept: "application/json", "content-type": "application/json" })
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ p_expected_rev: 1, p_data: "blob", p_updated_at: 5 })
    expect(calls[0].init.redirect).toBe("error")
  })
  it("rpc without arguments sends an empty object", async () => {
    const { t, calls } = make(() => json(null))
    await t.rpc("delete_push_token")
    expect(calls[0].init.body).toBe("{}")
  })
  it("select: GET with select=* and url-encoded equality filters; no body, no content-type", async () => {
    const { t, calls } = make(() => json([]))
    await t.select("syncs", { uid: "a,b&c=d e/é" })
    expect(calls[0].url).toBe(`${URL_}/rest/v1/syncs?select=*&uid=eq.${encodeURIComponent("a,b&c=d e/é")}`)
    expect(calls[0].init.method).toBe("GET")
    expect(calls[0].init.body).toBeUndefined()
    expect(headersOf(calls[0].init)["content-type"]).toBeUndefined()
    await t.select("connections")
    expect(calls[1].url).toBe(`${URL_}/rest/v1/connections?select=*`)
  })
  it("the token is only in the Authorization header: never in the URL or the body", async () => {
    const { t, calls } = make(() => json([]))
    await t.rpc("get_profile_name", { p_uid: "u" })
    await t.select("syncs")
    for (const c of calls) {
      expect(c.url).not.toContain(TOKEN)
      expect(String(c.init.body ?? "")).not.toContain(TOKEN)
    }
  })
  it("function, table and column names are validated; nothing is sent for a bad name", async () => {
    const { t, fetchFn } = make(() => json([]))
    for (const fn of ["../x", "a/b", "A", "x?y=1", "", "x y", "9x", "x;drop", "a".repeat(80)]) await expect(t.rpc(fn), fn).rejects.toMatchObject({ kind: "invalid" })
    for (const tb of ["syncs/../x", "Syncs", "x?select=*", "", "x#y"]) await expect(t.select(tb), tb).rejects.toMatchObject({ kind: "invalid" })
    await expect(t.select("syncs", { "uid&admin": "1" })).rejects.toMatchObject({ kind: "invalid" })
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe("no anonymous access", () => {
  it("without a token nothing is sent and the error is unauthorized", async () => {
    const { t, fetchFn } = make(() => json([]))
    t.setAccessToken?.("")
    await expect(t.rpc("sync_put", {})).rejects.toMatchObject({ kind: "unauthorized", code: "supabase-unauthenticated" })
    await expect(t.select("syncs")).rejects.toMatchObject({ kind: "unauthorized" })
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it("a malformed token (spaces, CRLF, too short) is cleared and never sent", async () => {
    const { t, fetchFn } = make(() => json([]))
    for (const bad of ["short", "has space in it 1234567890123", `${TOKEN}\r\nx-evil: 1`, "tokén-with-unicode-12345678901"]) {
      t.setAccessToken?.(bad)
      await expect(t.rpc("sync_put"), bad).rejects.toMatchObject({ kind: "unauthorized" })
    }
    expect(fetchFn).not.toHaveBeenCalled()
  })
  it("the latest token is used for each call", async () => {
    const { t, calls } = make(() => json(null))
    await t.rpc("a_fn")
    t.setAccessToken?.("another.token-value_1234567890.sig-1234567890")
    await t.rpc("a_fn")
    expect(headersOf(calls[0].init).authorization).toBe(`Bearer ${TOKEN}`)
    expect(headersOf(calls[1].init).authorization).toBe("Bearer another.token-value_1234567890.sig-1234567890")
  })
})

describe("responses", () => {
  it("returns scalars, arrays, objects and null; an empty body or 204 is null", async () => {
    for (const [body, want] of [[json("existing"), "existing"], [json(7), 7], [json(true), true], [json([{ a: 1 }]), [{ a: 1 }]], [json(null), null], [new Response("", { status: 200 }), null], [new Response(null, { status: 204 }), null]] as const) {
      const { t } = make(() => body.clone())
      expect(await t.rpc("x_fn")).toEqual({ data: want, error: null })
    }
  })
  it("a sync blob round-trips byte for byte (whitespace, CRLF, unicode)", async () => {
    const blob = " gz1:H4sI+/== \r\né中😀\t"
    const { t } = make(() => json([{ uid: "u", data: blob, rev: 3, updated_at: 5 }]))
    const r = await t.select("syncs")
    expect((r.data as { data: string }[])[0].data).toBe(blob)
  })
  it("database errors keep only the code and a short message (no details, hint or body)", async () => {
    const { t } = make(() => json({ code: "40001", message: "revision conflict", details: "SECRET DETAIL", hint: "SECRET HINT" }, 409))
    const r = await t.rpc("sync_put")
    expect(r).toEqual({ data: null, error: { code: "40001", message: "revision conflict" } })
    expect(JSON.stringify(r)).not.toMatch(/SECRET/)
  })
  it("long messages are truncated", async () => {
    const { t } = make(() => json({ code: "22023", message: "x".repeat(5000) }, 400))
    expect(((await t.rpc("f_n")).error?.message ?? "").length).toBeLessThanOrEqual(200)
  })
  it("JWT trouble of every PostgREST flavour is reported as PGRST301 (unauthorized)", async () => {
    for (const code of ["PGRST301", "PGRST302", "PGRST303"]) {
      const { t } = make(() => json({ code, message: "JWT expired" }, 401))
      expect((await t.rpc("x_fn")).error?.code, code).toBe("PGRST301")
    }
  })
  it("authorization failures: a code from the body wins; without a body 401/403 become 42501; other codes keep their status", async () => {
    expect((await make(() => json({ code: "42501", message: "permission denied for table x" }, 403)).t.select("profiles")).error?.code).toBe("42501")
    expect((await make(() => new Response("<html>denied</html>", { status: 401 })).t.rpc("x_fn")).error?.code).toBe("42501")
    expect((await make(() => new Response("", { status: 403 })).t.rpc("x_fn")).error?.code).toBe("42501")
    expect((await make(() => new Response("nope", { status: 404 })).t.rpc("x_fn")).error?.code).toBe("http-404")
    expect((await make(() => json({ code: "bad code with spaces!", message: "m" }, 400)).t.rpc("x_fn")).error?.code).toBe("http-400")
  })
  it("malformed or oversized success bodies are a distinct, generic error", async () => {
    for (const body of ["{not json", "<html>gateway</html>", '{"a":']) {
      const r = await make(() => new Response(body, { status: 200 })).t.rpc("x_fn")
      expect(r).toEqual({ data: null, error: { code: "supabase-malformed", message: "malformed response from the server" } })
    }
    const big = await make(() => new Response("[" + '"x",'.repeat(50) + '"x"]', { status: 200 }), { maxResponseChars: 100 }).t.rpc("x_fn")
    expect(big.error?.code).toBe("supabase-response-too-large")
    const declared = await make(() => new Response("[]", { status: 200, headers: { "content-length": "999999999" } })).t.rpc("x_fn")
    expect(declared.error?.code).toBe("supabase-response-too-large")
  })
})

describe("transient trouble is thrown, so callers see `unavailable`", () => {
  it("402, 408, 429 and every 5xx are thrown; a network failure is thrown", async () => {
    for (const status of [402, 408, 429, 500, 502, 503, 504]) {
      await expect(make(() => new Response("{}", { status })).t.rpc("x_fn"), String(status)).rejects.toThrow(/unavailable/)
    }
    await expect(make(() => Promise.reject(new TypeError("Failed to fetch"))).t.rpc("x_fn")).rejects.toThrow()
  })
  it("PostgREST answers errors raised by our functions with HTTP 500: a SQLSTATE body is a database answer, not an outage", async () => {
    // observed against the real local stack: sync_put's stale revision is `500 {"code":"40001","message":"revision conflict"}`
    const r = await make(() => json({ code: "40001", message: "revision conflict", details: null, hint: null }, 500)).t.rpc("sync_put")
    expect(r).toEqual({ data: null, error: { code: "40001", message: "revision conflict" } })
    const be = createSupabaseBackend({ transport: make(() => json({ code: "40001", message: "revision conflict" }, 500)).t, guard: async () => TOKEN })
    expect(await be.sync.put("u", "blob", 1)).toEqual({ ok: false, reason: "conflict" })
    expect((await make(() => json({ code: "22023", message: "invalid name" }, 500)).t.rpc("upsert_profile")).error?.code).toBe("22023")
  })
  it("5xx without a database SQLSTATE, or in a connection/resource/shutdown class, stays unavailable", async () => {
    for (const body of [{ code: "PGRST000", message: "could not connect" }, { code: "08006", message: "connection failure" }, { code: "53300", message: "too many connections" }, { code: "57014", message: "statement timeout" }, { code: "58000", message: "system" }, { message: "no code" }, "<html>bad gateway</html>", "", { code: "lowercase", message: "x" }]) {
      const res = typeof body === "string" ? new Response(body, { status: 500 }) : json(body, 500)
      await expect(make(() => res.clone()).t.rpc("x_fn"), JSON.stringify(body)).rejects.toThrow(/unavailable/)
    }
  })
  it("a request that never completes is cut off at the timeout, even if fetch ignores the abort signal", async () => {
    const { t } = make(() => new Promise<Response>(() => {}), { timeoutMs: 30 })
    await expect(t.rpc("x_fn")).rejects.toThrow(/timed out/)
  })
  it("a body that never finishes streaming is cut off too", async () => {
    const hang = { status: 200, headers: new Headers(), text: () => new Promise<string>(() => {}) } as unknown as Response
    const { t } = make(() => hang, { timeoutMs: 30 })
    await expect(t.rpc("x_fn")).rejects.toThrow(/timed out/)
  })
  it("error text never contains the token or the key", async () => {
    for (const make1 of [
      () => make(() => new Response("{}", { status: 503 })),
      () => make(() => json({ code: "42501", message: "denied" }, 403)),
      () => make(() => new Response("{bad", { status: 200 })),
    ]) {
      const { t } = make1()
      let text = ""
      try {
        text = JSON.stringify(await t.rpc("x_fn"))
      } catch (e) {
        text = String((e as Error).message)
      }
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain(KEY)
    }
  })
})

describe("through the adapter", () => {
  const guard = async () => TOKEN
  const backend = (responder: (url: string, init: RequestInit) => Response | Promise<Response>) => {
    const m = make(responder)
    return { ...m, be: createSupabaseBackend({ transport: m.t, guard }) }
  }

  it("sync.get reads the caller's row through RLS; no row is null", async () => {
    const { be, calls } = backend(() => json([{ uid: "u", data: "blob", rev: 4, updated_at: 1790000000000 }]))
    expect(await be.sync.get("u")).toEqual({ data: "blob", rev: 4, updatedAt: 1790000000000 })
    expect(calls[0].url).toContain("/rest/v1/syncs?select=*")
    expect(await backend(() => json([])).be.sync.get("u")).toBeNull()
  })
  it("sync.put sends the expected revision, never an owner, and returns the new revision", async () => {
    const { be, calls } = backend(() => json(5))
    expect(await be.sync.put("someone-else", "blob", 4)).toEqual({ ok: true, rev: 5 })
    const body = JSON.parse(String(calls[0].init.body))
    expect(body).toMatchObject({ p_expected_rev: 4, p_data: "blob" })
    expect(Object.keys(body).sort()).toEqual(["p_data", "p_expected_rev", "p_updated_at"])
  })
  it("a stale revision (40001) is a conflict result, not an exception", async () => {
    const { be } = backend(() => json({ code: "40001", message: "revision conflict" }, 409))
    expect(await be.sync.put("u", "blob", 1)).toEqual({ ok: false, reason: "conflict" })
  })
  it("authorization failures surface as unauthorized BackendErrors", async () => {
    for (const r of [() => json({ code: "42501", message: "not signed in" }, 403), () => json({ code: "PGRST303", message: "JWT expired" }, 401)]) {
      await expect(backend(r).be.profiles.save("u", "Name")).rejects.toMatchObject({ kind: "unauthorized", retryable: false })
    }
  })
  it("network and server trouble surface as unavailable (retryable); the timeout too", async () => {
    await expect(backend(() => Promise.reject(new TypeError("Failed to fetch"))).be.sync.get("u")).rejects.toMatchObject({ kind: "unavailable", retryable: true })
    await expect(backend(() => new Response("{}", { status: 503 })).be.sync.get("u")).rejects.toMatchObject({ kind: "unavailable", retryable: true })
    const slow = createSupabaseBackend({ transport: make(() => new Promise<Response>(() => {}), { timeoutMs: 30 }).t, guard })
    await expect(slow.sync.get("u")).rejects.toMatchObject({ kind: "unavailable" })
  })
  it("a malformed body is `unknown` (not retryable) with a generic message", async () => {
    const e = await backend(() => new Response("<html>", { status: 200 })).be.sync.get("u").catch((x) => x)
    expect(e).toBeInstanceOf(BackendError)
    expect(e).toMatchObject({ kind: "unknown", retryable: false, code: "supabase-malformed" })
    expect(e.message).toBe("malformed response from the server")
  })
  it("validation errors from the database are `invalid`; duplicates are conflicts", async () => {
    await expect(backend(() => json({ code: "22023", message: "invalid name" }, 400)).be.profiles.save("u", "")).rejects.toMatchObject({ kind: "invalid" })
    await expect(backend(() => json({ code: "23505", message: "duplicate" }, 409)).be.invites.create("u", "n", 15)).rejects.toMatchObject({ kind: "conflict" })
  })
  it("supported operations map to the right functions and tables", async () => {
    const seen: string[] = []
    const { be } = backend((url) => {
      seen.push(url.replace(URL_, ""))
      if (url.includes("get_invite")) return json([{ owner: "o", owner_name: "On", expires_at: "2026-10-09T00:00:00Z", expired: false }])
      if (url.includes("send_request")) return json("req-id")
      if (url.includes("rest/v1/connections")) return json([{ id: "c1", from_uid: "a", to_uid: "b", from_name: "A", to_name: "B", status: "pending", created_at: "2026-10-01T00:00:00Z", responded_at: null }])
      return json(null)
    })
    expect((await be.invites.read("tok")) !== null).toBe(true)
    expect(await be.connections.send({ uid: "a", name: "A" }, { uid: "b", name: "B" })).toBe("req-id")
    expect((await be.connections.list("a")).map((c) => c.id)).toEqual(["c1"])
    await be.pushTokens.save("a", "push-token")
    await be.connections.respond("c1", "accepted")
    expect(seen).toEqual([
      "/rest/v1/rpc/get_invite",
      "/rest/v1/rpc/send_request",
      "/rest/v1/connections?select=*",
      "/rest/v1/rpc/save_push_token",
      "/rest/v1/rpc/respond_request",
    ])
  })
  it("realtime is still not implemented: subscriptions report not-live and send nothing", async () => {
    const { be, fetchFn } = backend(() => json([]))
    const onState = vi.fn()
    be.sync.watch("u", { onData: vi.fn(), onState })
    expect(onState).toHaveBeenCalledWith(false, expect.anything())
    expect(fetchFn).not.toHaveBeenCalled()
    expect(make(() => json(null)).t.setRealtimeAuth).toBeUndefined()
  })
})

describe("the guard still decides, and the flags stay off", () => {
  const cfg = { url: URL_, publishableKey: KEY }
  const bridge = (status: string) => ({ ensureAuthenticated: async () => ({ status }) as never, getToken: async () => TOKEN })
  it("flag off, missing configuration or an unauthenticated bridge: the transport is never reached", async () => {
    for (const [flag, config, status] of [[false, cfg, "authenticated"], [true, null, "authenticated"], [true, cfg, "unauthorized"], [true, cfg, "unavailable"]] as const) {
      const { t, fetchFn } = make(() => json([]))
      const be = createSupabaseBackend({ transport: t, guard: createSupabaseGuard({ flagEnabled: () => flag, config: () => config, bridge: bridge(status) }) })
      await expect(be.sync.get("u")).rejects.toBeInstanceOf(BackendError)
      expect(fetchFn).not.toHaveBeenCalled()
    }
  })
  it("with everything satisfied, exactly one request goes out, to the configured origin only", async () => {
    const { t, calls } = make(() => json([]))
    const be = createSupabaseBackend({ transport: t, guard: createSupabaseGuard({ flagEnabled: () => true, config: () => cfg, bridge: bridge("authenticated") }) })
    await be.sync.get("u")
    expect(calls).toHaveLength(1)
    expect(new URL(calls[0].url).origin).toBe(URL_)
  })
  it("by default the app backend is Firebase and the Supabase transport is never built or used", () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    expect(getBackend().kind).toBe("firebase")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", KEY)
    expect(getBackend().kind).toBe("firebase")
    expect(net).not.toHaveBeenCalled()
  })
  it("even when the supabase kind is selected, flag off means no request", async () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    vi.stubEnv("NEXT_PUBLIC_BACKEND", "supabase")
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", URL_)
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", KEY)
    const be = getBackend()
    expect(be.kind).toBe("supabase")
    await expect(be.sync.get("u")).rejects.toMatchObject({ code: "supabase-not-configured" })
    expect(net).not.toHaveBeenCalled()
  })
  it("the transport is constructed only in the supabase branch of getBackend, and nothing else imports it", () => {
    const idx = fs.readFileSync(path.join(ROOT, "lib", "backend", "index.ts"), "utf8")
    // exactly three mentions: the definition, the supabase-branch call, and (Phase 7 shadow reader) the flag-gated getShadowReader()
    expect(idx.match(/buildSupabaseTransport\(\)/g)).toHaveLength(3)
    expect(idx).toMatch(/\? createSupabaseBackend\(\{[^\n]*transport: buildSupabaseTransport\(\)/)
    const reader = idx.slice(idx.indexOf("export function getShadowReader"), idx.indexOf("/** Tests only: install a backend"))
    expect(reader).toMatch(/if \(!shadowReadEnabled\(\) \|\| !authBridgeEnabled\(\) \|\| !readBuildSupabaseConfig\(\)\) return null/)
    expect(reader.indexOf("shadowReadEnabled()")).toBeLessThan(reader.indexOf("buildSupabaseTransport()")) // the flags are checked first
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const importers = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => /supabase\/transport/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    expect(importers).toEqual(["lib/backend/index.ts"])
  })
  it("the transport source holds no key, URL or credential and no console output", () => {
    const src = fs.readFileSync(path.join(ROOT, "lib", "backend", "supabase", "transport.ts"), "utf8")
    expect(src).not.toMatch(/console\.|sb_(publishable|secret)_|supabase\.co|eyJ[A-Za-z0-9_-]{10,}/)
  })
})
