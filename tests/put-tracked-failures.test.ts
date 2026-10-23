import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WriteLedger, putTracked, type MarkerStore, type WriteMarker } from "@/lib/signin-reconcile"
import type { PutResult } from "@/lib/cloud-sync"

beforeEach(() => {
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
})
afterEach(() => vi.unstubAllGlobals())

/** A device whose storage works for the first save (the marker, before sending) and then starts failing, like a full disk */
class FailingDisk implements MarkerStore {
  saves = 0
  constructor(private failAfter: number) {}
  async load() {
    return []
  }
  async save(_list: WriteMarker[]) {
    this.saves++
    if (this.saves > this.failAfter) throw new Error("storage full")
  }
}

describe("a write that reached the server but could not be recorded on this device", () => {
  it("is reported as unsure, never thrown (a throw leaves the sync marked busy and nothing is ever sent again)", async () => {
    const ledger = new WriteLedger(new FailingDisk(1))
    const put = async (): Promise<PutResult> => ({ ok: true, rev: 1 })
    const result = await putTracked(ledger, put, "acct", "copy", null, async () => {})
    expect(result).toEqual({ ok: false, reason: "unavailable" })
  })

  it("also when recording the new revision itself fails", async () => {
    const ledger = new WriteLedger(new FailingDisk(10))
    const put = async (): Promise<PutResult> => ({ ok: true, rev: 1 })
    const result = await putTracked(ledger, put, "acct", "copy", null, async () => {
      throw new Error("could not store the base")
    })
    expect(result).toEqual({ ok: false, reason: "unavailable" })
  })

  it("a definite refusal is still reported as refused when tidying its marker fails", async () => {
    const ledger = new WriteLedger(new FailingDisk(1))
    const put = async (): Promise<PutResult> => ({ ok: false, reason: "conflict" })
    expect(await putTracked(ledger, put, "acct", "copy", null)).toEqual({ ok: false, reason: "conflict" })
  })

  it("a normal write still confirms", async () => {
    const ledger = new WriteLedger(new FailingDisk(10))
    const put = async (): Promise<PutResult> => ({ ok: true, rev: 1 })
    expect(await putTracked(ledger, put, "acct", "copy", null)).toEqual({ ok: true, rev: 1 })
  })
})
