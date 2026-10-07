/**
 * Friend connections, built on Firebase Anonymous Auth + Firestore (both on the free Spark plan,
 * no Cloud Functions needed). Every user gets a permanent anonymous account id; that id is what the
 * QR code and the permanent link carry. Magic links are short-lived invite tokens.
 *
 * This file keeps what is genuinely Firebase Auth (anonymous sign-in) and the link helpers. Every Firestore operation
 * now lives in lib/backend/firebase (see PHASE4A_REPOSITORY_ARCHITECTURE.md). The functions below with a `database`
 * parameter are thin forwards to that adapter, kept so the identity layer and the emulator tests keep their signatures.
 * New application code should use `getBackend()` from lib/backend instead.
 *
 * Collections (see firestore.rules):
 *   users/{uid}        { name }
 *   invites/{token}    { owner, ownerName, expiresAt }     short-lived magic links
 *   requests/{id}      { from, to, fromName, toName, participants, status }
 *   pings/{id}         "did you mark me present?" (see lib/backend/firebase and firestore.rules)
 *   pushTokens/{uid}   { token }   this account's device token; Cloud Functions use it to alert about pings
 */
import { getAuth, signInAnonymously, onAuthStateChanged, type User } from "firebase/auth"
import type { Firestore } from "firebase/firestore"
import { app, db } from "./firebase"
import type { FriendRequest, Ping } from "./types"
import { firebaseBackendFor } from "./backend/firebase"

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

const be = (database: Firestore) => firebaseBackendFor(database)
const onState = (onError: (e: Error) => void) => (live: boolean, e?: unknown) => {
  if (!live && e) onError(e as Error)
}

export const saveProfile = (uid: string, name: string, database: Firestore = db) => be(database).profiles.save(uid, name)

export const getProfileName = (uid: string): Promise<string | null> => be(db).profiles.getName(uid)

/** Live list of every request that involves this user (incoming, outgoing, accepted) */
export const watchRequests = (uid: string, onData: (r: FriendRequest[]) => void, onError: (e: Error) => void, database: Firestore = db) =>
  be(database).connections.watch(uid, { onData, onState: onState(onError) })

/** Every request that involves this user, once */
export const listRequests = (uid: string, database: Firestore = db) => be(database).connections.list(uid)

/** Resolves to `{ id }`, as the Firestore document reference it replaced did */
export const sendRequest = async (me: { uid: string; name: string }, to: { uid: string; name: string }, database: Firestore = db) => ({
  id: await be(database).connections.send(me, to),
})

export const respondToRequest = (id: string, status: "accepted" | "declined", database: Firestore = db) => be(database).connections.respond(id, status)

export const removeRequest = (id: string, database: Firestore = db) => be(database).connections.remove(id)

/** A magic link that stops working after `minutes` */
export const createInvite = (uid: string, name: string, minutes = 15) => be(db).invites.create(uid, name, minutes)

export const readInvite = (token: string) => be(db).invites.read(token)

export const permanentLink = (uid: string) => `${location.origin}/?add=${uid}`
export const magicLink = (token: string) => `${location.origin}/?invite=${token}`

/** Live list of pings that involve this user (ones they sent and ones sent to them) */
export const watchPings = (uid: string, onData: (p: Ping[]) => void, onError: (e: Error) => void, database: Firestore = db) =>
  be(database).pings.watch(uid, { onData, onState: onState(onError) })

/** Save this device's push token so a mate's ping or reply can alert it (read only by the owner and the Cloud Functions) */
export const savePushToken = (uid: string, token: string, database: Firestore = db) => be(database).pushTokens.save(uid, token)

/** Stop alerting this device for this account (used before switching or signing out of it) */
export const deletePushToken = (uid: string, database: Firestore = db) => be(database).pushTokens.remove(uid)
