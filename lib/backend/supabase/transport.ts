/**
 * The real fetch-based Supabase transport (Phase 7 preparation). It implements the two things the adapter needs, `rpc` and
 * `select`, over PostgREST, with no new dependency. It is built only for the `supabase` backend kind, and the adapter asks the
 * authorization guard (flag, configuration, bridge token) before EVERY call, so with the flags off nothing here ever runs.
 *
 * Security properties (each is a test in tests/phase7-supabase-transport.test.ts):
 *  - it talks only to the configured origin, which must be https (http only for a loopback host, for local testing), with no
 *    credentials in the URL and no path;
 *  - it never sends a request without an access token: there is no anonymous fallback;
 *  - function and table names are validated against a strict pattern; filter values are URL-encoded, so a name or value cannot
 *    change the path or add parameters;
 *  - the token travels only in the Authorization header, and appears in no URL, error message or log;
 *  - server error text is reduced to its short `message`; `details`, `hint` and the body are dropped; messages are truncated;
 *  - the response size is bounded and a request has a hard timeout that holds even if `fetch` ignores its abort signal;
 *  - transient failures (offline, timeout, 402/408/429/5xx) are thrown, so the adapter reports `unavailable` (retryable);
 *    database answers are returned as `{ error: { code } }` so the adapter maps the SQLSTATE; malformed bodies are a distinct error.
 */
import { BackendError } from "../errors"
import type { PostgrestResult, SupabaseTransport } from "./index"
import type { SupabaseConfig } from "./guard"

export interface FetchTransportOptions {
  config: SupabaseConfig
  fetch?: typeof fetch
  /** hard limit per request; default 10 s */
  timeoutMs?: number
  /** largest response body accepted, in characters; default 4 MB (a sync blob is below 900 KB) */
  maxResponseChars?: number
}

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/
const TOKEN_RE = /^[A-Za-z0-9._-]{20,8192}$/
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])
const MESSAGE_MAX = 200

const invalid = (message: string, code: string) => new BackendError("invalid", message, { code })

/** Validates the configured URL and returns its origin. Throws a BackendError on anything unsafe. */
export function safeOrigin(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw invalid("the Supabase URL is not a valid URL", "supabase-bad-url")
  }
  const https = u.protocol === "https:"
  const loopbackHttp = u.protocol === "http:" && LOOPBACK.has(u.hostname)
  if (!https && !loopbackHttp) throw invalid("the Supabase URL must use https", "supabase-bad-url")
  if (u.username || u.password) throw invalid("the Supabase URL must not contain credentials", "supabase-bad-url")
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) throw invalid("the Supabase URL must be an origin only", "supabase-bad-url")
  return u.origin
}

export function createFetchTransport(opts: FetchTransportOptions): SupabaseTransport {
  const origin = safeOrigin(opts.config.url)
  const apikey = opts.config.publishableKey
  if (!apikey || /[\r\n]/.test(apikey)) throw invalid("the Supabase publishable key is missing or malformed", "supabase-bad-key")
  const fetchFn = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a))
  const timeoutMs = opts.timeoutMs ?? 10_000
  const maxChars = opts.maxResponseChars ?? 4_000_000
  let token: string | null = null

  /** One request. Everything that depends on shared state (the token) is read synchronously, before the first await. */
  async function send<T>(path: string, init: { method: "GET" | "POST"; body?: string }): Promise<PostgrestResult<T>> {
    const bearer = token
    if (!bearer) throw new BackendError("unauthorized", "no Supabase access token: nothing was sent", { code: "supabase-unauthenticated" })
    const headers: Record<string, string> = { apikey, authorization: `Bearer ${bearer}`, accept: "application/json" }
    if (init.body !== undefined) headers["content-type"] = "application/json"

    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error("request timed out")) // holds even if fetch ignores the abort signal
      }, timeoutMs)
    })
    try {
      const res = await Promise.race([fetchFn(`${origin}${path}`, { method: init.method, headers, body: init.body, signal: controller.signal, redirect: "error", cache: "no-store" }), deadline])
      const declared = Number(res.headers.get("content-length") ?? 0)
      if (declared > maxChars) return fail("supabase-response-too-large", "the response is too large")
      const text = await Promise.race([res.text(), deadline])
      if (text.length > maxChars) return fail("supabase-response-too-large", "the response is too large")
      return interpret<T>(res.status, text)
    } finally {
      clearTimeout(timer)
    }
  }

  const fail = <T>(code: string, message: string): PostgrestResult<T> => ({ data: null, error: { code, message } })

  function interpret<T>(status: number, text: string): PostgrestResult<T> {
    // trouble that may pass: thrown, so the adapter reports `unavailable` (retryable). 402 is a quota restriction.
    if (status === 402 || status === 408 || status === 429) throw new Error(`Supabase unavailable (HTTP ${status})`)
    let body: unknown = null
    let parsed = true
    if (text !== "") {
      try {
        body = JSON.parse(text)
      } catch {
        parsed = false
      }
    }
    if (status >= 200 && status < 300) {
      if (!parsed) return fail("supabase-malformed", "malformed response from the server")
      return { data: body as T, error: null }
    }
    // a database / PostgREST answer
    const o = parsed && body && typeof body === "object" ? (body as { code?: unknown; message?: unknown }) : {}
    let code = typeof o.code === "string" && /^[A-Za-z0-9_]{1,20}$/.test(o.code) ? o.code : ""
    if (status >= 500) {
      // PostgREST answers some errors RAISED BY OUR FUNCTIONS with HTTP 500 (observed: the 40001 "revision conflict" of sync_put).
      // Those carry a 5-character SQLSTATE and are database answers. Gateway trouble (HTML, no code, PGRST00x) and connection,
      // resource or shutdown classes (08, 53, 57, 58) are transient: thrown, so the caller sees `unavailable`.
      const database = /^[0-9A-Z]{5}$/.test(code) && !/^(08|53|57|58)/.test(code)
      if (!database) throw new Error(`Supabase unavailable (HTTP ${status})`)
    }
    if (code.startsWith("PGRST30")) code = "PGRST301" // JWT problems (invalid, expired, claims): all mean "unauthorized"
    if (!code) code = status === 401 || status === 403 ? "42501" : `http-${status}`
    const message = typeof o.message === "string" ? o.message.slice(0, MESSAGE_MAX) : `request failed (HTTP ${status})`
    return { data: null, error: { code, message } } // details, hint and the body are deliberately dropped
  }

  return {
    setAccessToken(t: string) {
      token = typeof t === "string" && TOKEN_RE.test(t) ? t : null // a malformed token is cleared, never sent
    },
    async rpc(fn, args) {
      if (!NAME_RE.test(fn)) throw invalid("invalid function name", "supabase-bad-name")
      return send(`/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args ?? {}) })
    },
    async select(table, eq) {
      if (!NAME_RE.test(table)) throw invalid("invalid table name", "supabase-bad-name")
      const params = ["select=*"]
      for (const [col, value] of Object.entries(eq ?? {})) {
        if (!NAME_RE.test(col)) throw invalid("invalid column name", "supabase-bad-name")
        params.push(`${col}=eq.${encodeURIComponent(String(value))}`)
      }
      return send(`/rest/v1/${table}?${params.join("&")}`, { method: "GET" })
    },
  }
}
