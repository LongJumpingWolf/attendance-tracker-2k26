import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { Timestamp, doc, getDoc, setDoc, updateDoc, type Firestore } from "firebase/firestore"
import fs from "node:fs"
import { answerPing, createPing, finalizePing, leasePing } from "@/lib/ping-server"
import { applyPingResult, resultIsSaved } from "@/lib/ping-apply"
import { markFor } from "@/lib/attendance"
import type { Mate, Ping, Subject } from "@/lib/types"

/**
 * The whole exactly-once flow, with the REAL lease / finalize transactions and the real rules, and a fake "device"
 * (an in-memory copy plus a disk) so a crash can be staged at every step.
 */
let env: RulesTestEnvironment
const db = (uid: string) => env.authenticatedContext(uid).firestore() as unknown as Firestore
const ID = "ping-flow-0001"
const DATE = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

const subject = (): Subject => ({
  id: "dbms", name: "DBMS", attended: 4, missed: 1, requirement: 75, glowColor: "#000", tags: [],
  slots: [{ day: 0, start: "09:00", end: "10:00" }, { day: 1, start: "09:00", end: "10:00" }, { day: 2, start: "09:00", end: "10:00" }, { day: 3, start: "09:00", end: "10:00" }, { day: 4, start: "09:00", end: "10:00" }, { day: 5, start: "09:00", end: "10:00" }, { day: 6, start: "09:00", end: "10:00" }],
})
const mate = (): Mate => ({ id: "m", name: "Rahul", uid: "rahul", covered: 0, repaid: 0 })

class Device {
  live = { subjects: [subject()], mates: [mate()] }
  saved = JSON.parse(JSON.stringify(this.live))
  constructor(public id: string) {}
  async apply(p: Ping, opts: { crashBeforeSave?: boolean } = {}) {
    const r = applyPingResult(this.live.subjects, this.live.mates, p)
    this.live = { subjects: r.subjects, mates: r.mates }
    if (opts.crashBeforeSave) throw new Error("crashed before the result reached the disk")
    this.saved = JSON.parse(JSON.stringify(this.live))
    return resultIsSaved(this.saved, r, p)
  }
  restart() {
    this.live = JSON.parse(JSON.stringify(this.saved))
  }
}
const stored = async () => {
  let d: Record<string, unknown> | undefined
  await env.withSecurityRulesDisabled(async (c) => void (d = (await getDoc(doc(c.firestore() as unknown as Firestore, "pings", ID))).data()))
  return d
}
const asPing = async (): Promise<Ping> => ({ id: ID, ...(await stored()) } as unknown as Ping)

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-ping", firestore: { rules: fs.readFileSync("firestore.rules", "utf8") } })
})
afterAll(() => env.cleanup())
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled((c) => setDoc(doc(c.firestore() as unknown as Firestore, "requests/req1"), { from: "asha", to: "rahul", fromName: "Asha", toName: "Rahul", participants: ["asha", "rahul"], status: "accepted" }))
  await createPing(db("asha"), { id: ID, from: { uid: "asha", name: "Asha" }, to: { uid: "rahul", name: "Rahul" }, date: DATE, requestId: "req1", items: [{ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer: null }] })
  await answerPing(db("rahul"), ID, [{ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer: "yes" }])
})

/** What the app does, using the real server calls */
const process = async (device: Device, opts: { crashBeforeSave?: boolean; crashBeforeFinalize?: boolean } = {}) => {
  const { processAnswered } = await import("@/lib/ping-processing")
  return processAnswered(await asPing(), {
    lease: (id) => leasePing(db("asha"), id, device.id),
    apply: (p) => device.apply(p, opts),
    finalize: async (id) => {
      if (opts.crashBeforeFinalize) throw new Error("tab closed before finishing")
      await finalizePing(db("asha"), id)
    },
  })
}

describe("the exactly-once flow against the real server", () => {
  it("processes once and ends processed", async () => {
    const phone = new Device("phone-device-001")
    expect(await process(phone)).toBe("processed")
    expect((await stored())?.status).toBe("processed")
    expect(markFor(phone.saved.subjects[0], DATE, "09:00")).toBe("P")
    expect(phone.saved.mates[0].covered).toBe(1)
  })

  it("11. a crash before the result reached the disk: the Ping is still answered, and reopening recovers it", async () => {
    const phone = new Device("phone-device-001")
    expect(await process(phone, { crashBeforeSave: true })).toBe("apply-failed")
    expect((await stored())?.status).toBe("answered") // the server never says processed
    phone.restart() // reopen: memory is gone, the disk has nothing
    expect(phone.saved.mates[0].covered).toBe(0)
    expect(await process(phone)).toBe("processed")
    expect(phone.saved.mates[0].covered).toBe(1)
    expect(markFor(phone.saved.subjects[0], DATE, "09:00")).toBe("P")
  })

  it("10. a crash after saving but before finishing: it finishes on reopen, with no second favour or mark", async () => {
    const phone = new Device("phone-device-001")
    expect(await process(phone, { crashBeforeFinalize: true })).toBe("finalize-failed")
    expect((await stored())?.status).toBe("answered")
    phone.restart()
    expect(await process(phone)).toBe("processed")
    expect(phone.saved.mates[0].covered).toBe(1)
    expect(phone.saved.subjects[0].attended).toBe(5)
    expect(phone.saved.subjects[0].log).toHaveLength(1)
  })

  it("9. two devices: one holds the lease, the other cannot, and only one result is applied", async () => {
    const phone = new Device("phone-device-001")
    const laptop = new Device("laptop-device-01")
    // the phone takes the lease and then dies before applying
    expect(await process(phone, { crashBeforeSave: true })).toBe("apply-failed")
    expect(await process(laptop)).toBe("not-leased") // held off, by the server
    expect(laptop.saved.mates[0].covered).toBe(0)
    // two minutes later (by the server's clock) the lease has run out and the laptop takes over
    await env.withSecurityRulesDisabled((c) => updateDoc(doc(c.firestore() as unknown as Firestore, "pings", ID), { claimedAt: Timestamp.fromMillis(Date.now() - 3 * 60_000) }))
    vi.resetModules() // the laptop is a different browser: its own memory
    expect(await process(laptop)).toBe("processed")
    expect(laptop.saved.mates[0].covered).toBe(1)
    // the phone reopens later: the Ping is processed, it applies nothing a second time
    phone.restart()
    expect(await process(phone)).toBe("not-leased")
    expect(phone.saved.mates[0].covered).toBe(0)
  })

  it("12. nothing runs after it is processed", async () => {
    const phone = new Device("phone-device-001")
    await process(phone)
    for (let i = 0; i < 3; i++) expect(await process(phone)).toBe("not-leased")
    expect(phone.saved.mates[0].covered).toBe(1)
    expect(phone.saved.subjects[0].log).toHaveLength(1)
  })
})
