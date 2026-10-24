"use client"

import { collection, doc, getDocs, limit, orderBy, query, serverTimestamp, setDoc, startAfter, Timestamp, where, writeBatch, type QueryDocumentSnapshot } from "firebase/firestore"
import { getAuth } from "firebase/auth"
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

export type UsageDeviceType = "phone_tablet" | "desktop" | "unknown"
export type UsageBrowserFamily = "Chrome" | "Safari" | "Edge" | "Firefox" | "Samsung Internet" | "Opera" | "Other"

export interface ProductUsageEvent {
  id: string
  actorUid: string
  sessionId: string
  event: UsageEventName
  screen: UsageScreen
  /** Random first-party browser-storage ID; it is not a hardware identifier. */
  visitorId?: string
  /** Coarse, derived categories only. The raw user-agent string is never stored. */
  deviceType?: UsageDeviceType
  browserFamily?: UsageBrowserFamily
  createdAt: { toDate?: () => Date } | Date | null
}

const randomHex = () => {
  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") return ""
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}
let memorySessionId = ""
let memoryVisitorId = ""
const fallbackDedup = new Set<string>()

function getVisitorId() {
  try {
    const saved = localStorage.getItem("attendance-analytics-visitor-id")
    if (saved && /^[a-f0-9]{32}$/.test(saved)) return saved
    const id = randomHex()
    if (id) localStorage.setItem("attendance-analytics-visitor-id", id)
    return id
  } catch {
    if (!memoryVisitorId) memoryVisitorId = randomHex()
    return memoryVisitorId
  }
}

function getCoarseDeviceType(): UsageDeviceType {
  if (typeof window === "undefined" || typeof navigator === "undefined") return "unknown"
  return window.matchMedia?.("(pointer: coarse)").matches ? "phone_tablet" : "desktop"
}

function getBrowserFamily(): UsageBrowserFamily {
  if (typeof navigator === "undefined") return "Other"
  const ua = navigator.userAgent
  if (/SamsungBrowser\//i.test(ua)) return "Samsung Internet"
  if (/(EdgA?|EdgiOS|Edg)\//i.test(ua)) return "Edge"
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return "Opera"
  if (/Firefox\//i.test(ua) || /FxiOS\//i.test(ua)) return "Firefox"
  if (/CriOS\//i.test(ua) || /Chrome\//i.test(ua)) return "Chrome"
  if (/Safari\//i.test(ua) || /Version\//i.test(ua)) return "Safari"
  return "Other"
}

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
 * Optional, high-level usage analytics, collected only after the existing opt-in.
 * It records a pseudonymous Firebase UID, random tab-session ID, random first-party
 * browser-storage ID, coarse device/browser categories, an allowlisted event/screen,
 * and server timestamp. It never stores raw user-agent, IP, precise location, titles,
 * attendance values/dates, free text, emails, or hardware fingerprints.
 */
export async function recordProductUsageEvent(event: UsageEventName, screen: UsageScreen): Promise<boolean> {
  try {
    if (typeof window === "undefined") return false
    if (localStorage.getItem(USAGE_ANALYTICS_KEY) !== "1") {
      try { localStorage.removeItem("attendance-analytics-visitor-id") } catch {}
      return false
    }
    if (localStorage.getItem(TERMS_KEY) !== "1") return false
    const user = getAuth(app).currentUser
    if (!user?.uid || user.uid.length > 128) return false

    const sessionId = getSessionId()
    const visitorId = getVisitorId()
    const deviceType = getCoarseDeviceType()
    const browserFamily = getBrowserFamily()
    const id = randomHex()
    if (!sessionId || !visitorId || !id) return false

    const dedupKey = event === "app_open"
      ? `attendance-usage-opened:${sessionId}`
      : event === "screen_view"
        ? `attendance-usage-last-screen:${sessionId}`
        : ""

    // The marker is set before the save so two calls at the same moment (React running an effect twice) count once, and put
    // back if the save fails, so an open made while offline is counted when it next happens instead of never.
    let previous = ""
    if (dedupKey) {
      try { previous = sessionStorage.getItem(dedupKey) || "" } catch { previous = fallbackDedup.has(dedupKey) ? screen : "" }
      if ((event === "app_open" && previous === "1") || (event === "screen_view" && previous === screen)) return false
      try { sessionStorage.setItem(dedupKey, event === "app_open" ? "1" : screen) } catch { fallbackDedup.add(dedupKey) }
    }
    const undoMarker = () => {
      if (!dedupKey) return
      try { if (previous) sessionStorage.setItem(dedupKey, previous); else sessionStorage.removeItem(dedupKey) } catch { fallbackDedup.delete(dedupKey) }
    }

    try {
      await setDoc(doc(db, "productUsageEvents", id), {
        actorUid: user.uid,
        sessionId,
        visitorId,
        deviceType,
        browserFamily,
        event,
        screen,
        createdAt: serverTimestamp(),
      })
      return true
    } catch (writeError) {
      // Older published rules allow only the legacy schema. Retry that safe,
      // minimal shape so analytics does not stop working while rules are updated.
      const code = writeError && typeof writeError === "object" && "code" in writeError
        ? String((writeError as { code?: unknown }).code || "")
        : ""
      if (code !== "permission-denied") {
        undoMarker()
        return false
      }
      try {
        await setDoc(doc(db, "productUsageEvents", id), {
          actorUid: user.uid,
          sessionId,
          event,
          screen,
          createdAt: serverTimestamp(),
        })
        return true
      } catch {
        undoMarker()
        return false
      }
    }
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

/** The most events the dashboard loads in one go (read in pages of USAGE_PAGE). Past this the oldest are left out and the page says so. */
export const USAGE_EVENT_LIMIT = 20000
const USAGE_PAGE = 2000

/** Developer-only query; the matching Firestore rule enforces access on the server. */
export async function getDeveloperProductUsageEvents(): Promise<{ events: ProductUsageEvent[]; truncated: boolean }> {
  const cutoff = Timestamp.fromMillis(Date.now() - 90 * 24 * 60 * 60 * 1000)
  for (let i = 0; i < 20; i++) {
    const old = await getDocs(query(collection(db, "productUsageEvents"), where("createdAt", "<", cutoff), orderBy("createdAt", "asc"), limit(400)))
    if (old.empty) break
    const batch = writeBatch(db)
    old.docs.forEach((row) => batch.delete(row.ref))
    await batch.commit()
    if (old.size < 400) break
  }
  const docs: QueryDocumentSnapshot[] = []
  let truncated = false
  let last: QueryDocumentSnapshot | undefined
  while (docs.length < USAGE_EVENT_LIMIT) {
    const page = await getDocs(
      last
        ? query(collection(db, "productUsageEvents"), orderBy("createdAt", "desc"), startAfter(last), limit(USAGE_PAGE))
        : query(collection(db, "productUsageEvents"), orderBy("createdAt", "desc"), limit(USAGE_PAGE)),
    )
    docs.push(...page.docs)
    if (page.size < USAGE_PAGE) break
    last = page.docs[page.size - 1]
    if (docs.length >= USAGE_EVENT_LIMIT) truncated = true
  }
  const events = docs.map((row) => {
    const d = row.data()
    return {
      id: row.id,
      actorUid: String(d.actorUid ?? ""),
      sessionId: String(d.sessionId ?? ""),
      visitorId: typeof d.visitorId === "string" && /^[a-f0-9]{32}$/.test(d.visitorId) ? d.visitorId : undefined,
      deviceType: ["phone_tablet", "desktop", "unknown"].includes(d.deviceType) ? d.deviceType as UsageDeviceType : undefined,
      browserFamily: ["Chrome", "Safari", "Edge", "Firefox", "Samsung Internet", "Opera", "Other"].includes(d.browserFamily) ? d.browserFamily as UsageBrowserFamily : undefined,
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
  return { events, truncated }
}
