/**
 * The Supabase adapter is a SKELETON: inactive, with no client, no credentials and no auth bridge. These tests prove it
 * cannot reach anything by itself, fails explicitly and closed, and (given a fake transport) maps each operation to the
 * Phase 3 functions with the right arguments. No network, no credentials, no project.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createSupabaseBackend, readSupabaseConfig, type SupabaseTransport } from "@/lib/backend/supabase"
import { BackendError, fromPostgresError } from "@/lib/backend/errors"
import type { NewPing } from "@/lib/backend/contracts"

afterEach(() => vi.unstubAllGlobals())

const A = "uidAlice00000000000000000001"
const B = "uidBob0000000000000000000002"
const ping: NewPing = {
  id: "ping-AB-00000001",
  from: { uid: A, name: "Alice" },
  to: { uid: B, name: "Bob" },
  date: "2026-10-06",
  items: [{ key: "k", subjectId: "s", name: "Maths", answer: null }],
  requestId: "req1",
}

describe("configuration", () => {
  it("is null without both variables, and never has a default value", () => {
    expect(readSupabaseConfig({})).toBeNull()
    expect(readSupabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.test" })).toBeNull()
    expect(readSupabaseConfig({ NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" })).toBeNull()
    expect(readSupabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.test", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "k" })).toEqual({ url: "https://x.test", publishableKey: "k" })
    // Phase 6A renamed the key variable to the publishable key; the legacy anon key is no longer read
    expect(readSupabaseConfig({ NEXT_PUBLIC_SUPABASE_URL: "https://x.test", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" })).toBeNull()
  })
})

describe("with no transport (the only way the app can build it today)", () => {
  const be = createSupabaseBackend()

  it("constructs without credentials and says what it is", () => {
    expect(be.kind).toBe("supabase")
  })

  it("every operation fails with the explicit not-configured error, and nothing touches the network", async () => {
    const net = vi.fn(() => {
      throw new Error("network must not be used")
    })
    vi.stubGlobal("fetch", net)
    vi.stubGlobal("XMLHttpRequest", net)
    const calls: [string, () => Promise<unknown>][] = [
      ["sync.get", () => be.sync.get(A)],
      ["sync.put", () => be.sync.put(A, "d", null)],
      ["profiles.save", () => be.profiles.save(A, "Alice")],
      ["profiles.getName", () => be.profiles.getName(A)],
      ["invites.create", () => be.invites.create(A, "Alice", 15)],
      ["invites.read", () => be.invites.read("t")],
      ["invites.remove", () => be.invites.remove("t")],
      ["connections.list", () => be.connections.list(A)],
      ["connections.send", () => be.connections.send(ping.from, ping.to)],
      ["connections.respond", () => be.connections.respond("id", "accepted")],
      ["connections.remove", () => be.connections.remove("id")],
      ["pings.create", () => be.pings.create(ping)],
      ["pings.answer", () => be.pings.answer("id", [])],
      ["pings.lease", () => be.pings.lease("id", "dev")],
      ["pings.finalize", () => be.pings.finalize("id")],
      ["pings.dismiss", () => be.pings.dismiss("id", "deviceAlice01")],
      ["pings.remove", () => be.pings.remove("id")],
      ["pushTokens.save", () => be.pushTokens.save(A, "t")],
      ["pushTokens.remove", () => be.pushTokens.remove(A)],
    ]
    for (const [name, call] of calls) {
      const e = await call().then(
        () => null,
        (x) => x,
      )
      expect(e, name).toBeInstanceOf(BackendError)
      expect(e, name).toMatchObject({ kind: "unauthorized", code: "supabase-not-configured", retryable: false })
      expect(e.message, name).toMatch(/Supabase backend not configured\/authorized/)
    }
    expect(net).not.toHaveBeenCalled()
  })

  it("realtime is not implemented: a subscription reports not-live with the reason and a no-op unsubscribe", () => {
    const states: [boolean, unknown][] = []
    const subs = [
      be.sync.watch(A, { onData: vi.fn(), onState: (l, e) => states.push([l, e]) }),
      be.connections.watch(A, { onData: vi.fn(), onState: (l, e) => states.push([l, e]) }),
      be.pings.watch(A, { onData: vi.fn(), onState: (l, e) => states.push([l, e]) }),
    ]
    expect(states).toHaveLength(3)
    for (const [live, e] of states) {
      expect(live).toBe(false)
      expect(e).toMatchObject({ code: "supabase-not-configured" })
    }
    subs.forEach((off) => expect(off()).toBeUndefined())
  })
})

describe("with an injected fake transport (argument mapping only; the identity bridge is NOT implemented or tested)", () => {
  const make = (rpc: SupabaseTransport["rpc"], select: SupabaseTransport["select"] = async () => ({ data: [], error: null })) => createSupabaseBackend({ transport: { rpc, select } })
  const ok = (data: unknown) => async () => ({ data, error: null })

  it("sync.put calls sync_put with the expected revision (0 when creating) and never sends the owner", async () => {
    const rpc = vi.fn(ok(1))
    const be = make(rpc)
    expect(await be.sync.put(A, "gz1:x", null)).toEqual({ ok: true, rev: 1 })
    expect(rpc).toHaveBeenCalledWith("sync_put", { p_expected_rev: 0, p_data: "gz1:x", p_updated_at: expect.any(Number) })
    await make(rpc).sync.put(A, "gz1:y", 4)
    expect(rpc).toHaveBeenLastCalledWith("sync_put", expect.objectContaining({ p_expected_rev: 4 }))
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(A)
  })

  it("sync.put maps the revision conflict (40001) to a conflict result, and other errors to BackendError", async () => {
    const be = make(async () => ({ data: null, error: { code: "40001", message: "revision conflict" } }))
    expect(await be.sync.put(A, "d", 1)).toEqual({ ok: false, reason: "conflict" })
    const denied = make(async () => ({ data: null, error: { code: "42501", message: "nope" } }))
    await expect(denied.sync.put(A, "d", 1)).rejects.toMatchObject({ kind: "unauthorized", code: "42501" })
  })

  it("sync.get returns the caller's row as plain values, or null", async () => {
    const be = make(ok(null), async () => ({ data: [{ uid: A, data: "gz1:z", rev: 3, updated_at: "1790000000000" }], error: null }))
    expect(await be.sync.get(A)).toEqual({ data: "gz1:z", rev: 3, updatedAt: 1790000000000 })
    expect(await make(ok(null)).sync.get(A)).toBeNull()
  })

  it("sync.get never returns a row that is not the requested owner's (different uid, or no uid): it refuses, it does not say 'nothing stored'", async () => {
    const B = "b".repeat(28)
    const other = make(ok(null), async () => ({ data: [{ uid: B, data: "gz1:theirs", rev: 9, updated_at: 1 }], error: null }))
    await expect(other.sync.get(A)).rejects.toMatchObject({ kind: "unauthorized", code: "sync-owner-mismatch", retryable: false })
    const bare = make(ok(null), async () => ({ data: [{ data: "gz1:x", rev: 1, updated_at: 1 }], error: null }))
    await expect(bare.sync.get(A)).rejects.toMatchObject({ code: "sync-owner-mismatch" })
    const noLeak = await other.sync.get(A).then(() => "returned", (e) => JSON.stringify(e.message))
    expect(noLeak).not.toContain("theirs")
  })

  it("the watcher built on it never delivers another account's row either", async () => {
    const B = "b".repeat(28)
    const got: unknown[] = []
    const be = createSupabaseBackend({
      transport: { rpc: async () => ({ data: null, error: null }), select: async () => ({ data: [{ uid: B, data: "gz1:theirs", rev: 2, updated_at: 1 }], error: null }) },
      guard: async () => "x".repeat(40),
      realtime: { bridge: { ensureAuthenticated: async () => ({ status: "unauthorized" }) as never, getToken: async () => null, onToken: () => () => {} }, createTransport: () => ({ setAuth: () => {}, subscribe: () => () => {} }), pollMs: 1000 },
    })
    const off = be.sync.watch(A, { onData: (d) => void got.push(d) })
    await new Promise((r) => setTimeout(r, 20))
    off()
    expect(got).toEqual([])
  })

  it("maps requests, pings, profiles, invites and push tokens to the Phase 3 functions", async () => {
    const rpc = vi.fn(async (fn: string) => ({ data: fn === "create_ping" ? "existing" : fn === "finalize_ping" ? "already" : fn === "lease_ping" ? true : fn === "dismiss_ping" ? "dismissed" : fn === "send_request" ? "newid" : null, error: null }))
    const be = make(rpc)
    expect(await be.connections.send(ping.from, ping.to)).toBe("newid")
    expect(rpc).toHaveBeenLastCalledWith("send_request", { p_to_uid: B, p_from_name: "Alice", p_to_name: "Bob" })
    await be.connections.respond("c1", "declined")
    expect(rpc).toHaveBeenLastCalledWith("respond_request", { p_id: "c1", p_status: "declined" })
    await be.connections.remove("c1")
    expect(rpc).toHaveBeenLastCalledWith("remove_request", { p_id: "c1" })
    expect(await be.pings.create(ping)).toBe("existing")
    expect(rpc).toHaveBeenLastCalledWith("create_ping", { p_id: ping.id, p_to_uid: B, p_from_name: "Alice", p_to_name: "Bob", p_request_id: "req1", p_date: "2026-10-06", p_items: ping.items })
    expect(await be.pings.lease("p", "deviceAlice01")).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith("lease_ping", { p_id: "p", p_device_id: "deviceAlice01" })
    expect(await be.pings.finalize("p")).toBe("already")
    expect(await be.pings.dismiss("p", "deviceAlice01")).toBe("dismissed")
    expect(rpc).toHaveBeenLastCalledWith("dismiss_ping", { p_id: "p", p_device_id: "deviceAlice01" })
    await be.pings.answer("p", ping.items)
    expect(rpc).toHaveBeenLastCalledWith("answer_ping", { p_id: "p", p_items: ping.items })
    await be.pings.remove("p")
    await be.profiles.save(A, "Alice")
    expect(rpc).toHaveBeenLastCalledWith("upsert_profile", { p_name: "Alice" })
    await be.profiles.getName(B)
    expect(rpc).toHaveBeenLastCalledWith("get_profile_name", { p_uid: B })
    await be.pushTokens.save(A, "fcm")
    expect(rpc).toHaveBeenLastCalledWith("save_push_token", { p_token: "fcm", p_device_id: "legacy" })
    await be.pushTokens.remove(A)
    expect(rpc).toHaveBeenLastCalledWith("delete_push_token", { p_device_id: "legacy" })
    const made = await be.invites.create(A, "Alice", 15)
    expect(rpc).toHaveBeenLastCalledWith("create_invite", { p_token: made.token, p_owner_name: "Alice", p_minutes: 15 })
    expect(made.token).toMatch(/^[0-9a-z]{18}$/)
  })

  it("rows from connections are mapped to the app's FriendRequest shape", async () => {
    const be = make(ok(null), async () => ({
      data: [{ id: "c1", from_uid: A, to_uid: B, from_name: "Alice", to_name: "Bob", status: "accepted", created_at: "2026-10-01T00:00:00Z", responded_at: null }],
      error: null,
    }))
    expect(await be.connections.list(A)).toEqual([
      { id: "c1", from: A, to: B, fromName: "Alice", toName: "Bob", participants: [A, B], status: "accepted", createdAt: Date.parse("2026-10-01T00:00:00Z"), respondedAt: null },
    ])
  })

  it("a transport that throws (offline) is an unavailable, retryable BackendError", async () => {
    const be = make(async () => {
      throw new TypeError("fetch failed")
    })
    await expect(be.pings.finalize("p")).rejects.toMatchObject({ kind: "unavailable", retryable: true })
  })
})

describe("Postgres error mapping (the SQLSTATEs of the Phase 3 functions)", () => {
  it.each([
    ["42501", "unauthorized"],
    ["22023", "invalid"],
    ["54000", "invalid"],
    ["P0002", "not-found"],
    ["23505", "conflict"],
    ["40001", "conflict"],
    ["55000", "conflict"],
    ["XX000", "unknown"],
  ])("%s -> %s", (code, kind) => {
    expect(fromPostgresError({ code, message: "m" })).toMatchObject({ kind, code, retryable: false })
  })
})
