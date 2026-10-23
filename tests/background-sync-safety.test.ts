/**
 * Background sync against the shared lock: incoming data (a pull, a listener snapshot) must never be applied while a restore, a
 * reset or a demo transition is replacing the device's data, must not repopulate data after a reset or overwrite a demo, and must
 * not be thrown away: it is set aside and applied once the replacement is over. Real ledger/ingestor/merge/restore-point/lock code;
 * `Device` wires them the way hooks/use-cloud-sync.ts does (owner, epoch, pause and lock checked in `canProceed`, which `merge`
 * re-checks after its awaited restore-point saves, immediately before applying).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { buildBackup, type FullBackupData } from "@/lib/backup"
import { mergeData, same } from "@/lib/merge"
import { isDemoLive, lockHolder, onRelease, resetLockForTests, setDemoLive, tryAcquire } from "@/lib/operation-lock"
import { loadSchedule, saveSchedule } from "@/lib/reminders"
import { saveRestorePoint } from "@/lib/restore-points"
import { resetEverything, restoreFrom } from "@/lib/safe-replace"
import { createIngestor, DeferredError, emptyData, WriteLedger, type BaseRecord, type MarkerStore, type WriteMarker } from "@/lib/signin-reconcile"
import type { Subject } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")

beforeEach(() => {
  const m = new Map<string, string>()
  vi.stubGlobal("window", {})
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-01T10:00:00Z"))
  resetLockForTests()
})
afterEach(() => {
  resetLockForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const tick = () => vi.setSystemTime(new Date(Date.now() + 1000))

const sub = (id: string, name: string): Subject => ({ id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [] })
const data = (subjects: Subject[], extra: Partial<FullBackupData> = {}): FullBackupData => ({ ...emptyData(), subjects, ...extra })
const names = (d: FullBackupData) => d.subjects.map((s) => s.name)

class Disk implements MarkerStore {
  value: unknown
  async load() {
    return structuredClone(this.value)
  }
  async save(list: WriteMarker[]) {
    this.value = structuredClone(list)
  }
}
const hold = () => {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}

/** One browser: the stored copy (CAS), the hook's owner/epoch/pause state, and the ingestor wired like the hook */
function world() {
  const base0 = data([sub("s1", "Original")])
  tick()
  const store = { rev: 1, text: buildBackup(base0, false) }
  const state = {
    owner: "acct" as string | null,
    epoch: 0,
    paused: false,
    data: base0,
    rev: 1 as number | null,
    base: { rev: 1, data: base0 } as BaseRecord | null,
    merges: 0,
    deferred: false,
    waitBeforeApply: null as null | (() => Promise<void>),
    pulls: 0,
  }
  const ledger = new WriteLedger(new Disk())
  const ingestor = createIngestor({
    ledger,
    getRev: () => state.rev,
    revCorrupt: () => false,
    loadBase: async () => state.base,
    merge: async (cloud, rev, base, _why, canProceed) => {
      if (state.waitBeforeApply) await state.waitBeforeApply() // e.g. the awaited restore-point / base / marker work in the hook
      await saveRestorePoint("Before a sync update", state.data)
      if (canProceed && !canProceed()) throw new DeferredError() // immediately before applying
      state.merges++
      const merged = mergeData(base, state.data, cloud).data
      state.data = merged
      state.base = { rev, data: cloud }
      state.rev = rev
      return !same(merged, cloud)
    },
    adoptLanded: async () => {},
  })
  /** what the hook's gate does */
  const gate = () => {
    const owner = state.owner
    const epoch = state.epoch
    return () => state.owner === owner && !(state.paused || isDemoLive()) && state.epoch === epoch && lockHolder() === null
  }
  const pull = async () => {
    if (!state.owner || state.paused || isDemoLive()) return null
    state.pulls++
    if (lockHolder() !== null) {
      state.deferred = true
      return null
    }
    const out = await ingestor.ingest({ data: store.text, rev: store.rev }, "pull", gate())
    if (out.kind === "failed" && out.reason === "deferred") state.deferred = true
    return out
  }
  // the hook's retry: when the lock is released, set-aside data is fetched and applied again, once
  const stop = onRelease(() => {
    if (!state.deferred) return
    state.deferred = false
    void pull()
  })
  const remote = (d: FullBackupData) => {
    tick()
    store.rev += 1
    store.text = buildBackup(d, false)
  }
  return { store, state, ledger, pull, remote, stop, base0 }
}

const INCOMING = { subjects: [sub("b1", "Backup subject")], tasks: [], tags: [], mates: [], reminders: [], full: true as const }
const flush = () => new Promise((r) => setTimeout(r, 0))

function restoreDeps(w: ReturnType<typeof world>, slow?: Promise<void>) {
  return {
    current: (): FullBackupData => ({ ...w.state.data, reminders: loadSchedule() }),
    saveRestorePoint: async (r: string, d: FullBackupData) => {
      if (slow) await slow
      await saveRestorePoint(r, d)
    },
    demoActive: () => isDemoLive(),
    applyData: (d: { subjects: Subject[]; tasks: FullBackupData["tasks"]; tags: string[]; mates?: FullBackupData["mates"] }) => {
      w.state.data = { ...w.state.data, subjects: d.subjects, tasks: d.tasks, tags: d.tags, mates: d.mates ?? [] }
    },
    applyReminders: saveSchedule,
    readReminders: loadSchedule,
    dataPersisted: async () => true,
  }
}

describe("incoming data during a restore", () => {
  it("is not applied while the restore holds the lock, is not lost, and is applied once the lock is released", async () => {
    const w = world()
    const g = hold()
    const restore = restoreFrom(INCOMING, restoreDeps(w, g.p))
    await flush()
    expect(lockHolder()).toBe("restore")
    w.remote(data([sub("s1", "Original"), sub("x", "Remote addition")]))
    expect(await w.pull()).toBeNull() // set aside
    expect(w.state.merges).toBe(0)
    expect(names(w.state.data)).toEqual(["Original"]) // untouched by sync
    g.open()
    expect((await restore).ok).toBe(true)
    await flush()
    await flush()
    expect(w.state.merges).toBe(1) // retried exactly once, no loop
    expect(w.state.pulls).toBe(2)
    expect(names(w.state.data).sort()).toEqual(["Backup subject", "Remote addition"]) // both the restore and the remote work are there
    expect(w.state.deferred).toBe(false)
    w.stop()
  })

  it("deterministically: the lock appearing during the merge's awaited work defers it, changes nothing, keeps the marker, and the copy is retried after", async () => {
    const w = world()
    w.remote(data([sub("s1", "Original"), sub("x", "Remote addition")]))
    let release: (() => void) | null = null
    w.state.waitBeforeApply = async () => {
      release = tryAcquire("restore") // a restore begins while the merge is mid-way
    }
    // a write in doubt, to prove its marker is untouched by the deferral
    await w.ledger.begin("t", 1)
    const out = await w.pull()
    expect(out).toEqual({ kind: "failed", reason: "deferred" })
    expect(w.state.merges).toBe(0)
    expect(names(w.state.data)).toEqual(["Original"])
    expect((await w.ledger.list()).length).toBe(1)
    w.state.waitBeforeApply = null
    release!() // the restore ends: the set-aside copy is applied
    await flush()
    await flush()
    expect(w.state.merges).toBe(1)
    expect(names(w.state.data).sort()).toEqual(["Original", "Remote addition"])
    w.stop()
  })
})

describe("incoming data during and after a reset", () => {
  it("an in-flight pull cannot repopulate the device after a reset (the reset detaches the account first)", async () => {
    const w = world()
    w.remote(data([sub("s1", "Original"), sub("x", "Remote addition")]))
    const g = hold()
    w.state.waitBeforeApply = () => g.p
    const inFlight = w.pull() // fetched the account's copy; about to apply it
    await flush()
    const reset = await resetEverything({
      current: () => ({ ...w.state.data, reminders: loadSchedule() }),
      saveRestorePoint,
      demoActive: () => isDemoLive(),
      clear: () => {
        w.state.owner = null
        w.state.epoch++
        w.state.data = emptyData()
      },
      isCleared: async () => true,
    })
    expect(reset.ok).toBe(true)
    g.open()
    const out = await inFlight
    expect(out).toEqual({ kind: "failed", reason: "deferred" })
    expect(w.state.merges).toBe(0)
    expect(w.state.data.subjects).toEqual([]) // stays empty
    await flush()
    await flush()
    expect(w.state.merges).toBe(0)
    expect(await w.pull()).toBeNull() // and with no account, nothing is fetched at all
    w.stop()
  })

  it("a listener snapshot that arrives while the reset holds the lock is set aside, and with the account gone it is not applied afterwards either", async () => {
    const w = world()
    let resetFinished = false
    const g = hold()
    const reset = resetEverything({
      current: () => ({ ...w.state.data, reminders: loadSchedule() }),
      saveRestorePoint: async (r, d) => {
        await g.p
        await saveRestorePoint(r, d)
      },
      demoActive: () => false,
      clear: () => {
        w.state.owner = null
        w.state.epoch++
        w.state.data = emptyData()
        resetFinished = true
      },
      isCleared: async () => true,
    })
    await flush()
    w.remote(data([sub("s1", "Original"), sub("y", "Late arrival")]))
    expect(await w.pull()).toBeNull() // lock held
    g.open()
    expect((await reset).ok).toBe(true)
    expect(resetFinished).toBe(true)
    await flush()
    await flush()
    expect(w.state.data.subjects).toEqual([])
    expect(w.state.merges).toBe(0)
    w.stop()
  })
})

describe("incoming data and the demo", () => {
  it("is not applied once the demo has started, even before the paused option has re-rendered, and applies after the demo ends", async () => {
    const w = world()
    const g = hold()
    w.state.waitBeforeApply = () => g.p
    w.remote(data([sub("s1", "Original"), sub("x", "Remote addition")]))
    const inFlight = w.pull()
    await flush()
    const demoData = data([sub("demo", "Demo subject")])
    w.state.data = demoData // the page swaps the sample data in ...
    setDemoLive(true) // ... and flags it in the same step (state.paused is still false: React has not re-rendered)
    expect(w.state.paused).toBe(false)
    g.open()
    expect(await inFlight).toEqual({ kind: "failed", reason: "deferred" })
    expect(w.state.data).toBe(demoData) // the sample data was not overwritten by the real copy
    expect(w.state.merges).toBe(0)
    // the demo ends: the page restores the real data and clears the flag; the pause ending re-pulls
    w.state.data = data([sub("s1", "Original")])
    w.state.waitBeforeApply = null
    setDemoLive(false)
    await w.pull()
    expect(names(w.state.data).sort()).toEqual(["Original", "Remote addition"])
    w.stop()
  })

  it("while the demo is live nothing is even fetched", async () => {
    const w = world()
    setDemoLive(true)
    expect(await w.pull()).toBeNull()
    expect(w.state.pulls).toBe(0)
    w.stop()
  })
})

describe("the epoch and the pause", () => {
  it("work started under an older epoch (the account changed, or the pause began and ended) does not apply", async () => {
    const w = world()
    const g = hold()
    w.state.waitBeforeApply = () => g.p
    w.remote(data([sub("s1", "Original"), sub("x", "Remote addition")]))
    const inFlight = w.pull()
    await flush()
    w.state.epoch++ // pause began and ended / account re-resolved
    g.open()
    expect(await inFlight).toEqual({ kind: "failed", reason: "deferred" })
    expect(w.state.merges).toBe(0)
    w.stop()
  })

  it("a copy set aside because of a pause is applied when the pause ends (the effect re-runs and pulls), not dropped", async () => {
    const w = world()
    w.remote(data([sub("s1", "Original"), sub("x", "Remote addition")]))
    w.state.paused = true
    expect(await w.pull()).toBeNull()
    w.state.paused = false
    w.state.epoch++
    await w.pull()
    expect(names(w.state.data).sort()).toEqual(["Original", "Remote addition"])
    w.stop()
  })
})

describe("the hook is wired to all of this", () => {
  const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
  it("pull, the listener, push and the first connection check the lock, the pause and the epoch", () => {
    expect(hook).toMatch(/if \(lockHolder\(\) !== null\) \{\s*deferredRef\.current = true/)
    expect(hook).toMatch(/ingest\(doc, "pull", can\)/)
    expect(hook).toMatch(/ingest\(doc, "live", can\)/)
    expect(hook).toMatch(/epochRef\.current === epoch && lockHolder\(\) === null/)
    expect(hook).toMatch(/epochRef\.current\+\+ \/\/ the account, the pause state/)
    expect(hook).toMatch(/epochRef\.current\+\+ \/\/ anything fetched for this account must not be applied now/)
    expect(hook).toMatch(/if \(canProceed && !canProceed\(\)\) throw new DeferredError\(\)/)
  })
  it("a deferred copy is retried when the lock is released", () => {
    expect(hook).toMatch(/onRelease\(\(\) => \{\s*if \(!deferredRef\.current\) return\s*deferredRef\.current = false\s*void syncRef\.current\(\)/)
    expect(hook).toMatch(/if \(out\.reason === "deferred"\) deferredRef\.current = true/)
  })
  it("the page clears the demo flag whenever the demo ends or everything is reset, and never raises it (the guide never swaps in sample data)", () => {
    const page = fs.readFileSync(path.join(ROOT, "app/page.tsx"), "utf8")
    expect((page.match(/setDemoLive\(false\)/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(page).not.toMatch(/setDemoLive\(true\)/)
  })
})

describe("the ingestor stands down at every step, touching nothing", () => {
  const stored = () => {
    tick()
    return { data: buildBackup(data([sub("s1", "Original"), sub("x", "Remote")]), false), rev: 2 }
  }
  function spyEnv() {
    const calls: string[] = []
    const ledger = new WriteLedger(new Disk())
    const env = {
      ledger,
      getRev: () => (calls.push("getRev"), 1),
      revCorrupt: () => false,
      loadBase: async () => (calls.push("loadBase"), null),
      merge: async () => (calls.push("merge"), true),
      adoptLanded: async () => void calls.push("adopt"),
    }
    return { env, calls, ledger }
  }

  it("not allowed from the start: nothing is read, merged or recorded", async () => {
    const { env, calls } = spyEnv()
    expect(await createIngestor(env).ingest(stored(), "pull", () => false)).toEqual({ kind: "failed", reason: "deferred" })
    expect(calls).toEqual([])
  })

  it("allowed at first but not any more by the time it would adopt a write that had landed: not adopted, marker kept", async () => {
    const { env, calls, ledger } = spyEnv()
    const doc = stored()
    const marker = await ledger.begin(doc.data, 1) // exactly the text now stored, at the revision it would make
    let asked = 0
    const out = await createIngestor(env).ingest(doc, "pull", () => ++asked < 3)
    expect(out).toEqual({ kind: "failed", reason: "deferred" })
    expect(calls).not.toContain("adopt")
    expect((await ledger.list()).map((m) => m.id)).toEqual([marker.id])
  })

  it("allowed throughout: it adopts and clears the marker", async () => {
    const { env, calls, ledger } = spyEnv()
    const doc = stored()
    await ledger.begin(doc.data, 1)
    expect(await createIngestor(env).ingest(doc, "pull", () => true)).toEqual({ kind: "landed" })
    expect(calls).toContain("adopt")
    expect(await ledger.list()).toEqual([])
  })
})
