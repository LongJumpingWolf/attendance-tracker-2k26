/**
 * Restore points: automatic copies of this device's data, saved just before anything could overwrite it
 * (a sync that brings in another device's changes, joining an account, restoring a backup, resetting).
 * They live in IndexedDB on this device, newest first, so a bad merge or a mistake is always recoverable. None is ever
 * removed automatically. Writes are serialized and read back (see saveRestorePoint).
 */
import { dbGet, dbSet } from "./db"
import { same } from "./merge"
import { newId } from "./ids"
import type { FullBackupData } from "./backup"

export interface RestorePoint {
  id: string
  at: number
  reason: string
  data: FullBackupData
  /**
   * Set when the point is read back (never stored): false for a point saved before reminders were kept in it. Its `reminders` is then
   * an empty list that means "not recorded", so restoring it must leave the reminders on this device alone.
   */
  remindersKnown?: boolean
  /** Likewise for tags and mates: false means "this older point never recorded them", which is not the same as "there were none" */
  tagsKnown?: boolean
  matesKnown?: boolean
  holidaysKnown?: boolean
  scheduleOverridesKnown?: boolean
}

const KEY = "restorePoints"

/**
 * Whether a copy holds anything worth a restore point. Tags alone and reminders alone count: they are things the person made and
 * cannot get back, and they used to be treated as empty (so a "safety copy" of them was silently not made). Everything that decides
 * "can this be protected?" uses this one rule.
 */
export const holdsSomething = (d: FullBackupData): boolean => d.subjects.length + d.tasks.length + d.tags.length + d.mates.length + d.reminders.length + (d.holidays?.length ?? 0) + (d.scheduleOverrides?.length ?? 0) > 0

const isEmpty = (d: FullBackupData) => !holdsSomething(d)

const list = <T,>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : [])

/** Points written by older versions may lack lists that exist now; they are read with empty ones instead of crashing the screen */
function readable(p: RestorePoint): RestorePoint | null {
  if (!p || typeof p !== "object" || typeof p.id !== "string" || !p.data || typeof p.data !== "object") return null
  const d = p.data as Partial<FullBackupData>
  return {
    id: p.id,
    at: typeof p.at === "number" ? p.at : 0,
    reason: typeof p.reason === "string" ? p.reason : "Restore point",
    data: { subjects: list(d.subjects), tasks: list(d.tasks), tags: list(d.tags), mates: list(d.mates), reminders: list(d.reminders), ...(Array.isArray(d.holidays) ? { holidays: list(d.holidays) } : {}), ...(Array.isArray(d.scheduleOverrides) ? { scheduleOverrides: list(d.scheduleOverrides) } : {}) },
    remindersKnown: Array.isArray(d.reminders),
    tagsKnown: Array.isArray(d.tags),
    matesKnown: Array.isArray(d.mates),
    holidaysKnown: Array.isArray(d.holidays),
    scheduleOverridesKnown: Array.isArray(d.scheduleOverrides),
  }
}

/** The list exactly as stored. Writes start from THIS, never from the normalised view, so an older point is never rewritten as something it was not. */
async function stored(): Promise<unknown[]> {
  const found = await dbGet<unknown[]>(KEY)
  return Array.isArray(found) ? found : []
}

export async function listRestorePoints(): Promise<RestorePoint[]> {
  return (await stored()).map((p) => readable(p as RestorePoint)).filter((p): p is RestorePoint => p !== null)
}

const noun = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What a point holds, including tags, mates and reminders (a point of only those is still a point) */
export function contents(p: RestorePoint): string {
  const d = p.data
  const parts = [
    d.subjects.length && noun(d.subjects.length, "subject", "subjects"),
    d.tasks.length && noun(d.tasks.length, "deadline", "deadlines"),
    d.tags.length && noun(d.tags.length, "tag", "tags"),
    d.mates.length && noun(d.mates.length, "mate", "mates"),
    p.remindersKnown !== false && d.reminders.length && noun(d.reminders.length, "reminder", "reminders"),
    p.holidaysKnown !== false && (d.holidays?.length ?? 0) && noun(d.holidays!.length, "holiday", "holidays"),
    p.scheduleOverridesKnown !== false && (d.scheduleOverrides?.length ?? 0) && noun(d.scheduleOverrides!.length, "timetable change", "timetable changes"),
  ].filter(Boolean)
  return parts.length ? parts.join(", ") : "nothing recorded"
}

/** A restore point could not be saved, or could not be read back after saving. Callers must treat the data as unprotected. */
export class RestorePointError extends Error {
  constructor(message = "The safety copy could not be saved on this device. If storage is full, delete older restore points under Settings > Backup & restore and try again.") {
    super(message)
    this.name = "RestorePointError"
  }
}

/**
 * Every change to the list is read-then-rewrite of one stored value, so two overlapping calls would lose one of them.
 * They run one after another instead. A failed call does not stop the ones queued behind it.
 */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job)
  queue = run.catch(() => {})
  return run
}

/**
 * Saves a copy unless it is empty or identical to the newest one. After writing, the list is read back from storage and
 * the copy must be in it; if it is not (storage full or blocked) this throws RestorePointError rather than claiming success.
 */
export function saveRestorePoint(reason: string, data: FullBackupData): Promise<void> {
  return serial(async () => {
    if (isEmpty(data)) return
    const all = await stored()
    const newest = (await listRestorePoints())[0]
    if (newest && same(newest.data, data)) return
    // Never trimmed automatically: only the person deleting one removes it
    const point: RestorePoint = { id: newId(), at: Date.now(), reason, data }
    await dbSet(KEY, [point, ...all])
    const back = (await listRestorePoints()).find((p) => p.id === point.id)
    if (!back || !same(back.data, data)) throw new RestorePointError()
  })
}

export function deleteRestorePoint(id: string): Promise<void> {
  return serial(async () => {
    await dbSet(KEY, (await stored()).filter((p) => (p as RestorePoint)?.id !== id))
  })
}
