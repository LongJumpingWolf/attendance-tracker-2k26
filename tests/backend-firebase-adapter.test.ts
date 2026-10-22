/**
 * Contract tests for the Firebase adapter (lib/backend/firebase), against an in-memory stand-in for Firestore.
 * They pin what the adapter SENDS (document paths and payloads, exactly as the pre-refactor code wrote them), how it
 * reacts to errors, and how its subscriptions behave. Security rules are NOT tested here: that is tests/rules (emulator).
 */
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as fake from "./helpers/fake-firestore"

vi.mock("firebase/firestore", async () => (await import("./helpers/fake-firestore")).api)

import { createFirebaseBackend, firebaseBackendFor } from "@/lib/backend/firebase"
import { BackendError, fromFirebaseError } from "@/lib/backend/errors"
import type { Backend, NewPing } from "@/lib/backend/contracts"
import { LEASE_MS } from "@/lib/backend/contracts"
import { createPing, leasePing } from "@/lib/ping-server"
import { watchRequests } from "@/lib/social"

const db = {} as never
const A = "uidAlice00000000000000000001"
const B = "uidBob0000000000000000000002"
const SERVER = { __serverTimestamp: true }

let be: Backend
let signedIn = 0
beforeEach(() => {
  fake.reset()
  signedIn = 0
  be = createFirebaseBackend({ db, ensureSignedIn: async () => void signedIn++ })
})

const ping = (over: Partial<NewPing> = {}): NewPing => ({
  id: "ping-AB-00000001",
  from: { uid: A, name: "Alice" },
  to: { uid: B, name: "Bob" },
  date: "2026-10-06",
  items: [{ key: "s1@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer: null }],
  requestId: "req1",
  ...over,
})

describe("sync store", () => {
  it("get is null when nothing is stored, and signs in first, as before", async () => {
    expect(await be.sync.get(A)).toBeNull()
    expect(signedIn).toBe(1)
  })

  it("a first put creates rev 1 with exactly {data, rev, updatedAt} at syncs/{owner}", async () => {
    expect(await be.sync.put(A, "gz1:abc", null)).toEqual({ ok: true, rev: 1 })
    const w = fake.state.writes.find((x) => x.op === "tx.set")!
    expect(w.path).toBe(`syncs/${A}`)
    expect(Object.keys(w.data!).sort()).toEqual(["data", "rev", "updatedAt"])
    expect(w.data).toMatchObject({ data: "gz1:abc", rev: 1 })
    expect(await be.sync.get(A)).toMatchObject({ data: "gz1:abc", rev: 1 })
  })

  it("compare-and-set: the right revision lands, a stale one is a conflict and writes nothing", async () => {
    await be.sync.put(A, "one", null)
    expect(await be.sync.put(A, "two", 1)).toEqual({ ok: true, rev: 2 })
    const before = fake.state.writes.length
    expect(await be.sync.put(A, "stale", 1)).toEqual({ ok: false, reason: "conflict" })
    expect(await be.sync.put(A, "create-over", null)).toEqual({ ok: false, reason: "conflict" })
    expect(fake.state.writes.length).toBe(before)
    expect((await be.sync.get(A))!.data).toBe("two")
  })

  it("a transport failure surfaces as a retryable BackendError that keeps the Firestore code", async () => {
    fake.state.failNext.set("runTransaction", "unavailable")
    const e = await be.sync.put(A, "x", null).catch((x) => x)
    expect(e).toBeInstanceOf(BackendError)
    expect(e).toMatchObject({ kind: "unavailable", retryable: true, code: "unavailable" })
  })

  it("watch: current state first, then each change; unsubscribe stops it", async () => {
    await be.sync.put(A, "one", null)
    const seen: string[] = []
    const states: boolean[] = []
    const off = be.sync.watch(A, { onData: (d) => seen.push(`${d.data}@${d.rev}`), onState: (live) => states.push(live) })
    await vi.waitFor(() => expect(seen).toEqual(["one@1"]))
    expect(states.at(-1)).toBe(true)
    await be.sync.put(A, "two", 1)
    expect(seen).toEqual(["one@1", "two@2"])
    off()
    await be.sync.put(A, "three", 2)
    expect(seen).toEqual(["one@1", "two@2"])
    expect(fake.state.listeners.size).toBe(0)
  })

  it("watch: a listener that errors is restarted by the existing resilient wrapper and reported not-live first", async () => {
    vi.useFakeTimers()
    try {
      fake.state.failNext.set("onSnapshot", "unavailable")
      const states: [boolean, string | undefined][] = []
      const seen: string[] = []
      const off = be.sync.watch(A, { onData: (d) => seen.push(d.data), onState: (live, e) => states.push([live, (e as BackendError | undefined)?.kind]) })
      await vi.advanceTimersByTimeAsync(0)
      expect(states).toEqual([[false, "unavailable"]])
      await be.sync.put(A, "later", null)
      await vi.advanceTimersByTimeAsync(3000) // the first retry delay
      await vi.advanceTimersByTimeAsync(0)
      expect(seen).toEqual(["later"])
      expect(states.at(-1)).toEqual([true, undefined])
      off()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("profile, invite and push-token stores", () => {
  it("profiles write users/{uid} {name, updatedAt: server time} and read the name back", async () => {
    await be.profiles.save(A, "Alice")
    expect(fake.state.writes[0]).toEqual({ op: "setDoc", path: `users/${A}`, data: { name: "Alice", updatedAt: SERVER } })
    expect(await be.profiles.getName(A)).toBe("Alice")
    expect(await be.profiles.getName(B)).toBeNull()
  })

  it("invites write invites/{token} with owner, ownerName, a timestamp expiry and a server createdAt", async () => {
    const { token, expiresAt } = await be.invites.create(A, "Alice", 15)
    expect(token).toMatch(/^[0-9a-z]{18}$/)
    const w = fake.state.writes[0]
    expect(w.path).toBe(`invites/${token}`)
    expect(Object.keys(w.data!).sort()).toEqual(["createdAt", "expiresAt", "owner", "ownerName"])
    expect(w.data).toMatchObject({ owner: A, ownerName: "Alice", createdAt: SERVER })
    expect(expiresAt).toBeGreaterThan(Date.now() + 14 * 60_000)
    expect(await be.invites.read(token)).toMatchObject({ owner: A, ownerName: "Alice", expired: false })
    expect(await be.invites.read("nope")).toBeNull()
    await be.invites.remove(token)
    expect(await be.invites.read(token)).toBeNull()
  })

  it("an expired invite reads as expired", async () => {
    fake.state.docs.set("invites/old", { owner: A, ownerName: "Alice", expiresAt: new fake.FakeTs(Date.now() - 1000) })
    expect(await be.invites.read("old")).toMatchObject({ expired: true })
  })

  it("push tokens are one document per account: pushTokens/{uid} {token, updatedAt}", async () => {
    await be.pushTokens.save(A, "fcm")
    expect(fake.state.writes[0]).toEqual({ op: "setDoc", path: `pushTokens/${A}`, data: { token: "fcm", updatedAt: SERVER } })
    await be.pushTokens.remove(A)
    expect(fake.state.docs.has(`pushTokens/${A}`)).toBe(false)
  })
})

describe("connection store", () => {
  it("send adds requests/{auto} with the original fields, pending, server time; returns the new id", async () => {
    const id = await be.connections.send({ uid: A, name: "Alice" }, { uid: B, name: "Bob" })
    const w = fake.state.writes[0]
    expect(w).toEqual({
      op: "addDoc",
      path: `requests/${id}`,
      data: { from: A, to: B, fromName: "Alice", toName: "Bob", participants: [A, B], status: "pending", createdAt: SERVER },
    })
  })

  it("respond writes only {status, respondedAt}; remove deletes the document", async () => {
    const id = await be.connections.send({ uid: A, name: "Alice" }, { uid: B, name: "Bob" })
    await be.connections.respond(id, "accepted")
    expect(fake.state.writes.at(-1)).toEqual({ op: "updateDoc", path: `requests/${id}`, data: { status: "accepted", respondedAt: SERVER } })
    await be.connections.remove(id)
    expect(fake.state.docs.has(`requests/${id}`)).toBe(false)
  })

  it("list returns only this account's requests as plain values: timestamps are milliseconds", async () => {
    const id = await be.connections.send({ uid: A, name: "Alice" }, { uid: B, name: "Bob" })
    fake.state.docs.set("requests/other", { from: "x", to: "y", participants: ["x", "y"], status: "accepted", fromName: "", toName: "" })
    const list = await be.connections.list(B)
    expect(list.map((r) => r.id)).toEqual([id])
    expect(list[0]).toMatchObject({ from: A, to: B, status: "pending", participants: [A, B], createdAt: fake.state.now })
    expect(typeof (list[0] as unknown as { createdAt: unknown }).createdAt).toBe("number")
  })

  it("watch delivers the current list, then changes, and detaches", async () => {
    const lists: string[][] = []
    const off = be.connections.watch(B, { onData: (r) => lists.push(r.map((x) => x.id)) })
    await vi.waitFor(() => expect(lists).toEqual([[]]))
    const id = await be.connections.send({ uid: A, name: "Alice" }, { uid: B, name: "Bob" })
    expect(lists.at(-1)).toEqual([id])
    off()
    await be.connections.remove(id)
    expect(lists.at(-1)).toEqual([id])
  })

  it("the legacy forward watchRequests maps a failed listener to onError exactly as before", async () => {
    vi.useFakeTimers()
    try {
      fake.state.failNext.set("onSnapshot", "permission-denied")
      const errors: Error[] = []
      const off = watchRequests(A, () => {}, (e) => errors.push(e), db)
      await vi.advanceTimersByTimeAsync(0)
      expect(errors).toHaveLength(1)
      expect((errors[0] as BackendError).code).toBe("permission-denied") // the code old readers looked at is kept
      off()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("ping store", () => {
  it("create writes pings/{id} with exactly the original fields", async () => {
    expect(await be.pings.create(ping())).toBe("created")
    expect(fake.state.writes[0]).toEqual({
      op: "setDoc",
      path: "pings/ping-AB-00000001",
      data: {
        from: A,
        to: B,
        fromName: "Alice",
        toName: "Bob",
        participants: [A, B],
        requestId: "req1",
        date: "2026-10-06",
        items: ping().items,
        status: "asking",
        createdAt: SERVER,
      },
    })
  })

  it("a retry of the same request resolves to 'existing'; a different request under the same id is refused", async () => {
    await be.pings.create(ping())
    fake.state.failNext.set("setDoc", "permission-denied") // the rules refuse an overwrite
    expect(await be.pings.create(ping())).toBe("existing")
    fake.state.failNext.set("setDoc", "permission-denied")
    const e = await be.pings.create(ping({ requestId: "someOtherRequest" })).catch((x) => x)
    expect(e).toMatchObject({ kind: "unauthorized", code: "permission-denied" })
  })

  it("answer writes only {items, status: answered, respondedAt}", async () => {
    await be.pings.create(ping())
    const answered = ping().items.map((i) => ({ ...i, answer: "yes" as const }))
    await be.pings.answer("ping-AB-00000001", answered)
    expect(fake.state.writes.at(-1)).toEqual({ op: "updateDoc", path: "pings/ping-AB-00000001", data: { items: answered, status: "answered", respondedAt: SERVER } })
  })

  describe("lease", () => {
    const id = "ping-AB-00000001"
    const answeredDoc = (claim?: { by: string; at: number }) =>
      fake.state.docs.set(`pings/${id}`, { status: "answered", from: A, to: B, ...(claim ? { claimedBy: claim.by, claimedAt: new fake.FakeTs(claim.at) } : {}) })

    it("is false when the Ping does not exist or is not answered", async () => {
      expect(await be.pings.lease(id, "dev1")).toBe(false)
      fake.state.docs.set(`pings/${id}`, { status: "asking" })
      expect(await be.pings.lease(id, "dev1")).toBe(false)
    })

    it("takes a free lease with {claimedBy, claimedAt: server time} and nothing else", async () => {
      answeredDoc()
      expect(await be.pings.lease(id, "dev1")).toBe(true)
      expect(fake.state.writes.at(-1)).toEqual({ op: "tx.update", path: `pings/${id}`, data: { claimedBy: "dev1", claimedAt: SERVER } })
    })

    it("another device cannot take a live lease; the holder renews; a lease that ran out can be taken over", async () => {
      const now = 1_790_000_100_000
      answeredDoc({ by: "dev1", at: now - 10_000 })
      expect(await be.pings.lease(id, "dev2", now)).toBe(false)
      expect(await be.pings.lease(id, "dev1", now)).toBe(true)
      answeredDoc({ by: "dev1", at: now - LEASE_MS - 1 })
      expect(await be.pings.lease(id, "dev2", now)).toBe(true)
    })

    it("a permission-denied from the server means someone else holds it: false, not an error", async () => {
      answeredDoc()
      fake.state.failNext.set("runTransaction", "permission-denied")
      expect(await be.pings.lease(id, "dev1")).toBe(false)
    })

    it("any other failure is a BackendError", async () => {
      answeredDoc()
      fake.state.failNext.set("runTransaction", "unavailable")
      await expect(be.pings.lease(id, "dev1")).rejects.toMatchObject({ kind: "unavailable" })
    })

    it("the legacy forward leasePing(db, ...) behaves the same", async () => {
      answeredDoc()
      expect(await leasePing(db, id, "dev1")).toBe(true)
    })
  })

  describe("finalize", () => {
    const id = "ping-AB-00000001"
    it("writes only {status: processed, processedAt: server time}", async () => {
      fake.state.docs.set(`pings/${id}`, { status: "answered" })
      expect(await be.pings.finalize(id)).toBe("processed")
      expect(fake.state.writes.at(-1)).toEqual({ op: "updateDoc", path: `pings/${id}`, data: { status: "processed", processedAt: SERVER } })
    })

    it("a refused write on an already processed Ping is 'already'; on any other state it is an error", async () => {
      fake.state.docs.set(`pings/${id}`, { status: "processed" })
      fake.state.failNext.set("updateDoc", "permission-denied")
      expect(await be.pings.finalize(id)).toBe("already")
      fake.state.docs.set(`pings/${id}`, { status: "asking" })
      fake.state.failNext.set("updateDoc", "permission-denied")
      await expect(be.pings.finalize(id)).rejects.toMatchObject({ kind: "unauthorized" })
    })
  })

  describe("dismiss", () => {
    const id = "ping-AB-00000002"
    it("requires the current lease and writes a distinct dismissed status", async () => {
      fake.state.docs.set(`pings/${id}`, { status: "answered", claimedBy: "dev1", claimedAt: fake.state.now })
      expect(await be.pings.dismiss(id, "dev1")).toBe("dismissed")
      expect(fake.state.writes.at(-1)).toEqual({
        op: "updateDoc",
        path: `pings/${id}`,
        data: { status: "dismissed", dismissedAt: SERVER },
      })
    })

    it("recognises an already dismissed reply and won't reinterpret an integrated reply", async () => {
      fake.state.docs.set(`pings/${id}`, { status: "dismissed" })
      fake.state.failNext.set("runTransaction", "permission-denied")
      expect(await be.pings.dismiss(id, "dev1")).toBe("already-dismissed")
      fake.state.docs.set(`pings/${id}`, { status: "processed" })
      fake.state.failNext.set("runTransaction", "permission-denied")
      expect(await be.pings.dismiss(id, "dev1")).toBe("already-processed")
    })
  })

  it("remove deletes the document", async () => {
    await be.pings.create(ping())
    await be.pings.remove("ping-AB-00000001")
    expect(fake.state.docs.has("pings/ping-AB-00000001")).toBe(false)
  })

  it("watch delivers Pings as plain values (timestamps in ms) and detaches", async () => {
    const seen: { createdAt?: unknown; claimedAt?: unknown }[][] = []
    const off = be.pings.watch(B, { onData: (p) => seen.push(p) })
    await be.pings.create(ping())
    expect(seen.at(-1)).toHaveLength(1)
    expect(seen.at(-1)![0].createdAt).toBe(fake.state.now)
    off()
    expect(fake.state.listeners.size).toBe(0)
  })

  it("the legacy forward createPing(db, ...) writes the same document", async () => {
    expect(await createPing(db, ping())).toBe("created")
    expect(fake.state.docs.has("pings/ping-AB-00000001")).toBe(true)
  })
})

describe("one backend per database handle", () => {
  it("reuses the adapter for the same handle and gives a different handle its own", () => {
    const d1 = {} as never
    const d2 = {} as never
    expect(firebaseBackendFor(d1)).toBe(firebaseBackendFor(d1))
    expect(firebaseBackendFor(d1)).not.toBe(firebaseBackendFor(d2))
  })
})

describe("error normalisation", () => {
  it.each([
    ["permission-denied", "unauthorized", false],
    ["unauthenticated", "unauthorized", false],
    ["unavailable", "unavailable", true],
    ["deadline-exceeded", "unavailable", true],
    ["auth/network-request-failed", "unavailable", true],
    ["not-found", "not-found", false],
    ["aborted", "conflict", false],
    ["already-exists", "conflict", false],
    ["invalid-argument", "invalid", false],
    ["something-new", "unknown", false],
  ])("%s -> %s (retryable %s)", (code, kind, retryable) => {
    const e = fromFirebaseError(Object.assign(new Error("boom"), { code }))
    expect(e).toMatchObject({ kind, retryable, code, message: "boom" })
  })

  it("passes a BackendError through untouched and wraps a plain error as unknown", () => {
    const e = new BackendError("conflict", "x")
    expect(fromFirebaseError(e)).toBe(e)
    expect(fromFirebaseError(new Error("plain")).kind).toBe("unknown")
  })
})
