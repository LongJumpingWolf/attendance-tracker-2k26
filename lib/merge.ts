/**
 * Three-way merge of two copies of the app's data that were both changed since they last agreed.
 *
 *   base   = the copy both sides last had in common (the last synced copy)
 *   local  = this device now
 *   remote = the stored copy now
 *
 * Nothing is dropped silently: an item added on either side is kept, an item deleted on one side is only deleted if the
 * other side left it alone, counts add up both sides' changes, and when the same field was changed differently on both
 * sides this device's value is kept and the clash is counted so the caller can save both copies as restore points.
 *
 * Output follows the stored copy's order (then this device's additions), so merging a copy that has no local changes
 * returns it unchanged and two devices can never keep rewriting each other's ordering.
 *
 * With no base (first sign-in on a device that already has data), items are matched by id, subjects and mates also by
 * name, and counts take the larger side rather than adding, so nothing is counted twice.
 */
import type { FullBackupData } from "./backup"
import type { LogEntry, Mate, Subject, Task } from "./types"
import type { ScheduleEntry } from "./reminders"

export interface MergeResult {
  data: FullBackupData
  /** Fields changed differently on both sides. This device's value was kept. */
  conflicts: number
}

type Tally = { n: number }

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x,
  )
export const same = (a: unknown, b: unknown) => canon(a) === canon(b)

/** Returns whichever of remote / local already equals the merged value, so unchanged data keeps its identity and order */
function prefer<T>(merged: T, remote: T, local: T): T {
  if (same(merged, remote)) return remote
  if (same(merged, local)) return local
  return merged
}

/** One value changed on one side or both */
function pick<T>(base: T | undefined, local: T | undefined, remote: T | undefined, t: Tally): T | undefined {
  if (same(local, remote)) return local
  if (same(base, local)) return remote
  if (same(base, remote)) return local
  t.n++
  return local
}

const norm = (s: string) => s.trim().toLowerCase()

/** Items with ids: added anywhere is kept, deleted only if the other side didn't touch it */
function mergeList<T extends { id: string }>(
  base: T[] | undefined,
  local: T[],
  remote: T[],
  item: (b: T | undefined, l: T, r: T) => T,
  t: Tally,
): T[] {
  const b = new Map((base ?? []).map((x) => [x.id, x]))
  const l = new Map(local.map((x) => [x.id, x]))
  const r = new Map(remote.map((x) => [x.id, x]))
  const out: T[] = []
  for (const x of remote) {
    const mine = l.get(x.id)
    const was = b.get(x.id)
    if (mine) out.push(item(was, mine, x))
    else if (!was) out.push(x) // added there
    else if (same(was, x)) continue // deleted here, untouched there
    else {
      t.n++ // deleted here but changed there: keep it
      out.push(x)
    }
  }
  for (const x of local) {
    if (r.has(x.id)) continue
    const was = b.get(x.id)
    if (!was) out.push(x) // added here
    else if (same(was, x)) continue // deleted there, untouched here
    else {
      t.n++ // deleted there but changed here: keep it
      out.push(x)
    }
  }
  return out
}

/** A plain list of strings treated as a set (tags) */
function mergeSet(base: string[] | undefined, local: string[], remote: string[]): string[] {
  const b = new Set(base ?? [])
  const l = new Set(local)
  const r = new Set(remote)
  const keep = (e: string) => (l.has(e) && r.has(e)) || (!b.has(e) && (l.has(e) || r.has(e)))
  const out = [...remote.filter(keep), ...local.filter((e) => !r.has(e) && keep(e))]
  return prefer(out, remote, local)
}

/** A counter several devices add to: base plus what each side added. Without a base, the larger side. */
const mergeCount = (base: number | undefined, local: number, remote: number) =>
  Math.max(0, base === undefined ? Math.max(local, remote) : base + (local - base) + (remote - base))

/** A list where the same value can repeat (favour dates): counts per value are merged like counters */
function mergeMultiset(base: string[] | undefined, local: string[] | undefined, remote: string[] | undefined, hasBase: boolean): string[] | undefined {
  if (!local && !remote) return undefined
  const tally = (a?: string[]) => {
    const m = new Map<string, number>()
    for (const x of a ?? []) m.set(x, (m.get(x) ?? 0) + 1)
    return m
  }
  const b = tally(base)
  const l = tally(local)
  const r = tally(remote)
  const out: string[] = []
  for (const k of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
    const n = mergeCount(hasBase ? (b.get(k) ?? 0) : undefined, l.get(k) ?? 0, r.get(k) ?? 0)
    for (let i = 0; i < n; i++) out.push(k)
  }
  out.sort()
  return prefer(out, remote ?? [], local ?? [])
}

/** Merges objects field by field. `special` handles fields that need more than "which side changed". */
function mergeObject<T extends object>(
  base: T | undefined,
  local: T,
  remote: T,
  t: Tally,
  special: Record<string, (b: unknown, l: unknown, r: unknown) => unknown> = {},
): T {
  const b = (base ?? {}) as Record<string, unknown>
  const l = local as Record<string, unknown>
  const r = remote as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of new Set([...Object.keys(r), ...Object.keys(l)])) {
    const v = special[k] ? special[k](b[k], l[k], r[k]) : pick(b[k], l[k], r[k], t)
    if (v !== undefined) out[k] = v
  }
  return prefer(out as T, remote, local)
}

const effect = (log: LogEntry[] | undefined) => {
  let P = 0
  let A = 0
  for (const e of log ?? []) {
    if (e.s === "P") P++
    else A++
  }
  return { P, A }
}
const entryKey = (e: LogEntry) => `${e.d}|${e.t ?? ""}`

function mergeLog(base: LogEntry[] | undefined, local: LogEntry[] | undefined, remote: LogEntry[] | undefined, t: Tally): LogEntry[] | undefined {
  if (!local && !remote) return undefined
  const withId = (a?: LogEntry[]) => (a ? a.map((e) => ({ ...e, id: entryKey(e) })) : undefined)
  const entries = mergeList(withId(base), withId(local) ?? [], withId(remote) ?? [], (b, l, r) => pick(b, l, r, t) as typeof l, t)
  const out = entries.map((e) => {
    const { id: _id, ...rest } = e
    return rest as LogEntry
  })
  return prefer(out, remote ?? [], local ?? [])
}

function mergeSubject(base: Subject | undefined, local: Subject, remote: Subject, t: Tally): Subject {
  const log = mergeLog(base?.log, local.log, remote.log, t)
  const merged = mergeObject(base, local, remote, t, {
    log: () => log,
    tags: (b, l, r) => mergeSet(b as string[] | undefined, (l as string[]) ?? [], (r as string[]) ?? []),
    plan: (b, l, r) => {
      if (l === undefined && r === undefined) return undefined
      const bp = (b ?? {}) as Record<string, string>
      const lp = (l ?? {}) as Record<string, string>
      const rp = (r ?? {}) as Record<string, string>
      const out: Record<string, string> = {}
      for (const k of new Set([...Object.keys(rp), ...Object.keys(lp)])) {
        const v = pick(bp[k], lp[k], rp[k], t)
        if (v !== undefined) out[k] = v
      }
      return out
    },
    attended: () => 0,
    missed: () => 0,
  })
  // Counts: what the merged log explains, plus whatever each side added by hand outside the log
  const em = effect(log)
  const count = (key: "attended" | "missed", ek: "P" | "A") => {
    const nonL = local[key] - effect(local.log)[ek]
    const nonR = remote[key] - effect(remote.log)[ek]
    if (!base) return Math.max(0, em[ek] + Math.max(nonL, nonR))
    return Math.max(0, em[ek] + nonL + nonR - (base[key] - effect(base.log)[ek]))
  }
  const out: Subject = { ...merged, attended: count("attended", "P"), missed: count("missed", "A") }
  return prefer(out, remote, local)
}

function mergeMate(base: Mate | undefined, local: Mate, remote: Mate, t: Tally): Mate {
  const hasBase = base !== undefined
  const num = (b: unknown, l: unknown, r: unknown) => mergeCount(b as number | undefined, l as number, r as number)
  const dates = (b: unknown, l: unknown, r: unknown) => mergeMultiset(b as string[], l as string[], r as string[], hasBase)
  return mergeObject(base, local, remote, t, { covered: num, repaid: num, coveredLog: dates, repaidLog: dates })
}

/** With no shared base, treat the same subject / mate on both sides as one thing even if its id differs */
function alignRemote(local: FullBackupData, remote: FullBackupData): FullBackupData {
  const subjectIds = new Map<string, string>()
  const subjects = remote.subjects.map((s) => {
    const mine = local.subjects.find((x) => x.id === s.id) ?? local.subjects.find((x) => norm(x.name) === norm(s.name))
    if (mine && mine.id !== s.id) subjectIds.set(s.id, mine.id)
    return mine ? { ...s, id: mine.id } : s
  })
  const mates = remote.mates.map((m) => {
    const mine = local.mates.find((x) => x.id === m.id) ?? local.mates.find((x) => (m.uid && x.uid === m.uid) || norm(x.name) === norm(m.name))
    return mine ? { ...m, id: mine.id } : m
  })
  const tasks = remote.tasks.map((k) => (k.subjectId && subjectIds.has(k.subjectId) ? { ...k, subjectId: subjectIds.get(k.subjectId) } : k))
  return { ...remote, subjects, mates, tasks }
}

export function mergeData(base: FullBackupData | null, local: FullBackupData, remoteIn: FullBackupData): MergeResult {
  const t: Tally = { n: 0 }
  const remote = base ? remoteIn : alignRemote(local, remoteIn)
  const data: FullBackupData = {
    subjects: mergeList(base?.subjects, local.subjects, remote.subjects, (b, l, r) => mergeSubject(b, l, r, t), t),
    tasks: mergeList<Task>(base?.tasks, local.tasks, remote.tasks, (b, l, r) => mergeObject(b, l, r, t), t),
    tags: mergeSet(base?.tags, local.tags, remote.tags),
    mates: mergeList(base?.mates, local.mates, remote.mates, (b, l, r) => mergeMate(b, l, r, t), t),
    reminders: mergeList<ScheduleEntry>(base?.reminders, local.reminders, remote.reminders, (b, l, r) => mergeObject(b, l, r, t), t),
  }
  return { data, conflicts: t.n }
}
