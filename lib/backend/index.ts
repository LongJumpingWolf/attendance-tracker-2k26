/**
 * The ONE place that decides which backend answers. Everything else asks `getBackend()` and never checks a flag.
 *
 *   NEXT_PUBLIC_BACKEND   unset or "firebase"  -> Firebase (the production backend, the default)
 *                         "supabase"           -> the Supabase skeleton, which refuses every call (fails closed): nothing
 *                                                 can reach Supabase until a later phase wires and authorizes it. Even then it
 *                                                 needs NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE=true, the Supabase configuration and a
 *                                                 valid bridge token (lib/backend/supabase/guard.ts)
 *                         anything else        -> an error, never a silent fallback
 *
 * There is no user-visible setting and no runtime switch.
 */
import { getAuth, onIdTokenChanged } from "firebase/auth"
import { app, db } from "../firebase"
import { ensureSignedIn } from "../social"
import { BackendError } from "./errors"
import type { Backend, BackendKind } from "./contracts"
import { createFirebaseBackend } from "./firebase"
import { createSupabaseBackend, createSupabaseGuard, readBuildSupabaseConfig } from "./supabase"
import { anyShadowFlag, authBridgeEnabled, shadowFlags, type ShadowFlags } from "./flags"
import { isolateShadowFailures } from "./shadow"
import { createSupabaseShadowWriter } from "./shadow-supabase"
import { withShadow } from "./shadow-backend"
import { createAuthBridge, createFetchBootstrapTransport, type AuthBridge } from "./supabase-auth"

export * from "./contracts"
export { BackendError, isBackendError, type BackendErrorKind } from "./errors"

export function resolveBackendKind(raw: string | undefined): BackendKind {
  const v = raw?.trim().toLowerCase()
  if (!v || v === "firebase") return "firebase"
  if (v === "supabase") return "supabase"
  throw new BackendError("invalid", `Unknown backend "${raw}". Use "firebase" or "supabase".`, { code: "invalid-backend-config" })
}

/** The static reference lets Next.js inline the build-time value */
const configured = () => resolveBackendKind(process.env.NEXT_PUBLIC_BACKEND)

let bridge: AuthBridge | null = null

/**
 * The Firebase -> Supabase auth bridge, built on first use. Building it does nothing: no Firebase call, no network, no
 * subscription. It is only consulted by the Supabase guard, and the guard only runs when the Supabase backend is selected.
 */
export function getAuthBridge(): AuthBridge {
  bridge ??= createAuthBridge({
    enabled: authBridgeEnabled,
    identity: {
      current: () => {
        try {
          return getAuth(app).currentUser
        } catch {
          return null // Firebase Auth is not configured (local mode): there is no user, so the bridge stays unauthorized
        }
      },
      onChange: (listener) => onIdTokenChanged(getAuth(app), () => listener()),
    },
    bootstrap: async (idToken) => {
      const config = readBuildSupabaseConfig()
      if (!config) throw new Error("Supabase is not configured")
      return createFetchBootstrapTransport(config)(idToken)
    },
    // Phase 6D: at most 3 attempts with backoff for transient failures, tokens refreshed 2 minutes before expiry, and a
    // 30 s pause after a failure so a down bootstrap is not called once per operation. Only reachable with the bridge flag on.
    retry: { maxAttempts: 3 },
    refreshMarginMs: 120_000,
    failureCooldownMs: 30_000,
  })
  return bridge
}

/**
 * Firebase, optionally with the Phase 6B shadow writer around it. With every shadow flag off (the default), or the auth
 * bridge off, or the Supabase configuration missing, this returns `base` itself: the same object, nothing wrapped.
 */
function firebaseWithOptionalShadow(base: Backend, flags: ShadowFlags): Backend {
  if (!anyShadowFlag(flags) || !authBridgeEnabled() || !readBuildSupabaseConfig()) return base
  const guard = createSupabaseGuard({ flagEnabled: authBridgeEnabled, config: readBuildSupabaseConfig, bridge: getAuthBridge() })
  const writer = createSupabaseShadowWriter({
    guard,
    config: readBuildSupabaseConfig,
    currentUid: () => {
      try {
        return getAuth(app).currentUser?.uid ?? null
      } catch {
        return null
      }
    },
  })
  return withShadow(base, isolateShadowFailures(writer), flags)
}

let cached: Backend | null = null
let cachedKey: string | null = null
let override: Backend | null = null

export function getBackend(): Backend {
  if (override) return override
  const kind = configured() // throws on an invalid value: fail closed
  const flags = shadowFlags()
  const key = `${kind}|${flags.sync}|${flags.social}|${flags.push}|${authBridgeEnabled()}`
  if (cached && cachedKey === key) return cached
  cached =
    kind === "supabase"
      ? createSupabaseBackend({ guard: createSupabaseGuard({ flagEnabled: authBridgeEnabled, config: readBuildSupabaseConfig, bridge: getAuthBridge() }) })
      : firebaseWithOptionalShadow(createFirebaseBackend({ db, ensureSignedIn }), flags)
  cachedKey = key
  return cached
}

/** Tests only: install a backend (or null to go back to the configured one) */
export function setBackendForTests(b: Backend | null) {
  override = b
}
