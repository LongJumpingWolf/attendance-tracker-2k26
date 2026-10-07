/**
 * Who you are to your mates, and how that stays stable.
 *
 * The identity is the Firebase account id. Signing in with Google upgrades the account you already have (same id), so
 * your mates, Pings and alerts stay with you, on every device that signs in to the same Google account.
 *
 * The one case where an id can change is a Google account that is already tied to another id (it was first used on
 * another device). This device is then switched to that id. The mates connected here under the old id would be left
 * behind, so before switching they are carried over by a deterministic path:
 *
 *   1. the connections made under the old id are noted (and saved, in case the app closes half-way)
 *   2. they are ended on the server, so nobody is left connected to an id that is about to be abandoned
 *   3. the device signs in as the Google account's id
 *   4. a fresh connection request is sent to each of those mates from the new id; they accept it once, and their
 *      history with you is kept (the ledger matches them by name; see adoptConnections)
 *
 * Nothing is merged silently and nothing is deleted without the person agreeing first.
 */
import {
  GoogleAuthProvider,
  linkWithCredential,
  signInWithCredential,
  signOut,
  type Auth,
  type AuthCredential,
} from "firebase/auth"
import { collection, deleteDoc, doc, getDocs, query, where, type Firestore } from "firebase/firestore"
import type { FriendRequest, Mate } from "./types"
import { deletePushToken, saveProfile, sendRequest } from "./social"

export interface Connection {
  /** The mate's account id */
  uid: string
  name: string
  /** The accepted connection between you */
  requestId: string
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code

/** Every connection (accepted or still waiting) that involves this account */
async function allRequests(db: Firestore, uid: string): Promise<FriendRequest[]> {
  const snap = await getDocs(query(collection(db, "requests"), where("participants", "array-contains", uid)))
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FriendRequest, "id">) }))
}

/** The mates this account is connected to right now */
export async function listConnections(db: Firestore, uid: string): Promise<Connection[]> {
  return (await allRequests(db, uid))
    .filter((r) => r.status === "accepted")
    .map((r) => ({ uid: r.participants.find((p) => p !== uid) as string, name: r.from === uid ? r.toName : r.fromName, requestId: r.id }))
    .filter((c) => !!c.uid)
}

export type LinkOutcome =
  | { kind: "linked"; uid: string }
  /** This Google account already belongs to another id. Nothing has changed yet. */
  | { kind: "exists"; credential: AuthCredential; carry: Connection[] }

/** Upgrades the signed-in (anonymous) account with a Google credential, keeping its id, or reports that Google already has one */
export async function linkGoogle(auth: Auth, db: Firestore, credential: AuthCredential): Promise<LinkOutcome> {
  const user = auth.currentUser
  if (!user) return { kind: "linked", uid: (await signInWithCredential(auth, credential)).user.uid }
  if (!user.isAnonymous) return { kind: "linked", uid: user.uid }
  try {
    return { kind: "linked", uid: (await linkWithCredential(user, credential)).user.uid }
  } catch (e) {
    if (codeOf(e) !== "auth/credential-already-in-use") throw e
    return planSwitch(db, user.uid, GoogleAuthProvider.credentialFromError(e as never) ?? credential)
  }
}

/** What switching to the account Google already has would leave behind */
export async function planSwitch(db: Firestore, fromUid: string, credential: AuthCredential): Promise<Extract<LinkOutcome, { kind: "exists" }>> {
  return { kind: "exists", credential, carry: await listConnections(db, fromUid) }
}

const CARRY_KEY = "identityCarry"
interface Carry {
  from: string
  mates: Connection[]
}
const saveCarry = (c: Carry | null) => {
  try {
    if (c) localStorage.setItem(CARRY_KEY, JSON.stringify(c))
    else localStorage.removeItem(CARRY_KEY)
  } catch {
    /* not remembered: the connections were just ended, and the person can add them again */
  }
}
export const readCarry = (): Carry | null => {
  try {
    const raw = localStorage.getItem(CARRY_KEY)
    return raw ? (JSON.parse(raw) as Carry) : null
  } catch {
    return null
  }
}

/**
 * Switches this device to the account Google already has, carrying the mates over. Safe to run again after a failure:
 * what is left to do is remembered until it is done.
 */
export async function switchToExisting(
  auth: Auth,
  db: Firestore,
  credential: AuthCredential,
  carry: Connection[],
  name: string,
): Promise<{ uid: string; reconnected: number }> {
  const old = auth.currentUser
  if (old && carry.length > 0) {
    saveCarry({ from: old.uid, mates: carry }) // first, so a crash after the next step can still be finished
    await Promise.all(carry.map((c) => deleteDoc(doc(db, "requests", c.requestId))))
  }
  if (old) await deletePushToken(old.uid, db).catch(() => {}) // this device stops being alerted for the identity it is leaving
  const uid = (await signInWithCredential(auth, credential)).user.uid
  await announceProfile(db, uid, name) // friends look the name up by account id
  return { uid, reconnected: await completeCarry(db, uid, name) }
}

/** Sends the new connection requests that a switch left to do. Returns how many mates were asked. */
export async function completeCarry(db: Firestore, uid: string, name: string): Promise<number> {
  const pending = readCarry()
  if (!pending || pending.from === uid) return 0
  const have = new Set((await allRequests(db, uid)).flatMap((r) => r.participants))
  let sent = 0
  for (const m of pending.mates) {
    if (have.has(m.uid)) continue
    try {
      await sendRequest({ uid, name: name || "Someone" }, { uid: m.uid, name: m.name }, db)
      sent++
    } catch {
      return sent // something is wrong (offline?): leave the rest remembered for next time
    }
  }
  saveCarry(null)
  return sent
}

/** Signs out. This device stops being alerted for the account it is leaving, and any later account starts clean. */
export async function signOutOfAccount(auth: Auth, db: Firestore) {
  const user = auth.currentUser
  if (user) await deletePushToken(user.uid, db).catch(() => {})
  await signOut(auth)
}

/** The profile name follows the account that is signed in */
export const announceProfile = (db: Firestore, uid: string, name: string) => (name ? saveProfile(uid, name, db).catch(() => {}) : Promise.resolve())

/**
 * The favour ledger lists everyone you are connected to. A mate who reconnected under a new account id (see above) is
 * the same person with the same name: their old row, no longer connected, takes the new id and keeps its history,
 * instead of a second row appearing.
 */
export function adoptConnections(mates: Mate[], connections: { uid: string; name: string }[]): Mate[] {
  const norm = (s: string) => s.trim().toLowerCase()
  const live = new Set(connections.map((c) => c.uid))
  let next = mates
  for (const c of connections) {
    if (next.some((m) => m.uid === c.uid)) continue
    const stale = next.findIndex((m) => norm(m.name) === norm(c.name) && (!m.uid || !live.has(m.uid)))
    next =
      stale !== -1
        ? next.map((m, i) => (i === stale ? { ...m, uid: c.uid } : m))
        : [...next, { id: c.uid, uid: c.uid, name: c.name, covered: 0, repaid: 0 }]
  }
  return next
}
