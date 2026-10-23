import { addDoc, collection, doc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where, writeBatch } from "firebase/firestore"
import { getAuth } from "firebase/auth"
import { app, db, firebaseConfigured } from "./firebase"
import { devReplies, msOf, type FeedbackKind, type ThreadMessage } from "./feedback-threads"

export type { FeedbackKind } from "./feedback-threads"

export interface FeedbackRecord {
  id: string
  uid: string | null
  userEmail: string | null
  userName: string | null
  kind: FeedbackKind
  rating: number | null
  message: string
  imageData?: string
  status: "open" | "replied" | "resolved"
  developerReply?: string
  createdAt?: { toDate?: () => Date } | Date | null
  repliedAt?: unknown
  seenByUser?: boolean
  /** Who spoke last, and when: the developer's list uses it to find tickets waiting on them */
  lastFrom?: "user" | "developer"
  lastMessageAt?: unknown
  /** How many times the developer has answered (see devReplies in feedback-threads.ts for older tickets) */
  devReplyCount?: number
  /** How many messages the person has added after the first one */
  messageCount?: number
  /** The person's answer to "did the fix work?" */
  fixFeedback?: "up" | "down" | null
  ratingUpdatedAt?: unknown
  platform?: string
  deviceType?: string
  browser?: string
  area?: string
  frequency?: string
  network?: string
}

const MAX_IMAGE_DATA_URL = 380_000

/** Decode any browser-supported image and downscale/re-encode it before it leaves the device. */
export async function compressFeedbackImage(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image file.")
  if (typeof createImageBitmap !== "function") throw new Error("This browser cannot compress images. Try a smaller image or a modern browser.")
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement("canvas")
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) throw new Error("Could not prepare this image.")
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    for (const quality of [0.82, 0.72, 0.62, 0.52, 0.42, 0.32]) {
      const data = canvas.toDataURL("image/jpeg", quality)
      if (data.length <= MAX_IMAGE_DATA_URL) return data
    }
    throw new Error("This image could not be compressed enough. Try cropping it and attach it again.")
  } finally {
    bitmap.close()
  }
}

export interface BugDiagnostics {
  platform: string
  deviceType: string
  browser: string
  area: string
  frequency: string
  network: string
}

export async function submitFeedback(input: { kind: FeedbackKind; rating: number | null; message: string; imageData?: string; diagnostics?: BugDiagnostics }) {
  if (!firebaseConfigured()) throw new Error("Feedback sending is not configured in this build yet.")
  const authUser = getAuth(app).currentUser
  const message = input.message.trim().slice(0, 2000)
  if (!message && input.rating == null) throw new Error("Add a short note or choose a rating first.")
  if (input.rating != null && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)) throw new Error("Choose a rating from 1 to 5.")
  if (input.imageData && input.imageData.length > MAX_IMAGE_DATA_URL) throw new Error("The compressed image is still too large. Try another image.")
  const created = await addDoc(collection(db, "feedback"), {
    uid: authUser && !authUser.isAnonymous ? authUser.uid : null,
    userEmail: authUser && !authUser.isAnonymous ? authUser.email : null,
    userName: authUser && !authUser.isAnonymous ? authUser.displayName : null,
    kind: input.kind,
    rating: input.rating,
    message,
    ...(input.imageData ? { imageData: input.imageData } : {}),
    ...(input.kind === "bug" && input.diagnostics ? {
      platform: input.diagnostics.platform.slice(0, 40),
      deviceType: input.diagnostics.deviceType.slice(0, 40),
      browser: input.diagnostics.browser.slice(0, 60),
      area: input.diagnostics.area.slice(0, 80),
      frequency: input.diagnostics.frequency.slice(0, 40),
      network: input.diagnostics.network.slice(0, 40),
    } : {}),
    status: "open",
    seenByUser: false,
    createdAt: serverTimestamp(),
  })
  return created.id
}

const signedInUser = () => {
  const u = getAuth(app).currentUser
  return u && !u.isAnonymous ? u : null
}

const plain = (id: string, data: Record<string, unknown>) => ({ id, ...data } as FeedbackRecord)

/** Every ticket the signed-in person has sent, live. Rules only let this query return their own. */
export function watchMyTickets(uid: string, onData: (rows: FeedbackRecord[]) => void, onError: (e: Error) => void = () => {}) {
  return onSnapshot(query(collection(db, "feedback"), where("uid", "==", uid), limit(200)), (snap) => onData(snap.docs.map((d) => plain(d.id, d.data()))), onError)
}

/** The messages after the first reply on one ticket, live */
export function watchThread(id: string, onData: (messages: ThreadMessage[]) => void, onError: (e: Error) => void = () => {}) {
  return onSnapshot(query(collection(db, "feedback", id, "messages"), orderBy("createdAt", "asc")), (snap) => onData(snap.docs.map((d) => {
    const m = d.data()
    return { id: d.id, from: m.from === "developer" ? "developer" : "user", text: typeof m.text === "string" ? m.text : "", at: msOf(m.createdAt) ?? Date.now(), ...(typeof m.helpful === "boolean" ? { helpful: m.helpful } : {}) } as ThreadMessage
  })), onError)
}

/** The person has opened the developer's reply */
export async function markTicketSeen(id: string) {
  await updateDoc(doc(db, "feedback", id), { seenByUser: true })
}

/** The person adds a message to a ticket. Not allowed once it is closed (except notes on a rating). */
export async function sendUserMessage(ticket: Pick<FeedbackRecord, "id" | "messageCount">, text: string) {
  const clean = text.trim().slice(0, 1000)
  if (!clean) throw new Error("Write a message first.")
  const batch = writeBatch(db)
  batch.set(doc(collection(db, "feedback", ticket.id, "messages")), { from: "user", text: clean, createdAt: serverTimestamp() })
  batch.update(doc(db, "feedback", ticket.id), { status: "open", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: (ticket.messageCount ?? 0) + 1 })
  await batch.commit()
}

/** "Did the fix work?" Answered once, with an optional comment, even after the developer closed the ticket. */
export async function sendFixFeedback(ticket: Pick<FeedbackRecord, "id" | "messageCount">, helpful: boolean, comment: string) {
  const batch = writeBatch(db)
  batch.set(doc(collection(db, "feedback", ticket.id, "messages")), { from: "user", text: comment.trim().slice(0, 1000), helpful, createdAt: serverTimestamp() })
  batch.update(doc(db, "feedback", ticket.id), { fixFeedback: helpful ? "up" : "down", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: (ticket.messageCount ?? 0) + 1 })
  await batch.commit()
}

/**
 * One rating per account that can be changed later (its notes are ordinary messages, as many as the person likes).
 * Returns the ticket so a note can be added to it. Someone who isn't signed in rates once without an account.
 */
export async function saveRating(existing: FeedbackRecord | null, rating: number, note = ""): Promise<string> {
  if (!firebaseConfigured()) throw new Error("Feedback sending is not configured in this build yet.")
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new Error("Choose a rating from 1 to 5.")
  const user = signedInUser()
  if (!user) return submitFeedback({ kind: "rating", rating, message: note })
  let id: string
  if (existing) {
    await updateDoc(doc(db, "feedback", existing.id), { rating, ratingUpdatedAt: serverTimestamp() })
    id = existing.id
  } else {
    const ref = doc(db, "feedback", `rating-${user.uid}`)
    await setDoc(ref, { uid: user.uid, userEmail: user.email, userName: user.displayName, kind: "rating", rating, message: "", status: "open", seenByUser: false, createdAt: serverTimestamp() })
    id = ref.id
  }
  if (note.trim()) await sendUserMessage({ id, messageCount: existing?.messageCount ?? 0 }, note)
  return id
}

export async function getAdminFeedback() {
  const snap = await getDocs(query(collection(db, "feedback"), orderBy("createdAt", "desc")))
  return snap.docs.map((d) => plain(d.id, d.data()))
}

/**
 * The developer answers a ticket. The first answer lives on the ticket itself (so older tickets and the thank-you screen
 * work as before); later ones are messages. `close` also marks the ticket closed.
 */
export async function developerReplyTo(row: FeedbackRecord, text: string, close: boolean) {
  const reply = text.trim().slice(0, 2000)
  if (!reply) throw new Error("Write a short reply before sending it.")
  const count = devReplies(row)
  const status = close ? "resolved" : "replied"
  const common = { status, lastFrom: "developer", lastMessageAt: serverTimestamp(), devReplyCount: count + 1, seenByUser: false }
  if (count === 0) {
    await updateDoc(doc(db, "feedback", row.id), { ...common, developerReply: reply, repliedAt: serverTimestamp() })
    return
  }
  const batch = writeBatch(db)
  batch.set(doc(collection(db, "feedback", row.id, "messages")), { from: "developer", text: reply, createdAt: serverTimestamp() })
  batch.update(doc(db, "feedback", row.id), common)
  await batch.commit()
}

/** Close a ticket without saying anything, or open it again */
export async function setTicketClosed(row: FeedbackRecord, closed: boolean) {
  await updateDoc(doc(db, "feedback", row.id), { status: closed ? "resolved" : devReplies(row) > 0 ? "replied" : "open" })
}
