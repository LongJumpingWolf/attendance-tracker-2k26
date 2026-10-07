/**
 * The ONE place that decides which backend answers. Everything else asks `getBackend()` and never checks a flag.
 *
 *   NEXT_PUBLIC_BACKEND   unset or "firebase"  -> Firebase (the production backend, the default)
 *                         "supabase"           -> the Supabase skeleton, which refuses every call (fails closed): nothing
 *                                                 can reach Supabase until a later phase wires and authorizes it
 *                         anything else        -> an error, never a silent fallback
 *
 * There is no user-visible setting and no runtime switch.
 */
import { db } from "../firebase"
import { ensureSignedIn } from "../social"
import { BackendError } from "./errors"
import type { Backend, BackendKind } from "./contracts"
import { createFirebaseBackend } from "./firebase"
import { createSupabaseBackend } from "./supabase"

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

let cached: Backend | null = null
let cachedKind: BackendKind | null = null
let override: Backend | null = null

export function getBackend(): Backend {
  if (override) return override
  const kind = configured() // throws on an invalid value: fail closed
  if (cached && cachedKind === kind) return cached
  cached = kind === "supabase" ? createSupabaseBackend() : createFirebaseBackend({ db, ensureSignedIn })
  cachedKind = kind
  return cached
}

/** Tests only: install a backend (or null to go back to the configured one) */
export function setBackendForTests(b: Backend | null) {
  override = b
}
