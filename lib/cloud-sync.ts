/**
 * Where synced data is kept, keyed by the signed-in account. In production that is Firestore (free Spark plan, see
 * firestore.rules). Until Firebase keys are added, development builds use a small route on the dev server
 * instead (app/api/dev-sync), so a laptop and a phone on the same Wi-Fi can already sync.
 */
import { firebaseConfigured } from "./firebase"
import { getBackend } from "./backend"
import { DOC_LIMIT_BYTES, firestoreDocBytes } from "./backend/limits"

export { DOC_LIMIT_BYTES, firestoreDocBytes }

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

export type CloudKind = "firebase" | "dev" | "none"

export const cloudKind = (): CloudKind =>
  firebaseConfigured() ? "firebase" : process.env.NODE_ENV !== "production" ? "dev" : "none"

export async function cloudGet(owner: string): Promise<CloudDoc | null> {
  const kind = cloudKind()
  if (kind === "firebase") {
    const d = await getBackend().sync.get(owner)
    if (!d) return null
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
      return await getBackend().sync.put(owner, data, expectedRev)
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
    return getBackend().sync.watch(owner, {
      onData: (d) => {
        unpack(d.data).then((data) => onDoc({ ...d, data }), () => {})
      },
      onState: (live) => onLive(live),
    })
  }
  if (kind === "dev") {
    onLive(true)
    const t = setInterval(() => void cloudGet(owner).then((d) => d && onDoc(d), () => onLive(false)), 15_000)
    return () => clearInterval(t)
  }
  return () => {}
}
