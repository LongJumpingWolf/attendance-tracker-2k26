import { beforeEach, describe, expect, it, vi } from "vitest"
import { processAnswered, type ProcessDeps } from "@/lib/ping-processing"
import { applyPingResult, resultIsSaved } from "@/lib/ping-apply"
import { markFor } from "@/lib/attendance"
import type { Mate, Ping, Subject } from "@/lib/types"

const DATE = "2026-10-06"
const subject = (): Subject => ({
  id: "dbms", name: "DBMS", attended: 4, missed: 1, requirement: 75, glowColor: "#000", tags: [],
  slots: [{ day: 2, start: "09:00", end: "10:00", kind: "Lecture" }, { day: 2, start: "14:00", end: "15:00" }],
})
const mate = (): Mate => ({ id: "m1", name: "Rahul", uid: "rahul", covered: 0, repaid: 0 })
const ping = (): Ping => ({
  id: "ping-1", from: "me", to: "rahul", fromName: "Me", toName: "Rahul", participants: ["me", "rahul"], date: DATE, status: "answered",
  items: [{ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer: "yes" }, { key: "dbms@14:00", subjectId: "dbms", name: "DBMS", t: "14:00", answer: "yes" }],
})

/** The server (shared) and one device's data. "saved" is what is on that device's disk; "live" is what the app holds in memory. */
class Server {
  status: "answered" | "processed" = "answered"
  leaseBy: string | null = null
  leaseLive = false
  finalizeCalls = 0
  lease(id: string, device: string) {
    if (this.status !== "answered") return false
    if (this.leaseBy && this.leaseBy !== device && this.leaseLive) return false
    this.leaseBy = device
    this.leaseLive = true
    return true
  }
  expireLease() {
    this.leaseLive = false
  }
}
class Device {
  live = { subjects: [subject()], mates: [mate()] }
  saved = { subjects: [subject()], mates: [mate()] }
  diskWorks = true
  applyRuns = 0
  constructor(public id: string, public server: Server) {}
  deps(over: Partial<ProcessDeps> = {}): ProcessDeps {
    return {
      lease: async () => this.server.lease("ping-1", this.id),
      apply: async (p) => {
        this.applyRuns++
        const r = applyPingResult(this.live.subjects, this.live.mates, p)
        this.live = { subjects: r.subjects, mates: r.mates }
        if (this.diskWorks) this.saved = JSON.parse(JSON.stringify(this.live)) // the write to IndexedDB
        return resultIsSaved(this.saved, r, p) // read back what is actually on disk
      },
      finalize: async () => {
        this.server.finalizeCalls++
        this.server.status = "processed"
      },
      ...over,
    }
  }
  /** The app is closed and reopened: whatever was only in memory is gone, what was saved is all there is */
  restart() {
    this.live = JSON.parse(JSON.stringify(this.saved))
  }
  get favours() {
    return this.saved.mates[0].covered
  }
  get presentCount() {
    return ["09:00", "14:00"].filter((t) => markFor(this.saved.subjects[0], DATE, t) === "P").length
  }
}

describe("a Ping is never processed before its result is saved", () => {
  let server: Server
  let phone: Device
  beforeEach(() => {
    server = new Server()
    phone = new Device("phone-device-1", server)
  })

  it("the normal path: lease, apply, save, finalize, once", async () => {
    expect(await processAnswered(ping(), phone.deps())).toBe("processed")
    expect(server.status).toBe("processed")
    expect(phone.presentCount).toBe(2)
    expect(phone.favours).toBe(2)
  })

  it("10. a crash right after taking the lease loses nothing: the Ping is still answered, and the next run finishes it", async () => {
    const crash = phone.deps({ apply: async () => { throw new Error("browser crashed") } })
    expect(await processAnswered(ping(), crash)).toBe("apply-failed")
    expect(server.status).toBe("answered") // not processed: the answer is still on the server
    expect(phone.presentCount).toBe(0)
    phone.restart() // the app reopens
    expect(await processAnswered(ping(), phone.deps())).toBe("processed") // and it has its own lease back, so it carries on
    expect(phone.presentCount).toBe(2)
    expect(phone.favours).toBe(2)
  })

  it("11. a crash after the result was saved but before finishing: reopening finishes it without applying anything twice", async () => {
    const dies = phone.deps({ finalize: async () => { throw new Error("tab closed") } })
    expect(await processAnswered(ping(), dies)).toBe("finalize-failed")
    expect(server.status).toBe("answered")
    expect(phone.favours).toBe(2) // the result was already saved
    phone.restart()
    expect(await processAnswered(ping(), phone.deps())).toBe("processed")
    expect(phone.favours).toBe(2) // not 4
    expect(phone.saved.subjects[0].log).toHaveLength(2) // not 4
    expect(phone.saved.subjects[0].attended).toBe(6)
  })

  it("the invariant: when the disk write did not stick, the Ping is NOT finalized", async () => {
    phone.diskWorks = false // memory has it, disk doesn't (a crash in the middle of saving)
    const result = await processAnswered(ping(), phone.deps())
    expect(result).toBe("apply-failed")
    expect(server.finalizeCalls).toBe(0)
    expect(server.status).toBe("answered")
    phone.diskWorks = true
    phone.restart()
    expect(await processAnswered(ping(), phone.deps())).toBe("processed")
    expect(phone.favours).toBe(2)
  })

  it("the invariant holds whichever step fails, however many times", async () => {
    for (const failAt of ["lease", "apply", "save", "finalize"] as const) {
      const s = new Server()
      const d = new Device("phone-device-1", s)
      const deps = d.deps({
        ...(failAt === "lease" ? { lease: async () => { throw new Error("offline") } } : {}),
        ...(failAt === "apply" ? { apply: async () => { throw new Error("boom") } } : {}),
        ...(failAt === "finalize" ? { finalize: async () => { throw new Error("offline") } } : {}),
      })
      if (failAt === "save") d.diskWorks = false
      await processAnswered(ping(), deps)
      // Whatever happened, the server never says processed unless the device really has the result
      if (s.status === "processed") expect(d.presentCount).toBe(2)
      expect(s.status).toBe("answered")
      d.diskWorks = true
      d.restart()
      expect(await processAnswered(ping(), d.deps())).toBe("processed")
      expect(d.presentCount).toBe(2)
      expect(d.favours).toBe(2)
    }
  })

  it("9. duplicate answering is impossible: once processed, nothing runs again", async () => {
    await processAnswered(ping(), phone.deps())
    expect(await processAnswered(ping(), phone.deps())).toBe("not-leased")
    expect(await processAnswered(ping(), phone.deps())).toBe("not-leased")
    expect(phone.applyRuns).toBe(1)
    expect(phone.favours).toBe(2)
    expect(server.finalizeCalls).toBe(1)
  })

  it("the same Ping triggered twice at once is handled once", async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const slow = phone.deps({ lease: async () => { await gate; return server.lease("ping-1", phone.id) } })
    const first = processAnswered(ping(), slow)
    const second = await processAnswered(ping(), phone.deps())
    expect(second).toBe("busy")
    release()
    expect(await first).toBe("processed")
    expect(phone.applyRuns).toBe(1)
  })
})

describe("9. two devices cannot both claim the same Ping", () => {
  it("while one holds the lease the other waits, and only one applies", async () => {
    const server = new Server()
    const phone = new Device("phone-device-1", server)
    const laptop = new Device("laptop-device-1", server)
    // Two separate browsers don't share memory, so each gets its own copy of the module
    const phoneRun = (await import("@/lib/ping-processing")).processAnswered
    vi.resetModules()
    const laptopRun = (await import("@/lib/ping-processing")).processAnswered
    const [a, b] = await Promise.all([phoneRun(ping(), phone.deps()), laptopRun(ping(), laptop.deps())])
    expect([a, b].filter((r) => r === "processed")).toHaveLength(1)
    expect([a, b]).toContain("not-leased")
    expect(phone.applyRuns + laptop.applyRuns).toBe(1)
    expect(server.finalizeCalls).toBe(1)
  })

  it("if the first device dies mid-way, the other takes over once the lease runs out, and the result still arrives exactly once", async () => {
    vi.resetModules()
    const server = new Server()
    const phone = new Device("phone-device-1", server)
    const laptop = new Device("laptop-device-1", server)
    await processAnswered(ping(), phone.deps({ apply: async () => { throw new Error("phone died") } }))
    expect(await processAnswered(ping(), laptop.deps())).toBe("not-leased") // the phone still holds it for now
    server.expireLease() // two minutes pass
    expect(await processAnswered(ping(), laptop.deps())).toBe("processed")
    expect(laptop.presentCount).toBe(2)
    expect(laptop.favours).toBe(2)
    // the phone comes back later: the Ping is processed, so it does nothing, and its own data never got a duplicate
    phone.restart()
    expect(await processAnswered(ping(), phone.deps())).toBe("not-leased")
    expect(phone.favours).toBe(0) // it will receive the result through sync, not by applying it a second time
  })

  it("a device that already applied it recovers its own lease at once", async () => {
    const server = new Server()
    const phone = new Device("phone-device-1", server)
    await processAnswered(ping(), phone.deps({ finalize: async () => { throw new Error("offline") } }))
    expect(server.lease("ping-1", "laptop-device-1")).toBe(false) // the laptop is held off
    expect(await processAnswered(ping(), phone.deps())).toBe("processed")
  })
})

describe("what a recovery run does to attendance", () => {
  it("12. never duplicates the attendance mark or the favour, however many times it runs", async () => {
    const server = new Server()
    const phone = new Device("phone-device-1", server)
    const failing = phone.deps({ finalize: async () => { throw new Error("offline") } })
    for (let i = 0; i < 4; i++) await processAnswered(ping(), failing)
    await processAnswered(ping(), phone.deps())
    expect(phone.saved.subjects[0].log).toHaveLength(2)
    expect(phone.saved.subjects[0].attended).toBe(6)
    expect(phone.saved.mates[0].covered).toBe(2)
    expect(phone.saved.mates[0].coveredPings).toHaveLength(2)
  })
})
