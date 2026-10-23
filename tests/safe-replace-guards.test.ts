/**
 * The remaining safe-replacement defects, as behaviour (real restore-point, reminder, lock, merge and sign-in code on a stubbed
 * localStorage; injected effects only where a failure has to be forced):
 *   demo protection, tags-only / reminders-only data, failed persistence, state changing during the safety copy, overlapping
 *   destructive operations, reset and cloud-clear failures, restore points written before reminders were kept in them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import type { FullBackupData } from "@/lib/backup"
import type { BackupData } from "@/lib/backup-import"
import { buildBackup } from "@/lib/backup"
import { BUSY_MESSAGE, lockHolder, resetLockForTests, tryAcquire, withLock } from "@/lib/operation-lock"
import { loadSchedule, saveSchedule, SCHEDULE_KEY, type ScheduleEntry } from "@/lib/reminders"
import { dataPersisted, resetIsComplete } from "@/lib/replace-verify"
import { contents, holdsSomething, listRestorePoints, RestorePointError, saveRestorePoint } from "@/lib/restore-points"
import { MESSAGES, resetEverything, restoreFrom, type ReplaceResult, type RestoreRequest } from "@/lib/safe-replace"
import { emptyData, planFirstSignIn, PromptController, restorable, runChoice, withPutTimeout, withReadTimeout, type ChoiceEnv } from "@/lib/signin-reconcile"
import { same } from "@/lib/merge"
import type { Subject } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")

let ls: Map<string, string>
let refuse: Set<string>
beforeEach(() => {
  ls = new Map()
  refuse = new Set()
  vi.stubGlobal("window", {})
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => ls.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (refuse.has(k) || refuse.has("*")) throw new Error("storage refuses " + k)
      ls.set(k, v)
    },
    removeItem: (k: string) => void ls.delete(k),
  })
  resetLockForTests()
})
afterEach(() => {
  resetLockForTests()
  vi.unstubAllGlobals()
})

const sub = (id: string, name: string): Subject => ({ id, name, attended: 1, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [{ d: "2026-10-01", s: "P" }] })
const rem = (id: string): ScheduleEntry => ({ id, day: 1, startTime: "09:00", endTime: "10:00", subjectName: "X", notifyOffset: 10, notifyWhen: "before" })
type Data = Omit<FullBackupData, "reminders">
const NOW_DATA: Data = { subjects: [sub("n1", "Now")], tasks: [], tags: ["now"], mates: [] }
const INCOMING: BackupData = { subjects: [sub("b1", "Backup")], tasks: [], tags: ["old"], mates: [], reminders: [rem("rb")], full: true }

/** A device with live (mutable) data, real reminder storage and real restore points */
function device(start: Data = NOW_DATA, reminders: ScheduleEntry[] = [rem("rn")]) {
  const s = {
    data: start,
    demo: false,
    persistOk: true,
    /** what storage holds (the screen state may differ when persisting fails) */
    stored: start,
    /** replaces the persistence check (to simulate storage that never confirms, or a concurrent change during the wait) */
    persistCheck: null as null | ((d: BackupData) => Promise<boolean>),
    clearCloudFails: false,
    /** replaces cloud clearing (to hold it, or to change the data while it waits) */
    clearCloudImpl: null as null | (() => Promise<void>),
    clearedOk: true,
    applied: 0,
    cleared: 0,
    cloudCleared: 0,
    onSave: null as null | (() => void), // runs while the safety copy is being saved
  }
  saveSchedule(reminders)
  const base = {
    current: (): FullBackupData => ({ ...s.data, reminders: loadSchedule() }),
    demoActive: () => s.demo,
    saveRestorePoint: async (reason: string, d: FullBackupData) => {
      await Promise.resolve()
      s.onSave?.()
      await saveRestorePoint(reason, d)
    },
  }
  const restore = (incoming: RestoreRequest = INCOMING) =>
    restoreFrom(incoming, {
      ...base,
      applyData: (d) => {
        s.applied++
        s.data = { subjects: d.subjects, tasks: d.tasks, tags: d.tags, mates: d.mates ?? [] }
        if (s.persistOk) s.stored = s.data // when storage refuses, the screen changes and storage keeps what it had
      },
      applyReminders: saveSchedule,
      readReminders: loadSchedule,
      dataPersisted: async (d) => (s.persistCheck ? s.persistCheck(d) : same({ ...s.stored }, { subjects: d.subjects, tasks: d.tasks, tags: d.tags, mates: d.mates ?? [] })),
    })
  const reset = () =>
    resetEverything({
      ...base,
      clearCloud: async () => {
        s.cloudCleared++
        if (s.clearCloudImpl) return s.clearCloudImpl()
        if (s.clearCloudFails) throw new Error("cloud clear failed")
      },
      clear: () => {
        s.cleared++
        s.data = { subjects: [], tasks: [], tags: [], mates: [] }
        ls.delete(SCHEDULE_KEY)
      },
      isCleared: async () => s.clearedOk,
    })
  return { s, restore, reset, base }
}
const names = (d: Data) => d.subjects.map((x) => x.name)

describe("demo protection", () => {
  it.each(["restore", "reset"] as const)("%s is refused while the demo is on screen: nothing is saved, cleared or changed", async (op) => {
    const d = device()
    d.s.demo = true
    const r = await d[op]()
    expect(r).toEqual({ ok: false, message: MESSAGES.demo })
    expect(d.s.applied + d.s.cleared + d.s.cloudCleared).toBe(0)
    expect(names(d.s.data)).toEqual(["Now"])
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])
    expect(await listRestorePoints()).toEqual([])
    expect(lockHolder()).toBeNull()
  })

  it.each(["restore", "reset"] as const)("%s: the demo starting WHILE the safety copy is saved is caught before the first change", async (op) => {
    const d = device()
    d.s.onSave = () => void (d.s.demo = true)
    const r = await d[op]()
    expect(r).toEqual({ ok: false, message: MESSAGES.demo })
    expect(d.s.applied + d.s.cleared + d.s.cloudCleared).toBe(0)
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])
    expect(lockHolder()).toBeNull()
  })

  it("reset: the demo starting during cloud clear stops the local wipe", async () => {
    const d = device()
    const base = d.base
    const r = await resetEverything({
      ...base,
      clearCloud: async () => void (d.s.demo = true),
      clear: () => void d.s.cleared++,
      isCleared: async () => true,
    })
    expect(r).toEqual({ ok: false, message: MESSAGES.resetHalfDone })
    expect(d.s.cleared).toBe(0)
  })

  it("the guard reads the live value each time it is asked (a render-time copy would lag)", async () => {
    let live = false
    let asked = 0
    const r = await restoreFrom(INCOMING, {
      current: () => ({ ...NOW_DATA, reminders: [] }),
      saveRestorePoint: async () => {},
      demoActive: () => (asked++, live),
      applyData: () => {},
      applyReminders: () => {},
      readReminders: () => INCOMING.reminders!,
      dataPersisted: async () => true,
    })
    expect(r.ok).toBe(true)
    expect(asked).toBeGreaterThanOrEqual(3) // before, after the copy, immediately before the change
    live = true
    expect((await restoreFrom(INCOMING, { current: () => ({ ...NOW_DATA, reminders: [] }), saveRestorePoint: async () => {}, demoActive: () => live, applyData: () => {}, applyReminders: () => {}, readReminders: () => [], dataPersisted: async () => true })).ok).toBe(false)
  })

  it("the page sets its demo flag in the same step that starts or ends the demo, and asks for the lock", () => {
    const page = fs.readFileSync(path.join(ROOT, "app/page.tsx"), "utf8")
    // The app guide is illustrative: nothing ever turns the demo on, so real data is never swapped out
    expect(page).not.toMatch(/setDemoActive\(true\)/)
    expect(page).not.toMatch(/demoActiveRef\.current = true/)
    expect(page).toMatch(/demoActiveRef\.current = false\s*\n\s*setDemoLive\(false\)\s*\n\s*setDemoActive\(false\)/)
    expect(page).toMatch(/tryAcquire\("demo"\)/)
    expect(page).toMatch(/demoActive: demoIsActive/)
  })
})

describe("tags-only and reminders-only data is not 'empty'", () => {
  const only = (over: Partial<FullBackupData>): FullBackupData => ({ ...emptyData(), ...over })
  it("one rule everywhere: restore points, sign-in protection and the safe-replace decisions agree", () => {
    for (const d of [only({ tags: ["a"] }), only({ reminders: [rem("r")] }), only({ subjects: [sub("s", "S")] }), only({ tasks: [{ id: "t", title: "T", dueDate: "2026-11-01" } as never] }), only({ mates: [{ id: "m", name: "M", covered: 0, repaid: 0 }] })]) {
      expect(holdsSomething(d)).toBe(true)
      expect(restorable(d)).toBe(true)
    }
    expect(holdsSomething(emptyData())).toBe(false)
    expect(restorable(emptyData())).toBe(false)
  })

  it.each([
    ["tags only", only({ tags: ["core", "lab"] })],
    ["reminders only", only({ reminders: [rem("r1")] })],
  ])("%s: a restore point is made, read back and listed", async (_n, d) => {
    await saveRestorePoint("x", d)
    const [p] = await listRestorePoints()
    expect(p.data.tags).toEqual(d.tags)
    expect(p.data.reminders).toEqual(d.reminders)
    expect(p.remindersKnown).toBe(true)
  })

  it("a truly empty copy still makes no point", async () => {
    await saveRestorePoint("x", emptyData())
    expect(await listRestorePoints()).toEqual([])
  })

  it("restoring over a device that holds only tags protects the tags first, and refuses if that copy cannot be made", async () => {
    const d = device({ subjects: [], tasks: [], tags: ["only-tag"], mates: [] }, [])
    expect((await d.restore()).ok).toBe(true)
    expect((await listRestorePoints())[0].data.tags).toEqual(["only-tag"])

    const e = device({ subjects: [], tasks: [], tags: ["only-tag"], mates: [] }, [])
    refuse.add("*")
    ls.clear()
    const r = await e.restore()
    expect(r).toEqual({ ok: false, message: MESSAGES.restoreNotSaved })
    expect(e.s.data.tags).toEqual(["only-tag"])
  })

  it("restoring over a device that holds only reminders protects them first", async () => {
    const d = device({ subjects: [], tasks: [], tags: [], mates: [] }, [rem("lonely")])
    expect((await d.restore()).ok).toBe(true)
    expect((await listRestorePoints())[0].data.reminders.map((x) => x.id)).toEqual(["lonely"])
  })

  it("the half-done message points at Restore points exactly when there is something in one (tags or reminders count)", async () => {
    const r = await restoreFrom(INCOMING, {
      current: () => ({ ...emptyData(), tags: ["t"] }),
      saveRestorePoint: async () => {},
      demoActive: () => false,
      applyData: () => {
        throw new Error("x")
      },
      applyReminders: () => {},
      readReminders: () => [],
      dataPersisted: async () => true,
    })
    expect(r).toEqual({ ok: false, message: MESSAGES.restoreHalfDone })
  })

  it("the restore-point list labels tags, mates and reminders too", async () => {
        await saveRestorePoint("x", only({ tags: ["a", "b"], reminders: [rem("r")] }))
    expect(contents((await listRestorePoints())[0])).toBe("2 tags, 1 reminder")
    await saveRestorePoint("y", only({ subjects: [sub("s", "S")], mates: [{ id: "m", name: "M", covered: 0, repaid: 0 }] }))
    expect(contents((await listRestorePoints())[0])).toBe("1 subject, 1 mate")
  })
})

describe("failed persistence is never reported as success", () => {
  it("a reminder write the storage refuses is caught by reading back; the old data and reminders are put back", async () => {
    const d = device()
    refuse.add(SCHEDULE_KEY) // saveSchedule swallows the failure, as it always has
    const r = await d.restore()
    expect(r).toEqual({ ok: false, message: MESSAGES.restoreNotKept })
    expect(names(d.s.data)).toEqual(["Now"]) // put back
    expect(d.s.applied).toBe(2) // applied, then restored
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])
    expect((await listRestorePoints())[0].data.reminders.map((x) => x.id)).toEqual(["rn"]) // the safety copy is still there
  })

  it("data that is on screen but not in storage is not 'restored'", async () => {
    const d = device()
    d.s.persistOk = false
    const r = await d.restore()
    expect(r).toEqual({ ok: false, message: MESSAGES.restoreNotKept })
    expect(names(d.s.data)).toEqual(["Now"])
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"]) // reminders were applied before the check, then put back
    expect((await listRestorePoints()).length).toBe(1)
  })

  it("with nothing to keep the message does not send the person to an empty Restore points list", async () => {
    const d = device({ subjects: [], tasks: [], tags: [], mates: [] }, [])
    d.s.persistOk = false
    expect(await d.restore()).toEqual({ ok: false, message: MESSAGES.restoreNotKeptNoCopy })
  })

  it("dataPersisted reads storage: true when it holds the data, false when it does not", async () => {
    ls.set("subjects", JSON.stringify(INCOMING.subjects))
    ls.set("tasks", "[]")
    ls.set("tags", JSON.stringify(INCOMING.tags))
    expect(await dataPersisted(INCOMING, 50, 10)).toBe(true)
    ls.set("tags", JSON.stringify(["different"]))
    expect(await dataPersisted(INCOMING, 50, 10)).toBe(false)
  })

  it("resetIsComplete: false while anything the reset removes is stored; the empty list counts as cleared", async () => {
    expect(await resetIsComplete(50, 10)).toBe(true)
    ls.set("subjects", "[]")
    expect(await resetIsComplete(50, 10)).toBe(true)
    ls.set(SCHEDULE_KEY, "[1]")
    expect(await resetIsComplete(50, 10)).toBe(false)
    ls.delete(SCHEDULE_KEY)
    ls.set("tasks", JSON.stringify([{ id: "t" }]))
    expect(await resetIsComplete(50, 10)).toBe(false)
  })
})

describe("the data changing while the safety copy is being saved", () => {
  it("a stale copy is not relied on: it is made again from what is there now, and then the change goes ahead", async () => {
    const d = device()
    let first = true
    d.s.onSave = () => {
      if (first) {
        first = false
        d.s.data = { ...d.s.data, subjects: [...d.s.data.subjects, sub("late", "Added meanwhile")] }
      }
    }
    const r = await d.restore()
    expect(r.ok).toBe(true)
    const points = await listRestorePoints()
    expect(points.length).toBe(2)
    expect(points[0].data.subjects.map((x) => x.name)).toEqual(["Now", "Added meanwhile"]) // the fresh one is what recovers the work
  })

  it("reminders changing meanwhile count too", async () => {
    const d = device()
    let first = true
    d.s.onSave = () => {
      if (first) {
        first = false
        saveSchedule([rem("rn"), rem("added")])
      }
    }
    expect((await d.restore()).ok).toBe(true)
    expect((await listRestorePoints())[0].data.reminders.map((x) => x.id)).toEqual(["rn", "added"])
  })

  it("if it keeps changing, nothing is replaced and the person is told to try again", async () => {
    const d = device()
    let n = 0
    d.s.onSave = () => void (d.s.data = { ...d.s.data, tags: [...d.s.data.tags, `t${n++}`] })
    const r = await d.reset()
    expect(r).toEqual({ ok: false, message: MESSAGES.changedWhileSaving })
    expect(d.s.cleared + d.s.cloudCleared + d.s.applied).toBe(0)
    expect(lockHolder()).toBeNull()
  })
})

describe("overlapping destructive operations", () => {
  it("a second restore while one is running is refused, and the first completes normally", async () => {
    const d = device()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const slow = d.base.saveRestorePoint
    d.base.saveRestorePoint = async (reason, data) => {
      await gate
      return slow(reason, data)
    }
    const first = restoreFrom(INCOMING, { ...d.base, applyData: () => void d.s.applied++, applyReminders: saveSchedule, readReminders: loadSchedule, dataPersisted: async () => true })
    await Promise.resolve()
    expect(lockHolder()).toBe("restore")
    const second = await d.reset()
    expect(second).toEqual({ ok: false, message: MESSAGES.busy })
    expect(d.s.cleared + d.s.cloudCleared).toBe(0)
    release()
    expect((await first).ok).toBe(true)
    expect(d.s.applied).toBe(1)
    expect(lockHolder()).toBeNull()
  })

  it("two simultaneous restores: exactly one runs", async () => {
    const d = device()
    const results = await Promise.all([d.restore(), d.restore()])
    expect(results.filter((r) => r.ok)).toHaveLength(1)
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, message: MESSAGES.busy }])
    expect(d.s.applied).toBe(1)
  })

  it.each([
    ["a failed safety copy", async (d: ReturnType<typeof device>) => { refuse.add("*"); ls.clear(); return d.restore() }],
    ["a failed persistence check", async (d: ReturnType<typeof device>) => { d.s.persistOk = false; return d.restore() }],
    ["a failed cloud clear", async (d: ReturnType<typeof device>) => { d.s.clearCloudFails = true; return d.reset() }],
    ["a thrown error", async (d: ReturnType<typeof device>) => { d.base.saveRestorePoint = async () => { throw new TypeError("boom") }; return d.restore() }],
    ["a success", async (d: ReturnType<typeof device>) => d.restore()],
  ])("the lock is released after %s", async (_n, run) => {
    const d = device()
    await run(d)
    expect(lockHolder()).toBeNull()
    refuse.clear()
    expect(tryAcquire("next")).not.toBeNull()
  })

  it("starting or ending the demo is refused while a restore or reset holds the lock, and allowed after", () => {
    const release = tryAcquire("restore")!
    expect(tryAcquire("demo")).toBeNull()
    release()
    release() // releasing twice is harmless
    const demo = tryAcquire("demo")
    expect(demo).not.toBeNull()
    expect(tryAcquire("restore")).toBeNull() // and a restore cannot start in the middle of a demo transition
    demo!()
  })

  it("withLock runs the job once, reports busy otherwise, and releases when the job throws", async () => {
    expect(await withLock("a", async () => 1, () => "busy")).toBe(1)
    const release = tryAcquire("x")!
    expect(await withLock("a", async () => 1, () => "busy")).toBe("busy")
    release()
    await expect(withLock("a", async () => { throw new Error("x") }, () => "busy")).rejects.toThrow("x")
    expect(lockHolder()).toBeNull()
  })

  it("a sign-in choice is refused while a restore or reset is replacing the data, and runs once it is over", async () => {
    const acct = emptyData()
    const dev: FullBackupData = { ...emptyData(), subjects: [sub("d1", "DBMS")] }
    const prompts = new PromptController(() => {})
    const stored = { rev: 1, text: buildBackup({ ...acct, subjects: [sub("a1", "Pharm")] }, false) }
    const plan = planFirstSignIn({ device: dev, cloud: { kind: "doc", doc: { data: stored.text, rev: 1, updatedAt: 1 } }, accountId: "acct", dataOwner: null })
    if (plan.kind !== "choose") throw new Error("expected a choice")
    prompts.show(plan.offer)
    let device = dev
    const env: ChoiceEnv = {
      prompts,
      accountId: () => "acct",
      paused: () => false,
      deps: {
        getDevice: () => device,
        applyDevice: (d) => void (device = d),
        verifyDevice: async (d) => same(device, d),
        saveRestorePoint,
        listRestorePoints,
        cloudGet: async () => ({ data: stored.text, rev: stored.rev, updatedAt: 1 }),
        cloudPut: async () => ({ ok: true, rev: 2 }),
      },
      deviceReplaced: () => {},
      finalize: () => prompts.clear(),
      rebuild: async () => {},
    }
    const busy = tryAcquire("restore")!
    expect(await runChoice(env, "cloud", true)).toBe(BUSY_MESSAGE)
    expect(device).toBe(dev)
    expect(prompts.current?.working).toBe(false) // the prompt is untouched
    busy()
    expect(await runChoice(env, "cloud", true)).toBeNull()
    expect(lockHolder()).toBeNull() // and it let go again
    expect(device).not.toBe(dev)
  })
})

describe("reset: cloud clear and deletion failures", () => {
  it("cloud clearing fails before the local wipe, and the safety copy is kept", async () => {
    const d = device()
    d.s.clearCloudFails = true
    const r = await d.reset()
    expect(r).toEqual({ ok: false, message: MESSAGES.resetHalfDone })
    expect(d.s.cloudCleared).toBe(1)
    expect(d.s.cleared).toBe(0)
    expect(names(d.s.data)).toEqual(["Now"])
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])
    expect((await listRestorePoints()).length).toBe(1)
  })

  it("the order is: safety copy, cloud clear, local wipe, check", async () => {
    const events: string[] = []
    await resetEverything({
      current: () => ({ ...NOW_DATA, reminders: [] }),
      saveRestorePoint: async () => void events.push("copy"),
      demoActive: () => false,
      clearCloud: async () => void events.push("cloud"),
      clear: () => void events.push("clear"),
      isCleared: async () => (events.push("check"), true),
    })
    expect(events).toEqual(["copy", "cloud", "clear", "check"])
  })

  it("something is still stored after the wipe: not a success; the message says so and points at the safety copy", async () => {
    const d = device()
    d.s.clearedOk = false
    const r = await d.reset()
    expect(r).toEqual({ ok: false, message: MESSAGES.resetNotKept })
    expect((await listRestorePoints()).length).toBe(1)
    expect(lockHolder()).toBeNull()
  })

  it("a failure inside the wipe is reported as unfinished", async () => {
    const r = await resetEverything({
      current: () => ({ ...NOW_DATA, reminders: [] }),
      saveRestorePoint: async () => {},
      demoActive: () => false,
      clearCloud: async () => {},
      clear: () => {
        throw new Error("x")
      },
      isCleared: async () => true,
    })
    expect(r).toEqual({ ok: false, message: MESSAGES.resetHalfDone })
  })
})

describe("storage that is full", () => {
  it("every message about a failed safety copy tells the person what to do, and nothing is deleted for them", async () => {
    for (const m of [MESSAGES.restoreNotSaved, MESSAGES.resetNotSaved]) expect(m).toMatch(/delete older restore points under Settings > Backup & restore/)
    expect(new RestorePointError().message).toMatch(/delete older restore points/)
    await saveRestorePoint("keep me", { ...emptyData(), subjects: [sub("s", "S")] })
    const d = device()
    refuse.add("*")
    const r: ReplaceResult = await d.restore()
    expect(r.ok).toBe(false)
    refuse.clear()
    expect((await listRestorePoints()).map((p) => p.reason)).toContain("keep me") // existing points are never trimmed
  })
})

describe("restore points saved before reminders (or tags, mates) were kept in them", () => {
  const legacy = [{ id: "old1", at: 5, reason: "Before reset", data: { subjects: [sub("o", "Old subject")], tasks: [] } }]

  it("are listed with empty lists instead of crashing, and marked as not having recorded reminders", async () => {
    ls.set("restorePoints", JSON.stringify(legacy))
    const [p] = await listRestorePoints()
    expect(p.data.reminders).toEqual([])
    expect(p.data.tags).toEqual([])
    expect(p.data.mates).toEqual([])
    expect(p.remindersKnown).toBe(false)
        expect(contents(p)).toBe("1 subject")
  })

  it("saving and deleting never rewrite an older point as something it was not", async () => {
    ls.set("restorePoints", JSON.stringify(legacy))
    await saveRestorePoint("new", { ...emptyData(), tags: ["t"] })
    const raw = JSON.parse(ls.get("restorePoints")!) as { id: string; data: Record<string, unknown> }[]
    const old = raw.find((p) => p.id === "old1")!
    expect(old.data).not.toHaveProperty("reminders")
    expect(old.data).not.toHaveProperty("tags")
    const { deleteRestorePoint } = await import("@/lib/restore-points")
    await deleteRestorePoint(raw.find((p) => p.id !== "old1")!.id)
    expect(JSON.parse(ls.get("restorePoints")!)).toEqual(legacy)
  })

  it("restoring one leaves this device's reminders alone", async () => {
    ls.set("restorePoints", JSON.stringify(legacy))
    const d = device()
    const [p] = await listRestorePoints()
    const r = await d.restore({ ...p.data, full: p.remindersKnown })
    expect(r.ok).toBe(true)
    expect(names(d.s.data)).toEqual(["Old subject"])
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"]) // not wiped by an empty list that only meant "not recorded"
  })

  it("junk entries are skipped, not shown", async () => {
    ls.set("restorePoints", JSON.stringify([null, 5, { id: 3 }, ...legacy]))
    expect((await listRestorePoints()).map((p) => p.id)).toEqual(["old1"])
  })

  it("the screen restores with the right flag and says why reminders are untouched", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/restore-points.tsx"), "utf8")
    expect(src).toMatch(/onRestore\(p\.data, \{ reminders: p\.remindersKnown !== false, tags: p\.tagsKnown !== false, mates: p\.matesKnown !== false, holidays: p\.holidaysKnown !== false, scheduleOverrides: p\.scheduleOverridesKnown !== false \}\)/)
    expect(src).toMatch(/older copy didn’t include/)
  })
})


describe("restore verification does not undo a legitimate concurrent update", () => {
  it("the expected state not being observed while something else changed the data: nothing is put back, and the message says what is true", async () => {
    const d = device()
    d.s.persistCheck = async () => {
      // while we wait to see our data in storage, the person (or a sync merge) adds something
      d.s.data = { ...d.s.data, subjects: [...d.s.data.subjects, sub("live", "Added during the wait")] }
      return false
    }
    const r = await d.restore()
    expect(r).toEqual({ ok: false, message: MESSAGES.restoreUnconfirmed })
    expect(names(d.s.data)).toEqual(["Backup", "Added during the wait"]) // the legitimate update survives; no old snapshot was laid over it
    expect(d.s.applied).toBe(1) // applied once, never "put back"
    expect((await listRestorePoints()).length).toBe(1) // the safety copy is there
  })

  it("nothing else changed: the restore is undone and the undo is found in storage and on screen before it is claimed", async () => {
    const d = device()
    d.s.persistOk = false // storage refuses the new data, so it keeps the old
    const r = await d.restore()
    expect(r).toEqual({ ok: false, message: MESSAGES.restoreNotKept })
    expect(names(d.s.data)).toEqual(["Now"])
    expect(d.s.applied).toBe(2)
  })

  it("the undo cannot be confirmed: an accurate, actionable error that sends the person to the safety copy, which is kept", async () => {
    const d = device()
    d.s.persistCheck = async () => false // storage never confirms anything
    const r = await d.restore()
    expect(r).toEqual({ ok: false, message: MESSAGES.restorePutBackUnverified })
    expect(r.ok === false && r.message).toMatch(/restore it from there/)
    expect((await listRestorePoints()).map((p) => p.reason)).toEqual(["Before restoring a backup"])
    expect(lockHolder()).toBeNull()
  })

  it("with nothing worth keeping the unverified-undo message does not point at an empty list", async () => {
    const d = device({ subjects: [], tasks: [], tags: [], mates: [] }, [])
    d.s.persistCheck = async () => false
    expect(await d.restore()).toEqual({ ok: false, message: MESSAGES.restorePutBackUnverifiedNoCopy })
  })

  it("a reminder write the storage refuses leaves the old reminders (nothing to put back) and the data is undone only if untouched", async () => {
    const d = device()
    refuse.add(SCHEDULE_KEY)
    const r = await d.restore()
    expect(r).toEqual({ ok: false, message: MESSAGES.restoreNotKept })
    expect(loadSchedule().map((x) => x.id)).toEqual(["rn"])
    expect(names(d.s.data)).toEqual(["Now"])
  })
})

describe("reset: cloud clearing", () => {
  it("the lock stays held while cloud clearing is in progress", async () => {
    const d = device()
    let finish!: () => void
    let entered!: () => void
    const cloudClearStarted = new Promise<void>((r) => (entered = r))
    d.s.clearCloudImpl = () => {
      entered()
      return new Promise<void>((r) => (finish = r))
    }
    const run = d.reset()
    await cloudClearStarted
    expect(lockHolder()).toBe("reset")
    expect(await d.restore()).toEqual({ ok: false, message: MESSAGES.busy })
    finish()
    expect((await run).ok).toBe(true)
    expect(lockHolder()).toBeNull()
  })

  it("a reset clears the cloud copy without signing the account out", async () => {
    const called: string[] = []
    const d = device()
    d.s.clearCloudImpl = async () => void called.push("cloud")
    expect((await d.reset()).ok).toBe(true)
    expect(called).toEqual(["cloud"])
    expect(d.s.cloudCleared).toBe(1)
    expect(d.s.cleared).toBe(1)
  })

  it("the hook detaches ownership, revision and markers BEFORE waiting on the network, and nothing is swallowed", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    const from = hook.indexOf("const signOut = async")
    const at = (needle: string) => hook.indexOf(needle, from)
    expect(at("ownerRef.current = null")).toBeGreaterThan(-1)
    expect(at("ownerRef.current = null")).toBeLessThan(at("await signOutIfConfigured("))
    expect(at("await ledger.clearAll()")).toBeLessThan(at("await signOutIfConfigured("))
    expect(hook).not.toMatch(/signOutAccount\(\)\.catch/)
  })

  it("data that changed while clearing the cloud copy is saved again before the wipe", async () => {
    const d = device()
    d.s.clearCloudImpl = async () => void (d.s.data = { ...d.s.data, subjects: [...d.s.data.subjects, sub("late", "Added while clearing cloud")] })
    expect((await d.reset()).ok).toBe(true)
    const points = await listRestorePoints()
    expect(points).toHaveLength(2)
    expect(points[0].data.subjects.map((x) => x.name)).toEqual(["Now", "Added while clearing cloud"])
  })
})

describe("restore points from before tags or mates were recorded", () => {
  const legacyNoTagsNoMates = [{ id: "old", at: 5, reason: "Before reset", data: { subjects: [sub("o", "Old subject")], tasks: [], reminders: [] } }]
  const explicitEmpty = [{ id: "new", at: 6, reason: "Before reset", data: { subjects: [sub("o", "Old subject")], tasks: [], tags: [], mates: [], reminders: [] } }]

  it("a missing list is distinguishable from an explicitly empty one", async () => {
    ls.set("restorePoints", JSON.stringify([...explicitEmpty, ...legacyNoTagsNoMates]))
    const [fresh, old] = await listRestorePoints()
    expect([fresh.tagsKnown, fresh.matesKnown, fresh.remindersKnown]).toEqual([true, true, true])
    expect([old.tagsKnown, old.matesKnown, old.remindersKnown]).toEqual([false, false, true])
  })

  it("restoring an older point leaves this device's tags and mates alone", async () => {
    ls.set("restorePoints", JSON.stringify(legacyNoTagsNoMates))
    const d = device({ subjects: [sub("n", "Now")], tasks: [], tags: ["mine"], mates: [{ id: "m", name: "Arjun", covered: 3, repaid: 0 }] })
    const [p] = await listRestorePoints()
    const r = await d.restore({ ...p.data, full: true, unrecorded: ["tags", "mates"] })
    expect(r.ok).toBe(true)
    expect(names(d.s.data)).toEqual(["Old subject"])
    expect(d.s.data.tags).toEqual(["mine"])
    expect(d.s.data.mates.map((m) => m.covered)).toEqual([3])
  })

  it("restoring a point whose lists are explicitly empty DOES empty them (that is what it recorded)", async () => {
    ls.set("restorePoints", JSON.stringify(explicitEmpty))
    const d = device({ subjects: [sub("n", "Now")], tasks: [], tags: ["mine"], mates: [] })
    const [p] = await listRestorePoints()
    expect((await d.restore({ ...p.data, full: true, unrecorded: [] })).ok).toBe(true)
    expect(d.s.data.tags).toEqual([])
  })

  it("the screen passes exactly what the point did not record, and the sheet turns it into 'unrecorded'", () => {
    const sheet = fs.readFileSync(path.join(ROOT, "components/settings-sheet.tsx"), "utf8")
    expect(sheet).toMatch(/unrecorded: \("tags" \| "mates" \| "holidays" \| "scheduleOverrides"\)\[\]/)
    expect(sheet).toMatch(/full: known\.reminders, unrecorded/)
    expect(fs.readFileSync(path.join(ROOT, "components/restore-points.tsx"), "utf8")).toMatch(/tags: p\.tagsKnown !== false, mates: p\.matesKnown !== false, holidays: p\.holidaysKnown !== false, scheduleOverrides: p\.scheduleOverridesKnown !== false/)
  })

  it("the legacy point is kept exactly as stored when other points are saved", async () => {
    ls.set("restorePoints", JSON.stringify(legacyNoTagsNoMates))
    await saveRestorePoint("new", { ...emptyData(), tags: ["t"] })
    const raw = JSON.parse(ls.get("restorePoints")!) as { id: string; data: Record<string, unknown> }[]
    expect(raw.find((r) => r.id === "old")!.data).not.toHaveProperty("tags")
    expect(raw.find((r) => r.id === "old")!.data).not.toHaveProperty("mates")
  })
})

describe("sign-in network calls cannot hang the shared lock", () => {
  const never = () => new Promise<never>(() => {})
  function setup(over: Partial<ChoiceEnv["deps"]> = {}) {
    const dev: FullBackupData = { ...emptyData(), subjects: [sub("d1", "DBMS")] }
    const stored = { rev: 1, text: buildBackup({ ...emptyData(), subjects: [sub("a1", "Pharm")] }, false) }
    const prompts = new PromptController(() => {})
    const plan = planFirstSignIn({ device: dev, cloud: { kind: "doc", doc: { data: stored.text, rev: 1, updatedAt: 1 } }, accountId: "acct", dataOwner: null })
    if (plan.kind !== "choose") throw new Error("expected a choice")
    prompts.show(plan.offer)
    let device = dev
    const env: ChoiceEnv = {
      prompts,
      accountId: () => "acct",
      paused: () => false,
      deps: {
        getDevice: () => device,
        applyDevice: (d) => void (device = d),
        verifyDevice: async (d) => same(device, d),
        saveRestorePoint,
        listRestorePoints,
        cloudGet: withReadTimeout(async () => ({ data: stored.text, rev: stored.rev, updatedAt: 1 }), 30),
        cloudPut: withPutTimeout(async () => ({ ok: true, rev: 2 }), 30),
        ...over,
      },
      deviceReplaced: () => {},
      finalize: () => prompts.clear(),
      rebuild: async () => {},
    }
    return { env, prompts, device: () => device, dev }
  }

  it("a read that never answers times out, the choice fails with a retryable message, nothing changes, and the lock is released", async () => {
    const x = setup({ cloudGet: withReadTimeout(never, 30) })
    const msg = await runChoice(x.env, "merge", false)
    expect(msg).toMatch(/Couldn’t reach your account/)
    expect(x.prompts.current?.working).toBe(false)
    expect(x.device()).toBe(x.dev)
    expect(lockHolder()).toBeNull()
  })

  it("a write that never answers is 'unavailable' (it may have landed): nothing is called done, and the lock is released", async () => {
    const x = setup({ cloudPut: withPutTimeout(never, 30) })
    const msg = await runChoice(x.env, "device", true)
    expect(msg).toMatch(/Couldn’t reach your account/)
    expect(lockHolder()).toBeNull()
    expect(x.prompts.current?.error).toBe(msg)
  })

  it("after the timeout the person can choose again, and it works once the network answers", async () => {
    let hang = true
    const answer = { data: buildBackup({ ...emptyData(), subjects: [sub("a1", "Pharm")] }, false), rev: 1, updatedAt: 1 }
    const x = setup({ cloudGet: withReadTimeout(() => (hang ? never() : Promise.resolve(answer)), 30) })
    expect(await runChoice(x.env, "cloud", true)).not.toBeNull()
    hang = false
    expect(await runChoice(x.env, "cloud", true)).toBeNull()
    expect(lockHolder()).toBeNull()
  })

  it("the timeout helpers pass real answers through untouched and clean up their timers", async () => {
    expect(await withReadTimeout(async () => 7, 1000)("o")).toBe(7)
    await expect(
      withReadTimeout(async () => {
        throw new Error("boom")
      }, 1000)("o"),
    ).rejects.toThrow("boom")
    expect(await withPutTimeout(async () => ({ ok: true as const, rev: 5 }), 1000)("o", "t", 4)).toEqual({ ok: true, rev: 5 })
    expect(
      await withPutTimeout(async () => {
        throw new Error("x")
      }, 1000)("o", "t", 4),
    ).toEqual({ ok: false, reason: "unavailable" })
    expect(await withPutTimeout(never, 20)("o", "t", 4)).toEqual({ ok: false, reason: "unavailable" })
  })

  it("the hook uses the bounded versions everywhere it reads or writes for the sign-in flow and for pushes", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(hook).toMatch(/const boundedPut = withPutTimeout\(cloudPut, PUT_TIMEOUT\)/)
    expect(hook).toMatch(/cloudGet: boundedGet,/)
    expect(hook).toMatch(/cloudPut: boundedPut,/)
    expect(hook).toMatch(/putTracked\(ledger, boundedPut, owner,/)
    expect(hook).toMatch(/await boundedPut\(accountId,/)
  })
})
