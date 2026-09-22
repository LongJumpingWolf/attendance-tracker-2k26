/**
 * Class reminders: a small local schedule ("10 minutes before Biology on Mondays"). It lives in localStorage,
 * and each entry is also sent to the push server when the device has a push subscription.
 */
import type { Slot, Subject } from "./types"
import { formatTime, toMin } from "./attendance"
import { registerServiceWorker } from "./notifications"

export interface ScheduleEntry {
  id: string
  /** 0 = Sunday ... 6 = Saturday */
  day: number
  /** "HH:MM" (24h) */
  startTime: string
  endTime: string
  subjectName: string
  /** Minutes */
  notifyOffset: number
  /** before the class starts, or after it ends */
  notifyWhen: "before" | "after"
}

export const SCHEDULE_KEY = "notificationSchedule"
export const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
/** The week as shown on screen: Monday first */
export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]

export function loadSchedule(): ScheduleEntry[] {
  if (typeof window === "undefined") return []
  try {
    const raw = localStorage.getItem(SCHEDULE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveSchedule(list: ScheduleEntry[]) {
  try {
    localStorage.setItem(SCHEDULE_KEY, JSON.stringify(list))
  } catch {
    /* storage full or blocked: the in-memory list still works this session */
  }
}

/** The clock time the reminder goes off, as "h:mm AM/PM" */
export function notifyClock(e: Pick<ScheduleEntry, "startTime" | "endTime" | "notifyOffset" | "notifyWhen">) {
  const base = e.notifyWhen === "before" ? toMin(e.startTime) - e.notifyOffset : toMin(e.endTime) + e.notifyOffset
  const m = ((base % 1440) + 1440) % 1440
  return formatTime(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`)
}

/** "10 min before it starts" / "5 min after it ends" */
export const describeReminder = (e: Pick<ScheduleEntry, "notifyOffset" | "notifyWhen">) =>
  e.notifyOffset === 0
    ? e.notifyWhen === "before"
      ? "When it starts"
      : "When it ends"
    : `${e.notifyOffset} min ${e.notifyWhen === "before" ? "before it starts" : "after it ends"}`

/** One reminder per timetable slot, 10 minutes before each class starts */
export function entriesFromTimetable(subjects: Subject[], existing: ScheduleEntry[]): ScheduleEntry[] {
  const out: ScheduleEntry[] = []
  const stamp = Date.now()
  subjects.forEach((s, i) => {
    ;(s.slots ?? []).forEach((slot: Slot, j) => {
      const dup = existing.some((e) => e.subjectName === s.name && e.day === slot.day && e.startTime === slot.start)
      if (dup) return
      out.push({ id: `${stamp}-${i}-${j}`, day: slot.day, startTime: slot.start, endTime: slot.end, subjectName: s.name, notifyOffset: 10, notifyWhen: "before" })
    })
  })
  return out
}

/** VAPID public keys are url-safe base64; the push API wants raw bytes */
function keyToBytes(base64: string) {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(padded)
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

/** This device's web-push subscription: the existing one, or a new one when notifications are allowed and a VAPID key is set */
async function webPushSubscription(create: boolean): Promise<PushSubscription | null> {
  const sw = await registerServiceWorker()
  if (!sw?.pushManager) return null
  const existing = await sw.pushManager.getSubscription()
  if (existing || !create) return existing
  const key = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY
  if (!key || Notification.permission !== "granted") return null
  try {
    return await sw.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) as BufferSource })
  } catch {
    return null
  }
}

const post = (url: string, method: "POST" | "DELETE", body: unknown) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })

/**
 * Saves the entry on the push server so it can remind this device while the app is closed.
 * The app's own id is the key, so editing a reminder updates it instead of adding a copy.
 * Returns "pushed" when the server has it, "local" when this device has no push subscription
 * (the reminder still fires while the app is open), and "failed" when the server couldn't be reached.
 */
export async function syncPush(entry: ScheduleEntry): Promise<"pushed" | "local" | "failed"> {
  try {
    const subscription = await webPushSubscription(true)
    if (!subscription) return "local"

    await post("/api/notifications/subscribe", "POST", subscription)
    await post("/api/notifications/schedule", "POST", {
      subscriptionEndpoint: subscription.endpoint,
      clientId: entry.id,
      type: "subject",
      day: entry.day,
      startTime: entry.startTime,
      endTime: entry.endTime,
      notifyOffset: entry.notifyOffset,
      notifyWhen: entry.notifyWhen,
      payload: {
        subject: entry.subjectName,
        title: `Class reminder: ${entry.subjectName}`,
        body: `${entry.subjectName} starts at ${formatTime(entry.startTime)}`,
        data: { subject: entry.subjectName, day: entry.day, startTime: entry.startTime, endTime: entry.endTime },
      },
    })
    return "pushed"
  } catch {
    return "failed"
  }
}

/** Takes a deleted reminder off the push server too, so it stops firing */
export async function removePush(entry: Pick<ScheduleEntry, "id">): Promise<void> {
  try {
    const subscription = await webPushSubscription(false)
    if (subscription) await post("/api/notifications/schedule", "DELETE", { subscriptionEndpoint: subscription.endpoint, clientId: entry.id })
  } catch {
    /* the server copy is harmless if it can't be reached; it stops matching once the app is reinstalled */
  }
}
