/**
 * Phase 6D/6E (PROPOSED, NOT DEPLOYED): the request handler of the production auth-role bootstrap.
 *
 * Pure logic. Every dependency (Firebase verification, user lookup, claim write, clock, rate limiters, config) is injected,
 * so the security behaviour is tested locally without Deno, Firebase or a network. The Deno / firebase-admin wiring is in
 * index.ts and is the only file that touches a secret.
 *
 * What it does: a signed-in Firebase user posts their own Firebase ID token; after verification the function makes sure the
 * custom claim `role = "authenticated"` exists on THAT user (and nothing else), so Supabase maps the next token to the
 * `authenticated` Postgres role. Firebase remains the identity provider; the UID stays the JWT `sub` (text).
 *
 * Guarantees (each is a test in tests/phase6d-bootstrap-function.test.ts and tests/phase6e-rate-limit.test.ts):
 *  - the request body is never read; no uid, role or claim from the client is ever used;
 *  - the uid is taken only from the verified token; the only claim ever written is the constant role "authenticated";
 *  - issuer and audience must equal the configured Firebase project; a token for another project is refused;
 *  - the token is verified WITH revocation checking (index.ts); a revoked token is 401, a disabled user 403;
 *  - CORS: exact-match allow-list from configuration; an unconfigured list refuses every browser request; never `*`, never echoed;
 *  - rate limits, three layers: per-instance memory; a database counter per verified uid and for all bootstrap attempts together
 *    (cannot be bypassed by header tricks); and a per-client-IP counter that is OFF unless the owner has verified how the
 *    platform sets the client-IP header (it is not established by official documentation);
 *  - repeated requests are idempotent: nothing is written once the claim exists;
 *  - an unexpected existing `role` claim is never overwritten;
 *  - responses carry only a fixed error word, never the token, the uid, a key or a library message.
 */

export const REQUIRED_ROLE = "authenticated"

export interface VerifiedToken {
  uid: string
  sub: string
  iss: string
  aud: string
  /** seconds since epoch */
  iat: number
  /** the `role` custom claim as it appears in the verified token (absent on a new user's first token) */
  role?: unknown
}

export interface UserRecordLike {
  disabled: boolean
  /** RFC 1123 date string, as the Admin SDK reports it; tokens issued before it are revoked */
  tokensValidAfterTime?: string
  customClaims?: Record<string, unknown> | null
}

export interface RateLimiter {
  /** true when the call is allowed; false when the key is over its limit */
  take(key: string): boolean
}

/** The database-backed counter (public.bootstrap_rate_check, service_role only). Rejects on any failure. */
export interface DbRateLimiter {
  take(bucket: "uid" | "ip" | "global", key: string, limit: number, windowSeconds: number): Promise<boolean>
}

/**
 * "off": the client IP is NOT used (default). The IP layer is disabled until the owner has observed, in the real
 *        deployment, which header value the platform sets and that a client cannot choose it.
 * "xff-first" / "xff-last": use the first / last entry of X-Forwarded-For.
 * Why this is a switch: if a client can choose the value, a per-IP limit lets an attacker lock a victim's address (for
 * example a shared campus address) out of sign-up, and fills the counter table with chosen keys.
 */
export type IpMode = "off" | "xff-first" | "xff-last"

export interface RateConfig {
  /** bootstrap attempts (that reach the Admin API) per verified account per 10 minutes */
  uidPer10Min: number
  /** bootstrap attempts for the whole project per minute */
  globalPerMin: number
  /** requests per client IP per minute; used only when ipMode is not "off" */
  ipPerMin: number
}

export interface HandlerConfig {
  /** exact origins, e.g. "https://app.example.com" */
  allowedOrigins: readonly string[]
  /** the Firebase project id: issuer and audience must match it */
  projectId: string
  ipMode: IpMode
  rate: RateConfig
}

export interface HandlerDeps {
  /** verifies signature, expiry, issuer, audience AND revocation with the Firebase Admin SDK; throws (with the SDK error `code`) when not valid */
  verifyIdToken(token: string): Promise<VerifiedToken>
  getUser(uid: string): Promise<UserRecordLike>
  setCustomClaims(uid: string, claims: Record<string, unknown>): Promise<void>
  /** per-instance limit applied before any cryptographic work */
  ipLimiter: RateLimiter
  /** per-instance, per-account limit applied before any Admin API call */
  uidLimiter: RateLimiter
  /** database counters (shared by all instances) */
  dbLimiter: DbRateLimiter
  /** logs a fixed code only; the handler never passes a token, uid, key or library message */
  log(code: string): void
}

// ---- configuration --------------------------------------------------------------------------------------------------

const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/
const PROJECT_ID_RE = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/

export const DEFAULT_RATE: RateConfig = { uidPer10Min: 6, globalPerMin: 120, ipPerMin: 60 }

export type ConfigError = "origins-missing" | "origins-invalid" | "project-missing" | "project-invalid" | "ip-mode-invalid" | "rate-invalid"
export type ConfigResult = { ok: true; config: HandlerConfig } | { ok: false; reason: ConfigError }

export interface ConfigEnv {
  ALLOWED_ORIGINS?: string
  FIREBASE_PROJECT_ID?: string
  CLIENT_IP_MODE?: string
  RATE_UID_PER_10MIN?: string
  RATE_GLOBAL_PER_MIN?: string
  RATE_IP_PER_MIN?: string
}

function intOr(raw: string | undefined, fallback: number): number | null {
  if (raw === undefined || raw.trim() === "") return fallback
  if (!/^\d{1,5}$/.test(raw.trim())) return null
  const n = Number(raw.trim())
  return n >= 1 && n <= 10000 ? n : null
}

/**
 * ALLOWED_ORIGINS: comma separated exact https origins (no path, no wildcard, no http, no localhost). Missing or invalid
 * configuration fails closed: the function then answers 503 to everything. The values are supplied by the owner.
 * Rate settings are optional integers 1..10000 (defaults above); CLIENT_IP_MODE is off | xff-first | xff-last (default off).
 */
export function parseConfig(env: ConfigEnv): ConfigResult {
  const rawOrigins = (env.ALLOWED_ORIGINS ?? "").trim()
  if (!rawOrigins) return { ok: false, reason: "origins-missing" }
  const origins = rawOrigins.split(",").map((o) => o.trim())
  if (origins.some((o) => !ORIGIN_RE.test(o))) return { ok: false, reason: "origins-invalid" }
  const projectId = (env.FIREBASE_PROJECT_ID ?? "").trim()
  if (!projectId) return { ok: false, reason: "project-missing" }
  if (!PROJECT_ID_RE.test(projectId)) return { ok: false, reason: "project-invalid" }
  const mode = (env.CLIENT_IP_MODE ?? "off").trim() || "off"
  if (mode !== "off" && mode !== "xff-first" && mode !== "xff-last") return { ok: false, reason: "ip-mode-invalid" }
  const uid = intOr(env.RATE_UID_PER_10MIN, DEFAULT_RATE.uidPer10Min)
  const global = intOr(env.RATE_GLOBAL_PER_MIN, DEFAULT_RATE.globalPerMin)
  const ip = intOr(env.RATE_IP_PER_MIN, DEFAULT_RATE.ipPerMin)
  if (uid === null || global === null || ip === null) return { ok: false, reason: "rate-invalid" }
  return { ok: true, config: { allowedOrigins: Array.from(new Set(origins)), projectId, ipMode: mode, rate: { uidPer10Min: uid, globalPerMin: global, ipPerMin: ip } } }
}

// ---- in-memory rate limiting ----------------------------------------------------------------------------------------

/**
 * A fixed-window counter held in the memory of ONE function instance. It is a secondary safeguard: Edge Function instances
 * are short-lived and several can run at once, so this bounds a burst against one instance, not a distributed attack.
 */
export function createRateLimiter(opts: { windowMs: number; max: number; maxKeys?: number }, now: () => number = Date.now): RateLimiter {
  const hits = new Map<string, { start: number; n: number }>()
  const maxKeys = opts.maxKeys ?? 5000
  return {
    take(key) {
      const t = now()
      const h = hits.get(key)
      if (!h || t - h.start >= opts.windowMs) {
        if (!h && hits.size >= maxKeys) {
          for (const [k, v] of hits) if (t - v.start >= opts.windowMs) hits.delete(k)
          if (hits.size >= maxKeys) return false // memory bound: refuse new keys while full of live ones
        }
        hits.set(key, { start: t, n: 1 })
        return true
      }
      h.n += 1
      return h.n <= opts.max
    },
  }
}

// ---- the handler ----------------------------------------------------------------------------------------------------

const CORS_METHODS = "POST, OPTIONS"
const CORS_HEADERS = "authorization, apikey, content-type, x-client-info"

type ErrorWord = "method" | "origin" | "missing-or-malformed-bearer" | "invalid-token" | "unauthorized" | "rate-limited" | "unavailable" | "server-error"

function respond(status: number, body: Record<string, unknown>, origin: string | null, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    vary: "Origin",
    ...extra,
  }
  if (origin) {
    headers["access-control-allow-origin"] = origin // only ever an exact allow-listed origin, never "*"
  }
  return new Response(JSON.stringify(body), { status, headers })
}
const fail = (status: number, error: ErrorWord, origin: string | null, extra?: Record<string, string>) =>
  respond(status, { success: false, error }, origin, extra)

const IP_CHARS = /^[0-9a-fA-F:.]{2,45}$/

/**
 * The client address used ONLY to bucket rate limits, never for authorization. With mode "off" there is no address:
 * every request shares one per-instance bucket. Anything that does not look like an IP address is "unknown".
 */
export function clientKey(req: Request, mode: IpMode): string {
  if (mode === "off") return "instance"
  const parts = (req.headers.get("x-forwarded-for") ?? "").split(",").map((p) => p.trim()).filter(Boolean)
  const pick = mode === "xff-first" ? parts[0] : parts[parts.length - 1]
  return pick && IP_CHARS.test(pick) ? pick : "unknown"
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

export function createHandler(configResult: ConfigResult, deps: HandlerDeps): (req: Request) => Promise<Response> {
  return async function handle(req: Request): Promise<Response> {
    if (!configResult.ok) {
      deps.log("config-invalid") // the reason is not sent to the client
      return new Response(JSON.stringify({ success: false, error: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      })
    }
    const { allowedOrigins, projectId, ipMode, rate } = configResult.config

    // CORS: a request that names an origin must name an allow-listed one. A request without an Origin header is not a
    // browser cross-origin call (server-side smoke test); it still needs a valid Firebase token below.
    const originHeader = req.headers.get("origin")
    let corsOrigin: string | null = null
    if (originHeader !== null) {
      if (!allowedOrigins.includes(originHeader)) {
        return new Response(JSON.stringify({ success: false, error: "origin" }), {
          status: 403,
          headers: { "content-type": "application/json", "cache-control": "no-store", vary: "Origin" },
        })
      }
      corsOrigin = originHeader
    }

    if (req.method === "OPTIONS") {
      if (corsOrigin === null) return new Response(null, { status: 403, headers: { vary: "Origin" } })
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": corsOrigin,
          "access-control-allow-methods": CORS_METHODS,
          "access-control-allow-headers": CORS_HEADERS,
          "access-control-max-age": "600",
          vary: "Origin",
        },
      })
    }
    if (req.method !== "POST") return fail(405, "method", corsOrigin, { allow: CORS_METHODS })

    // The body is never read. Only the Authorization header carries anything, and only a Firebase ID token.
    const m = /^Bearer ([A-Za-z0-9._-]{20,4096})$/.exec(req.headers.get("authorization") ?? "")
    if (!m) return fail(401, "missing-or-malformed-bearer", corsOrigin)

    const ip = clientKey(req, ipMode)
    if (!deps.ipLimiter.take(ip)) return fail(429, "rate-limited", corsOrigin, { "retry-after": "60" })

    // Layer 2a (only when the owner has enabled an IP mode): shared per-address counter before any verification work.
    if (ipMode !== "off" && ip !== "unknown") {
      try {
        if (!(await deps.dbLimiter.take("ip", await sha256Hex(ip), rate.ipPerMin, 60))) return fail(429, "rate-limited", corsOrigin, { "retry-after": "60" })
      } catch {
        deps.log("rate-store-failed")
        return fail(503, "unavailable", corsOrigin) // fail closed: do not do Admin work without a working limiter
      }
    }

    let token: VerifiedToken
    try {
      token = await deps.verifyIdToken(m[1])
    } catch (e) {
      const code = String((e as { code?: unknown })?.code ?? "")
      if (code === "auth/user-disabled") {
        deps.log("user-disabled")
        return fail(403, "unauthorized", corsOrigin)
      }
      deps.log(code === "auth/id-token-revoked" ? "token-revoked" : "verify-failed")
      return fail(401, "invalid-token", corsOrigin)
    }

    // Explicit checks on top of the SDK: the Firebase UID is text, comes only from the verified token, and the token
    // belongs to THIS Firebase project (Firebase signs all projects with the same keys).
    if (
      token.iss !== `https://securetoken.google.com/${projectId}` ||
      token.aud !== projectId ||
      typeof token.sub !== "string" ||
      token.sub.length < 1 ||
      token.sub.length > 128 ||
      token.sub !== token.uid
    ) {
      deps.log("claims-mismatch")
      return fail(401, "invalid-token", corsOrigin)
    }
    const uid = token.sub

    // Idempotent fast path: this very (revocation-checked) token already proves the role. No write, no database counter.
    if (token.role === REQUIRED_ROLE) return respond(200, { success: true }, corsOrigin)

    if (!deps.uidLimiter.take(uid)) return fail(429, "rate-limited", corsOrigin, { "retry-after": "60" })

    // Layer 2b: shared counters for the attempts that reach the Admin API. The key is the VERIFIED uid, never a client value.
    try {
      if (!(await deps.dbLimiter.take("uid", uid, rate.uidPer10Min, 600))) return fail(429, "rate-limited", corsOrigin, { "retry-after": "600" })
      if (!(await deps.dbLimiter.take("global", "bootstrap", rate.globalPerMin, 60))) return fail(429, "rate-limited", corsOrigin, { "retry-after": "60" })
    } catch {
      deps.log("rate-store-failed")
      return fail(503, "unavailable", corsOrigin)
    }

    try {
      const user = await deps.getUser(uid)
      if (user.disabled) {
        deps.log("user-disabled")
        return fail(403, "unauthorized", corsOrigin)
      }
      if (user.tokensValidAfterTime) {
        const validAfter = Date.parse(user.tokensValidAfterTime)
        if (Number.isFinite(validAfter) && token.iat * 1000 < validAfter) {
          deps.log("token-revoked")
          return fail(401, "invalid-token", corsOrigin)
        }
      }
      const existing = user.customClaims ?? {}
      if (existing.role === REQUIRED_ROLE) return respond(200, { success: true }, corsOrigin) // another device got there first
      if (existing.role !== undefined && existing.role !== null) {
        deps.log("role-conflict") // an unexpected pre-existing role is never overwritten
        return fail(403, "unauthorized", corsOrigin)
      }
      await deps.setCustomClaims(uid, { ...existing, role: REQUIRED_ROLE }) // the only claim this function ever writes
      return respond(200, { success: true }, corsOrigin)
    } catch (e) {
      const code = String((e as { code?: unknown })?.code ?? "")
      deps.log(code.startsWith("auth/") ? code.slice(0, 60).replace(/[^a-z0-9/_-]/gi, "") : "admin-call-failed")
      const transient = code === "auth/quota-exceeded" || code === "auth/internal-error" || code === "app/network-error"
      return transient ? fail(503, "unavailable", corsOrigin) : fail(500, "server-error", corsOrigin)
    }
  }
}
