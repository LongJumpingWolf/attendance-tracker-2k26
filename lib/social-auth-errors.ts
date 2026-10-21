/** Turn Firebase Authentication failures into actionable messages without exposing credentials or raw request URLs. */
export function describeSocialAuthError(error: unknown): string {
  const value = error && typeof error === "object" ? error as { code?: unknown; message?: unknown } : {}
  const code = typeof value.code === "string" ? value.code : ""
  const message = typeof value.message === "string" ? value.message : String(error ?? "")

  if (/operation-not-allowed|admin-restricted-operation/i.test(`${code} ${message}`)) {
    return "Anonymous sign-in is disabled in this Firebase project. Enable Authentication → Sign-in method → Anonymous, then restart the local app."
  }
  if (/invalid-api-key|api-key-not-valid|app-not-authorized/i.test(`${code} ${message}`)) {
    return "Firebase rejected this app's API key. Check that .env.local uses the API key and project ID from the same Firebase project, then restart npm run dev."
  }
  if (/unauthorized-domain/i.test(`${code} ${message}`)) {
    return "Firebase rejected localhost as an auth domain. In Firebase Authentication → Settings → Authorized domains, make sure localhost is listed."
  }
  if (/network-request-failed|network error|failed to fetch|offline/i.test(`${code} ${message}`)) {
    return "The browser could not reach Firebase Authentication. Check internet access, extensions/ad blockers, and the browser Network panel."
  }
  if (/too-many-requests/i.test(`${code} ${message}`)) {
    return "Firebase temporarily rate-limited sign-in attempts. Wait a few minutes before trying again."
  }
  if (/timed out|taking too long/i.test(message)) {
    return "Firebase sign-in did not finish within 10 seconds. On localhost, check .env.local and remove NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST / NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST unless both emulators are running. Restart the dev server after changing environment variables."
  }
  return message || "Firebase sign-in failed. Check the local Firebase configuration and try again."
}
