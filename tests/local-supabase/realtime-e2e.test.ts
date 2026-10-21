/**
 * Phase 8: the REAL Supabase adapter, the REAL fetch transport and the REAL Realtime wire transport against the LOCAL Supabase stack
 * (PostgREST, Realtime, Kong and the database from `npx supabase start`, with migration 20261011000100_realtime_syncs.sql applied
 * locally by `npx supabase migration up --local`). LOCAL ONLY: it refuses any URL that is not loopback. Tokens are HS256 JWTs signed with
 * the local stack's own development secret; no production credential is used and nothing here can reach production.
 * Run with: npm run test:local-supabase
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

import type { Backend, StoredSync } from "@/lib/backend/contracts"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createPhoenixRealtimeTransport, type WebSocketLike } from "@/lib/backend/supabase/realtime-transport"
import { createFetchTransport } from "@/lib/backend/supabase/transport"

const PROJECT = "attendance-tracker-2k26"
const run = Date.now().toString(36)
const pad = (s: string) => (s + "0".repeat(28)).slice(0, 28)
const A = pad(`RtAlice${run}`)
const B = pad(`RtBobby${run}`)

let apiUrl = ""
let publishableKey = ""
let jwtSecret = ""

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url")
function sign(sub: string): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64u(
    JSON.stringify({ sub, role: "authenticated", iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, exp: Math.floor(Date.now() / 1000) + 3600 }),
  )
  return `${head}.${body}.${crypto.createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url")}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 10_000, what = "condition") {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await sleep(40)
  }
  throw new Error("timed out waiting for " + what)
}

/** A bridge stand-in whose token the test controls (the real bridge needs a real Firebase user) */
function fakeBridge(initial: string | null) {
  let token = initial
  const listeners = new Set<(t: string | null) => void>()
  return {
    bridge: {
      ensureAuthenticated: async () => ({ status: token ? "authenticated" : "unauthorized" }) as never,
      getToken: async () => token,
      onToken: (l: (t: string | null) => void) => (listeners.add(l), () => void listeners.delete(l)),
    },
    set(next: string | null) {
      token = next
      for (const l of [...listeners]) l(next)
    },
    get: () => token,
  }
}

/** An ordinary REST-only backend, as "another device" of the same account would use it */
function plainBackend(token: () => string): Backend {
  return createSupabaseBackend({ transport: createFetchTransport({ config: { url: apiUrl, publishableKey }, timeoutMs: 8000 }), guard: async () => token() })
}

/** The backend under test: real REST + real Realtime, with sockets recorded so a test can kill them */
function watcherBackend(bridge: ReturnType<typeof fakeBridge>, opts: { pollMs?: number; blockSockets?: { on: boolean } } = {}) {
  const sockets: WebSocketLike[] = []
  const backend = createSupabaseBackend({
    transport: createFetchTransport({ config: { url: apiUrl, publishableKey }, timeoutMs: 8000 }),
    guard: async () => bridge.get() ?? "no-token-placeholder-0000000",
    realtime: {
      bridge: bridge.bridge,
      pollMs: opts.pollMs ?? 60_000,
      createTransport: (owner) =>
        createPhoenixRealtimeTransport({
          config: { url: apiUrl, publishableKey },
          table: "syncs",
          filter: `uid=eq.${owner}`,
          reconnectMinMs: 100,
          reconnectMaxMs: 400,
          heartbeatMs: 5000,
          socket: (url) => {
            if (opts.blockSockets?.on) throw new Error("sockets blocked by the test")
            const s = new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url)
            sockets.push(s)
            return s
          },
        }),
    },
  })
  return { backend, sockets }
}

function collector() {
  const docs: StoredSync[] = []
  const states: boolean[] = []
  return { docs, states, sub: { onData: (d: StoredSync) => void docs.push(d), onState: (l: boolean) => void states.push(l) } }
}
const revs = (c: ReturnType<typeof collector>) => c.docs.map((d) => d.rev)

beforeAll(() => {
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const s = JSON.parse(out.slice(out.indexOf("{")))
  apiUrl = s.API_URL
  publishableKey = s.PUBLISHABLE_KEY
  jwtSecret = s.JWT_SECRET
  const host = new URL(apiUrl).hostname
  if (!["127.0.0.1", "localhost"].includes(host)) throw new Error("refusing to run: the API URL is not loopback")
  if (!publishableKey || !jwtSecret) throw new Error("the local Supabase stack is not running (npx supabase start)")
  const pub = execFileSync("docker", ["exec", "-i", "supabase_db_Attendance_tracker", "psql", "-U", "postgres", "-X", "-t", "-A", "-c", "select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='syncs'"], { encoding: "utf8" }).trim()
  if (pub !== "1") throw new Error("public.syncs is not in the supabase_realtime publication: run `npx supabase migration up --local`")
})

afterAll(() => {
  const uids = [A, B].map((u) => `'${u}'`).join(",")
  try {
    execFileSync("docker", ["exec", "-i", "supabase_db_Attendance_tracker", "psql", "-U", "postgres", "-X", "-q", "-c", `delete from public.syncs where uid in (${uids});`], { stdio: "ignore" })
  } catch {
    /* best effort; the rows are tagged with this run's uids */
  }
})

describe("Phase 8 Realtime against the real local stack", () => {
  it("delivers the stored document first, then each later revision from the other device, live (the poll is effectively off)", async () => {
    const a = plainBackend(() => sign(A))
    await a.sync.put(A, "v1", null)
    const bridge = fakeBridge(sign(A))
    const w = watcherBackend(bridge, { pollMs: 600_000 })
    const c = collector()
    const off = w.backend.sync.watch(A, c.sub)
    await until(() => c.states.includes(true), 12_000, "the channel to become live")
    await until(() => revs(c).includes(1), 8000, "the first document")
    await a.sync.put(A, "v2", 1)
    await until(() => revs(c).includes(2), 8000, "revision 2 pushed by Realtime")
    await a.sync.put(A, "v3", 2)
    await until(() => revs(c).includes(3), 8000, "revision 3 pushed by Realtime")
    expect(revs(c)).toEqual([1, 2, 3]) // each revision exactly once, in order
    off()
    await until(() => w.sockets.every((s) => s.readyState === 3), 5000, "the socket to close")
  })

  it("socket killed, document changed while it is down, socket restored: the watcher converges (refetch after re-subscribe)", async () => {
    const a = plainBackend(() => sign(A))
    const cur = await a.sync.get(A)
    const base = cur!.rev
    const bridge = fakeBridge(sign(A))
    const gate = { on: false }
    const w = watcherBackend(bridge, { pollMs: 600_000, blockSockets: gate })
    const c = collector()
    const off = w.backend.sync.watch(A, c.sub)
    await until(() => c.states.includes(true), 12_000, "live")
    await until(() => revs(c).includes(base), 8000, "the current document")
    gate.on = true // the network refuses new sockets ...
    w.sockets[0].close() // ... and the live one is killed
    await until(() => c.states.at(-1) === false, 8000, "not-live to be reported")
    await a.sync.put(A, "while-down", base) // changed while no socket exists: no event can ever be replayed for this
    await sleep(500)
    expect(revs(c)).not.toContain(base + 1)
    gate.on = false // the network is back
    await until(() => revs(c).includes(base + 1), 15_000, "convergence on the change made while down")
    await until(() => c.states.at(-1) === true, 10_000, "live again")
    expect(revs(c).filter((r) => r === base + 1)).toHaveLength(1) // applied once
    off()
  })

  it("two watchers of the same account share ONE socket and each gets each revision exactly once", async () => {
    const a = plainBackend(() => sign(A))
    const base = (await a.sync.get(A))!.rev
    const bridge = fakeBridge(sign(A))
    const w = watcherBackend(bridge, { pollMs: 600_000 })
    const c1 = collector()
    const c2 = collector()
    const off1 = w.backend.sync.watch(A, c1.sub)
    const off2 = w.backend.sync.watch(A, c2.sub)
    await until(() => c1.states.includes(true), 12_000, "live")
    await a.sync.put(A, "dup", base)
    await until(() => revs(c1).includes(base + 1) && revs(c2).includes(base + 1), 8000, "both watchers")
    await sleep(600) // any duplicate delivery would have arrived by now
    expect(w.sockets).toHaveLength(1)
    expect(revs(c1).filter((r) => r === base + 1)).toHaveLength(1)
    expect(revs(c2).filter((r) => r === base + 1)).toHaveLength(1)
    off1()
    expect(w.sockets[0].readyState).toBe(1) // one watcher left: the channel stays
    off2()
    await until(() => w.sockets[0].readyState === 3, 5000, "the last watcher to close the socket")
  })

  it("while Realtime is unreachable the polling fallback keeps delivering, and it hands over when the socket works again", async () => {
    const a = plainBackend(() => sign(A))
    const base = (await a.sync.get(A))!.rev
    const bridge = fakeBridge(sign(A))
    const gate = { on: true }
    const w = watcherBackend(bridge, { pollMs: 300, blockSockets: gate })
    const c = collector()
    const off = w.backend.sync.watch(A, c.sub)
    await until(() => revs(c).includes(base), 6000, "the first read")
    await a.sync.put(A, "polled", base)
    await until(() => revs(c).includes(base + 1), 6000, "the change through the poll")
    expect(c.states.includes(true)).toBe(false) // never live meanwhile
    gate.on = false
    await until(() => c.states.at(-1) === true, 12_000, "live once sockets work")
    await a.sync.put(A, "live-now", base + 1)
    await until(() => revs(c).includes(base + 2), 8000, "the change through Realtime")
    expect(revs(c).filter((r) => r === base + 2)).toHaveLength(1)
    off()
  })

  it("sign-out drops the channel; another account gets its own channel and neither sees the other's documents", async () => {
    const a = plainBackend(() => sign(A))
    const b = plainBackend(() => sign(B))
    await b.sync.put(B, "b1", null)
    const baseA = (await a.sync.get(A))!.rev
    const bridge = fakeBridge(sign(A))
    const w = watcherBackend(bridge, { pollMs: 600_000 })
    const cA = collector()
    const offA = w.backend.sync.watch(A, cA.sub)
    await until(() => cA.states.includes(true), 12_000, "A live")

    bridge.set(null) // sign-out
    await until(() => w.sockets.every((s) => s.readyState === 3), 8000, "the signed-out channel to close")
    await until(() => cA.states.at(-1) === false, 5000, "not live after sign-out")
    await a.sync.put(A, "after-signout", baseA)
    await sleep(800)
    expect(revs(cA)).not.toContain(baseA + 1) // nothing is delivered to a signed-out watcher

    offA() // the app tears down A's watcher and attaches B's
    bridge.set(sign(B))
    const cB = collector()
    const offB = w.backend.sync.watch(B, cB.sub)
    await until(() => cB.states.includes(true), 12_000, "B live")
    await until(() => revs(cB).includes(1), 8000, "B's document")
    await b.sync.put(B, "b2", 1)
    await until(() => revs(cB).includes(2), 8000, "B's change")
    await a.sync.put(A, "a-again", baseA + 1)
    await sleep(800)
    expect(cB.docs.every((d) => d.data.startsWith("b"))).toBe(true) // never A's data
    expect(revs(cA)).not.toContain(baseA + 2) // and A's old watcher is gone
    offB()
    await until(() => w.sockets.every((s) => s.readyState === 3), 5000, "all sockets closed")
  })
})
