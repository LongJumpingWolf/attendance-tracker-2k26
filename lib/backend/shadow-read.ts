/**
 * The read-only shadow reader and reconciliation report (Phase 7 preparation).
 *
 * It answers one question for the SIGNED-IN user: does the Supabase copy of my sync backup and my profile name agree with the
 * authoritative Firebase copy? Firebase is always the reference; the shadow can never win, and nothing is ever repaired.
 *
 * Guarantees (each is a test in tests/phase7-shadow-read.test.ts and tests/shadow-integration/shadow-read.test.ts):
 *  - READ ONLY. The reader is handed a narrow surface, `{ sync.get, profiles.getName }`, built by `readSurface()`. The write
 *    methods of the backends are never reachable from here, so there is nothing to call by mistake.
 *  - ONE USER. Only the current user's own uid is ever read. If the account changes while reading, the result is discarded.
 *  - NO DATA IN THE REPORT. It holds statuses, revision numbers, lengths and a shortened uid. Never the sync blob, a name, a
 *    token or the full uid. The reader writes no logs.
 *  - DISTINCT OUTCOMES. match / mismatch (typed) / Firebase-side error / Supabase-side error (unavailable, unauthorized,
 *    malformed, invalid, unknown) / skipped. A failure to read is never reported as "missing".
 *  - AUTH PROBE FIRST. A token the database guard does not accept makes a table read return zero rows (fail closed), which
 *    would look like "missing in Supabase". The profile read goes through an RPC that raises for such a token, so it runs first
 *    and a refusal marks BOTH domains as a Supabase-side error instead of a false "missing".
 *  - CONFIRMED MISMATCHES. Firebase and Supabase are read a moment apart, and shadow writes are asynchronous, so a difference is
 *    read once more after a short pause before it is reported.
 */
import type { Backend, StoredSync } from "./contracts"
import { BackendError } from "./errors"
import { compareSync, diffCollections, type Mismatch } from "./reconcile"
import { redactUid } from "./shadow-diagnostics"

/** The only operations the reader can perform on either backend */
export interface ReadSurface {
  sync: { get(owner: string): Promise<StoredSync | null> }
  profiles: { getName(uid: string): Promise<string | null> }
}

/** Narrows a backend to the read surface. The returned object holds no reference to any write method. */
export function readSurface(b: Pick<Backend, "sync" | "profiles">): ReadSurface {
  return {
    sync: { get: (owner) => b.sync.get(owner) },
    profiles: { getName: (uid) => b.profiles.getName(uid) },
  }
}

export type ReadErrorReason = "unavailable" | "unauthorized" | "malformed" | "invalid" | "unknown"

export type DomainOutcome =
  | { status: "match" }
  | { status: "mismatch"; mismatches: ClassifiedMismatch[] }
  /** the authoritative read failed: nothing can be concluded about the shadow */
  | { status: "firebase-error"; reason: ReadErrorReason }
  /** the shadow read failed: this is NOT "missing" */
  | { status: "shadow-error"; reason: ReadErrorReason }

export interface ClassifiedMismatch extends Mismatch {
  /** For revision mismatches: whether the shadow is behind (usually mirror lag) or ahead of Firebase (never expected) */
  lag?: "supabase-behind" | "supabase-ahead"
  /** True when the difference was still there after the second read */
  confirmed: boolean
}

export interface ShadowReadReport {
  authoritative: "firebase"
  readOnly: true
  /** First four characters of the uid and *** */
  who: string
  at: number
  /** true when a first difference was read a second time */
  rechecked: boolean
  sync: DomainOutcome
  profile: DomainOutcome
}

export type ShadowReadResult = { status: "skipped"; reason: "no-user" | "identity-changed" } | { status: "done"; report: ShadowReadReport }

export interface ShadowReaderDeps {
  authoritative: ReadSurface
  shadow: ReadSurface
  /** The current Firebase user's uid, or null when nobody is signed in. The ONLY source of the uid that is read. */
  currentUid: () => string | null
  /** pause before re-reading a difference; default 750 ms */
  recheckDelayMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const reasonOf = (e: unknown): ReadErrorReason => {
  const be = e as Partial<BackendError> | null
  if (be?.code === "supabase-malformed") return "malformed"
  switch (be?.kind) {
    case "unavailable":
      return "unavailable"
    case "unauthorized":
      return "unauthorized"
    case "invalid":
      return "invalid"
    default:
      return "unknown"
  }
}

type Read<T> = { ok: true; value: T } | { ok: false; reason: ReadErrorReason }
async function attempt<T>(f: () => Promise<T>): Promise<Read<T>> {
  try {
    return { ok: true, value: await f() }
  } catch (e) {
    return { ok: false, reason: reasonOf(e) }
  }
}

/** A row from the shadow that does not have the shape of a stored sync is "malformed", not a value to compare */
const wellFormed = (s: StoredSync | null): boolean =>
  s === null || (typeof s.data === "string" && Number.isInteger(s.rev) && s.rev >= 0 && typeof s.updatedAt === "number" && Number.isFinite(s.updatedAt))

const classify = (m: Mismatch): ClassifiedMismatch => {
  const rev = /firebase rev (\d+), supabase rev (\d+)/.exec(m.detail)
  const lag = m.kind === "revision-mismatch" && rev ? (Number(rev[2]) < Number(rev[1]) ? "supabase-behind" : "supabase-ahead") : undefined
  return { ...m, key: redactUid(m.key), ...(lag ? { lag } : {}), confirmed: false }
}

function compareProfile(uid: string, firebase: string | null, supabase: string | null): Mismatch[] {
  const one = (name: string | null) => new Map<string, string>(name === null ? [] : [[uid, name]])
  return diffCollections<string>({ entity: "profile", firebase: one(firebase), supabase: one(supabase), equal: (a, b) => a === b })
}

export interface ShadowReader {
  run(): Promise<ShadowReadResult>
}

export function createShadowReader(deps: ShadowReaderDeps): ShadowReader {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const now = deps.now ?? Date.now

  /** One pass over both domains for ONE uid. */
  async function pass(uid: string): Promise<{ sync: DomainOutcome; profile: DomainOutcome }> {
    // 1. the profile read doubles as the authorization probe for the shadow (it goes through an RPC that raises for an unacceptable token)
    const [fbName, sbName] = await Promise.all([attempt(() => deps.authoritative.profiles.getName(uid)), attempt(() => deps.shadow.profiles.getName(uid))])
    let profile: DomainOutcome
    if (!fbName.ok) profile = { status: "firebase-error", reason: fbName.reason }
    else if (!sbName.ok) profile = { status: "shadow-error", reason: sbName.reason }
    else {
      const m = compareProfile(uid, fbName.value, sbName.value)
      profile = m.length === 0 ? { status: "match" } : { status: "mismatch", mismatches: m.map(classify) }
    }
    // 2. a refused or unreachable shadow means the sync read would be meaningless (a refused table read returns zero rows)
    if (sbName.ok === false && (sbName.reason === "unauthorized" || sbName.reason === "unavailable")) {
      return { profile, sync: { status: "shadow-error", reason: sbName.reason } }
    }
    const [fbSync, sbSync] = await Promise.all([attempt(() => deps.authoritative.sync.get(uid)), attempt(() => deps.shadow.sync.get(uid))])
    let sync: DomainOutcome
    if (!fbSync.ok) sync = { status: "firebase-error", reason: fbSync.reason }
    else if (!sbSync.ok) sync = { status: "shadow-error", reason: sbSync.reason }
    else if (!wellFormed(sbSync.value)) sync = { status: "shadow-error", reason: "malformed" }
    else if (!wellFormed(fbSync.value)) sync = { status: "firebase-error", reason: "malformed" }
    else {
      const m = compareSync(uid, fbSync.value, sbSync.value)
      sync = m.length === 0 ? { status: "match" } : { status: "mismatch", mismatches: m.map(classify) }
    }
    return { sync, profile }
  }

  return {
    async run(): Promise<ShadowReadResult> {
      const uid = deps.currentUid()
      if (!uid) return { status: "skipped", reason: "no-user" }
      let result = await pass(uid)
      let rechecked = false
      if (result.sync.status === "mismatch" || result.profile.status === "mismatch") {
        // writes are asynchronous and the two reads are not simultaneous: confirm before reporting
        await sleep(deps.recheckDelayMs ?? 750)
        if (deps.currentUid() !== uid) return { status: "skipped", reason: "identity-changed" }
        result = await pass(uid)
        rechecked = true
        for (const d of [result.sync, result.profile]) if (d.status === "mismatch") d.mismatches.forEach((m) => (m.confirmed = true))
      }
      if (deps.currentUid() !== uid) return { status: "skipped", reason: "identity-changed" } // the account changed under us: discard everything
      return { status: "done", report: { authoritative: "firebase", readOnly: true, who: redactUid(uid), at: now(), rechecked, sync: result.sync, profile: result.profile } }
    },
  }
}

// ---- the report ----------------------------------------------------------------------------------------------------

const describe = (d: DomainOutcome): string => {
  switch (d.status) {
    case "match":
      return "match"
    case "mismatch":
      return d.mismatches.map((m) => `${m.kind}${m.lag ? ` (${m.lag})` : ""}${m.confirmed ? " [confirmed]" : " [unconfirmed]"}: ${m.detail}`).join("; ")
    case "firebase-error":
      return `FIREBASE READ FAILED (${d.reason}): nothing concluded`
    case "shadow-error":
      return `SUPABASE READ FAILED (${d.reason}): not the same as missing`
  }
}

/** Plain text, safe to paste: statuses, revisions and lengths only. */
export function formatShadowReadReport(r: ShadowReadResult): string {
  if (r.status === "skipped") return `shadow read skipped (${r.reason}); nothing was read`
  const x = r.report
  return [
    `Shadow read, read-only. Reference: Firebase (authoritative). Account: ${x.who}. Re-read before reporting: ${x.rechecked ? "yes" : "no"}.`,
    `  sync:    ${describe(x.sync)}`,
    `  profile: ${describe(x.profile)}`,
    `  verdict: ${verdict(x)}`,
  ].join("\n")
}

/** "clean" only when both domains match; "inconclusive" when a read failed; otherwise "differs" */
export function verdict(x: ShadowReadReport): "clean" | "differs" | "inconclusive" {
  const ds = [x.sync, x.profile]
  if (ds.some((d) => d.status === "firebase-error" || d.status === "shadow-error")) return "inconclusive"
  return ds.every((d) => d.status === "match") ? "clean" : "differs"
}
