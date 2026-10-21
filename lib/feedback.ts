import { addDoc, collection, doc, getDocs, limit, orderBy, query, serverTimestamp, updateDoc, where } from "firebase/firestore"
import { getAuth } from "firebase/auth"
import { app, db, firebaseConfigured } from "./firebase"

export type FeedbackKind = "bug" | "rating" | "suggestion"
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

export async function getAdminFeedback() {
  const snap = await getDocs(query(collection(db, "feedback"), orderBy("createdAt", "desc")))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as FeedbackRecord))
}

export async function replyToFeedback(id: string, reply: string, resolved: boolean) {
  const text = reply.trim().slice(0, 2000)
  await updateDoc(doc(db, "feedback", id), {
    developerReply: text,
    status: resolved ? "resolved" : "replied",
    repliedAt: serverTimestamp(),
  })
}

export async function checkFeedbackReplies(uid: string): Promise<string[]> {
  const snap = await getDocs(query(collection(db, "feedback"), where("uid", "==", uid), limit(50)))
  const unread = snap.docs.filter((d) => d.data().developerReply && d.data().seenByUser !== true)
  if (!unread.length) return []
  await Promise.all(unread.map((d) => updateDoc(d.ref, { seenByUser: true })))
  return unread.map((d) => String(d.data().developerReply || "")).filter(Boolean)
}
