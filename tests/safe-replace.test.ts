/**
 * Regression: replacing or wiping this device's data (backup restore, restore point, reset) must save a safety copy FIRST,
 * and when that fails, change nothing (data AND reminders), say so accurately, and never report success.
 *
 * The first half drives lib/safe-replace.ts with the real restore-point code and the real reminder storage on a stubbed
 * localStorage, wired the way app/page.tsx wires it. The second half pins the three screens that used to report success
 * unconditionally (and the settings sheet that used to replace the reminders before any safety copy existed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import type { FullBackupData } from "@/lib/backup"
import type { BackupData } from "@/lib/backup-import"
import { loadSchedule, saveSchedule, type ScheduleEntry } from "@/lib/reminders"
import { listRestorePoints, RestorePointError, saveRestorePoint } from "@/lib/restore-points"
import { MESSAGES, resetEverything, restoreFrom, runGuarded } from "@/lib/safe-replace"
import type { Subject } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8")

let failWrites = false

function stubStorage() {
  const m = new Map<string, string>()

  vi.stubGlobal("window", {})

  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites && k !== "notificationSchedule") {
        throw new Error("storage full")
      }
      // Reminders remain writable: proves they are NOT touched when saving a safety copy fails.
      m.set(k, v)
    },
    removeItem: (k: string) => void m.delete(k),
  })
}

beforeEach(() => {
  failWrites = false
  stubStorage()
})

afterEach(() => vi.unstubAllGlobals())

const sub = (id: string, name: string): Subject => ({
  id,
  name,
  attended: 1,
  missed: 0,
  requirement: 75,
  glowColor: "#000",
  tags: [],
  log: [{ d: "2026-10-01", s: "P" }],
})

const reminder = (id: string, subjectName: string): ScheduleEntry => ({
  id,
  day: 1,
  startTime: "09:00",
  endTime: "10:00",
  subjectName,
  notifyOffset: 10,
  notifyWhen: "before",
})

const NOW = {
  subjects: [sub("n1", "Now subject")],
  tasks: [],
  tags: ["now"],
  mates: [],
  reminders: [reminder("rn", "Now subject")],
} satisfies FullBackupData

const BACKUP: BackupData = {
  subjects: [sub("b1", "Backup subject")],
  tasks: [],
  tags: ["old"],
  mates: [],
  reminders: [reminder("rb", "Backup subject")],
  full: true,
}

/** The guards every call must now supply; direct-call tests use these quiet defaults. */
const RESTORE_EXTRA = {
  demoActive: () => false,
  readReminders: () => BACKUP.reminders!,
  dataPersisted: async () => true,
}

/** Reset clears the current user's data without signing out. */
const RESET_EXTRA = {
  demoActive: () => false,
  isCleared: async () => true,
}

/**
 * A device: its data in memory and its reminders in stubbed localStorage,
 * wired the way app/page.tsx wires them.
 */
function device() {
  const knobs = {
    demo: false,
    persistOk: true,
    clearedOk: true,
  }

  const state = {
    data: {
      subjects: NOW.subjects,
      tasks: NOW.tasks,
      tags: NOW.tags,
      mates: NOW.mates,
    } as Omit<FullBackupData, "reminders">,
    cleared: 0,
  }

  saveSchedule(NOW.reminders)

  const common = {
    current: (): FullBackupData => ({
      ...state.data,
      reminders: loadSchedule(),
    }),
    saveRestorePoint,
    demoActive: () => knobs.demo,
  }

  return {
    state,
    knobs,
    common,

    restore: (incoming: BackupData) =>
      restoreFrom(incoming, {
        ...common,
        readReminders: loadSchedule,
        dataPersisted: async () => knobs.persistOk,
        applyData: (d) =>
          void (state.data = {
            subjects: d.subjects,
            tasks: d.tasks,
            tags: d.tags,
            mates: d.mates ?? [],
          }),
        applyReminders: saveSchedule,
      }),

    reset: () =>
      resetEverything({
        ...common,
        isCleared: async () => knobs.clearedOk,
        clear: () => {
          state.data = {
            subjects: [],
            tasks: [],
            tags: [],
            mates: [],
          }
          localStorage.removeItem("notificationSchedule")
          state.cleared++
        },
      }),
  }
}

describe("restoring a backup", () => {
  it("success: the safety copy holds the CURRENT data and reminders, then the data and reminders are replaced", async () => {
    const d = device()

    expect(await d.restore(BACKUP)).toEqual({ ok: true })
    expect(d.state.data.subjects.map((s) => s.name)).toEqual(["Backup subject"])
    expect(loadSchedule().map((r) => r.id)).toEqual(["rb"])

    const [p] = await listRestorePoints()

    expect(p.data.subjects.map((s) => s.name)).toEqual(["Now subject"])
    expect(p.data.reminders.map((r) => r.id)).toEqual(["rn"])
    // The reminders being replaced are in the safety copy.
  })

  it("safety copy cannot be saved: data AND reminders are unchanged, nothing is claimed, the message is accurate", async () => {
    const d = device()

    failWrites = true

    const r = await d.restore(BACKUP)

    expect(r).toEqual({
      ok: false,
      message: MESSAGES.restoreNotSaved,
    })
    expect(r.ok === false && r.message).toContain("not replaced")
    expect(d.state.data.subjects.map((s) => s.name)).toEqual(["Now subject"])
    expect(d.state.data.tags).toEqual(["now"])
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])

    // Reminders are preserved.
    failWrites = false

    expect(await listRestorePoints()).toEqual([])
  })

  it("a safety copy that cannot be read back counts as failed (nothing replaced)", async () => {
    const d = device()
    const apply = vi.fn()

    const r = await restoreFrom(BACKUP, {
      ...RESTORE_EXTRA,
      current: () => ({
        ...d.state.data,
        reminders: loadSchedule(),
      }),
      saveRestorePoint: async () => {
        throw new RestorePointError("not found when read back")
      },
      applyData: apply,
      applyReminders: apply,
    })

    expect(r).toEqual({
      ok: false,
      message: MESSAGES.restoreNotSaved,
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it("an unexpected error while saving also changes nothing and does not blame storage", async () => {
    const apply = vi.fn()

    const r = await restoreFrom(BACKUP, {
      ...RESTORE_EXTRA,
      current: () => NOW,
      saveRestorePoint: async () => {
        throw new TypeError("boom")
      },
      applyData: apply,
      applyReminders: apply,
    })

    expect(r).toEqual({
      ok: false,
      message: MESSAGES.restoreUnexpected,
    })
    expect(apply).not.toHaveBeenCalled()
  })

  it("order: the safety copy is finished before the data or the reminders are touched", async () => {
    const events: string[] = []

    await restoreFrom(BACKUP, {
      ...RESTORE_EXTRA,
      current: () => NOW,
      saveRestorePoint: async () => {
        await Promise.resolve()
        events.push("saved")
      },
      applyData: () => void events.push("data"),
      applyReminders: () => void events.push("reminders"),
    })

    expect(events).toEqual(["saved", "data", "reminders"])
  })

  it("a backup without reminders leaves the reminders alone even on success", async () => {
    const d = device()
    const { reminders: _unused, ...noReminders } = BACKUP
    void _unused

    expect((await d.restore(noReminders)).ok).toBe(true)
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])
  })

  it("a failure while applying is reported as unfinished (never as success) and points at the saved copy", async () => {
    const r = await restoreFrom(BACKUP, {
      ...RESTORE_EXTRA,
      current: () => NOW,
      saveRestorePoint: async () => {},
      applyData: () => {
        throw new Error("write failed")
      },
      applyReminders: () => {},
    })

    expect(r).toEqual({
      ok: false,
      message: MESSAGES.restoreHalfDone,
    })
  })

  it("after a refusal the person can try again once storage works, and then it succeeds", async () => {
    const d = device()

    failWrites = true
    expect((await d.restore(BACKUP)).ok).toBe(false)

    failWrites = false
    expect((await d.restore(BACKUP)).ok).toBe(true)
    expect(loadSchedule().map((x) => x.id)).toEqual(["rb"])
  })
})

describe("resetting", () => {
  it("success: safety copy (with reminders) first, then everything is cleared", async () => {
    const d = device()

    expect(await d.reset()).toEqual({ ok: true })
    expect(d.state.cleared).toBe(1)
    expect(d.state.data.subjects).toEqual([])
    expect(loadSchedule()).toEqual([])

    const [p] = await listRestorePoints()

    expect(p.reason).toBe("Before reset")
    expect(p.data.reminders.map((r) => r.id)).toEqual(["rn"])
  })

  it("safety copy cannot be saved: nothing is reset, reminders survive, the message says so", async () => {
    const d = device()

    failWrites = true

    const r = await d.reset()

    expect(r).toEqual({
      ok: false,
      message: MESSAGES.resetNotSaved,
    })
    expect(d.state.cleared).toBe(0)
    expect(d.state.data.subjects.map((s) => s.name)).toEqual(["Now subject"])
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])
  })

  it("a device with nothing to keep may still be reset (no copy is possible or needed)", async () => {
    const clear = vi.fn()

    const r = await resetEverything({
      ...RESET_EXTRA,
      current: () => ({
        subjects: [],
        tasks: [],
        tags: [],
        mates: [],
        reminders: [],
      }),
      saveRestorePoint: async () => {},
      clear,
    })

    expect(r.ok).toBe(true)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it("a failure while clearing is reported as unfinished", async () => {
    const r = await resetEverything({
      ...RESET_EXTRA,
      current: () => NOW,
      saveRestorePoint: async () => {},
      clear: () => {
        throw new Error("x")
      },
    })

    expect(r).toEqual({
      ok: false,
      message: MESSAGES.resetHalfDone,
    })
  })
})

describe("success is reported only when the change happened (runGuarded)", () => {
  it("done only on true", async () => {
    const done = vi.fn()
    const thrown = vi.fn()

    expect(await runGuarded(async () => true, done, thrown)).toBe(true)
    expect(done).toHaveBeenCalledTimes(1)

    expect(await runGuarded(async () => false, done, thrown)).toBe(false)
    expect(await runGuarded(() => Promise.reject(new Error("x")), done, thrown)).toBe(false)

    expect(done).toHaveBeenCalledTimes(1)
    expect(thrown).toHaveBeenCalledTimes(1)
  })
})

describe("the screens", () => {
  it("backup panel: 'Backup restored' appears only inside the success callback, and a refusal keeps the confirmation open", () => {
    const src = read("components/settings-panels.tsx")

    expect(src).toMatch(
      /runGuarded\(\s*\(\) => onImportData\(pending\),\s*\(\) => \{\s*onToast\("Backup restored"\)\s*setPending\(null\)/,
    )
    expect(src.match(/onToast\("Backup restored"\)/g)).toHaveLength(1)
  })

  it("restore points: 'Restored' appears only inside the success callback; the confirmation closes only on success", () => {
    const src = read("components/restore-points.tsx")

    expect(src).toMatch(
      /runGuarded\(\s*\(\) => onRestore\(p\.data, \{ reminders: p\.remindersKnown !== false[^)]*\}\),\s*\(\) => \{\s*setConfirming\(null\)\s*onToast\("Restored"\)/,
    )
    expect(src.match(/onToast\("Restored"\)/g)).toHaveLength(1)
  })

  it("settings sheet: reminders are replaced only after the page reports the data was replaced; a reset panel closes only on success", () => {
    const src = read("components/settings-sheet.tsx")

    expect(src).toMatch(
      /const ok = await p\.onImportData\(d\)\s*if \(ok && d\.full && d\.reminders\) setSchedule\(d\.reminders\)/,
    )
    expect(src).toMatch(
      /const ok = await p\.onImportData\(\{ \.\.\.d, full: known\.reminders, unrecorded \}\)\s*if \(ok && known\.reminders\) setSchedule\(d\.reminders\)/,
    )
    expect(src).toMatch(
      /const ok = await p\.onResetAllData\(\)\s*if \(ok\) setSchedule\(\[\]\)[^\n]*\s*if \(ok\) close\(\)/,
    )

    // The old order (reminders first, result ignored) must not come back.
    expect(src).not.toMatch(/setSchedule\(d\.reminders\)\s*p\.onImportData/)
  })

  it("the page handlers resolve a boolean and the types say so", () => {
    expect(read("components/settings-sheet.tsx")).toMatch(
      /onImportData: \(data: RestoreRequest\) => Promise<boolean>/,
    )
    expect(read("components/settings-sheet.tsx")).toMatch(
      /onResetAllData: \(\) => Promise<boolean>/,
    )
    expect(read("app/page.tsx")).toMatch(/return r\.ok/)
  })
})