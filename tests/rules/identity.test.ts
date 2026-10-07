import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { deleteApp, initializeApp, type FirebaseApp } from "firebase/app"
import { GoogleAuthProvider, connectAuthEmulator, getAuth, signInAnonymously, signInWithCredential, type Auth } from "firebase/auth"
import { connectFirestoreEmulator, doc, getDoc, getFirestore, updateDoc, type Firestore } from "firebase/firestore"
import fs from "node:fs"
import type { FriendRequest, Ping } from "@/lib/types"

/**
 * Identity, against the real Auth and Firestore emulators and the real rules. Each "device" is its own app with its own
 * sign-in, like separate browsers. The code under test is the code the app runs (lib/identity.ts, lib/social-session.ts).
 */
let env: RulesTestEnvironment
let social: typeof import("@/lib/social")
let identity: typeof import("@/lib/identity")
let session: typeof import("@/lib/social-session")
let pingServer: typeof import("@/lib/ping-server")
let apps: FirebaseApp[] = []
let followers: Device[] = []
let counter = 0

interface Device {
  auth: Auth
  db: Firestore
  requests: FriendRequest[]
  pings: Ping[]
  identities: (string | null)[]
  stop: () => void
}

/** A browser that is not signed in yet */
function browser(): Device {
  const app = initializeApp({ apiKey: "fake-key", projectId: "demo-ping", authDomain: "demo-ping.firebaseapp.com" }, `device-${++counter}`)
  apps.push(app)
  const auth = getAuth(app)
  connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true })
  const db = getFirestore(app)
  connectFirestoreEmulator(db, "127.0.0.1", 8080)
  return { auth, db, requests: [], pings: [], identities: [], stop: () => {} }
}
/** ...which starts following the signed-in account, as the app does */
function follow(d: Device) {
  followers.push(d)
  d.stop = session.followIdentity(
    { auth: d.auth, db: d.db },
    { onIdentity: (uid) => d.identities.push(uid), onRequests: (r) => (d.requests = r), onPings: (p) => (d.pings = p), onError: () => {} },
  )
  return d
}
const anonymous = async () => {
  const d = browser()
  await signInAnonymously(d.auth)
  return d
}
const google = (sub: string) => GoogleAuthProvider.credential(JSON.stringify({ sub, email: `${sub}@example.com`, email_verified: true }))
const uidOf = (d: Device) => d.auth.currentUser?.uid as string

const waitFor = async (check: () => boolean, what: string, ms = 8000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    if (check()) return
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

/** Two people become mates: a sends a request, b accepts. Returns the connection's id. */
async function connect(a: Device, aName: string, b: Device, bName: string) {
  const ref = await social.sendRequest({ uid: uidOf(a), name: aName }, { uid: uidOf(b), name: bName }, a.db)
  await updateDoc(doc(b.db, "requests", ref.id), { status: "accepted", respondedAt: new Date() })
  return ref.id
}
const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
const aPing = (id: string, from: Device, fromName: string, to: Device, toName: string, requestId: string) =>
  pingServer.createPing(from.db, { id, from: { uid: uidOf(from), name: fromName }, to: { uid: uidOf(to), name: toName }, date: day, requestId, items: [{ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer: null }] })

/** Whether a document exists, read with the rules off (an ordinary user can't read what isn't there) */
const existsOnServer = async (path: string) => {
  let found = false
  await env.withSecurityRulesDisabled(async (c) => void (found = (await getDoc(doc(c.firestore() as unknown as Firestore, path))).exists()))
  return found
}

const store = new Map<string, string>()
beforeAll(async () => {
  process.env.NEXT_PUBLIC_FIREBASE_API_KEY = "fake-key"
  process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID = "demo-ping"
  process.env.NEXT_PUBLIC_FIREBASE_APP_ID = "1:1:web:1"
  process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID = "1"
  process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN = "demo-ping.firebaseapp.com"
  vi.stubGlobal("localStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) })
  env = await initializeTestEnvironment({ projectId: "demo-ping", firestore: { rules: fs.readFileSync("firestore.rules", "utf8") } })
  social = await import("@/lib/social")
  identity = await import("@/lib/identity")
  session = await import("@/lib/social-session")
  pingServer = await import("@/lib/ping-server")
})
/** Every test closes its devices (listeners first, then the connections) so nothing from one test leaks into the next */
afterEach(async () => {
  followers.forEach((d) => d.stop())
  followers = []
  await Promise.all(apps.map((a) => deleteApp(a).catch(() => {})))
  apps = []
})
afterAll(async () => {
  await env.cleanup()
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  store.clear()
  await env.clearFirestore()
})

describe("1. anonymous -> Google sign-in keeps who you are", () => {
  it("keeps the same id, the same mates and the same listeners, and Pings still work both ways", async () => {
    const me = follow(await anonymous())
    const friend = await anonymous()
    const before = uidOf(me)
    const requestId = await connect(me, "Asha", friend, "Rahul")
    await waitFor(() => me.requests.some((r) => r.status === "accepted"), "the connection to reach the listener")
    await aPing("ping-in-before-aaaa", friend, "Rahul", me, "Asha", requestId) // an incoming Ping, before signing in
    await waitFor(() => me.pings.some((p) => p.id === "ping-in-before-aaaa"), "an incoming Ping before sign-in")

    const result = await identity.linkGoogle(me.auth, me.db, google("asha-google"))

    expect(result).toEqual({ kind: "linked", uid: before }) // 1. the identity is the same
    expect(uidOf(me)).toBe(before)
    expect(me.auth.currentUser?.isAnonymous).toBe(false)
    expect(me.identities).toEqual([before]) // the listeners were never torn down or re-pointed: nothing changed
    expect(me.requests.filter((r) => r.status === "accepted")).toHaveLength(1) // 2. the mate is still there
    // 4. Pings keep working after the transition: one arrives, and one can be sent
    await aPing("ping-in-after-bbbb", friend, "Rahul", me, "Asha", requestId)
    await waitFor(() => me.pings.some((p) => p.id === "ping-in-after-bbbb"), "an incoming Ping after sign-in")
    await expect(aPing("ping-out-after-cccc", me, "Asha", friend, "Rahul", requestId)).resolves.toBe("created")
    me.stop()
  })
})

describe("2. a Google account that already exists elsewhere", () => {
  it("with nothing to carry: the device becomes that account, and the listeners move to it", async () => {
    const first = await anonymous() // the device where Google was used first
    const homeUid = uidOf(first)
    await identity.linkGoogle(first.auth, first.db, google("shared-account"))
    const friend = await anonymous()
    const homeRequest = await connect(first, "Asha", friend, "Rahul")

    const second = follow(await anonymous()) // a second device, never signed in to Google
    const oldUid = uidOf(second)
    const outcome = await identity.linkGoogle(second.auth, second.db, google("shared-account"))
    expect(outcome).toMatchObject({ kind: "exists", carry: [] }) // nothing here would be left behind
    if (outcome.kind !== "exists") throw new Error("unreachable")

    await identity.switchToExisting(second.auth, second.db, outcome.credential, outcome.carry, "Asha")

    expect(uidOf(second)).toBe(homeUid) // 5. the same person, the same id, on both devices
    expect(second.identities).toEqual([oldUid, homeUid]) // 3. the listeners left the old identity and joined the new
    await waitFor(() => second.requests.some((r) => r.id === homeRequest && r.status === "accepted"), "the home account's mates to appear") // 5. mates are there
    await aPing("ping-home-0001-aa", friend, "Rahul", first, "Asha", homeRequest) // an incoming Ping for the account
    await waitFor(() => second.pings.some((p) => p.id === "ping-home-0001-aa"), "an incoming Ping on the second device")
    second.stop()
  })

  it("3. the old identity's data does not follow the device afterwards", async () => {
    const lonely = follow(await anonymous())
    const oldUid = uidOf(lonely)
    const friend = await anonymous()
    const oldRequest = await connect(lonely, "Asha", friend, "Rahul")
    await waitFor(() => lonely.requests.length === 1, "the old connection")
    const home = await anonymous()
    await identity.linkGoogle(home.auth, home.db, google("another-account"))
    const outcome = await identity.linkGoogle(lonely.auth, lonely.db, google("another-account"))
    if (outcome.kind !== "exists") throw new Error("expected the account to exist already")
    await identity.switchToExisting(lonely.auth, lonely.db, outcome.credential, outcome.carry, "Asha")
    // the connection under the old id has ended, and nothing of it is on screen
    expect(lonely.requests.some((r) => r.participants.includes(oldUid) && r.status === "accepted")).toBe(false)
    expect(await existsOnServer(`requests/${oldRequest}`)).toBe(false)
    lonely.stop()
  })

  it("carrying mates over: they are asked again from the new id, accept once, and Pings work", async () => {
    const first = await anonymous()
    const homeUid = uidOf(first)
    await identity.linkGoogle(first.auth, first.db, google("carry-account"))

    const second = follow(await anonymous())
    const leavingUid = uidOf(second)
    const friend = follow(await anonymous())
    const oldRequest = await connect(second, "Asha", friend, "Rahul") // made on the second device, before it knew about Google
    await waitFor(() => second.requests.length === 1 && friend.requests.length === 1, "the connection on both sides")
    await social.savePushToken(uidOf(second), "token-for-the-old-id", second.db)

    const outcome = await identity.linkGoogle(second.auth, second.db, google("carry-account"))
    if (outcome.kind !== "exists") throw new Error("expected the account to exist already")
    expect(outcome.carry).toEqual([{ uid: uidOf(friend), name: "Rahul", requestId: oldRequest }]) // the person is shown what would be left behind

    const switched = await identity.switchToExisting(second.auth, second.db, outcome.credential, outcome.carry, "Asha")
    expect(switched).toEqual({ uid: homeUid, reconnected: 1 })

    // the old connection is gone for the friend too, so they aren't left pointing at an id nobody uses
    await waitFor(() => !friend.requests.some((r) => r.id === oldRequest), "the old connection to end")
    // they now see a request from the new id
    await waitFor(() => friend.requests.some((r) => r.from === homeUid && r.status === "pending"), "the new request to arrive")
    // 6. this device no longer gets alerts for the identity it left
    expect(await existsOnServer(`pushTokens/${leavingUid}`)).toBe(false)
    expect(await existsOnServer(`users/${homeUid}`)).toBe(true) // the new id has a name to show

    // the friend accepts, once
    const request = friend.requests.find((r) => r.from === homeUid) as FriendRequest
    await updateDoc(doc(friend.db, "requests", request.id), { status: "accepted", respondedAt: new Date() })
    await waitFor(() => second.requests.some((r) => r.status === "accepted"), "the new connection to be accepted")

    // their ledger: the old row for the same person takes the new id and keeps its history
    const rahulsLedger = [{ id: "m1", name: "Asha", uid: uidOf(second) === homeUid ? "the-old-id" : "x", covered: 3, repaid: 1 }]
    const adopted = identity.adoptConnections(rahulsLedger, [{ uid: homeUid, name: "Asha" }])
    expect(adopted).toHaveLength(1)
    expect(adopted[0]).toMatchObject({ id: "m1", uid: homeUid, covered: 3, repaid: 1 })

    // and Pings work from the new identity, in both directions
    const connection = second.requests.find((r) => r.status === "accepted") as FriendRequest
    await expect(aPing("ping-new-id-0001", second, "Asha", friend, "Rahul", connection.id)).resolves.toBe("created")
    await expect(aPing("ping-new-id-0002", friend, "Rahul", second, "Asha", connection.id)).resolves.toBe("created")
    await waitFor(() => second.pings.some((p) => p.id === "ping-new-id-0002"), "an incoming Ping on the new identity")
    second.stop()
    friend.stop()
  })

  it("a switch that fails half-way is finished next time: the connections to carry are remembered", async () => {
    const first = await anonymous()
    await identity.linkGoogle(first.auth, first.db, google("half-way-account"))
    const second = await anonymous()
    const friend = await anonymous()
    await connect(second, "Asha", friend, "Rahul")
    const outcome = await identity.linkGoogle(second.auth, second.db, google("half-way-account"))
    if (outcome.kind !== "exists") throw new Error("expected the account to exist already")

    // sign-in fails (say the connection drops) after the old connections have been ended
    await expect(identity.switchToExisting(second.auth, second.db, GoogleAuthProvider.credential("not-a-real-token"), outcome.carry, "Asha")).rejects.toBeTruthy()
    expect(identity.readCarry()?.mates).toHaveLength(1) // remembered, not lost

    // later the person signs in properly, by any route; the leftover work is done
    await signInWithCredential(second.auth, outcome.credential)
    expect(await identity.completeCarry(second.db, uidOf(second), "Asha")).toBe(1)
    expect(identity.readCarry()).toBeNull()
  })
})

describe("sign out and back in", () => {
  it("5. signing out detaches everything; signing back in to the same account brings the mates and Pings back", async () => {
    const me = follow(await anonymous())
    const homeUid = uidOf(me)
    await identity.linkGoogle(me.auth, me.db, google("sign-out-account"))
    const friend = await anonymous()
    const requestId = await connect(me, "Asha", friend, "Rahul")
    await waitFor(() => me.requests.some((r) => r.status === "accepted"), "the connection")
    await social.savePushToken(homeUid, "token-1", me.db)

    await identity.signOutOfAccount(me.auth, me.db)
    expect(me.identities.at(-1)).toBeNull() // detached from the account that left
    expect(me.requests).toEqual([]) // none of its mates stay on screen
    expect(me.pings).toEqual([])
    expect(await existsOnServer(`pushTokens/${homeUid}`)).toBe(false) // and this device no longer gets that account's alerts

    // a Ping arrives for the account while this device is signed out: it must not be delivered here
    await aPing("ping-while-out-aa", friend, "Rahul", { auth: { currentUser: { uid: homeUid } } } as unknown as Device, "Asha", requestId)
    await new Promise((r) => setTimeout(r, 300))
    expect(me.pings).toEqual([])

    await signInWithCredential(me.auth, google("sign-out-account"))
    expect(uidOf(me)).toBe(homeUid) // the same account, the same id
    await waitFor(() => me.requests.some((r) => r.id === requestId && r.status === "accepted"), "the mate to come back")
    await waitFor(() => me.pings.some((p) => p.id === "ping-while-out-aa"), "the waiting Ping to be there")
    me.stop()
  })
})

describe("the ledger", () => {
  it("adds a new connection, and does not duplicate one it already has", () => {
    const ledger = identity.adoptConnections([{ id: "m1", name: "Rahul", uid: "r1", covered: 2, repaid: 0 }], [{ uid: "r1", name: "Rahul" }, { uid: "n1", name: "Neha" }])
    expect(ledger.map((m) => m.uid)).toEqual(["r1", "n1"])
  })

  it("does not take over a still-connected mate who happens to share a name", () => {
    const ledger = identity.adoptConnections([{ id: "m1", name: "Rahul", uid: "r1", covered: 2, repaid: 0 }], [{ uid: "r1", name: "Rahul" }, { uid: "r2", name: "Rahul" }])
    expect(ledger).toHaveLength(2)
    expect(ledger.find((m) => m.uid === "r1")?.covered).toBe(2)
  })

  it("an unconnected mate added by hand takes the account when that person connects", () => {
    const ledger = identity.adoptConnections([{ id: "m1", name: "Rahul", covered: 4, repaid: 1 }], [{ uid: "r1", name: "rahul" }])
    expect(ledger).toEqual([{ id: "m1", name: "Rahul", uid: "r1", covered: 4, repaid: 1 }])
  })
})
