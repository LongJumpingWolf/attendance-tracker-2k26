/**
 * Two "devices" of one account running the app's REAL sync core (write-ahead markers, revision settlement, the three-way merge, the
 * ingestor, restore points) on top of the REAL Supabase path against the LOCAL stack: real fetch transport, real adapter (sync.get/put
 * with compare-and-set and owner check), real Realtime wire transport, real RLS. LOCAL ONLY (loopback URL enforced). Tokens are HS256
 * JWTs signed with the local stack's development secret; no production credential is used.
 *
 * What this is NOT: it does not render React or run `hooks/use-cloud-sync.ts` itself. That hook reaches Supabase only through
 * lib/cloud-sync.ts -> getBackend() when Firebase is configured, and signs in through Firebase Auth plus the deployed bootstrap function;
 * neither exists on a local-only machine (no Firebase Auth emulator wiring in lib/firebase.ts, no local bootstrap function), and a
 * test-only token shortcut inside the app would be an authentication bypass. So this is the closest genuine integration: everything the
 * hook delegates to, over the real backend path, with the hook's own wiring mirrored in `Device`. The hook itself is covered by the
 * browser E2E in local (dev-store) mode and by its unit tests.
 * Run with: npm run test:local-supabase
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"

import { buildBackup, type FullBackupData } from "@/lib/backup"
import type { Backend, StoredSync } from "@/lib/backend/contracts"
import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createPhoenixRealtimeTransport, type WebSocketLike } from "@/lib/backend/supabase/realtime-transport"
import { createFetchTransport } from "@/lib/backend/supabase/transport"
import { mergeData, same } from "@/lib/merge"
import { createIngestor, emptyData, putTracked, WriteLedger, type BaseRecord, type MarkerStore, type WriteMarker } from "@/lib/signin-reconcile"
import type { Mate, Subject } from "@/lib/types"

const PROJECT = "attendance-tracker-2k26"
const run = Date.now().toString(36)
const pad = (s: string) => (s + "0".repeat(28)).slice(0, 28)
const ACCT = pad(`CoreAcct${run}`)
const OTHER = pad(`CoreOther${run}`)

let apiUrl = ""
let publishableKey = ""
let jwtSecret = ""
const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url")
function sign(sub: string): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = b64u(JSON.stringify({ sub, role: "authenticated", iss: `https://securetoken.google.com/${PROJECT}`, aud: PROJECT, exp: Math.floor(Date.now() / 1000) + 3600 }))
  return `${head}.${body}.${crypto.createHmac("sha256", jwtSecret).update(`${head}.${body}`).digest("base64url")}`
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => boolean, ms = 12_000, what = "condition") {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return
    await sleep(40)
  }
  throw new Error("timed out waiting for " + what)
}

const sub = (id: string, name: string): Subject => ({ id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], log: [] })
const mate = (covered: number): Mate => ({ id: "m1", name: "Arjun", covered, repaid: 0 })
const data = (subjects: Subject[], extra: Partial<FullBackupData> = {}): FullBackupData => ({ ...emptyData(), subjects, ...extra })
const names = (d: FullBackupData) => d.subjects.map((s) => s.name).sort()

class MemoryMarkers implements MarkerStore {
  value: unknown
  async load() {
    return structuredClone(this.value)
  }
  async save(list: WriteMarker[]) {
    this.value = structuredClone(list)
  }
}

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

/** One device: its own backend instance (own transport, own sockets, own bridge), its own data, base, revision and ledger */
class Device {
  data: FullBackupData
  rev: number | null = null
  base: BaseRecord | null = null
  bridge: ReturnType<typeof fakeBridge>
  backend: Backend
  sockets: WebSocketLike[] = []
  gate = { blockSockets: false, failFetches: 0 }
  ledger = new WriteLedger(new MemoryMarkers())
  received: StoredSync[] = []
  states: boolean[] = []
  merges = 0
  off: (() => void) | null = null
  pushes = 0
  ingestor: ReturnType<typeof createIngestor>

  constructor(token: string | null, start: FullBackupData = emptyData(), pollMs = 600_000) {
    this.data = start
    this.bridge = fakeBridge(token)
    const rest = createFetchTransport({ config: { url: apiUrl, publishableKey }, timeoutMs: 8000 })
    const flaky = {
      ...rest,
      select: async (table: string, eq?: Record<string, string>) => {
        if (table === "syncs" && this.gate.failFetches > 0) {
          this.gate.failFetches--
          throw new Error("simulated network failure")
        }
        return rest.select(table, eq)
      },
      setAccessToken: rest.setAccessToken?.bind(rest),
    }
    this.backend = createSupabaseBackend({
      transport: flaky,
      guard: async () => this.bridge.get() ?? "no-token-placeholder-0000000",
      realtime: {
        bridge: this.bridge.bridge,
        pollMs,
        createTransport: (owner) =>
          createPhoenixRealtimeTransport({
            config: { url: apiUrl, publishableKey },
            table: "syncs",
            filter: `uid=eq.${owner}`,
            reconnectMinMs: 100,
            reconnectMaxMs: 400,
            heartbeatMs: 5000,
            socket: (url) => {
              if (this.gate.blockSockets) throw new Error("sockets blocked by the test")
              const s = new (globalThis as unknown as { WebSocket: new (u: string) => WebSocketLike }).WebSocket(url)
              this.sockets.push(s)
              return s
            },
          }),
      },
    })
    this.ingestor = createIngestor({
      ledger: this.ledger,
      getRev: () => this.rev,
      revCorrupt: () => false,
      loadBase: async () => this.base,
      merge: async (cloud, rev, base) => {
        this.merges++
        const merged = mergeData(base, this.data, cloud).data
        const changed = !same(merged, this.data)
        this.data = merged
        this.base = { rev, data: cloud } // base first, then the revision (as the hook does)
        this.rev = rev
        return changed
      },
      adoptLanded: async (cloud, rev) => {
        this.base = { rev, data: cloud }
        this.rev = rev
      },
    })
  }

  /** the hook's live path: a document from the watcher goes through the ingestor */
  watch(owner: string) {
    this.off = this.backend.sync.watch(owner, {
      onData: (d) => {
        this.received.push(d)
        void this.ingestor.ingest({ data: d.data, rev: d.rev }, "live")
      },
      onState: (l) => void this.states.push(l),
    })
  }
  /** the hook's pull: read, then ingest */
  async pull(owner: string) {
    const d = await this.backend.sync.get(owner)
    return d ? this.ingestor.ingest({ data: d.data, rev: d.rev }, "pull") : null
  }
  /** the hook's push: marker first, then the compare-and-set write; a conflict is followed by a pull */
  async push(owner: string): Promise<{ ok: true; rev: number } | { ok: false; reason: "conflict" | "unavailable" | "too-large" }> {
    this.pushes++
    const sent = this.data
    const r = await putTracked(
      this.ledger,
      async (_o, text, expected) => {
        try {
          const res = await this.backend.sync.put(owner, text, expected)
          return res.ok ? { ok: true, rev: res.rev } : { ok: false, reason: "conflict" }
        } catch {
          return { ok: false, reason: "unavailable" }
        }
      },
      owner,
      buildBackup(sent, false),
      this.rev,
      async (rev) => {
        this.base = { rev, data: sent }
        this.rev = rev
      },
    )
    if (!r.ok && r.reason === "conflict") {
      await this.pull(owner)
      return this.push(owner) // merged result is sent next, as the hook does
    }
    return r
  }
  stop() {
    this.off?.()
    this.off = null
  }
}

beforeAll(() => {
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  const s = JSON.parse(out.slice(out.indexOf("{")))
  apiUrl = s.API_URL
  publishableKey = s.PUBLISHABLE_KEY
  jwtSecret = s.JWT_SECRET
  if (!["127.0.0.1", "localhost"].includes(new URL(apiUrl).hostname)) throw new Error("refusing to run: the API URL is not loopback")
  if (!publishableKey || !jwtSecret) throw new Error("the local Supabase stack is not running (npx supabase start)")
})

const cleanup = () => {
  const uids = [ACCT, OTHER].map((u) => `'${u}'`).join(",")
  try {
    execFileSync("docker", ["exec", "-i", "supabase_db_Attendance_tracker", "psql", "-U", "postgres", "-X", "-q", "-c", `delete from public.syncs where uid in (${uids});`], { stdio: "ignore" })
  } catch {
    /* best effort; rows are tagged with this run's uids */
  }
}
beforeEach(cleanup) // each test starts with no stored copy for these (unique, test-created) accounts
afterAll(cleanup)

describe("two devices of one account: the app's sync core over the real local Supabase path", () => {
  it("A writes, B receives it live; B writes, A converges; both end with both devices' work", async () => {
    const a = new Device(sign(ACCT), data([sub("a1", "Added on A")]))
    const b = new Device(sign(ACCT))
    b.watch(ACCT)
    a.watch(ACCT)
    await until(() => a.states.includes(true) && b.states.includes(true), 15_000, "both channels live")
    expect((await a.push(ACCT)).ok).toBe(true) // first write: creates revision 1
    await until(() => names(b.data).includes("Added on A"), 10_000, "B to receive A's write")
    expect(b.rev).toBe(1)

    b.data = { ...b.data, subjects: [...b.data.subjects, sub("b1", "Added on B")] }
    expect((await b.push(ACCT)).ok).toBe(true)
    await until(() => names(a.data).includes("Added on B"), 10_000, "A to converge on B's write")
    expect(names(a.data)).toEqual(["Added on A", "Added on B"])
    expect(names(b.data)).toEqual(["Added on A", "Added on B"])
    expect(a.rev).toBe(2)
    a.stop()
    b.stop()
  })

  it("simultaneous edits: one write conflicts (compare-and-set), merges on top of the other, and both devices converge; the counter adds both", async () => {
    const seed = new Device(sign(ACCT), data([sub("s1", "Shared")], { mates: [mate(0)] }))
    await seed.push(ACCT)
    const a = new Device(sign(ACCT))
    const b = new Device(sign(ACCT))
    await a.pull(ACCT)
    await b.pull(ACCT)
    a.data = { ...a.data, mates: [mate(1)] } // both log one favour from the same starting revision
    b.data = { ...b.data, mates: [mate(1)] }
    a.watch(ACCT)
    b.watch(ACCT)
    await until(() => a.states.includes(true) && b.states.includes(true), 15_000, "live")
    const [ra, rb] = await Promise.all([a.push(ACCT), b.push(ACCT)])
    expect(ra.ok && rb.ok).toBe(true)
    await until(() => a.data.mates[0]?.covered === 2 && b.data.mates[0]?.covered === 2, 8_000, "both counters to read 2").catch(async (e) => {
      console.log("DEBUG", JSON.stringify({ a: [a.rev, a.data.mates, a.merges, a.received.map((d) => d.rev)], b: [b.rev, b.data.mates, b.merges, b.received.map((d) => d.rev)], ra, rb, stored: (await seed.backend.sync.get(ACCT))?.rev }))
      throw e
    })
    const stored = await seed.backend.sync.get(ACCT)
    expect(stored!.rev).toBeGreaterThanOrEqual(3)
    a.stop()
    b.stop()
    seed.stop()
  })

  it("B's socket is killed and refused while A writes twice; when B's network returns, B converges on the latest revision", async () => {
    const a = new Device(sign(ACCT), data([sub("a1", "One")]))
    const b = new Device(sign(ACCT))
    b.watch(ACCT)
    await a.push(ACCT)
    await until(() => names(b.data).includes("One"), 12_000, "B live and current")
    await until(() => b.states.at(-1) === true, 10_000, "B live")
    b.gate.blockSockets = true
    b.sockets[0].close() // killed
    await until(() => b.states.at(-1) === false, 8000, "B to notice")
    a.data = { ...a.data, subjects: [...a.data.subjects, sub("a2", "Two")] }
    await a.push(ACCT)
    a.data = { ...a.data, subjects: [...a.data.subjects, sub("a3", "Three")] }
    await a.push(ACCT)
    await sleep(500)
    expect(names(b.data)).toEqual(["One"]) // missed while down; nothing replays it
    b.gate.blockSockets = false
    await until(() => names(b.data).includes("Three"), 15_000, "B to converge")
    expect(names(b.data)).toEqual(["One", "Three", "Two"])
    expect(b.rev).toBe(3)
    a.stop()
    b.stop()
  })

  it("the read made right after 'subscribed' fails once and nothing else ever happens: B still recovers (Task A fix, over the real path)", async () => {
    const a = new Device(sign(ACCT), data([sub("a1", "Before")]))
    await a.push(ACCT)
    const b = new Device(sign(ACCT))
    b.gate.blockSockets = true // so the channel cannot come up while A writes ...
    b.watch(ACCT)
    await until(() => b.rev === 1, 8000, "B's first read through the poll-less initial fetch")
    a.data = { ...a.data, subjects: [...a.data.subjects, sub("a2", "During the subscribe")] }
    await a.push(ACCT) // ... a change no event will ever announce to B
    b.gate.failFetches = 1 // the read made after B subscribes fails
    b.gate.blockSockets = false
    await until(() => b.states.at(-1) === true, 15_000, "B live")
    await until(() => names(b.data).includes("During the subscribe"), 15_000, "recovery by the bounded retry")
    expect(b.gate.failFetches).toBe(0) // the failure really happened
    a.stop()
    b.stop()
  })

  it("sign-out and account switch: the old account's data never reaches the next account's device", async () => {
    const other = new Device(sign(OTHER), data([sub("o1", "Other account")]))
    await other.push(OTHER)
    const a = new Device(sign(ACCT), data([sub("a1", "Account A")]))
    await a.push(ACCT)
    const dev = new Device(sign(ACCT))
    dev.watch(ACCT)
    await until(() => names(dev.data).includes("Account A"), 12_000, "the device to take A's data")
    dev.bridge.set(null) // sign-out
    await until(() => dev.sockets.every((s) => s.readyState === 3), 8000, "channel closed")
    a.data = { ...a.data, subjects: [...a.data.subjects, sub("a2", "A after sign-out")] }
    await a.push(ACCT)
    await sleep(800)
    expect(names(dev.data)).toEqual(["Account A"]) // nothing arrives for a signed-out device
    dev.stop()

    // the same device now belongs to another account, on a clean slate (the app clears the owner's state when accounts switch)
    const next = new Device(sign(OTHER))
    next.watch(OTHER)
    await until(() => names(next.data).includes("Other account"), 12_000, "the other account's data")
    await a.push(ACCT)
    await sleep(800)
    expect(names(next.data)).toEqual(["Other account"])
    expect(next.received.every((d) => d.data.includes("Other account"))).toBe(true)
    // and asking for A's copy with the other account's token is refused, not answered with the other account's row
    await expect(next.backend.sync.get(ACCT)).rejects.toMatchObject({ code: "sync-owner-mismatch" })
    next.stop()
    a.stop()
    other.stop()
  })
})
