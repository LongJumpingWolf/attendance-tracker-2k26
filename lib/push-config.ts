/** Public Web Push configuration. Some local environments use the legacy env name. */
export function resolveFirebaseVapidKey(primary?: string | null, legacy?: string | null): string | null {
  const value = (primary || legacy || "").trim()
  return value.length > 0 ? value : null
}

export function isPushServiceUnavailable(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const e = error as { name?: unknown; message?: unknown }
  return e.name === "AbortError" || (typeof e.message === "string" && /push service error|registration failed/i.test(e.message))
}

export function pushSetupMessage(error: unknown): string {
  if (isPushServiceUnavailable(error)) {
    return "This browser could not register for remote push notifications. In Brave, open brave://settings/privacy, enable “Use Google services for push messaging”, then fully restart Brave. Also verify the Firebase Web Push public VAPID key is set in .env.local. Attendance and friend connections can still work; local reminders may work while the app is open."
  }
  const e = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {}
  if (typeof e.code === "string" && e.code === "messaging/unsupported-browser") {
    return "This browser does not support Firebase push messaging. Local attendance reminders may still work while the app is open."
  }
  return typeof e.message === "string" && e.message ? e.message : "Remote push notification setup failed. Check the browser console for the error code."
}
