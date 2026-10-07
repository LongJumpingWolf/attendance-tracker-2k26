/**
 * One small error model for every backend. Domain code never sees a FirebaseError or a Postgres error: it sees a
 * BackendError with a kind it can act on. `code` keeps the backend's own code (for example "permission-denied") so the
 * existing readers of `error.code` keep working unchanged.
 */
export type BackendErrorKind =
  /** offline, timed out, quota or transport trouble: trying again later can work */
  | "unavailable"
  /** signed out, or not allowed. Retrying will not help until the identity changes */
  | "unauthorized"
  /** the state changed under us (stale revision, already exists, wrong state): re-read, then decide */
  | "conflict"
  | "not-found"
  /** the request itself is wrong (validation) */
  | "invalid"
  | "unknown"

export class BackendError extends Error {
  readonly kind: BackendErrorKind
  /** True only when the same request may succeed later without anything else changing */
  readonly retryable: boolean
  readonly code?: string
  readonly cause?: unknown

  constructor(kind: BackendErrorKind, message: string, opts: { code?: string; cause?: unknown } = {}) {
    super(message)
    this.name = "BackendError"
    this.kind = kind
    this.retryable = kind === "unavailable"
    this.code = opts.code
    this.cause = opts.cause
  }
}

export const isBackendError = (e: unknown): e is BackendError => e instanceof BackendError

const messageOf = (e: unknown) => (e as { message?: string } | null)?.message ?? String(e)

/** Firestore / Firebase Auth error codes -> kinds */
export function fromFirebaseError(e: unknown): BackendError {
  if (isBackendError(e)) return e
  const code = (e as { code?: string } | null)?.code
  const bare = code?.replace(/^(firestore|auth)\//, "")
  let kind: BackendErrorKind = "unknown"
  switch (bare) {
    case "permission-denied":
    case "unauthenticated":
      kind = "unauthorized"
      break
    case "unavailable":
    case "deadline-exceeded":
    case "cancelled":
    case "resource-exhausted":
    case "network-request-failed":
      kind = "unavailable"
      break
    case "not-found":
      kind = "not-found"
      break
    case "aborted":
    case "already-exists":
    case "failed-precondition":
      kind = "conflict"
      break
    case "invalid-argument":
    case "out-of-range":
      kind = "invalid"
      break
  }
  return new BackendError(kind, messageOf(e), { code, cause: e })
}

/** Postgres SQLSTATEs used by the Phase 3 functions (see PHASE3_SECURITY_MATRIX.md) -> kinds */
export function fromPostgresError(e: unknown): BackendError {
  if (isBackendError(e)) return e
  const code = (e as { code?: string } | null)?.code
  let kind: BackendErrorKind = "unknown"
  switch (code) {
    case "42501":
      kind = "unauthorized"
      break
    case "22023":
    case "54000":
      kind = "invalid"
      break
    case "P0002":
      kind = "not-found"
      break
    case "23505":
    case "40001":
    case "55000":
      kind = "conflict"
      break
    case "PGRST301": // PostgREST: JWT expired / invalid
      kind = "unauthorized"
      break
  }
  return new BackendError(kind, messageOf(e), { code, cause: e })
}

/** Thrown by a backend that is selected but not usable yet. Fails closed: nothing is sent anywhere. */
export const notConfigured = (what: string) =>
  new BackendError("unauthorized", `Supabase backend not configured/authorized: ${what}`, { code: "supabase-not-configured" })
