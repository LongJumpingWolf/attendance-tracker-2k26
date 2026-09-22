/**
 * Friend connections, built on Firebase Anonymous Auth + Firestore (both on the free Spark plan,
 * no Cloud Functions needed). Every user gets a permanent anonymous account id; that id is what the
 * QR code and the permanent link carry. Magic links are short-lived invite tokens.
 *
 * Collections (see firestore.rules):
 *   users/{uid}        { name }
 *   invites/{token}    { owner, ownerName, expiresAt }     short-lived magic links
 *   requests/{id}      { from, to, fromName, toName, participants, status }
 *   pings/{id}         { from, to, fromName, toName, participants, date, items[], status }   "did you mark me present?"
 */
import { getAuth, signInAnonymously, onAuthStateChanged, type User } from "firebase/auth"
import {
  collection,
  doc,
  getDoc,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from "firebase/firestore"
import { app, db } from "./firebase"
import type { FriendRequest, Ping, PingItem } from "./types"

export const socialConfigured = () =>
  Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  )

let signingIn: Promise<User> | null = null

/** Returns the current anonymous user, creating the account the first time */
export function ensureSignedIn(): Promise<User> {
  const auth = getAuth(app)
  if (auth.currentUser) return Promise.resolve(auth.currentUser)
  if (!signingIn) {
    signingIn = new Promise<User>((resolve, reject) => {
      const off = onAuthStateChanged(auth, async (user) => {
        off()
        if (user) return resolve(user)
        try {
          resolve((await signInAnonymously(auth)).user)
        } catch (e) {
          reject(e)
        }
      })
    }).finally(() => {
      signingIn = null
    })
  }
  return signingIn
}

export const saveProfile = (uid: string, name: string) =>
  setDoc(doc(db, "users", uid), { name, updatedAt: serverTimestamp() })

export async function getProfileName(uid: string): Promise<string | null> {
  const snap = await getDoc(doc(db, "users", uid))
  return snap.exists() ? ((snap.data().name as string) ?? null) : null
}

/** Live list of every request that involves this user (incoming, outgoing, accepted) */
export function watchRequests(uid: string, onData: (r: FriendRequest[]) => void, onError: (e: Error) => void) {
  const q = query(collection(db, "requests"), where("participants", "array-contains", uid))
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<FriendRequest, "id">) }))),
    onError,
  )
}

export const sendRequest = (me: { uid: string; name: string }, to: { uid: string; name: string }) =>
  addDoc(collection(db, "requests"), {
    from: me.uid,
    to: to.uid,
    fromName: me.name,
    toName: to.name,
    participants: [me.uid, to.uid],
    status: "pending",
    createdAt: serverTimestamp(),
  })

export const respondToRequest = (id: string, status: "accepted" | "declined") =>
  updateDoc(doc(db, "requests", id), { status, respondedAt: serverTimestamp() })

export const removeRequest = (id: string) => deleteDoc(doc(db, "requests", id))

const randomToken = () => {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 18)
}

/** A magic link that stops working after `minutes` */
export async function createInvite(uid: string, name: string, minutes = 15) {
  const token = randomToken()
  const expiresAt = Date.now() + minutes * 60_000
  await setDoc(doc(db, "invites", token), {
    owner: uid,
    ownerName: name,
    expiresAt: Timestamp.fromMillis(expiresAt),
    createdAt: serverTimestamp(),
  })
  return { token, expiresAt }
}

export async function readInvite(token: string) {
  const snap = await getDoc(doc(db, "invites", token))
  if (!snap.exists()) return null
  const d = snap.data()
  const expiresAt = (d.expiresAt as Timestamp).toMillis()
  return { owner: d.owner as string, ownerName: d.ownerName as string, expired: expiresAt < Date.now(), expiresAt }
}

export const permanentLink = (uid: string) => `${location.origin}/?add=${uid}`
export const magicLink = (token: string) => `${location.origin}/?invite=${token}`

/** Live list of pings that involve this user (ones they sent and ones sent to them) */
export function watchPings(uid: string, onData: (p: Ping[]) => void, onError: (e: Error) => void) {
  const q = query(collection(db, "pings"), where("participants", "array-contains", uid))
  return onSnapshot(
    q,
    (snap) => onData(snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<Ping, "id">) }))),
    onError,
  )
}

/** Ask a mate whether they marked you present in these classes */
export const sendPingDoc = (me: { uid: string; name: string }, to: { uid: string; name: string }, date: string, items: PingItem[], requestId: string) =>
  addDoc(collection(db, "pings"), {
    from: me.uid,
    to: to.uid,
    fromName: me.name,
    toName: to.name,
    participants: [me.uid, to.uid],
    requestId,
    date,
    items,
    status: "asking",
    createdAt: serverTimestamp(),
  })

/** The mate's reply: every item gets a yes or no */
export const answerPingDoc = (id: string, items: PingItem[]) =>
  updateDoc(doc(db, "pings", id), { items, status: "answered", respondedAt: serverTimestamp() })

/** Cancel a ping you sent, or clear an old one */
export const removePingDoc = (id: string) => deleteDoc(doc(db, "pings", id))
