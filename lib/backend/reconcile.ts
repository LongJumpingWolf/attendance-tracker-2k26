/**
 * The reconciliation / mismatch model (Phase 6A): pure comparison of the authoritative Firebase state against the
 * Supabase shadow state. READ-ONLY: every function takes plain values and returns a list of mismatches. Nothing here
 * accepts a store, a writer or a database handle, so it cannot overwrite Firebase (or Supabase). It creates no records;
 * persisting mismatches is a later phase, and Firebase wins every disagreement during shadow operation.
 *
 * The sync blob is opaque: it is compared as a string, never parsed.
 */
import type { StoredSync } from "./contracts"

export type MismatchKind =
  /** Firebase has it, the shadow does not (a mirror write was missed or failed) */
  | "missing-in-supabase"
  /** the shadow has it, Firebase does not (deleted in Firebase, or written without Firebase) */
  | "missing-in-firebase"
  /** both have it, the contents differ */
  | "value-mismatch"
  /** both have it, the revisions differ (a stale mirror, or a lost update) */
  | "revision-mismatch"
  /** the record belongs to different accounts on the two sides */
  | "auth-mismatch"
  /** a connection/Ping points at different people or a different request on the two sides */
  | "relation-mismatch"
  /** a record the migration does not expect to exist at all (wrong shape, wrong namespace) */
  | "unexpected-record"

export type MismatchEntity = "sync" | "profile" | "connection" | "ping" | "pushToken"

export interface Mismatch {
  kind: MismatchKind
  entity: MismatchEntity
  /** The record id (a uid for sync, profiles and push tokens) */
  key: string
  /** A short, non-secret explanation. Never contains the record contents (the sync blob is the user's whole backup). */
  detail: string
}

export interface ReconciliationReport {
  /** Always "firebase": nothing in the model can make the shadow win */
  authoritative: "firebase"
  mismatches: Mismatch[]
}

const mismatch = (kind: MismatchKind, entity: MismatchEntity, key: string, detail: string): Mismatch => ({ kind, entity, key, detail })

/** One sync document per Google account. Compares revision first, then the opaque text. */
export function compareSync(owner: string, firebase: StoredSync | null, supabase: StoredSync | null): Mismatch[] {
  if (!firebase && !supabase) return []
  if (firebase && !supabase) return [mismatch("missing-in-supabase", "sync", owner, `firebase rev ${firebase.rev}`)]
  if (!firebase && supabase) return [mismatch("missing-in-firebase", "sync", owner, `supabase rev ${supabase!.rev}`)]
  const f = firebase!
  const s = supabase!
  if (f.rev !== s.rev) return [mismatch("revision-mismatch", "sync", owner, `firebase rev ${f.rev}, supabase rev ${s.rev}`)]
  if (f.data !== s.data) return [mismatch("value-mismatch", "sync", owner, `same rev ${f.rev}, different stored text (${f.data.length} vs ${s.data.length} chars)`)]
  return []
}

export interface CollectionDiff<T> {
  entity: MismatchEntity
  firebase: ReadonlyMap<string, T>
  supabase: ReadonlyMap<string, T>
  /** Defaults to deep JSON equality. Never used for the sync blob (use compareSync). */
  equal?: (a: T, b: T) => boolean
  /** When given, differing revisions are reported as revision-mismatch before values are compared */
  revisionOf?: (v: T) => number | undefined
  /** Keys the migration expects to see in the shadow; anything else there is an unexpected-record */
  isExpectedKey?: (key: string) => boolean
}

export function diffCollections<T>(d: CollectionDiff<T>): Mismatch[] {
  const equal = d.equal ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b))
  const out: Mismatch[] = []
  for (const [key, f] of d.firebase) {
    const s = d.supabase.get(key)
    if (s === undefined) {
      out.push(mismatch("missing-in-supabase", d.entity, key, "not mirrored"))
      continue
    }
    const fr = d.revisionOf?.(f)
    const sr = d.revisionOf?.(s)
    if (fr !== undefined && sr !== undefined && fr !== sr) out.push(mismatch("revision-mismatch", d.entity, key, `firebase rev ${fr}, supabase rev ${sr}`))
    else if (!equal(f, s)) out.push(mismatch("value-mismatch", d.entity, key, "contents differ"))
  }
  for (const key of d.supabase.keys()) {
    if (d.firebase.has(key)) continue
    out.push(d.isExpectedKey && !d.isExpectedKey(key) ? mismatch("unexpected-record", d.entity, key, "key not expected in the shadow") : mismatch("missing-in-firebase", d.entity, key, "only in the shadow"))
  }
  return out
}

/** The owner of a record must be the same account on both sides (Firebase uid vs the Supabase JWT `sub` it was written under) */
export function checkOwner(entity: MismatchEntity, key: string, firebaseOwner: string, supabaseOwner: string): Mismatch[] {
  return firebaseOwner === supabaseOwner ? [] : [mismatch("auth-mismatch", entity, key, "the record belongs to a different account on each side")]
}

export interface Relation {
  /** the two accounts involved, any order */
  participants: readonly string[]
  /** the connection a Ping rides on, or the status of a connection */
  requestId?: string
  status?: string
}

/** Connections and Pings: the same people (and the same request/status) on both sides, regardless of order */
export function compareRelation(entity: "connection" | "ping", key: string, firebase: Relation, supabase: Relation): Mismatch[] {
  const people = (r: Relation) => [...r.participants].sort().join("|")
  if (people(firebase) !== people(supabase)) return [mismatch("relation-mismatch", entity, key, "different participants")]
  if (firebase.requestId !== supabase.requestId) return [mismatch("relation-mismatch", entity, key, "different connection request")]
  if (firebase.status !== supabase.status) return [mismatch("relation-mismatch", entity, key, `status ${firebase.status} vs ${supabase.status}`)]
  return []
}

/** Gathers mismatches into the one report type. The authority is fixed and cannot be changed by the caller. */
export function buildReport(mismatches: Mismatch[]): ReconciliationReport {
  return { authoritative: "firebase", mismatches }
}
