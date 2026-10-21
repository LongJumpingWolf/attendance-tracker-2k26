/**
 * D3: the comparison on screen and the choice made from it. Real PromptController / runChoice / applyChoice / planFirstSignIn /
 * merge / restore-point code on a stubbed storage and an in-memory account store. Only isolated state; no browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

import { buildBackup, type FullBackupData } from "@/lib/backup"
import { same } from "@/lib/merge"
import { resetLockForTests } from "@/lib/operation-lock"
import { listRestorePoints, saveRestorePoint } from "@/lib/restore-points"
import {
  emptyData,
  planFirstSignIn,
  PromptController,
  runChoice,

  type ChoiceEnv,
  type Offer,
  type PromptState,
} from "@/lib/signin-reconcile"
import type { PutResult } from "@/lib/cloud-sync"
import type { Subject } from "@/lib/types"

const ROOT = path.resolve(import.meta.dirname, "..")

beforeEach(() => {
  resetLockForTests()
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
})
afterEach(() => {
  resetLockForTests() // a test that leaves a choice hanging must not keep the shared lock for the next one
  vi.unstubAllGlobals()
})

const sub = (id: string, name: string, marks: [string, "P" | "A"][] = []): Subject => {
  const log = marks.map(([d, s]) => ({ d, s }))
  return { id, name, attended: log.filter((e) => e.s === "P").length, missed: log.filter((e) => e.s === "A").length, requirement: 75, glowColor: "#000", tags: [], log }
}
const data = (subjects: Subject[] = [], extra: Partial<FullBackupData> = {}): FullBackupData => ({ ...emptyData(), subjects, ...extra })
const DEVICE = data([sub("d1", "DBMS", [["2026-10-01", "P"]]), sub("d2", "Anatomy", [["2026-10-01", "A"]])])
const ACCOUNT = data([sub("a1", "DBMS", [["2026-10-03", "P"]]), sub("a2", "Pharmacology", [["2026-10-02", "P"]])])

/** Everything a choice touches, in memory, with hooks to hold a step open and to see what changed */
function world(opts: { dataOwner?: string | null } = {}) {
  const s = {
    account: "acct-1" as string | null,
    paused: false,
    device: DEVICE,
    store: { rev: 1, text: buildBackup(ACCOUNT, false) },
    puts: 0,
    applied: 0,
    owners: [] as string[], // deviceReplaced calls (the data-owner record)
    dataOwner: opts.dataOwner ?? null,
    finalized: [] as { owner: string; rev: number }[],
    rebuilt: [] as string[],
    changes: [] as (PromptState | null)[],
    gate: null as null | Promise<void>, // holds the account read open
    failRead: false,
    verifyOk: true,
  }
  const prompts = new PromptController((p) => s.changes.push(p))
  const plan = () => planFirstSignIn({ device: s.device, cloud: { kind: "doc", doc: { data: s.store.text, rev: s.store.rev, updatedAt: 1 } }, accountId: s.account ?? "acct-1", dataOwner: s.dataOwner })
  const offerOf = (p: ReturnType<typeof plan>): Offer => {
    if (p.kind !== "choose") throw new Error("expected a choice, got " + p.kind)
    return p.offer
  }
  const env: ChoiceEnv = {
    prompts,
    accountId: () => s.account,
    paused: () => s.paused,
    deps: {
      getDevice: () => s.device,
      applyDevice: (d) => {
        s.applied++
        s.device = d
      },
      verifyDevice: async (d) => s.verifyOk && same(s.device, d),
      saveRestorePoint,
      listRestorePoints,
      cloudGet: async () => {
        if (s.gate) await s.gate
        if (s.failRead) throw new Error("offline")
        return { data: s.store.text, rev: s.store.rev, updatedAt: 1 }
      },
      cloudPut: async (_o, text, expected): Promise<PutResult> => {
        if (expected !== s.store.rev) return { ok: false, reason: "conflict" }
        s.puts++
        s.store = { rev: s.store.rev + 1, text }
        return { ok: true, rev: s.store.rev }
      },
    },
    deviceReplaced: (owner) => {
      s.owners.push(owner)
      s.dataOwner = owner
    },
    finalize: (owner, res) => {
      s.finalized.push({ owner, rev: res.rev })
      s.dataOwner = owner // what adopt() records
      prompts.clear()
    },
    rebuild: async (notice) => {
      s.rebuilt.push(notice)
      // what connect() does: it declines to run while a prompt exists, then shows the comparison built from what is there now
      if (prompts.current) return
      prompts.show(offerOf(plan()), notice)
    },
  }
  return { s, prompts, env, plan, offerOf }
}

const hold = () => {
  let open!: () => void
  const p = new Promise<void>((r) => (open = r))
  return { p, open }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe("D3: prompt identity and synchronous current", () => {
  it("every new comparison has its own identity; the current one is known at once", () => {
    const w = world()
    const a = w.prompts.show(w.offerOf(w.plan()))
    expect(w.prompts.current).toBe(a)
    expect(w.prompts.isCurrent(a.id)).toBe(true)
    const b = w.prompts.show(w.offerOf(w.plan()))
    expect(b.id).not.toBe(a.id)
    expect(w.prompts.isCurrent(a.id)).toBe(false)
    expect(w.prompts.patch(a.id, { error: "late" })).toBe(false)
    expect(w.prompts.current?.error).toBeNull()
    w.prompts.clear()
    expect(w.prompts.current).toBeNull() // synchronously, with no render in between
    expect(w.prompts.patch(b.id, { working: true })).toBe(false)
  })

  it("the hook keeps no lagging copy of it: no effect-synced ref, the controller is the source", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(hook).not.toMatch(/promptRef/)
    expect(hook).toMatch(/useState\(\(\) => new PromptController\(setPrompt\)\)/)
  })
})

describe("D3: a late result cannot bring back a prompt that is gone", () => {
  it("failure arriving after the prompt was cleared (paused, signed out) does not resurrect it", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    const g = hold()
    w.s.gate = g.p
    w.s.failRead = true
    const run = runChoice(w.env, "merge", false)
    expect(w.prompts.current?.working).toBe(true)
    w.prompts.clear() // pause
    w.s.paused = true
    g.open()
    const msg = await run
    expect(typeof msg).toBe("string")
    expect(w.prompts.current).toBeNull()
    expect(w.s.changes.at(-1)).toBeNull() // the last thing that was ever shown is "nothing"
    expect(w.s.applied + w.s.puts).toBe(0)
  })

  it("failure arriving after a NEWER comparison replaced it does not write into the new one", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    const g = hold()
    w.s.gate = g.p
    w.s.failRead = true
    const run = runChoice(w.env, "merge", false)
    const newer = w.prompts.show(w.offerOf(w.plan())) // a newer comparison while the old choice is still reading
    g.open()
    await run
    expect(w.prompts.current?.id).toBe(newer.id)
    expect(w.prompts.current?.error).toBeNull()
    expect(w.prompts.current?.working).toBe(false)
  })

  it("a choice whose comparison was replaced stops before changing anything (reason: stale)", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    let reads = 0
    const base = w.env.deps.getDevice
    w.env.deps.getDevice = () => (++reads === 1 && w.prompts.show(w.offerOf(w.plan())), base())
    await runChoice(w.env, "cloud", true)
    expect(w.s.applied).toBe(0)
    expect(same(w.s.device, DEVICE)).toBe(true)
    expect(w.s.finalized).toEqual([])
  })

  it("while paused: the choice is refused with the neutral message and nothing is touched", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    w.s.paused = true
    const msg = await runChoice(w.env, "merge", false)
    expect(msg).toMatch(/paused/i)
    expect(w.s.applied + w.s.puts).toBe(0)
    expect(w.prompts.current?.working).toBe(false)
  })

  it("pausing while the choice runs stops it at the next step; the prompt stays gone", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    const base = w.env.deps.getDevice
    w.env.deps.getDevice = () => {
      w.s.paused = true
      w.prompts.clear()
      return base()
    }
    const msg = await runChoice(w.env, "merge", false)
    expect(msg).toMatch(/paused/i)
    expect(w.prompts.current).toBeNull()
    expect(w.s.applied + w.s.puts).toBe(0)
  })
})

describe("D3: changed-elsewhere rebuilds the comparison without depending on the stale prompt", () => {
  it("the old prompt is dropped, a new one with a new identity and the fresh account state is shown, with the reason", async () => {
    const w = world()
    const old = w.prompts.show(w.offerOf(w.plan()))
    const oldRev = old.offer.rev
    // another browser saves while the comparison is open
    w.s.store = { rev: 2, text: buildBackup(data([sub("a1", "DBMS"), sub("a3", "Physiology")]), false) }
    const msg = await runChoice(w.env, "device", true)
    expect(msg).toMatch(/changed while this was happening/)
    await flush()
    expect(w.s.rebuilt).toHaveLength(1)
    expect(w.prompts.isCurrent(old.id)).toBe(false)
    expect(w.prompts.current).not.toBeNull()
    expect(w.prompts.current?.id).not.toBe(old.id)
    expect(w.prompts.current?.offer.rev).toBe(2)
    expect(oldRev).toBe(1)
    expect(w.prompts.current?.error).toBe(msg) // the person is told why the comparison changed
    expect(w.prompts.current?.working).toBe(false)
    expect(w.s.puts).toBe(0) // nothing was replaced
  })

  it("the rebuild is not blocked by the prompt that caused it (the hook's connect() refuses to run while a prompt exists)", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    w.s.store = { rev: 2, text: buildBackup(ACCOUNT, false) }
    let sawPromptWhenRebuilding: boolean | null = null
    const rebuild = w.env.rebuild
    w.env.rebuild = async (n) => {
      sawPromptWhenRebuilding = w.prompts.current !== null
      await rebuild(n)
    }
    await runChoice(w.env, "device", true)
    expect(sawPromptWhenRebuilding).toBe(false)
    expect(w.prompts.current).not.toBeNull()
  })

  it("the hook clears first and numbers each attempt, so only the newest may show a comparison", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(hook).toMatch(/if \(cancelled \|\| ownerRef\.current === accountId \|\| prompts\.current\) return/)
    expect(hook).toMatch(/const gen = \+\+connectGen\.current/)
    expect(hook).toMatch(/gen !== connectGen\.current\) return/)
    expect(hook).toMatch(/prompts\.show\(plan\.offer, notice \?\? null\)/)
    expect(hook).toMatch(/rebuild: \(notice\) => connectRef\.current\(notice\)/)
  })
})

describe("D3: double clicks", () => {
  it.each(["merge", "device", "cloud"] as const)("%s: a second click while the first is running does nothing", async (choice) => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    const g = hold()
    w.s.gate = g.p
    const first = runChoice(w.env, choice, true)
    const second = runChoice(w.env, choice, true) // same tick: the first has not awaited anything yet
    expect(await second).toBeNull()
    g.open()
    expect(await first).toBeNull()
    expect(w.s.finalized).toHaveLength(1)
    expect(w.s.puts).toBeLessThanOrEqual(1)
    expect(w.s.applied).toBeLessThanOrEqual(1)
    expect((await listRestorePoints()).length).toBeLessThanOrEqual(2)
  })

  it("working is set before the first await, so the next click already sees it", () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    w.s.gate = hold().p
    void runChoice(w.env, "merge", false)
    expect(w.prompts.current?.working).toBe(true)
  })

  it("after a failure the person can choose again", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    w.s.failRead = true
    expect(await runChoice(w.env, "merge", false)).toMatch(/Couldn’t reach/)
    expect(w.prompts.current?.working).toBe(false)
    expect(w.prompts.current?.error).toMatch(/Couldn’t reach/)
    w.s.failRead = false
    expect(await runChoice(w.env, "merge", false)).toBeNull()
    expect(w.s.finalized).toHaveLength(1)
  })
})

describe("D3: the account changes during reconciliation", () => {
  it.each(["merge", "device", "cloud"] as const)("%s: switching accounts mid-way stops the choice before it changes this device or the account", async (choice) => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    const g = hold()
    w.s.gate = g.p
    const run = runChoice(w.env, choice, true)
    w.s.account = "acct-2" // signed in as someone else while the account copy was being read
    g.open()
    expect(await run).toBeNull() // nothing of it may stick to the next account
    expect(w.s.applied).toBe(0)
    expect(w.s.puts).toBe(0)
    expect(w.s.finalized).toEqual([])
    expect(w.s.owners).toEqual([])
    expect(same(w.s.device, DEVICE)).toBe(true)
  })

  it("signing out in the middle behaves the same", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    const g = hold()
    w.s.gate = g.p
    const run = runChoice(w.env, "merge", true)
    w.s.account = null
    g.open()
    expect(await run).toBeNull()
    expect(w.s.puts + w.s.applied).toBe(0)
  })

  it("the account changing between two steps is caught at the next read or replacement of this device's data", async () => {
    const w = world()
    w.prompts.show(w.offerOf(w.plan()))
    const base = w.env.deps.getDevice
    w.env.deps.getDevice = () => {
      w.s.account = "acct-2"
      return base()
    }
    await runChoice(w.env, "cloud", true)
    expect(w.s.applied).toBe(0)
    expect(same(w.s.device, DEVICE)).toBe(true)
  })
})

describe("D3: whose data this device holds is recorded whenever a choice changed it", () => {
  it("'use my account's data' records the account as owner at the moment the data is replaced", async () => {
    const w = world({ dataOwner: "acct-0" }) // the data here was the previous account's
    w.prompts.show(w.offerOf(w.plan()))
    expect(await runChoice(w.env, "cloud", true)).toBeNull()
    expect(w.s.owners).toEqual(["acct-1"])
    expect(w.s.dataOwner).toBe("acct-1")
    // the NEXT account is therefore told the data belongs to someone else, and the previous one is not mentioned
    const next = planFirstSignIn({ device: w.s.device, cloud: { kind: "none" }, accountId: "acct-2", dataOwner: w.s.dataOwner })
    expect(next.kind === "choose" && next.offer.foreign).toBe(true)
  })

  it("even when a later step fails, the device already holds this account's data and says so", async () => {
    const w = world({ dataOwner: "acct-0" })
    w.prompts.show(w.offerOf(w.plan()))
    w.s.verifyOk = false // the device's storage never shows the new data
    expect(await runChoice(w.env, "cloud", true)).toMatch(/Couldn’t finish saving/)
    expect(w.s.applied).toBe(1)
    expect(w.s.owners).toEqual(["acct-1"])
    expect(w.s.finalized).toEqual([]) // but nothing is called complete
    expect(w.prompts.current?.error).toMatch(/Couldn’t finish saving/)
  })

  it("a merge that changes this device's data records the owner; one that leaves it alone does not need to (finish records it)", async () => {
    const w = world({ dataOwner: "acct-0" })
    w.prompts.show(w.offerOf(w.plan()))
    expect(await runChoice(w.env, "merge", false)).toBeNull()
    expect(w.s.owners).toEqual(["acct-1"])

    const w2 = world({ dataOwner: "acct-0" })
    w2.s.device = data([sub("d1", "DBMS", [["2026-10-01", "P"]])])
    w2.s.store = { rev: 1, text: buildBackup(data([sub("d1", "DBMS", [["2026-10-01", "P"]])], { tags: ["core"] }), false) }
    w2.s.device = data([sub("d1", "DBMS", [["2026-10-01", "P"]]), sub("d2", "Anatomy")], { tags: ["core"] }) // a superset: merging changes nothing here
    w2.prompts.show(w2.offerOf(w2.plan()))
    expect(await runChoice(w2.env, "merge", false)).toBeNull()
    expect(w2.s.owners).toEqual([])
    expect(w2.s.finalized).toHaveLength(1)
    expect(w2.s.dataOwner).toBe("acct-1")
  })

  it("'use this device's data' leaves the device alone and the success path records the owner", async () => {
    const w = world({ dataOwner: "acct-0" })
    w.prompts.show(w.offerOf(w.plan()))
    expect(await runChoice(w.env, "device", true)).toBeNull()
    expect(w.s.applied).toBe(0)
    expect(w.s.dataOwner).toBe("acct-1")
  })

  it("a refused choice (not confirmed, paused, stale) records nothing", async () => {
    const w = world({ dataOwner: "acct-0" })
    w.prompts.show(w.offerOf(w.plan()))
    await runChoice(w.env, "cloud", false) // needs confirmation
    expect(w.s.owners).toEqual([])
    expect(w.s.dataOwner).toBe("acct-0")
  })

  it("the hook writes the record in deviceReplaced and in adopt", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(hook).toMatch(/deviceReplaced: \(owner\) => write\(DATA_OWNER_KEY, owner\)/)
    expect(hook).toMatch(/write\(DATA_OWNER_KEY, owner\)\s*write\(REV_KEY, String\(rev\)\)/)
  })
})

describe("D3: paused hides the sheet and shows a neutral status", () => {
  it("the hook hides the prompt the moment sync is paused and reports a neutral 'paused' status", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    expect(hook).toMatch(/reconcile: paused \? null : prompt/)
    expect(hook).toMatch(/if \(paused\) \{\s*prompts\.clear\(\)[\s\S]*?setStatus\("paused"\)/)
    expect(hook).toMatch(/export type SyncStatus = [^\n]*"paused"/)
    expect(fs.readFileSync(path.join(ROOT, "components/settings-sync.tsx"), "utf8")).toMatch(/paused: \{ text: "Paused while the demo shows"/)
  })

  it("a connect attempt still reading when sync is paused cannot show a comparison afterwards", () => {
    const hook = fs.readFileSync(path.join(ROOT, "hooks/use-cloud-sync.ts"), "utf8")
    // pausing re-runs the effect: it numbers the attempt away (connectGen) and cancels it
    expect(hook).toMatch(/connectGen\.current\+\+ \/\/ and a comparison still being built must not appear while it is paused/)
  })
})

describe("D3: the screen cannot start the choice twice either", () => {
  it("the apply button is disabled while working, and so are the options and 'decide later'", () => {
    const sheet = fs.readFileSync(path.join(ROOT, "components/reconcile-sheet.tsx"), "utf8")
    expect(sheet).toMatch(/const ready = Boolean\(opt\?\.enabled\) && \(!needsSure \|\| sure\) && !st\.working/)
    expect(sheet).toMatch(/disabled=\{!ready\}/)
    expect(sheet).toMatch(/data-testid="reconcile-later" disabled=\{st\.working\}/)
  })
})

