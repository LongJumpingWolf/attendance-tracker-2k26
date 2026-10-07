import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { attempt, OFFLINE_MESSAGE } from "@/lib/ping-send"
import {
  emptyPresented,
  loadPresented,
  nextEvent,
  resolveFocus,
  resultSummary,
  savePresented,
  type Presented,
} from "@/lib/ping-presentation"
import { localDate } from "@/lib/attendance"
import type { Ping } from "@/lib/types"

const ME = "me"
const MATE = "mate"
const daysAgo = (n: number) => localDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - n))
const ping = (o: Partial<Ping> = {}): Ping => ({
  id: "p1", from: MATE, to: ME, fromName: "Asha", toName: "Me", participants: [MATE, ME], date: daysAgo(0),
  items: [{ key: "s@09:00", subjectId: "s", name: "DBMS", t: "09:00", answer: null }], status: "asking", ...o,
})
const mine = (o: Partial<Ping> = {}) => ping({ from: ME, to: MATE, fromName: "Me", toName: "Rahul", participants: [ME, MATE], ...o }) // a Ping I sent
const answered = (o: Partial<Ping> = {}) => mine({ status: "answered", items: [{ key: "s@09:00", subjectId: "s", name: "DBMS", t: "09:00", answer: "yes" }], respondedAt: Date.now(), ...o })
const none: Presented = emptyPresented()

describe("a Ping asking for my answer", () => {
  it("1. appears at once when it arrives while the app is open (the live list gains it)", () => {
    expect(nextEvent([], ME, none)).toBeNull()
    const event = nextEvent([ping()], ME, none)
    expect(event).toMatchObject({ kind: "incoming" })
    expect(event?.ping.id).toBe("p1")
  })

  it("2. is found on the next launch when it arrived while the app was closed", () => {
    // a fresh launch: nothing remembered, the pending request is simply there in the data
    expect(nextEvent([ping({ id: "waiting" })], ME, loadPresented())?.ping.id).toBe("waiting")
  })

  it("4. is still shown at launch when the notification was missed or never delivered (the Ping is the source of truth)", () => {
    const pending = [ping({ id: "missed" })]
    expect(nextEvent(pending, ME, none, { focusId: null })?.ping.id).toBe("missed")
  })

  it("3. a notification opens exactly that Ping, even with an older one waiting", () => {
    const older = ping({ id: "old", date: daysAgo(2) })
    const wanted = ping({ id: "wanted", date: daysAgo(0) })
    expect(nextEvent([older, wanted], ME, none)?.ping.id).toBe("old") // by itself, the older request comes first
    expect(nextEvent([older, wanted], ME, none, { focusId: "wanted" })?.ping.id).toBe("wanted")
    const r = resolveFocus([older, wanted], ME, "wanted", none)
    expect(r.ok && r.event.ping.id).toBe("wanted")
  })

  it("5. is gone once answered, and stays gone even before the server's copy catches up", () => {
    expect(nextEvent([ping({ status: "answered" })], ME, none)).toBeNull()
    expect(nextEvent([ping({ status: "asking" })], ME, { ...none, incoming: { p1: Date.now() } })).toBeNull()
  })

  it("12. a processed Ping can't be shown as a request again, nor opened by id", () => {
    expect(nextEvent([ping({ status: "processed" })], ME, none)).toBeNull()
    expect(resolveFocus([ping({ status: "processed" })], ME, "p1", none)).toEqual({ ok: false, reason: "answered" })
  })

  it("an expired request is not put in front of anyone", () => {
    const old = ping({ date: daysAgo(5) })
    expect(nextEvent([old], ME, none)).toBeNull()
    expect(resolveFocus([old], ME, "p1", none)).toEqual({ ok: false, reason: "expired" })
  })

  it("a request sent by me, or between two other people, is never mine to answer", () => {
    expect(nextEvent([mine()], ME, none)).toBeNull()
    expect(nextEvent([ping({ participants: ["x", "y"], to: "y", from: "x" })], ME, none)).toBeNull()
  })
})

describe("the answer to a Ping I sent", () => {
  it("6. creates a pending result for me once the mate answers", () => {
    expect(nextEvent([mine({ status: "asking" })], ME, none)).toBeNull() // still waiting: nothing to show
    expect(nextEvent([answered()], ME, none)).toMatchObject({ kind: "result" })
  })

  it("7. shows while the app is open (the live list changes from asking to answered)", () => {
    const before = [mine()]
    const after = [answered()]
    expect(nextEvent(before, ME, none)).toBeNull()
    expect(nextEvent(after, ME, none)?.kind).toBe("result")
  })

  it("8. shows after reopening the app when it was answered while I was away, even though it's already processed", () => {
    expect(nextEvent([answered({ status: "processed" })], ME, none)?.kind).toBe("result")
  })

  it("9. is shown once: after I've seen it, it never comes back", () => {
    const seen: Presented = { ...none, result: { p1: Date.now() } }
    expect(nextEvent([answered()], ME, seen)).toBeNull()
    expect(resolveFocus([answered()], ME, "p1", seen)).toEqual({ ok: false, reason: "seen" })
  })

  it("an answer from long ago is left to the history, not announced", () => {
    expect(nextEvent([answered({ respondedAt: Date.now() - 10 * 86_400_000 })], ME, none)).toBeNull()
    expect(nextEvent([answered({ respondedAt: { seconds: Math.floor(Date.now() / 1000) - 60 } })], ME, none)?.kind).toBe("result") // a Firestore timestamp
  })

  it("is worded for what was actually answered", () => {
    expect(resultSummary(answered()).headline).toBe("Rahul marked you PRESENT")
    const none_ = answered({ items: [{ key: "a", subjectId: "s", name: "A", answer: "no" }] })
    expect(resultSummary(none_)).toMatchObject({ kind: "none", headline: "Rahul did not cover you" })
    const mixed = answered({ items: [{ key: "a", subjectId: "s", name: "A", answer: "yes" }, { key: "b", subjectId: "s", name: "B", answer: "no" }] })
    expect(resultSummary(mixed)).toMatchObject({ kind: "some", headline: "Rahul covered 1 of 2 classes" })
  })
})

describe("never the same Ping twice", () => {
  const store = new Map<string, string>()
  beforeEach(() => {
    store.clear()
    vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  })
  afterEach(() => vi.unstubAllGlobals())

  it("10. a notification tap and a manual launch share one record, so the Ping shows once", () => {
    const pings = [ping({ id: "once" })]
    let presented = loadPresented()
    const viaNotification = nextEvent(pings, ME, presented, { focusId: "once" })
    expect(viaNotification?.ping.id).toBe("once")
    presented = { ...presented, incoming: { once: Date.now() } } // the person answered it
    savePresented(presented)
    // the app is opened again by hand, and a late duplicate notification asks for the same id
    expect(nextEvent(pings, ME, loadPresented())).toBeNull()
    expect(nextEvent(pings, ME, loadPresented(), { focusId: "once" })).toBeNull()
  })

  it("the same Ping arriving twice in the data is one event", () => {
    expect(nextEvent([ping(), ping()], ME, none)?.ping.id).toBe("p1")
    const done = { ...none, incoming: { p1: 1 } }
    expect(nextEvent([ping(), ping()], ME, { ...done, incoming: { p1: Date.now() } })).toBeNull()
  })

  it("remembered across launches, and old entries are dropped", () => {
    savePresented({ incoming: { a: Date.now(), b: Date.now() - 90 * 86_400_000 }, result: {} })
    const back = loadPresented()
    expect(Object.keys(back.incoming)).toEqual(["a"])
    store.set("pingPresented", "{not json")
    expect(loadPresented()).toEqual(emptyPresented())
  })
})

describe("several Pings at once", () => {
  const a = ping({ id: "a", date: daysAgo(2) })
  const b = ping({ id: "b", date: daysAgo(1) })
  const c = ping({ id: "c", date: daysAgo(1) })
  const r = answered({ id: "r" })

  it("11. come in a fixed order: requests before answers, older class day first, then by id, however they arrive", () => {
    const orders = [[a, b, c, r], [r, c, b, a], [c, r, a, b], [b, a, r, c]]
    for (const list of orders) expect(nextEvent(list, ME, none)?.ping.id).toBe("a")
    const after = (done: string[]) => ({ ...none, incoming: Object.fromEntries(done.map((id) => [id, 1])) })
    expect(nextEvent([r, c, b, a], ME, after(["a"]))?.ping.id).toBe("b")
    expect(nextEvent([r, c, b, a], ME, after(["a", "b"]))?.ping.id).toBe("c")
    expect(nextEvent([r, c, b, a], ME, after(["a", "b", "c"]))?.ping.id).toBe("r")
  })

  it("a Ping on screen stays on screen when a newer, higher-priority one arrives", () => {
    expect(nextEvent([a, b], ME, none, { activeId: "b" })?.ping.id).toBe("b")
  })

  it("'Later' puts a request off for now but it is still pending, and an opened-by-id one overrides it", () => {
    expect(nextEvent([a, b], ME, none, { deferred: new Set(["a"]) })?.ping.id).toBe("b")
    expect(nextEvent([a], ME, none, { deferred: new Set(["a"]) })).toBeNull()
    expect(nextEvent([a], ME, none, { deferred: new Set(["a"]), focusId: "a" })?.ping.id).toBe("a")
  })
})

describe("opening a Ping by id (a notification or a link)", () => {
  it("refuses one that isn't there, or that belongs to other people, with the same answer", () => {
    expect(resolveFocus([], ME, "nope", none)).toEqual({ ok: false, reason: "missing" })
    const theirs = ping({ participants: ["x", "y"], from: "x", to: "y" })
    expect(resolveFocus([theirs], ME, "p1", none)).toEqual({ ok: false, reason: "missing" })
    expect(resolveFocus([ping()], null, "p1", none)).toEqual({ ok: false, reason: "missing" })
  })

  it("won't open my own Ping as a request, or one still waiting for the mate", () => {
    expect(resolveFocus([mine()], ME, "p1", none)).toEqual({ ok: false, reason: "waiting" })
  })
})

describe("13. Pings never claim success without the server", () => {
  afterEach(() => vi.useRealTimers())

  it("offline: says so at once, sends nothing and queues nothing", async () => {
    const write = vi.fn(async () => "sent")
    const r = await attempt(write, { online: false })
    expect(r).toEqual({ ok: false, reason: "offline", message: OFFLINE_MESSAGE })
    expect(write).not.toHaveBeenCalled()
  })

  it("online but unconfirmed: reports it as not confirmed instead of hanging", async () => {
    vi.useFakeTimers()
    const never = vi.fn(() => new Promise<string>(() => {}))
    const pending = attempt(never, { online: true, ms: 10_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await pending).toMatchObject({ ok: false, reason: "slow" })
  })

  it("a rejected write is a failure, not a success", async () => {
    expect(await attempt(() => Promise.reject(new Error("denied")), { online: true })).toMatchObject({ ok: false, reason: "failed" })
  })

  it("only a confirmed write is ok", async () => {
    expect(await attempt(async () => 42, { online: true })).toEqual({ ok: true, value: 42 })
  })

  it("reads the device's own online state when none is given", async () => {
    vi.stubGlobal("navigator", { onLine: false })
    const write = vi.fn(async () => 1)
    expect((await attempt(write)).ok).toBe(false)
    expect(write).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
