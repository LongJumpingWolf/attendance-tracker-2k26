/**
 * Phase 10, local logic only: deciding and sending the push for a Ping event on the Supabase side. Fakes for the database, the token
 * store and the messaging service: nothing is sent, nothing is deployed, no secret exists. See lib/backend/supabase/push-dispatch.ts.
 */
import { describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

import { answeredMessage, incomingMessage, type PushMessage } from "@/lib/backend/supabase/ping-push-messages"
import {
  backoffMs,
  createMemoryOutbox,
  dispatchPingEvent,
  eventKey,
  MAX_ATTEMPTS,
  PING_LIFETIME_MS,
  runPingEvent,
  type PingRecord,
  type PushDeps,
} from "@/lib/backend/supabase/push-dispatch"

const require = createRequire(import.meta.url)
const fb = require("../functions/ping-messages.js") as { incomingMessage: (p: unknown, id: string) => unknown; answeredMessage: (p: unknown, id: string) => unknown }
const ROOT = path.resolve(import.meta.dirname, "..")

const NOW = Date.parse("2026-10-12T12:00:00Z")
const ASKER = "a".repeat(28)
const MATE = "m".repeat(28)
const items = (...answers: (string | null)[]) => answers.map((answer, i) => ({ key: `k${i}`, subjectId: "s", name: `Pathology Practical ${i}`, t: "10:00", answer }))

const ping = (over: Partial<PingRecord> = {}): PingRecord => ({
  id: "ping-aaaa-0001",
  from_uid: ASKER,
  to_uid: MATE,
  from_name: "Asha",
  to_name: "Rahul",
  status: "asking",
  items: items(null, null),
  created_at: NOW - 3600_000,
  ...over,
})

function rig(initial: PingRecord | null = ping(), tokens: { deviceId: string; token: string }[] = [{ deviceId: "legacy", token: "tok-1" }]) {
  const state = { ping: initial, tokens, now: NOW, sendErrors: [] as unknown[], readFails: 0, tokenFails: 0 }
  const sent: (PushMessage & { token: string })[] = []
  const deleted: [string, string][] = []
  const asked: string[] = []
  const outbox = createMemoryOutbox()
  const deps: PushDeps = {
    getPing: async () => {
      if (state.readFails > 0) {
        state.readFails--
        throw new Error("db down")
      }
      return state.ping
    },
    tokens: async (uid) => {
      asked.push(uid)
      if (state.tokenFails > 0) {
        state.tokenFails--
        throw new Error("db down")
      }
      return state.tokens
    },
    deleteToken: async (uid, deviceId) => void deleted.push([uid, deviceId]),
    send: async (m) => {
      const next = state.sendErrors.shift()
      if (next) throw next
      sent.push(m)
    },
    outbox,
    now: () => state.now,
  }
  return { deps, state, sent, deleted, asked, outbox }
}
const dead = Object.assign(new Error("gone"), { code: "messaging/registration-token-not-registered" })
const flaky = Object.assign(new Error("try later"), { code: "messaging/server-unavailable" })

describe("the messages are the Firebase messages", () => {
  const cases = [
    { fromName: "Asha", toName: "Rahul", items: items(null) },
    { fromName: "  ", toName: "", items: [] },
    { fromName: "x".repeat(80), toName: "y".repeat(80), items: items("yes", "yes") },
    { toName: "Rahul", items: items("yes", "no") },
    { toName: "Rahul" },
  ]
  for (const [i, c] of cases.entries()) {
    it(`case ${i}: incoming and answered match functions/ping-messages.js exactly`, () => {
      expect(incomingMessage(c, "pid-1")).toEqual(fb.incomingMessage(c, "pid-1"))
      expect(answeredMessage(c, "pid-1")).toEqual(fb.answeredMessage(c, "pid-1"))
    })
  }
  it("a hostile id cannot break out of the link", () => {
    expect(incomingMessage({}, "a b&x=1/../").data.url).toBe("/?ping=a%20b%26x%3D1%2F..%2F")
  })
  it("no message ever names a class, subject or date, and every data value is a string", () => {
    for (const m of [incomingMessage({ fromName: "Asha", items: items(null) }, "p"), answeredMessage({ toName: "Rahul", items: items("yes") }, "p")]) {
      expect(JSON.stringify(m)).not.toMatch(/Pathology|2026-|10:00/)
      for (const v of Object.values(m.data)) expect(typeof v).toBe("string")
    }
  })
})

describe("who gets the push, and when", () => {
  it("'incoming' goes to the person asked, taken from the stored Ping", async () => {
    const r = rig()
    expect(await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).toEqual({ status: "sent", sent: 1, removed: 0 })
    expect(r.asked).toEqual([MATE])
    expect(r.sent[0].token).toBe("tok-1")
    expect(r.sent[0].data).toMatchObject({ event: "incoming", body: "Asha is asking about your attendance", pingId: "ping-aaaa-0001" })
  })

  it("'result' goes to the asker, and says only who answered", async () => {
    const r = rig(ping({ status: "answered", items: items("yes", "yes") }))
    expect((await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "result" })).status).toBe("sent")
    expect(r.asked).toEqual([ASKER])
    expect(r.sent[0].data.body).toBe("Rahul marked you present")
  })

  it("the recipient cannot be chosen by the event: extra fields in it are ignored", async () => {
    const r = rig()
    await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming", to: "attacker", recipient: "attacker", uid: "attacker" } as never)
    expect(r.asked).toEqual([MATE])
  })

  it("an event for a Ping that does not exist sends nothing", async () => {
    const r = rig(null)
    expect(await dispatchPingEvent(r.deps, { pingId: "nope-nope-0001", kind: "incoming" })).toEqual({ status: "gone" })
    expect(r.sent).toHaveLength(0)
    expect(r.asked).toHaveLength(0)
  })

  it("stale events are dropped: 'incoming' once it is no longer asking, 'result' before it is answered, unknown kinds", async () => {
    const answered = rig(ping({ status: "answered" }))
    expect((await dispatchPingEvent(answered.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).status).toBe("stale")
    const asking = rig()
    expect((await dispatchPingEvent(asking.deps, { pingId: "ping-aaaa-0001", kind: "result" })).status).toBe("stale")
    expect((await dispatchPingEvent(asking.deps, { pingId: "ping-aaaa-0001", kind: "other" as never })).status).toBe("stale")
    expect((await dispatchPingEvent(asking.deps, { pingId: 5 as never, kind: "incoming" })).status).toBe("stale")
    expect(asking.sent.length + answered.sent.length).toBe(0)
  })

  it("an expired Ping (3 days on the database clock), a Ping with no creation time, and a Ping dated in the future send nothing", async () => {
    for (const created of [NOW - PING_LIFETIME_MS - 1, NOW - PING_LIFETIME_MS, null, NOW + 3 * 24 * 3600_000]) {
      const r = rig(ping({ created_at: created }))
      expect((await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).status).toBe("expired")
      expect(r.sent).toHaveLength(0)
    }
    const fresh = rig(ping({ created_at: new Date(NOW - PING_LIFETIME_MS + 60_000).toISOString() })) // ISO strings work too
    expect((await dispatchPingEvent(fresh.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).status).toBe("sent")
  })

  it("a person who never turned alerts on gets nothing and nothing fails", async () => {
    const r = rig(ping(), [])
    expect(await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).toEqual({ status: "no-token" })
  })
})

describe("exactly once", () => {
  it("the same event delivered twice, or at the same moment, sends one push", async () => {
    const r = rig()
    const e = { pingId: "ping-aaaa-0001", kind: "incoming" as const }
    const outs = await Promise.all([dispatchPingEvent(r.deps, e), dispatchPingEvent(r.deps, e)])
    expect(outs.map((o) => o.status).sort()).toEqual(["duplicate", "sent"])
    expect((await dispatchPingEvent(r.deps, e)).status).toBe("duplicate")
    expect(r.sent).toHaveLength(1)
  })

  it("'incoming' and 'result' are different events for the same Ping", async () => {
    const r = rig()
    await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })
    r.state.ping = ping({ status: "answered", items: items("no") })
    expect((await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "result" })).status).toBe("sent")
    expect(r.sent.map((m) => m.data.event)).toEqual(["incoming", "result"])
    expect([...r.outbox.claimed].sort()).toEqual([eventKey("ping-aaaa-0001", "incoming"), eventKey("ping-aaaa-0001", "result")].sort())
  })
})

describe("failures: dead tokens, retries, giving up", () => {
  it("a dead token is deleted for that device only, never retried, and the event is finished", async () => {
    const r = rig(ping(), [{ deviceId: "legacy", token: "dead-tok" }])
    r.state.sendErrors = [dead]
    expect(await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).toEqual({ status: "token-removed", removed: 1 })
    expect(r.deleted).toEqual([[MATE, "legacy"]])
    expect((await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).status).toBe("duplicate")
  })

  it("with several tokens, a dead one is removed and the live one still gets the push", async () => {
    const r = rig(ping(), [
      { deviceId: "device-0001", token: "dead" },
      { deviceId: "device-0002", token: "alive" },
    ])
    r.state.sendErrors = [dead]
    expect(await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).toEqual({ status: "sent", sent: 1, removed: 1 })
    expect(r.deleted).toEqual([[MATE, "device-0001"]])
    expect(r.sent.map((m) => m.token)).toEqual(["alive"])
  })

  it("a temporary failure retries with growing, capped delays and then succeeds exactly once", async () => {
    const r = rig()
    r.state.sendErrors = [flaky, flaky]
    const sleeps: number[] = []
    const out = await runPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" }, async (ms) => void sleeps.push(ms))
    expect(out).toEqual({ status: "sent", sent: 1, removed: 0 })
    expect(sleeps).toEqual([1000, 2000])
    expect(r.sent).toHaveLength(1)
  })

  it("a failure that never clears stops after MAX_ATTEMPTS; it does not storm, and later deliveries of the event send nothing", async () => {
    const r = rig()
    r.state.sendErrors = Array.from({ length: 50 }, () => flaky)
    const sleeps: number[] = []
    const out = await runPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" }, async (ms) => void sleeps.push(ms))
    expect(out).toEqual({ status: "gave-up", attempts: MAX_ATTEMPTS })
    expect(sleeps).toHaveLength(MAX_ATTEMPTS - 1)
    expect(r.sent).toHaveLength(0)
    expect((await dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).status).toBe("duplicate")
  })

  it("the backoff schedule is 1 s, 2 s, 4 s ... capped at 60 s", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(backoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000, 60000])
  })

  it("the database being unreachable (reading the Ping, or the tokens) is retried and sends nothing meanwhile", async () => {
    const a = rig()
    a.state.readFails = 2
    expect((await runPingEvent(a.deps, { pingId: "ping-aaaa-0001", kind: "incoming" }, async () => {})).status).toBe("sent")
    const b = rig()
    b.state.tokenFails = 1
    expect((await runPingEvent(b.deps, { pingId: "ping-aaaa-0001", kind: "incoming" }, async () => {})).status).toBe("sent")
    expect(a.sent).toHaveLength(1)
    expect(b.sent).toHaveLength(1)
  })

  it("an event that cannot be completed is never reported as sent, and a thrown send never escapes", async () => {
    const r = rig()
    r.state.sendErrors = [new Error("weird")]
    await expect(dispatchPingEvent(r.deps, { pingId: "ping-aaaa-0001", kind: "incoming" })).resolves.toMatchObject({ status: "retry" })
  })
})

describe("nothing real can happen", () => {
  it("the dispatcher and messages import nothing, read no environment and name no secret or service", () => {
    for (const f of ["push-dispatch.ts", "ping-push-messages.ts"]) {
      const src = fs.readFileSync(path.join(ROOT, "lib/backend/supabase", f), "utf8")
      const code = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n")
      expect(code, f).not.toMatch(/process\.env|Deno\.env|fetch\(|require\(|import\(|firebase-admin|serviceAccount|private_key/)
    }
  })
  it("it is not imported by the app (no production path can reach it)", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : /\.(ts|tsx)$/.test(e.name) ? [path.posix.join(d, e.name)] : []))
    const users = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => !f.startsWith("lib/backend/supabase/") && /push-dispatch|ping-push-messages/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    expect(users).toEqual([])
  })
})
