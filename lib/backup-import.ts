/**
 * Reads a full JSON backup file (the one "Save a full backup" makes) into app data.
 */
import type { Mate, Subject, Task } from "./types"
import type { ScheduleEntry } from "./reminders"
import { parseFullBackup } from "./backup"

export interface BackupData {
  subjects: Subject[]
  tasks: Task[]
  tags: string[]
  mates?: Mate[]
  reminders?: ScheduleEntry[]
  /** Always true for a JSON backup: everything comes back exactly as saved */
  full?: boolean
}

/** Throws when the file can't be read at all. */
export async function parseBackupFile(file: File): Promise<BackupData> {
  if (!file.name.toLowerCase().endsWith(".json")) throw new Error("Use a backup file saved from this app (it ends in .json).")
  const r = parseFullBackup(await file.text())
  if (!r.ok) throw new Error(r.error)
  return { ...r.data, full: true }
}
