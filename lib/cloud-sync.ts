/**
 * Where synced data is kept, keyed by the signed-in account. In production that is Firestore (free Spark plan, see
 * firestore.rules). Until Firebase keys are added, development builds use a small route on the dev server
 * instead (app/api/dev-sync), so a laptop and a phone on the same Wi-Fi can already sync.
 */
import { doc, getDoc, runTransaction } from "firebase/firestore"
import { db, firebaseConfigured } from "./firebase"
import { ensureSignedIn } from "./social"

export interface CloudDoc {
  /** A full backup (see lib/backup.ts) as text */
  data: string
  /** Counts up by one on every write. A write only lands if the sender has seen the latest one. */
  rev: number
  updatedAt: number
}

export type PutResult = { ok: true; rev: number } | { ok: false; reason: "conflict" | "unavailable" }

export type CloudKind = "firebase" | "dev" | "none"

export const cloudKind = (): CloudKind =>
  firebaseConfigured() ? "firebase" : process.env.NODE_ENV !== "production" ? "dev" : "none"

export async function cloudGet(owner: string): Promise<CloudDoc | null> {
  const kind = cloudKind()
  if (kind === "firebase") {
    await ensureSignedIn()
    const snap = await getDoc(doc(db, "syncs", owner))
    return snap.exists() ? (snap.data() as CloudDoc) : null
  }
  if (kind === "dev") {
    const res = await fetch(`/api/dev-sync/${owner}`, { cache: "no-store" })
    if (res.status === 404) return null
    if (!res.ok) throw new Error("sync unavailable")
    return (await res.json()) as CloudDoc
  }
  throw new Error("sync unavailable")
}

/** Writes new data. expectedRev is the version the sender last saw (null when creating). */
export async function cloudPut(owner: string, data: string, expectedRev: number | null): Promise<PutResult> {
  const kind = cloudKind()
  try {
    if (kind === "firebase") {
      await ensureSignedIn()
      const ref = doc(db, "syncs", owner)
      return await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref)
        const rev = snap.exists() ? (snap.data().rev as number) : null
        if (rev !== expectedRev) return { ok: false, reason: "conflict" } as const
        const next = (rev ?? 0) + 1
        tx.set(ref, { data, rev: next, updatedAt: Date.now() })
        return { ok: true, rev: next } as const
      })
    }
    if (kind === "dev") {
      const res = await fetch(`/api/dev-sync/${owner}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data, expectedRev }),
      })
      if (res.status === 409) return { ok: false, reason: "conflict" }
      if (!res.ok) return { ok: false, reason: "unavailable" }
      return { ok: true, rev: ((await res.json()) as { rev: number }).rev }
    }
  } catch {
    /* offline or blocked */
  }
  return { ok: false, reason: "unavailable" }
}
