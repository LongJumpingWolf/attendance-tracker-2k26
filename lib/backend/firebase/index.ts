/**
 * The Firebase (Firestore) implementation of the backend contracts. This is the ONLY place application code talks to
 * Firestore. The operations are the ones the app has always made, moved here unchanged: same reads and writes, same
 * compare-and-set transaction, same server timestamps, same listeners (wrapped by `resilient`), same document shapes.
 * The rules in firestore.rules are the security boundary; this is the honest client side of them.
 *
 * Firestore objects stop here: timestamps leave as milliseconds, failures leave as BackendError (which keeps the
 * Firestore `code`, so anything reading `error.code` is unaffected).
 *
 * The database is a dependency, so the same code runs in the app and in the emulator tests.
 */
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  type Firestore,
} from "firebase/firestore"
import type { FriendRequest, Ping } from "../../types"
import { resilient } from "../../realtime"
import { fromFirebaseError } from "../errors"
import { randomToken } from "../token"
import {
  LEASE_MS,
  type Backend,
  type CloudSyncStore,
  type ConnectionStore,
  type InviteStore,
  type NewPing,
  type PingStore,
  type ProfileStore,
  type PushTokenStore,
  type StoredSync,
  type Subscription,
} from "../contracts"

export interface FirebaseDeps {
  db: Firestore
  /** Anonymous sign-in on demand. Only the sync store needs it (as it always did). */
  ensureSignedIn?: () => Promise<unknown>
}

/** A Firestore Timestamp becomes milliseconds; null (a write still pending), numbers and missing values pass through */
const ms = (v: unknown): unknown => (v && typeof (v as { toMillis?: unknown }).toMillis === "function" ? (v as Timestamp).toMillis() : v)

const TIME_FIELDS = ["createdAt", "respondedAt", "claimedAt", "processedAt", "dismissedAt"] as const
const plain = <T extends { id: string }>(id: string, data: Record<string, unknown>): T => {
  const out: Record<string, unknown> = { id, ...data }
  for (const f of TIME_FIELDS) if (f in out) out[f] = ms(out[f])
  return out as unknown as T
}

/** Maps every failure to a BackendError, once, at the edge */
const guard =
  <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
  async (...a: A): Promise<R> => {
    try {
      return await fn(...a)
    } catch (e) {
      throw fromFirebaseError(e)
    }
  }

const codeOf = (e: unknown) => (e as { code?: string } | null)?.code

const stateOf = (sub: Pick<Subscription<never>, "onState">) => (live: boolean, e?: unknown) => sub.onState?.(live, e === undefined ? undefined : fromFirebaseError(e))

export function createFirebaseBackend({ db, ensureSignedIn }: FirebaseDeps): Backend {
  // ---- sync -------------------------------------------------------------------------------------------------------
  const sync: CloudSyncStore = {
    get: guard(async (owner) => {
      await ensureSignedIn?.()
      const snap = await getDoc(doc(db, "syncs", owner))
      if (!snap.exists()) return null
      const d = snap.data() as StoredSync
      return { data: d.data, rev: d.rev, updatedAt: d.updatedAt }
    }),

    put: guard(async (owner, data, expectedRev) => {
      await ensureSignedIn?.()
      const ref = doc(db, "syncs", owner)
      return await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref)
        const rev = snap.exists() ? (snap.data().rev as number) : null
        if (rev !== expectedRev) return { ok: false, reason: "conflict" } as const
        const next = (rev ?? 0) + 1
        tx.set(ref, { data, rev: next, updatedAt: Date.now() })
        return { ok: true, rev: next } as const
      })
    }),

    watch(owner, sub) {
      return resilient(
        ({ ok, fail }) => {
          let off = () => {}
          let gone = false
          ;(ensureSignedIn ? ensureSignedIn() : Promise.resolve()).then(
            () => {
              if (gone) return
              off = onSnapshot(
                doc(db, "syncs", owner),
                (snap) => {
                  ok()
                  if (!snap.exists()) return
                  const d = snap.data() as StoredSync
                  sub.onData({ data: d.data, rev: d.rev, updatedAt: d.updatedAt })
                },
                fail,
              )
            },
            fail,
          )
          return () => {
            gone = true
            off()
          }
        },
        stateOf(sub),
      )
    },
  }

  // ---- profiles ---------------------------------------------------------------------------------------------------
  const profiles: ProfileStore = {
    save: guard(async (uid, name) => {
      await setDoc(doc(db, "users", uid), { name, updatedAt: serverTimestamp() })
    }),
    getName: guard(async (uid) => {
      const snap = await getDoc(doc(db, "users", uid))
      return snap.exists() ? ((snap.data().name as string) ?? null) : null
    }),
  }

  // ---- invites ----------------------------------------------------------------------------------------------------
  const invites: InviteStore = {
    create: guard(async (uid, name, minutes) => {
      const token = randomToken()
      const expiresAt = Date.now() + minutes * 60_000
      await setDoc(doc(db, "invites", token), {
        owner: uid,
        ownerName: name,
        expiresAt: Timestamp.fromMillis(expiresAt),
        createdAt: serverTimestamp(),
      })
      return { token, expiresAt }
    }),
    read: guard(async (token) => {
      const snap = await getDoc(doc(db, "invites", token))
      if (!snap.exists()) return null
      const d = snap.data()
      const expiresAt = (d.expiresAt as Timestamp).toMillis()
      return { owner: d.owner as string, ownerName: d.ownerName as string, expired: expiresAt < Date.now(), expiresAt }
    }),
    remove: guard(async (token) => {
      await deleteDoc(doc(db, "invites", token))
    }),
  }

  // ---- connections (requests/{id}) --------------------------------------------------------------------------------
  const connections: ConnectionStore = {
    watch(uid, sub) {
      const q = query(collection(db, "requests"), where("participants", "array-contains", uid))
      return resilient(
        ({ ok, fail }) =>
          onSnapshot(
            q,
            (snap) => {
              ok()
              sub.onData(snap.docs.map((d) => plain<FriendRequest>(d.id, d.data())))
            },
            fail,
          ),
        stateOf(sub),
      )
    },
    list: guard(async (uid) => {
      const snap = await getDocs(query(collection(db, "requests"), where("participants", "array-contains", uid)))
      return snap.docs.map((d) => plain<FriendRequest>(d.id, d.data()))
    }),
    send: guard(async (me, to) => {
      const ref = await addDoc(collection(db, "requests"), {
        from: me.uid,
        to: to.uid,
        fromName: me.name,
        toName: to.name,
        participants: [me.uid, to.uid],
        status: "pending",
        createdAt: serverTimestamp(),
      })
      return ref.id
    }),
    respond: guard(async (id, status) => {
      await updateDoc(doc(db, "requests", id), { status, respondedAt: serverTimestamp() })
    }),
    remove: guard(async (id) => {
      await deleteDoc(doc(db, "requests", id))
    }),
  }

  // ---- pings ------------------------------------------------------------------------------------------------------
  const sameLogicalPing = (data: Record<string, unknown>, p: NewPing) => {
    const keys = (list: unknown) => (Array.isArray(list) ? list.map((i) => (i as { key?: string })?.key).join("|") : "")
    return data.from === p.from.uid && data.to === p.to.uid && data.date === p.date && data.requestId === p.requestId && keys(data.items) === keys(p.items)
  }

  const pings: PingStore = {
    watch(uid, sub) {
      const q = query(collection(db, "pings"), where("participants", "array-contains", uid))
      return resilient(
        ({ ok, fail }) =>
          onSnapshot(
            q,
            (snap) => {
              ok()
              sub.onData(snap.docs.map((d) => plain<Ping>(d.id, d.data())))
            },
            fail,
          ),
        stateOf(sub),
      )
    },

    /**
     * Creates the Ping. If a Ping with this id already exists and is the same request (the first attempt reached the
     * server although the app never heard back), that is success: there is still exactly one.
     */
    create: guard(async (p) => {
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
        return "created" as const
      } catch (e) {
        // Writing over a Ping that exists is an update, which the rules refuse. Look at what is there before giving up.
        if (codeOf(e) === "permission-denied") {
          const snap = await getDoc(ref).catch(() => null)
          if (snap?.exists() && sameLogicalPing(snap.data(), p)) return "existing" as const
        }
        throw e
      }
    }),

    /** The mate's answer. Every class gets a yes or no; the rules let nothing else change. */
    answer: guard(async (id, items) => {
      await updateDoc(doc(db, "pings", id), { items, status: "answered", respondedAt: serverTimestamp() })
    }),

    /**
     * Takes the lease on an answered Ping so this device can apply it. True when this device now holds it. False when
     * another device holds a live lease, or the Ping is no longer waiting to be applied. A lease this device already holds
     * is renewed, which is how a crashed attempt is picked up again after a reload.
     */
    lease: guard(async (id, deviceId, now = Date.now()) => {
      const ref = doc(db, "pings", id)
      try {
        return await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref)
          if (!snap.exists() || snap.data().status !== "answered") return false
          const d = snap.data()
          const at = (ms(d.claimedAt) as number | null | undefined) ?? null
          const live = at !== null && now - at < LEASE_MS
          if (live && d.claimedBy !== deviceId) return false
          tx.update(ref, { claimedBy: deviceId, claimedAt: serverTimestamp() })
          return true
        })
      } catch (e) {
        if (codeOf(e) === "permission-denied") return false // the server's clock says someone else still holds it
        throw e
      }
    }),

    /** The answer has been applied (and saved) on this device: mark the Ping processed. Already processed counts as done. */
    finalize: guard(async (id) => {
      const ref = doc(db, "pings", id)
      try {
        await updateDoc(ref, { status: "processed", processedAt: serverTimestamp() })
        return "processed" as const
      } catch (e) {
        if (codeOf(e) === "permission-denied") {
          const snap = await getDoc(ref).catch(() => null)
          if (snap?.exists() && snap.data().status === "processed") return "already" as const
        }
        throw e
      }
    }),

    /** Explicitly decline an answer without applying it to attendance; the decision is shared across devices. */
    dismiss: guard(async (id, deviceId) => {
      const ref = doc(db, "pings", id)
      try {
        return await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref)
          if (!snap.exists()) throw new Error("Ping not found.")
          const data = snap.data()
          if (data.status === "dismissed") return "already-dismissed" as const
          if (data.status === "processed") return "already-processed" as const
          if (data.status !== "answered") throw new Error("Ping is not waiting for a decision.")
          const claimedAt = ms(data.claimedAt) as number | null | undefined
          if (data.claimedBy !== deviceId || claimedAt == null || Date.now() - claimedAt >= LEASE_MS) {
            throw new Error("This device no longer holds the Ping decision lease.")
          }
          tx.update(ref, { status: "dismissed", dismissedAt: serverTimestamp() })
          return "dismissed" as const
        })
      } catch (e) {
        if (codeOf(e) === "permission-denied") {
          const snap = await getDoc(ref).catch(() => null)
          if (snap?.exists() && snap.data().status === "dismissed") return "already-dismissed" as const
          if (snap?.exists() && snap.data().status === "processed") return "already-processed" as const
        }
        throw e
      }
    }),

    /** Withdraw or clear a Ping. The rules keep an answer that hasn't been applied yet. */
    remove: guard(async (id) => {
      await deleteDoc(doc(db, "pings", id))
    }),
  }

  // ---- push tokens ------------------------------------------------------------------------------------------------
  const pushTokens: PushTokenStore = {
    save: guard(async (uid, token) => {
      await setDoc(doc(db, "pushTokens", uid), { token, updatedAt: serverTimestamp() })
    }),
    remove: guard(async (uid) => {
      await deleteDoc(doc(db, "pushTokens", uid))
    }),
  }

  return { kind: "firebase", sync, profiles, invites, connections, pings, pushTokens }
}

/** One backend per database handle: the app has one, the emulator tests have several (one per signed-in browser) */
const perDb = new WeakMap<Firestore, Backend>()
export function firebaseBackendFor(db: Firestore): Backend {
  let b = perDb.get(db)
  if (!b) perDb.set(db, (b = createFirebaseBackend({ db })))
  return b
}
