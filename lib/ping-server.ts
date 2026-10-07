/**
 * Everything the app does to a Ping on the server, with the database passed in so the very same code runs in the app
 * and in the emulator tests. The operations themselves now live in the Firebase adapter (lib/backend/firebase), unchanged;
 * these are forwards with the original signatures, kept for the emulator tests and the identity layer. Application code
 * should use `getBackend().pings` (lib/backend) instead. The rules in firestore.rules are the security boundary.
 *
 *   createPing    asker  -> a new Ping, once. A retry with the same id resolves to the Ping that is already there.
 *   answerPing    mate   -> yes / no on each class (nothing else can change)
 *   leasePing     asker  -> "I am applying this answer" (one device at a time; a lease that runs out can be taken over)
 *   finalizePing  asker  -> the answer has been applied: processed, for good
 */
import type { Firestore } from "firebase/firestore"
import type { PingItem } from "./types"
import { firebaseBackendFor } from "./backend/firebase"
import { LEASE_MS, type NewPing } from "./backend/contracts"

export { LEASE_MS }
export type { NewPing }

export const createPing = (db: Firestore, p: NewPing) => firebaseBackendFor(db).pings.create(p)

/** The mate's answer. Every class gets a yes or no; the rules let nothing else change. */
export const answerPing = (db: Firestore, id: string, items: PingItem[]) => firebaseBackendFor(db).pings.answer(id, items)

/** True when this device now holds the lease. A lease this device already holds is renewed. */
export const leasePing = (db: Firestore, id: string, deviceId: string, now = Date.now()) => firebaseBackendFor(db).pings.lease(id, deviceId, now)

/** The answer has been applied (and saved) on this device: mark the Ping processed. Already processed counts as done. */
export const finalizePing = (db: Firestore, id: string) => firebaseBackendFor(db).pings.finalize(id)

/** Withdraw or clear a Ping. The rules keep an answer that hasn't been applied yet. */
export const removePing = (db: Firestore, id: string) => firebaseBackendFor(db).pings.remove(id)
