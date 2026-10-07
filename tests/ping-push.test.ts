import { describe, expect, it, vi } from "vitest"
import { createRequire } from "node:module"
import fs from "node:fs"

const require = createRequire(import.meta.url)
const { incomingMessage, answeredMessage } = require("../functions/ping-messages.js") as {
  incomingMessage: (p: unknown, id: string) => { data: Record<string, string>; webpush: { headers: Record<string, string> } }
  answeredMessage: (p: unknown, id: string) => { data: Record<string, string>; webpush: { headers: Record<string, string> } }
}

const items = (...answers: (string | null)[]) => answers.map((answer, i) => ({ key: `s${i}`, name: `Pathology Practical ${i}`, t: "10:00", answer }))

describe("the push messages", () => {
  const asked = { fromName: "Asha", toName: "Rahul", date: "2026-10-06", items: items(null, null) }

  it("say who, and nothing about the classes (a notification can show on a locked screen)", () => {
    const m = incomingMessage(asked, "abc123")
    const text = JSON.stringify(m)
    expect(m.data.body).toBe("Asha is asking about your attendance")
    expect(text).not.toMatch(/Pathology|2026-10-06|10:00/)
  })

  it("carry the Ping id as a link and as the tag, so a tap opens that Ping and a repeat replaces itself", () => {
    const m = incomingMessage(asked, "abc123")
    expect(m.data.url).toBe("/?ping=abc123")
    expect(m.data.tag).toBe("ping-abc123")
    expect(m.data.pingId).toBe("abc123")
    expect(m.data.type).toBe("ping")
    for (const v of Object.values(m.data)) expect(typeof v).toBe("string") // data-only messages must be all strings
  })

  it("keep a hostile id from breaking out of the link", () => {
    expect(incomingMessage(asked, "a b&x=1/../").data.url).toBe("/?ping=a%20b%26x%3D1%2F..%2F")
  })

  it("tell the sender when the mate covered them, and otherwise just that there is a reply", () => {
    expect(answeredMessage({ toName: "Rahul", items: items("yes", "yes") }, "p").data).toMatchObject({ title: "Ping answered", body: "Rahul marked you present", url: "/?ping=p", event: "result" })
    expect(answeredMessage({ toName: "Rahul", items: items("yes", "no") }, "p").data.body).toBe("Rahul replied to your Ping")
    expect(answeredMessage({ toName: "Rahul", items: items("no") }, "p").data.body).toBe("Rahul replied to your Ping")
    expect(JSON.stringify(answeredMessage({ toName: "Rahul", items: items("yes") }, "p"))).not.toMatch(/Pathology/)
  })

  it("survive missing names and are sent with high urgency for about three days", () => {
    expect(incomingMessage({ items: [] }, "x").data.body).toBe("A mate is asking about your attendance")
    const m = incomingMessage(asked, "x")
    expect(m.webpush.headers).toEqual({ Urgency: "high", TTL: "259200" })
  })
})

/** Runs the real service worker file against a fake worker environment, and hands back its handlers */
function loadWorker(windows: { visibilityState: string; focus?: () => Promise<void>; postMessage?: (m: unknown) => void }[] = []) {
  const handlers: Record<string, (e: unknown) => void> = {}
  const shown: { title: string; options: { body: string; tag: string; data: { url: string; pingId: string | null; type: string | null } } }[] = []
  const opened: string[] = []
  const self = {
    location: { origin: "https://app.test" },
    addEventListener: (type: string, fn: (e: unknown) => void) => void (handlers[type] = fn),
    registration: { showNotification: vi.fn(async (title: string, options: never) => void shown.push({ title, options })) },
    skipWaiting: vi.fn(),
  }
  const clients = {
    matchAll: vi.fn(async () => windows.map((w) => ({ focus: async () => {}, postMessage: () => {}, ...w }))),
    openWindow: vi.fn(async (url: string) => void opened.push(url)),
    claim: vi.fn(),
  }
  const code = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8")
  new Function("self", "clients", "caches", "fetch", code)(self, clients, { keys: async () => [], open: async () => ({}) }, vi.fn())
  const run = async (type: string, event: Record<string, unknown>) => {
    let waited: Promise<unknown> = Promise.resolve()
    handlers[type]({ ...event, waitUntil: (p: Promise<unknown>) => void (waited = p) })
    await waited
  }
  const push = (payload: unknown) => run("push", { data: { json: () => payload } })
  const click = (data: unknown) => run("notificationclick", { notification: { close: vi.fn(), data } })
  return { push, click, run, shown, opened, clients, handlers }
}

describe("the service worker", () => {
  const ping = { data: { type: "ping", pingId: "abc", tag: "ping-abc", title: "Ping", body: "Asha is asking about your attendance", url: "/?ping=abc" } }

  it("has no Firebase code in it (it reads the push itself)", () => {
    const code = fs.readFileSync(new URL("../public/sw.js", import.meta.url), "utf8")
    expect(code).not.toMatch(/importScripts|firebase\.initializeApp|gstatic/)
  })

  it("shows a Ping notification when the app isn't open in front of the person", async () => {
    const w = loadWorker([])
    await w.push(ping)
    expect(w.shown).toHaveLength(1)
    expect(w.shown[0].title).toBe("Ping")
    expect(w.shown[0].options).toMatchObject({ body: "Asha is asking about your attendance", tag: "ping-abc", data: { url: "/?ping=abc", pingId: "abc", type: "ping" } })
  })

  it("stays quiet when the app is open and visible: the app shows the Ping itself, so there is no second copy", async () => {
    const w = loadWorker([{ visibilityState: "visible" }])
    await w.push(ping)
    expect(w.shown).toHaveLength(0)
  })

  it("still notifies when the app is open but hidden behind another app", async () => {
    const w = loadWorker([{ visibilityState: "hidden" }])
    await w.push(ping)
    expect(w.shown).toHaveLength(1)
  })

  it("other notifications (like a class reminder) are not suppressed", async () => {
    const w = loadWorker([{ visibilityState: "visible" }])
    await w.push({ data: { title: "Class reminder", body: "DBMS at 9" } })
    expect(w.shown).toHaveLength(1)
  })

  it("also understands a plain notification payload, and ignores an empty or unreadable push", async () => {
    const w = loadWorker([])
    await w.push({ notification: { title: "Hello", body: "There" } })
    expect(w.shown[0].title).toBe("Hello")
    await w.push({})
    await w.run("push", {}) // a push with no data at all
    await w.run("push", { data: { json: () => { throw new Error("not json") } } }) // data that can't be read
    expect(w.shown).toHaveLength(1)
  })

  it("never links outside this app", async () => {
    const w = loadWorker([])
    await w.push({ data: { title: "x", body: "y", url: "https://evil.example/steal" } })
    await w.push({ data: { title: "x2", body: "y", url: "javascript:alert(1)" } })
    expect(w.shown.map((s) => s.options.data.url)).toEqual(["/", "/"])
    await w.push({ data: { title: "ok", body: "y", url: "https://app.test/?ping=zzz" } })
    expect(w.shown[2].options.data.url).toBe("/?ping=zzz")
  })

  it("a tap opens the app at that Ping when the app is closed", async () => {
    const w = loadWorker([])
    await w.click({ url: "/?ping=abc", pingId: "abc", type: "ping" })
    expect(w.opened).toEqual(["/?ping=abc"])
  })

  it("a tap on a running app focuses it and tells it which Ping, without reloading", async () => {
    const focus = vi.fn(async () => {})
    const postMessage = vi.fn()
    const w = loadWorker([{ visibilityState: "hidden", focus, postMessage }])
    await w.click({ url: "/?ping=abc", pingId: "abc", type: "ping" })
    expect(focus).toHaveBeenCalled()
    expect(postMessage).toHaveBeenCalledWith({ type: "open-ping", id: "abc" })
    expect(w.opened).toEqual([])
  })

  it("a tap on a notification with no Ping (a class reminder) just opens or focuses the app", async () => {
    const w = loadWorker([])
    await w.click({ url: "https://app.test/" })
    expect(w.opened).toEqual(["/"])
  })
})

const { makeHandlers } = require("../functions/ping-handlers.js") as {
  makeHandlers: (d: {
    getToken: (uid: string) => Promise<string | null>
    deleteToken: (uid: string) => Promise<void>
    send: (m: Record<string, unknown>) => Promise<void>
    log?: { error: (...a: unknown[]) => void }
  }) => {
    onCreated: (p: Record<string, unknown>, id: string) => Promise<string>
    onUpdated: (b: Record<string, unknown>, a: Record<string, unknown>, id: string) => Promise<string>
  }
}

describe("the Cloud Function logic (with a fake token store and fake messaging)", () => {
  const ping = { from: "asha", to: "rahul", fromName: "Asha", toName: "Rahul", status: "asking", items: items(null) }
  const setup = (token: string | null = "tok-rahul") => {
    const sent: Record<string, unknown>[] = []
    const removed: string[] = []
    const errors: unknown[][] = []
    const send = vi.fn(async (m: Record<string, unknown>) => void sent.push(m))
    const h = makeHandlers({ getToken: async () => token, deleteToken: async (uid) => void removed.push(uid), send, log: { error: (...a) => void errors.push(a) } })
    return { h, sent, removed, errors, send }
  }

  it("a new Ping alerts the person who was asked, with the safe message and the Ping's link", async () => {
    const { h, sent } = setup()
    expect(await h.onCreated(ping, "p1")).toBe("sent")
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({ token: "tok-rahul", data: { event: "incoming", pingId: "p1", url: "/?ping=p1", tag: "ping-p1" } })
    expect(JSON.stringify(sent[0])).not.toMatch(/Pathology/)
  })

  it("an answer alerts the person who asked, once, only at the moment it is answered", async () => {
    const { h, sent } = setup("tok-asha")
    const answered = { ...ping, status: "answered", items: items("yes", "yes") }
    expect(await h.onUpdated(ping, answered, "p1")).toBe("sent")
    expect(sent[0]).toMatchObject({ token: "tok-asha", data: { event: "result", body: "Rahul marked you present" } })
    // taking the lease, finishing, or any later edit are not news
    expect(await h.onUpdated(answered, { ...answered, claimedBy: "device-1" }, "p1")).toBe("ignored")
    expect(await h.onUpdated(answered, { ...answered, status: "processed" }, "p1")).toBe("ignored")
    expect(await h.onUpdated(ping, { ...ping, status: "asking" }, "p1")).toBe("ignored")
    expect(sent).toHaveLength(1)
  })

  it("a Ping that isn't asking never raises a request alert", async () => {
    const { h, send } = setup()
    expect(await h.onCreated({ ...ping, status: "answered" }, "p1")).toBe("ignored")
    expect(send).not.toHaveBeenCalled()
  })

  it("nobody who turned alerts off is messaged, and nothing breaks", async () => {
    const { h, send } = setup(null)
    expect(await h.onCreated(ping, "p1")).toBe("no-token")
    expect(send).not.toHaveBeenCalled()
  })

  it("a token that is no longer valid is removed, so it isn't tried again", async () => {
    const { h, removed, errors } = setup()
    const dead = makeHandlers({ getToken: async () => "old", deleteToken: async (uid) => void removed.push(uid), send: async () => { throw Object.assign(new Error("gone"), { code: "messaging/registration-token-not-registered" }) }, log: { error: (...a) => void errors.push(a) } })
    expect(await dead.onCreated(ping, "p1")).toBe("token-removed")
    expect(removed).toEqual(["rahul"])
    expect(errors).toHaveLength(0)
    expect(h).toBeTruthy()
  })

  it("any other sending failure is logged and keeps the token", async () => {
    const removed: string[] = []
    const errors: unknown[][] = []
    const h = makeHandlers({ getToken: async () => "tok", deleteToken: async (uid) => void removed.push(uid), send: async () => { throw new Error("quota") }, log: { error: (...a) => void errors.push(a) } })
    expect(await h.onCreated(ping, "p1")).toBe("failed")
    expect(removed).toEqual([])
    expect(errors).toHaveLength(1)
  })

  it("26. a duplicate delivery of the same event sends the same tagged message, which the phone shows once", async () => {
    const { h, sent } = setup()
    await h.onCreated(ping, "p1")
    await h.onCreated(ping, "p1") // Cloud Functions can deliver an event more than once
    expect(sent).toHaveLength(2)
    expect((sent[0].data as Record<string, string>).tag).toBe((sent[1].data as Record<string, string>).tag)
  })

  it("several Pings each get their own tag, so none replaces another", async () => {
    const { h, sent } = setup()
    await h.onCreated(ping, "p1")
    await h.onCreated(ping, "p2")
    expect(new Set(sent.map((m) => (m.data as Record<string, string>).tag)).size).toBe(2)
  })
})
