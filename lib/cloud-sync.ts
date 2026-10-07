/**
 * Where synced data is kept, keyed by the signed-in account. In production that is Firestore (free Spark plan, see
 * firestore.rules). Until Firebase keys are added, development builds use a small route on the dev server
 * instead (app/api/dev-sync), so a laptop and a phone on the same Wi-Fi can already sync.
 */
import { doc, getDoc, onSnapshot, runTransaction } from "firebase/firestore"
import { db, firebaseConfigured } from "./firebase"
import { ensureSignedIn } from "./social"
import { resilient } from "./realtime"

/**
 * What is stored is the backup text, gzipped and base64'd ("gz1:" in front). Plain text from earlier versions is still
 * read. Compressing keeps one year of marks around 16 KB instead of ~470 KB, which is what keeps every sync and every
 * realtime update inside the free bandwidth, and keeps the document far below Firestore's 1 MiB limit.
 */
const GZ = "gz1:"

export async function pack(text: string): Promise<string> {
  if (typeof CompressionStream === "undefined") return text
  const bytes = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer())
  let bin = ""
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return GZ + btoa(bin)
}

export async function unpack(stored: string): Promise<string> {
  if (!stored.startsWith(GZ)) return stored
  if (typeof DecompressionStream === "undefined") throw new Error("this browser can't read the stored copy")
  const bin = atob(stored.slice(GZ.length))
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0))
  return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text()
}

export interface CloudDoc {
  /** A full backup (see lib/backup.ts) as text */
  data: string
  /** Counts up by one on every write. A write only lands if the sender has seen the latest one. */
  rev: number
  updatedAt: number
}

export type PutResult = { ok: true; rev: number } | { ok: false; reason: "conflict" | "unavailable" | "too-large" }

/** Firestore refuses documents over 1 MiB (1,048,576 bytes). Stay well under it, and under the 900,000-character cap in firestore.rules. */
export const DOC_LIMIT_BYTES = 800_000

/**
 * The size Firestore counts for the stored document: its name (each path part plus 1, plus 16), every field name (+1)
 * with its value (a string is its UTF-8 bytes + 1, a number is 8), and 32 for the document itself.
 */
export function firestoreDocBytes(owner: string, data: string): number {
  const utf8 = (s: string) => new TextEncoder().encode(s).length
  const name = utf8("syncs") + 1 + utf8(owner) + 1 + 16
  const fields = utf8("data") + 1 + utf8(data) + 1 + (utf8("rev") + 1 + 8) + (utf8("updatedAt") + 1 + 8)
  return name + fields + 32
}

export type CloudKind = "firebase" | "dev" | "none"

export const cloudKind = (): CloudKind =>
  firebaseConfigured() ? "firebase" : process.env.NODE_ENV !== "production" ? "dev" : "none"

export async function cloudGet(owner: string): Promise<CloudDoc | null> {
  const kind = cloudKind()
  if (kind === "firebase") {
    await ensureSignedIn()
    const snap = await getDoc(doc(db, "syncs", owner))
    if (!snap.exists()) return null
    const d = snap.data() as CloudDoc
    return { ...d, data: await unpack(d.data) }
  }
  if (kind === "dev") {
    const res = await fetch(`/api/dev-sync/${owner}`, { cache: "no-store" })
    if (res.status === 404) return null
    if (!res.ok) throw new Error("sync unavailable")
    const d = (await res.json()) as CloudDoc
    return { ...d, data: await unpack(d.data) }
  }
  throw new Error("sync unavailable")
}

/** Writes new data. expectedRev is the version the sender last saw (null when creating). */
export async function cloudPut(owner: string, text: string, expectedRev: number | null): Promise<PutResult> {
  const kind = cloudKind()
  try {
    const data = await pack(text)
    // Checked before any network call. Nothing is sent, and nothing on this device is touched.
    if (firestoreDocBytes(owner, data) > DOC_LIMIT_BYTES) return { ok: false, reason: "too-large" }
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

/**
 * Watches this account's one stored copy (one document, `syncs/{owner}`: never a collection) and calls onDoc whenever
 * another device changes it. If the listener dies it is restarted on its own, and `onLive` says whether it is running.
 * Without Firebase (development) the same document is checked every 15 seconds instead.
 */
export function watchCloud(owner: string, onDoc: (d: CloudDoc) => void, onLive: (live: boolean) => void): () => void {
  const kind = cloudKind()
  if (kind === "firebase") {
    return resilient(
      ({ ok, fail }) => {
        let off = () => {}
        let gone = false
        ensureSignedIn().then(
          () => {
            if (gone) return
            off = onSnapshot(
              doc(db, "syncs", owner),
              (snap) => {
                ok()
                if (!snap.exists()) return
                const d = snap.data() as CloudDoc
                unpack(d.data).then((data) => onDoc({ ...d, data }), () => {})
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
      (live) => onLive(live),
    )
  }
  if (kind === "dev") {
    onLive(true)
    const t = setInterval(() => void cloudGet(owner).then((d) => d && onDoc(d), () => onLive(false)), 15_000)
    return () => clearInterval(t)
  }
  return () => {}
}
