/**
 * The full backup: one JSON file that holds everything the app keeps on this device, so restoring it
 * brings back exactly what was saved (class days, every mark, plans, mates and reminders included).
 */
import type { Holiday, LogEntry, Mate, ScheduleOverride, Slot, Subject, Task } from "./types"
import type { ScheduleEntry } from "./reminders"

export const BACKUP_APP = "college-tracker"
export const BACKUP_VERSION = 1

export interface FullBackupData {
  subjects: Subject[]
  tasks: Task[]
  tags: string[]
  mates: Mate[]
  reminders: ScheduleEntry[]
  /** Custom holiday ranges. Optional so older backups remain readable. */
  holidays?: Holiday[]
  /** Date-specific cancellations/substitutions. Optional so older backups remain readable. */
  scheduleOverrides?: ScheduleOverride[]
}

export interface FullBackup {
  app: typeof BACKUP_APP
  version: number
  exportedAt: string
  data: FullBackupData
}

/** `pretty` is for files people open; sync sends the compact form */
export const buildBackup = (data: FullBackupData, pretty = true): string =>
  JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: new Date().toISOString(), data } satisfies FullBackup, null, pretty ? 2 : 0)

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null
const list = <T>(v: unknown, ok: (x: unknown) => x is T): T[] => (Array.isArray(v) ? v.filter(ok) : [])

const isSubject = (x: unknown): x is Subject =>
  isObj(x) && typeof x.id === "string" && typeof x.name === "string" && typeof x.attended === "number" && typeof x.missed === "number" && typeof x.requirement === "number"
const isLog = (x: unknown): x is LogEntry => isObj(x) && typeof x.d === "string" && (x.s === "P" || x.s === "A")
const isSlot = (x: unknown): x is Slot => isObj(x) && typeof x.day === "number" && Number.isInteger(x.day) && x.day >= 0 && x.day <= 6 && typeof x.start === "string" && typeof x.end === "string"
/**
 * The checks above only prove a subject has its counts. The lists and the plan are read everywhere (`tags.filter`, `log.map`,
 * the planner), so a hand-edited or damaged file with `tags` missing or `log: {}` would crash every screen and every sync
 * merge that touches it, and the bad shape would then be saved and synced to every device. Repair them on the way in.
 */
function cleanSubject(s: Subject): Subject {
  const out: Subject = { ...s, tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === "string") : [], glowColor: typeof s.glowColor === "string" ? s.glowColor : "#0a84ff" }
  if (s.log !== undefined) out.log = Array.isArray(s.log) ? s.log.filter(isLog) : []
  if (s.slots !== undefined) out.slots = Array.isArray(s.slots) ? s.slots.filter(isSlot) : []
  if (s.plan !== undefined) {
    out.plan = isObj(s.plan) && !Array.isArray(s.plan) ? (Object.fromEntries(Object.entries(s.plan).filter(([, v]) => v === "attend" || v === "skip")) as Subject["plan"]) : {}
  }
  return out
}
const isTask = (x: unknown): x is Task => isObj(x) && typeof x.id === "string" && typeof x.title === "string" && typeof x.dueDate === "string"
const isMate = (x: unknown): x is Mate => isObj(x) && typeof x.id === "string" && typeof x.name === "string" && typeof x.covered === "number" && typeof x.repaid === "number"
const isReminder = (x: unknown): x is ScheduleEntry =>
  isObj(x) && typeof x.id === "string" && (x.subjectId === undefined || typeof x.subjectId === "string") && typeof x.day === "number" && typeof x.startTime === "string" && typeof x.endTime === "string" && typeof x.subjectName === "string"
const isString = (x: unknown): x is string => typeof x === "string"
const isHoliday = (x: unknown): x is Holiday => isObj(x) && typeof x.id === "string" && typeof x.date === "string" && typeof x.name === "string" && (x.endDate === undefined || typeof x.endDate === "string")
const isOverride = (x: unknown): x is ScheduleOverride => isObj(x) && typeof x.id === "string" && typeof x.date === "string" && typeof x.originalSubjectId === "string" && typeof x.start === "string" && (x.kind === "cancelled" || x.kind === "substitute") && (x.kind !== "substitute" || typeof x.substituteSubjectId === "string")

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
      subjects: list(d.subjects, isSubject).map(cleanSubject),
      tasks: list(d.tasks, isTask),
      tags: list(d.tags, isString),
      mates: list(d.mates, isMate),
      reminders: list(d.reminders, isReminder),
      ...(Array.isArray(d.holidays) ? { holidays: list(d.holidays, isHoliday) } : {}),
      ...(Array.isArray(d.scheduleOverrides) ? { scheduleOverrides: list(d.scheduleOverrides, isOverride) } : {}),
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
  // Some mobile browsers start downloads asynchronously; revoking immediately can invalidate the blob URL.
  window.setTimeout(() => URL.revokeObjectURL(url), 3000)
}
