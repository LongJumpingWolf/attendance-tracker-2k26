/**
 * Everything the app does to a Ping on the server, with the database passed in so the very same code runs in the app
 * and in the emulator tests. The rules in firestore.rules are the security boundary; this is the honest client side of them.
 *
 *   createPing    asker  -> a new Ping, once. A retry with the same id resolves to the Ping that is already there.
 *   answerPing    mate   -> yes / no on each class (nothing else can change)
 *   leasePing     asker  -> "I am applying this answer" (one device at a time; a lease that runs out can be taken over)
 *   finalizePing  asker  -> the answer has been applied: processed, for good
 */
import { deleteDoc, doc, getDoc, runTransaction, serverTimestamp, setDoc, updateDoc, type Firestore } from "firebase/firestore"
import type { PingItem } from "./types"
import { msOf } from "./ping-presentation"

/** How long a device may hold an answer while it applies it. The server enforces this with its own clock. */
export const LEASE_MS = 2 * 60_000

export interface NewPing {
  /** Chosen by the app, once per logical Ping, so retrying can never make a second one */
  id: string
  from: { uid: string; name: string }
  to: { uid: string; name: string }
  /** The class day, YYYY-MM-DD */
  date: string
  items: PingItem[]
  /** The accepted connection between the two people */
  requestId: string
}

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code

const sameLogicalPing = (data: Record<string, unknown>, p: NewPing) => {
  const keys = (list: unknown) => (Array.isArray(list) ? list.map((i) => (i as { key?: string })?.key).join("|") : "")
  return data.from === p.from.uid && data.to === p.to.uid && data.date === p.date && data.requestId === p.requestId && keys(data.items) === keys(p.items)
}

/**
 * Creates the Ping. If a Ping with this id already exists and is the same request (the first attempt reached the
 * server although the app never heard back), that is success: there is still exactly one.
 */
export async function createPing(db: Firestore, p: NewPing): Promise<"created" | "existing"> {
  const ref = doc(db, "pings", p.id)
  try {
    await setDoc(ref, {
      from: p.from.uid,
      to: p.to.uid,
      fromName: p.from.name,
      toName: p.to.name,
      participants: [p.from.uid, p.to.uid],
      requestId: p.requestId,
      date: p.date,
      items: p.items,
      status: "asking",
      createdAt: serverTimestamp(),
    })
    return "created"
  } catch (e) {
    // Writing over a Ping that exists is an update, which the rules refuse. Look at what is there before giving up.
    if (codeOf(e) === "permission-denied") {
      const snap = await getDoc(ref).catch(() => null)
      if (snap?.exists() && sameLogicalPing(snap.data(), p)) return "existing"
    }
    throw e
  }
}

/** The mate's answer. Every class gets a yes or no; the rules let nothing else change. */
export const answerPing = (db: Firestore, id: string, items: PingItem[]) =>
  updateDoc(doc(db, "pings", id), { items, status: "answered", respondedAt: serverTimestamp() })

/**
 * Takes the lease on an answered Ping so this device can apply it. True when this device now holds it. False when
 * another device holds a live lease, or the Ping is no longer waiting to be applied. A lease this device already holds
 * is renewed, which is how a crashed attempt is picked up again after a reload.
 */
export async function leasePing(db: Firestore, id: string, deviceId: string, now = Date.now()): Promise<boolean> {
  const ref = doc(db, "pings", id)
  try {
    return await runTransaction(db, async (tx) => {
      const snap = await tx.get(ref)
      if (!snap.exists() || snap.data().status !== "answered") return false
      const d = snap.data()
      const at = msOf(d.claimedAt)
      const live = at !== null && now - at < LEASE_MS
      if (live && d.claimedBy !== deviceId) return false
      tx.update(ref, { claimedBy: deviceId, claimedAt: serverTimestamp() })
      return true
    })
  } catch (e) {
    if (codeOf(e) === "permission-denied") return false // the server's clock says someone else still holds it
    throw e
  }
}

/** The answer has been applied (and saved) on this device: mark the Ping processed. Already processed counts as done. */
export async function finalizePing(db: Firestore, id: string): Promise<"processed" | "already"> {
  const ref = doc(db, "pings", id)
  try {
    await updateDoc(ref, { status: "processed", processedAt: serverTimestamp() })
    return "processed"
  } catch (e) {
    if (codeOf(e) === "permission-denied") {
      const snap = await getDoc(ref).catch(() => null)
      if (snap?.exists() && snap.data().status === "processed") return "already"
    }
    throw e
  }
}

/** Withdraw or clear a Ping. The rules keep an answer that hasn't been applied yet. */
export const removePing = (db: Firestore, id: string) => deleteDoc(doc(db, "pings", id))
