/**
 * First-sign-in upload race: an edit made while the first upload is in flight must not be recorded as already synced.
 * The hook records what `settleFirstConnection` returns (production code, shared with the tests) and sends again when `needsPush`.
 * The flow below runs that function with the real planner, ledger and push helper against a compare-and-set stand-in store.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { buildBackup, parseFullBackup, type FullBackupData } from "@/lib/backup"
import type { PutResult } from "@/lib/cloud-sync"
import { same } from "@/lib/merge"
import { resetLockForTests } from "@/lib/operation-lock"
import { listRestorePoints, saveRestorePoint } from "@/lib/restore-points"
import {
  emptyData,
  fingerprint,
  planFirstSignIn,
  PromptController,
  putTracked,
  runChoice,
  settleFirstConnection,
  WriteLedger,
  type ChoiceEnv,
  type MarkerStore,
  type WriteMarker,
} from "@/lib/signin-reconcile"
import type { Subject } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")
beforeEach(() => {
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  resetLockForTests()
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date("2026-10-01T10:00:00Z"))
})
afterEach(() => {
  resetLockForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const sub = (id: string, name: string): Subject => ({ id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [] })
const data = (subjects: Subject[]): FullBackupData => ({ ...emptyData(), subjects })

class Disk implements MarkerStore {
  value: unknown
  async load() {
    return structuredClone(this.value)
  }
  async save(list: WriteMarker[]) {
    this.value = structuredClone(list)
  }
}

/** a store whose put can be held open, like a slow network */
function store() {
  const s = { rev: 0, text: null as string | null, gate: null as null | Promise<void> }
  const put = async (_o: string, text: string, expected: number | null): Promise<PutResult> => {
    if (s.gate) await s.gate
    if ((s.text === null ? null : s.rev) !== expected) return { ok: false, reason: "conflict" }
    s.rev = (expected ?? 0) + 1
    s.text = text
    return { ok: true, rev: s.rev }
  }
  return { s, put }
}

describe("first-sign-in upload: what is recorded as synced", () => {
  const D = data([sub("d1", "DBMS")])
  const E = data([sub("d1", "DBMS"), sub("d2", "Edited while uploading")])

  it("the uploaded snapshot is what is recorded; an edit made while the request was in flight is not, and it is sent next", async () => {
    const st = store()
    const plan = planFirstSignIn({ device: D, cloud: { kind: "none" }, accountId: "acct", dataOwner: null })
    expect(plan.kind).toBe("upload")
    if (plan.kind !== "upload") return
    let open!: () => void
    st.s.gate = new Promise<void>((r) => (open = r))
    let current = D // dataRef.current in the hook
    const uploading = st.put("acct", buildBackup(D, false), plan.rev) // the first upload, now pending
    current = E // the person marks attendance / adds a subject meanwhile
    open()
    const r = await uploading
    expect(r.ok).toBe(true)

    const settled = settleFirstConnection(D, current)
    expect(settled.lastJson).toBe(fingerprint(D)) // the snapshot that went up ...
    expect(settled.lastJson).not.toBe(fingerprint(E)) // ... not the data as it is now
    expect(settled.needsPush).toBe(true)

    // what the push does next: compares the data with lastJson, finds a difference, and sends it
    expect(fingerprint(current) !== settled.lastJson).toBe(true)
    const ledger = new WriteLedger(new Disk())
    tick()
    const second = await putTracked(ledger, st.put, "acct", buildBackup(current, false), r.ok ? r.rev : null)
    expect(second).toEqual({ ok: true, rev: 2 })
    const stored = parseFullBackup(st.s.text!)
    expect(stored.ok && stored.data.subjects.map((x) => x.name)).toEqual(["DBMS", "Edited while uploading"])
  })

  it("the old way of recording it (the data as it is after the await) would have hidden the edit: nothing would ever be sent", () => {
    const lastJsonOld = fingerprint(E) // fingerprint(dataRef.current) after the upload
    expect(fingerprint(E) === lastJsonOld).toBe(true) // push sees "nothing to send"
    expect(settleFirstConnection(D, E).needsPush).toBe(true) // the fixed behaviour
  })

  it("no edit during the upload: recorded as synced, nothing more to send", () => {
    expect(settleFirstConnection(D, D)).toEqual({ lastJson: fingerprint(D), needsPush: false })
  })

  it("reminders are not part of the comparison (they are not React state)", () => {
    const withReminder: FullBackupData = { ...D, reminders: [{ id: "r", day: 1, startTime: "09:00", endTime: "10:00", subjectName: "X", notifyOffset: 5, notifyWhen: "before" }] }
    expect(settleFirstConnection(D, withReminder).needsPush).toBe(false)
  })

  it("the edit being undone before the upload finishes needs no extra send", () => {
    expect(settleFirstConnection(D, data([sub("d1", "DBMS")])).needsPush).toBe(false)
  })

  it("the hook records the uploaded snapshot in every first-connection path, and re-triggers a push when edits arrived meanwhile", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(hook).toMatch(/connected\(accountId, r\.rev, device\)/)
    expect(hook).toMatch(/connected\(accountId, plan\.rev, device\)/)
    expect(hook).toMatch(/connected\(accountId, plan\.rev, plan\.data\)/)
    expect(hook).not.toMatch(/adopt\(accountId, [^)]*fingerprint\(dataRef\.current\)/) // never the mutable data
    expect(hook).toMatch(/const s = settleFirstConnection\(snapshot, dataRef\.current\)[\s\S]{0,200}if \(s\.needsPush\) \{\s*setStatus\("syncing"\)\s*setKick/)
  })
})

describe("a sign-in choice that waits on the network: edits made meanwhile are pushed", () => {
  const DEVICE = data([sub("d1", "DBMS")])
  const ACCOUNT = data([sub("a1", "Pharmacology")])

  /** the hook's finalize, using the same helper as the hook's connected(): record the verified snapshot, flag a push if the data moved */
  async function run(choice: "merge" | "device" | "cloud", edit: boolean) {
    tick()
    const st = { rev: 1, text: buildBackup(ACCOUNT, false) }
    let current: FullBackupData = DEVICE // what the hook sees as the data right now (dataRef.current)
    let started!: () => void
    const putStarted = new Promise<void>((r) => (started = r))
    let open!: () => void
    const gate = new Promise<void>((r) => (open = r))
    const prompts = new PromptController(() => {})
    const plan = planFirstSignIn({ device: DEVICE, cloud: { kind: "doc", doc: { data: st.text, rev: 1, updatedAt: 1 } }, accountId: "acct", dataOwner: null })
    if (plan.kind !== "choose") throw new Error("expected a choice")
    prompts.show(plan.offer)
    let settled: { rev: number; lastJson: string; needsPush: boolean } | null = null
    const env: ChoiceEnv = {
      prompts,
      accountId: () => "acct",
      paused: () => false,
      deps: {
        getDevice: () => current,
        applyDevice: (d) => void (current = d),
        verifyDevice: async (d) => same(current, d),
        saveRestorePoint,
        listRestorePoints,
        cloudGet: async () => ({ data: st.text, rev: st.rev, updatedAt: 1 }),
        cloudPut: async (_o, text, expected): Promise<PutResult> => {
          started()
          await gate // the network is slow
          if (expected !== st.rev) return { ok: false, reason: "conflict" }
          st.rev += 1
          st.text = text
          return { ok: true, rev: st.rev }
        },
      },
      deviceReplaced: () => {},
      finalize: (_owner, res) => {
        settled = { rev: res.rev, ...settleFirstConnection(res.data, current) } // = connected(owner, res.rev, res.data) in the hook
        prompts.clear()
      },
      rebuild: async () => {},
    }
    const running = runChoice(env, choice, true)
    if (choice !== "cloud") {
      await putStarted
      if (edit) current = { ...current, subjects: [...current.subjects, sub("late", "Edited while the choice waited")] }
    }
    open()
    expect(await running).toBeNull()
    return {
      st,
      settled: settled as unknown as { rev: number; lastJson: string; needsPush: boolean },
      current: () => current,
      push: async () => {
        const ledger = new WriteLedger(new Disk())
        tick()
        return putTracked(ledger, async (_o, text, expected): Promise<PutResult> => {
          if (expected !== st.rev) return { ok: false, reason: "conflict" }
          st.rev += 1
          st.text = text
          return { ok: true, rev: st.rev }
        }, "acct", buildBackup(current, false), settled!.rev)
      },
    }
  }

  it.each(["merge", "device"] as const)("%s: the edit made while the choice waited is not recorded as synced, and the next push puts it in the stored copy", async (choice) => {
    const x = await run(choice, true)
    expect(x.settled.needsPush).toBe(true)
    expect(x.settled.lastJson).not.toBe(fingerprint(x.current()))
    // the push the hook schedules (the data differs from what is recorded as synced)
    expect(fingerprint(x.current()) !== x.settled.lastJson).toBe(true)
    const r = await x.push()
    expect(r?.ok).toBe(true)
    const stored = parseFullBackup(x.st.text)
    expect(stored.ok && stored.data.subjects.map((s) => s.name)).toContain("Edited while the choice waited")
  })

  it.each(["merge", "device", "cloud"] as const)("%s: no edit meanwhile means nothing more to send", async (choice) => {
    const x = await run(choice, false)
    expect(x.settled.needsPush).toBe(false)
    expect(x.settled.lastJson).toBe(fingerprint(x.current()))
  })

  it("the hook's finalize goes through the same helper, and a send that turns out to be unnecessary does not leave 'Syncing…' showing", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(hook).toMatch(/connected\(owner, res\.rev, res\.data\)/)
    expect(hook).not.toMatch(/adopt\(owner, res\.rev, fingerprint\(res\.data\)\)/)
    expect(hook).toMatch(/setStatus\(\(st\) => \(st === "syncing" \? "synced" : st\)\)/)
  })
})

function tick() {
  vi.setSystemTime(new Date(Date.now() + 1000))
}
