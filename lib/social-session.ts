/**
 * Keeps the friend and Ping listeners attached to whoever is signed in RIGHT NOW.
 *
 * Before, the listeners were started once for the account the app happened to have at start-up. When the account
 * changed (signing in with Google on a device that already had a profile, signing out) they stayed on the old one, so
 * mates and Pings of the new identity never appeared and the old ones lingered.
 *
 * This follows the sign-in state: when the account changes it detaches from the old one, clears what the old one
 * brought in, and attaches to the new one. The same account signing in with Google (anonymous account becoming a Google
 * account, same uid) changes nothing, because nothing about who you are to your mates changed.
 */
import { onAuthStateChanged, type Auth } from "firebase/auth"
import type { Firestore } from "firebase/firestore"
import type { FriendRequest, Ping } from "./types"
import { watchPings, watchRequests } from "./social"

export interface IdentityHandlers {
  /** The account changed (null = signed out). Not called again for the same account. */
  onIdentity: (uid: string | null, anonymous: boolean) => void
  onRequests: (requests: FriendRequest[]) => void
  onPings: (pings: Ping[]) => void
  onError: (e: Error) => void
}

export function followIdentity({ auth, db }: { auth: Auth; db: Firestore }, h: IdentityHandlers): () => void {
  let current: string | null | undefined
  let detachers: Array<() => void> = []
  const detach = () => {
    detachers.forEach((f) => f())
    detachers = []
  }

  const stop = onAuthStateChanged(auth, (user) => {
    const uid = user?.uid ?? null
    if (uid === current) return
    detach()
    current = uid
    // Nothing the old identity brought in stays on screen
    h.onRequests([])
    h.onPings([])
    h.onIdentity(uid, user?.isAnonymous ?? true)
    if (!uid) return
    // A late callback from a listener that has just been replaced must not land on the new identity
    const mine = <T,>(fn: (v: T) => void) => (v: T) => {
      if (current === uid) fn(v)
    }
    detachers = [
      watchRequests(uid, mine(h.onRequests), mine(h.onError), db),
      watchPings(uid, mine(h.onPings), mine(h.onError), db),
    ]
  })

  return () => {
    stop()
    detach()
    current = undefined
  }
}
