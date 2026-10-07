/**
 * Restore points: automatic copies of this device's data, saved just before anything could overwrite it
 * (a sync that brings in another device's changes, joining an account, restoring a backup, resetting).
 * They live in IndexedDB on this device, newest first, so a bad merge or a mistake is always recoverable. None is ever
 * removed automatically.
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
}

const KEY = "restorePoints"

const isEmpty = (d: FullBackupData) => d.subjects.length + d.tasks.length + d.mates.length === 0

export async function listRestorePoints(): Promise<RestorePoint[]> {
  const found = await dbGet<RestorePoint[]>(KEY)
  return Array.isArray(found) ? found : []
}

/** Saves a copy unless it is empty or identical to the newest one */
export async function saveRestorePoint(reason: string, data: FullBackupData): Promise<void> {
  if (isEmpty(data)) return
  const all = await listRestorePoints()
  if (all[0] && same(all[0].data, data)) return
  // Never trimmed automatically: only the person deleting one removes it
  await dbSet(KEY, [{ id: newId(), at: Date.now(), reason, data }, ...all])
}

export async function deleteRestorePoint(id: string): Promise<void> {
  await dbSet(KEY, (await listRestorePoints()).filter((p) => p.id !== id))
}
