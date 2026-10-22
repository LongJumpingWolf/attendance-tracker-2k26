/**
 * Read-back checks for replacing or wiping this device's data: "the screen shows it" is not "it is stored". The app persists its
 * data asynchronously and lib/db.ts reports nothing when storage refuses a write, so success is only claimed when the stored
 * value is found. Used by lib/safe-replace.ts through app/page.tsx.
 */
import type { BackupData } from "./backup-import"
import { dbGet } from "./db"
import { same } from "./merge"

/** Everything "Start fresh" removes from this device (the theme stays) */
export const RESET_LOCAL_KEYS = [
  "subjects", "tasks", "tags", "mates", "holidays", "scheduleOverrides", "notificationSchedule", "pingSeenIds", "appliedPings", "pingPresented", "pingSendKeys",
  "wrappedSeenWeek", "demo-pings", "mock-pings", "subjectsView", "onboardingDone", "attendance-usage-analytics-consent",
] as const
export const RESET_DB_KEYS = ["subjects", "tasks", "tags", "mates", "holidays", "scheduleOverrides", "syncBase", "syncBaseV2", "syncUncertain"] as const
/** the part of the above that holds the person's data (after a reset these may be stored as an empty list or be gone) */
const LISTS = ["subjects", "tasks", "tags", "mates", "holidays", "scheduleOverrides"] as const

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function until(check: () => Promise<boolean>, timeoutMs: number, pollMs: number): Promise<boolean> {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await check()) return true
    } catch {
      /* try again until the time is up */
    }
    if (Date.now() >= end) return false
    await sleep(pollMs)
  }
}

/** True once storage holds exactly the subjects, deadlines, tags and mates of `d` */
export function dataPersisted(d: BackupData, timeoutMs = 5000, pollMs = 100): Promise<boolean> {
  return until(
    async () => {
      const [subjects, tasks, tags, mates, holidays, scheduleOverrides] = await Promise.all([dbGet("subjects"), dbGet("tasks"), dbGet("tags"), dbGet("mates"), dbGet("holidays"), dbGet("scheduleOverrides")])
      return same(subjects ?? [], d.subjects) && same(tasks ?? [], d.tasks) && same(tags ?? [], d.tags) && same(mates ?? [], d.mates ?? []) &&
        (d.holidays === undefined || same(holidays ?? [], d.holidays)) && (d.scheduleOverrides === undefined || same(scheduleOverrides ?? [], d.scheduleOverrides))
    },
    timeoutMs,
    pollMs,
  )
}

/** True once none of what a reset removes is still stored */
export function resetIsComplete(timeoutMs = 3000, pollMs = 100): Promise<boolean> {
  return until(
    async () => {
      for (const k of RESET_LOCAL_KEYS) {
        const v = localStorage.getItem(k)
        if (v === null) continue
        if ((LISTS as readonly string[]).includes(k) && v === "[]") continue // when IndexedDB is unavailable the empty list is kept here
        return false
      }
      for (const k of RESET_DB_KEYS) {
        const v = await dbGet<unknown>(k)
        if (v === undefined) continue
        if ((LISTS as readonly string[]).includes(k) && Array.isArray(v) && v.length === 0) continue // the empty state, saved again after the wipe
        return false
      }
      return true
    },
    timeoutMs,
    pollMs,
  )
}
