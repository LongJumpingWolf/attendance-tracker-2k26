/**
 * The authorization guard in front of the Supabase adapter (Phase 6A). Every adapter operation asks it first.
 *
 * The adapter may only operate when ALL of these hold, checked in this order:
 *   1. the auth-bridge feature flag is on,
 *   2. the Supabase configuration (URL and publishable key) exists,
 *   3. the bridge holds a valid token for the CURRENT Firebase user.
 * Otherwise the call is refused with a BackendError and nothing is sent. There is no fallback of any kind: a selected
 * Supabase backend never degrades to anonymous Supabase access, and never to Firebase.
 */
import { BackendError, notConfigured } from "../errors"
import type { AuthBridge } from "../supabase-auth"

export interface SupabaseConfig {
  url: string
  publishableKey: string
}

/**
 * Documented, never given a value in the repository:
 *   NEXT_PUBLIC_SUPABASE_URL                the project URL
 *   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY    the publishable key (sb_publishable_...). Row access is decided by RLS and the
 *                                           RPCs, not by hiding this. The legacy anon JWT is not used.
 * The static references let Next.js inline the build-time values.
 */
export function readSupabaseConfig(env: Record<string, string | undefined>): SupabaseConfig | null {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim()
  const publishableKey = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()
  return url && publishableKey ? { url, publishableKey } : null
}

export const readBuildSupabaseConfig = (): SupabaseConfig | null =>
  readSupabaseConfig({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  })

export interface GuardDeps {
  flagEnabled: () => boolean
  config: () => SupabaseConfig | null
  bridge: Pick<AuthBridge, "ensureAuthenticated" | "getToken">
}

/** Resolves to the Firebase token to use for this operation, or throws a BackendError. */
export type SupabaseGuard = () => Promise<string>

export function createSupabaseGuard(deps: GuardDeps): SupabaseGuard {
  return async () => {
    if (!deps.flagEnabled()) throw notConfigured("the auth bridge is disabled (NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE)")
    if (!deps.config()) throw notConfigured("the Supabase URL or publishable key is missing")
    const state = await deps.bridge.ensureAuthenticated()
    if (state.status !== "authenticated") {
      const kind = state.status === "unavailable" ? "unavailable" : "unauthorized"
      throw new BackendError(kind, `Supabase backend not authorized: bridge is ${state.status}${state.reason ? ` (${state.reason})` : ""}`, { code: "supabase-unauthenticated" })
    }
    const token = await deps.bridge.getToken()
    if (!token) throw new BackendError("unauthorized", "Supabase backend not authorized: no token for the current Firebase user", { code: "supabase-unauthenticated" })
    return token
  }
}
