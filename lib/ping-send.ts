/**
 * Sending or answering a Ping needs the server. This runs the write only when the device is online, and never lets it
 * hang: offline returns at once (nothing is sent, nothing is queued), and a write that is still unconfirmed after
 * `ms` is reported as not confirmed. A caller shows a success screen only for `ok: true`.
 */
export const OFFLINE_MESSAGE = "You're offline. Ping wasn't sent."
export const SLOW_MESSAGE = "That is taking too long, so it isn't confirmed. Check your connection and try again."
export const FAILED_MESSAGE = "Couldn't send that. Try again."

export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: "offline" | "slow" | "failed"; message: string }

export async function attempt<T>(run: () => Promise<T>, opts: { online?: boolean; ms?: number } = {}): Promise<Attempt<T>> {
  const online = opts.online ?? (typeof navigator === "undefined" ? true : navigator.onLine !== false)
  if (!online) return { ok: false, reason: "offline", message: OFFLINE_MESSAGE } // `run` is never called
  let timer: ReturnType<typeof setTimeout> | undefined
  const slow = new Promise<"slow">((resolve) => {
    timer = setTimeout(() => resolve("slow"), opts.ms ?? 10_000)
  })
  const started = run()
  started.catch(() => {}) // a late failure after we gave up must not surface as an unhandled rejection
  try {
    const result = await Promise.race([started.then((value) => ({ value })), slow])
    if (result === "slow") return { ok: false, reason: "slow", message: SLOW_MESSAGE }
    return { ok: true, value: result.value }
  } catch {
    return { ok: false, reason: "failed", message: FAILED_MESSAGE }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
