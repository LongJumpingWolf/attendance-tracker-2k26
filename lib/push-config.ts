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
    return "This browser could not register for alerts after the app closes. You can still use local reminders while College Tracker is open. In Brave, enable Google services for push messaging in Privacy and security settings, then fully restart the browser and try again."
  }
  return "Background alert setup could not be completed on this device. Check browser notification permission and try again. Local reminders may still work while College Tracker is open."
}
