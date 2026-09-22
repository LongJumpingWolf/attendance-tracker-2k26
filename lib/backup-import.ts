/**
 * Reads a backup file (the ZIP of Excel sheets the app exports, or an older CSV) into app data.
 * Dates are accepted as real dates, Excel serial numbers, YYYY-MM-DD or DD/MM/YYYY.
 */
import type { Mate, Subject, Task } from "./types"
import type { ScheduleEntry } from "./reminders"
import { parseFullBackup } from "./backup"

export interface BackupData {
  subjects: Subject[]
  tasks: Task[]
  tags: string[]
  /** Only in a full backup */
  mates?: Mate[]
  reminders?: ScheduleEntry[]
  /** true for a full JSON backup, which restores everything exactly. Older spreadsheet backups are partial. */
  full?: boolean
}

const pad = (n: number) => String(n).padStart(2, "0")
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

function toYMD(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null
  if (value instanceof Date) return ymd(value)
  if (typeof value === "number") return ymd(new Date(Date.UTC(1899, 11, 30) + value * 86400000))
  const s = String(value).trim()
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s)
  if (iso) return `${iso[1]}-${pad(Number(iso[2]))}-${pad(Number(iso[3]))}`
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s) // this app exports DD/MM/YYYY
  if (slash) return `${slash[3]}-${pad(Number(slash[2]))}-${pad(Number(slash[1]))}`
  const parsed = new Date(s)
  return isNaN(parsed.getTime()) ? null : ymd(parsed)
}

function parseCSVLine(line: string): string[] {
  const out: string[] = []
  let cur = ""
  let quoted = false
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (ch === "," && !quoted) {
      out.push(cur.trim())
      cur = ""
    } else cur += ch
  }
  out.push(cur.trim())
  return out
}

const uid = (i: number) => `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`

async function zipRows(entry: { async: (t: "arraybuffer") => Promise<ArrayBuffer> }) {
  const ExcelJS = (await import("exceljs")).default
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(await entry.async("arraybuffer"))
  const rows: { cell: (n: number) => unknown }[] = []
  wb.worksheets[0]?.eachRow((row, n) => {
    if (n > 1) rows.push({ cell: (i) => row.getCell(i).value })
  })
  return rows
}

async function fromZip(buffer: ArrayBuffer): Promise<BackupData> {
  const JSZip = (await import("jszip")).default
  const zip = await new JSZip().loadAsync(buffer)
  const data: BackupData = { subjects: [], tasks: [], tags: [] }
  let i = 0

  for (const [name, entry] of Object.entries(zip.files)) {
    if (name.startsWith("__MACOSX")) continue
    if (name.includes("Attendance")) {
      for (const r of await zipRows(entry)) {
        data.subjects.push({
          id: uid(i++),
          name: String(r.cell(1) ?? ""),
          attended: Number(r.cell(2)) || 0,
          missed: Number(r.cell(3)) || 0,
          requirement: Number(String(r.cell(5) ?? "").replace("%", "")) || 75,
          glowColor: "#22c55e",
          tags: [],
        })
      }
    } else if (name.includes("Exams-Assignments")) {
      for (const r of await zipRows(entry)) {
        data.tasks.push({
          id: uid(i++),
          title: String(r.cell(1) ?? ""),
          dueDate: toYMD(r.cell(3)) ?? ymd(new Date()),
          remindDaysBefore: Number(r.cell(5)) || 0,
        })
      }
    } else if (name.includes("Tags")) {
      for (const r of await zipRows(entry)) {
        const tag = r.cell(1)
        if (tag) data.tags.push(String(tag))
      }
    }
  }
  data.subjects = data.subjects.filter((s) => s.name)
  data.tasks = data.tasks.filter((t) => t.title)
  return data
}

function fromCsv(text: string): BackupData {
  const data: BackupData = { subjects: [], tasks: [], tags: [] }
  const lines = text.split("\n")
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    const v = parseCSVLine(lines[i])
    if (v[0] === "subject") {
      data.subjects.push({
        id: v[1],
        name: v[2],
        attended: Number.parseInt(v[3]) || 0,
        missed: Number.parseInt(v[4]) || 0,
        requirement: Number.parseInt(v[5]) || 75,
        glowColor: v[6] || "#22c55e",
        tags: v[7] ? v[7].split("|") : [],
      })
    } else if (v[0] === "task") {
      data.tasks.push({
        id: v[1],
        title: v[8],
        dueDate: v[9],
        remindDaysBefore: v[11] ? Number.parseInt(v[11]) : 0,
      })
    } else if (v[0] === "tag" && v[2]) {
      data.tags.push(v[2])
    }
  }
  return data
}

/** Throws when the file can't be read at all; returns empty lists when it has nothing the app recognises. */
export async function parseBackupFile(file: File): Promise<BackupData> {
  if (file.name.toLowerCase().endsWith(".json")) {
    const r = parseFullBackup(await file.text())
    if (!r.ok) throw new Error(r.error)
    return { ...r.data, full: true }
  }
  if (file.name.toLowerCase().endsWith(".zip")) return fromZip(await file.arrayBuffer())
  return fromCsv(await file.text())
}
