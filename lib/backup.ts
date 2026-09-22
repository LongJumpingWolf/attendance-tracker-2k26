/**
 * The full backup: one JSON file that holds everything the app keeps on this device, so restoring it
 * brings back exactly what was saved (class days, every mark, plans, mates and reminders included).
 */
import type { Mate, Subject, Task } from "./types"
import type { ScheduleEntry } from "./reminders"

export const BACKUP_APP = "college-tracker"
export const BACKUP_VERSION = 1

export interface FullBackupData {
  subjects: Subject[]
  tasks: Task[]
  tags: string[]
  mates: Mate[]
  reminders: ScheduleEntry[]
}

export interface FullBackup {
  app: typeof BACKUP_APP
  version: number
  exportedAt: string
  data: FullBackupData
}

export const buildBackup = (data: FullBackupData): string =>
  JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data } satisfies FullBackup, null, 2)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const list = <T>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(ok) : [])

const isSubject = (x: unknown): x is Subject =>
  isObj(x) && typeof x.id === "string" && typeof x.name === "string" && typeof x.attended === "number" && typeof x.missed === "number" && typeof x.requirement === "number"
const isTask = (x: unknown): x is Task => isObj(x) && typeof x.id === "string" && typeof x.title === "string" && typeof x.dueDate === "string"
const isMate = (x: unknown): x is Mate => isObj(x) && typeof x.id === "string" && typeof x.name === "string" && typeof x.covered === "number" && typeof x.repaid === "number"
const isReminder = (x: unknown): x is ScheduleEntry =>
  isObj(x) && typeof x.id === "string" && typeof x.day === "number" && typeof x.startTime === "string" && typeof x.endTime === "string" && typeof x.subjectName === "string"
const isString = (x: unknown): x is string => typeof x === "string"

/** Reads a backup file's text. Anything that isn't a backup from this app is rejected rather than half-loaded. */
export function parseFullBackup(text: string): { ok: true; data: FullBackupData } | { ok: false; error: string } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, error: "That isn't a backup file." }
  }
  if (!isObj(raw) || raw.app !== BACKUP_APP || !isObj(raw.data)) return { ok: false, error: "That file isn't a College Tracker backup." }
  if (typeof raw.version === "number" && raw.version > BACKUP_VERSION) return { ok: false, error: "This backup is from a newer version of the app. Update the app first." }
  const d = raw.data
  return {
    ok: true,
    data: {
      subjects: list(d.subjects, isSubject),
      tasks: list(d.tasks, isTask),
      tags: list(d.tags, isString),
      mates: list(d.mates, isMate),
      reminders: list(d.reminders, isReminder),
    },
  }
}

/** Saves text as a file through the browser */
export function downloadText(filename: string, text: string, mime = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type: mime }))
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
