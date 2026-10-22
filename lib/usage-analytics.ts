"use client"

import { collection, doc, getAuth, getDocs, limit, orderBy, query, serverTimestamp, setDoc, Timestamp, where, writeBatch } from "firebase/firestore"
import { app, db } from "@/lib/firebase"

export const USAGE_ANALYTICS_KEY = "attendance-usage-analytics-consent"
const TERMS_KEY = "attendance-terms-consent-v3"

export type UsageScreen = "today" | "subjects" | "calendar" | "mates" | "settings" | "scanner"
export type UsageEventName =
  | "app_open"
  | "screen_view"
  | "settings_open"
  | "attendance_mark"
  | "attendance_clear"
  | "scan_checkin"
  | "subject_create"
  | "subject_update"
  | "subject_delete"
  | "task_create"
  | "task_update"
  | "task_complete"
  | "task_reopen"
  | "task_delete"

export interface ProductUsageEvent {
  id: string
  actorUid: string
  sessionId: string
  event: UsageEventName
  screen: UsageScreen
  createdAt: { toDate?: () => Date } | Date | null
}

const randomHex = () => {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") return ""
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
let memorySessionId = ""
const fallbackDedup = new Set<string>()

function getSessionId() {
  try {
    const saved = sessionStorage.getItem("attendance-usage-session-id")
    if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved
    const id = randomHex()
    if (id) sessionStorage.setItem("attendance-usage-session-id", id)
    return id
  } catch {
    if (!memorySessionId) memorySessionId = randomHex()
    return memorySessionId
  }
}

/**
 * Optional, high-level usage analytics. It records only a pseudonymous Firebase UID,
 * random tab-session ID, an allowlisted event and screen name, and a server timestamp.
 * It intentionally never receives subject/task names, attendance values or dates,
 * free text, email, location, IP address, or device/browser fingerprints.
 */
export async function recordProductUsageEvent(event: UsageEventName, screen: UsageScreen): Promise<boolean> {
  try {
    if (typeof window === "undefined") return false
    if (localStorage.getItem(TERMS_KEY) !== "1" || localStorage.getItem(USAGE_ANALYTICS_KEY) !== "1") return false
    const user = getAuth(app).currentUser
    if (!user?.uid || user.uid.length > 128) return false

    const sessionId = getSessionId()
    const id = randomHex()
    if (!sessionId || !id) return false

    const dedupKey = event === "app_open"
      ? `attendance-usage-opened:${sessionId}`
      : event === "screen_view"
        ? `attendance-usage-last-screen:${sessionId}`
        : ""

    if (dedupKey) {
      let previous = ""
      try { previous = sessionStorage.getItem(dedupKey) || "" } catch { previous = fallbackDedup.has(dedupKey) ? screen : "" }
      if ((event === "app_open" && previous === "1") || (event === "screen_view" && previous === screen)) return false
      try { sessionStorage.setItem(dedupKey, event === "app_open" ? "1" : screen) } catch { fallbackDedup.add(dedupKey) }
    }

    await setDoc(doc(db, "productUsageEvents", id), {
      actorUid: user.uid,
      sessionId,
      event,
      screen,
      createdAt: serverTimestamp(),
    })
    return true
  } catch {
    // Analytics must never interrupt attendance, task, or timetable operations.
    return false
  }
}

const dateVal = (v: unknown): ProductUsageEvent["createdAt"] => {
  if (v instanceof Date) return v
  if (v && typeof v === "object" && "toDate" in v && typeof v.toDate === "function") return v as { toDate: () => Date }
  return null
}

/** Developer-only query; the matching Firestore rule enforces access on the server. */
export async function getDeveloperProductUsageEvents(): Promise<ProductUsageEvent[]> {
  const cutoff = Timestamp.fromMillis(Date.now() - 90 * 24 * 60 * 60 * 1000)
  for (let i = 0; i < 20; i++) {
    const old = await getDocs(query(collection(db, "productUsageEvents"), where("createdAt", "<", cutoff), orderBy("createdAt", "asc"), limit(400)))
    if (old.empty) break
    const batch = writeBatch(db)
    old.docs.forEach((row) => batch.delete(row.ref))
    await batch.commit()
    if (old.size < 400) break
  }
  const snap = await getDocs(query(collection(db, "productUsageEvents"), orderBy("createdAt", "desc"), limit(3000)))
  return snap.docs.map((row) => {
    const d = row.data()
    return {
      id: row.id,
      actorUid: String(d.actorUid ?? ""),
      sessionId: String(d.sessionId ?? ""),
      event: d.event as UsageEventName,
      screen: d.screen as UsageScreen,
      createdAt: dateVal(d.createdAt),
    }
  }).filter((e) =>
    /^[a-f0-9]{32}$/.test(e.id)
    && /^[A-Za-z0-9_-]{1,128}$/.test(e.actorUid)
    && /^[a-f0-9]{32}$/.test(e.sessionId)
    && ["app_open", "screen_view", "settings_open", "attendance_mark", "attendance_clear", "scan_checkin", "subject_create", "subject_update", "subject_delete", "task_create", "task_update", "task_complete", "task_reopen", "task_delete"].includes(e.event)
    && ["today", "subjects", "calendar", "mates", "settings", "scanner"].includes(e.screen)
  )
}
