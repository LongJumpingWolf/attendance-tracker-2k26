/**
 * One lock for everything that replaces the data on this device wholesale: restoring a backup, restoring a restore point,
 * resetting, starting or ending the demo, and carrying out a sign-in choice. Two of them running at once would each save a
 * safety copy of, and then overwrite, what the other was in the middle of changing.
 *
 * It is a plain module-level holder (one tab, one JavaScript thread), taken synchronously, so there is no window between
 * "is anything running?" and "I am running". Whoever takes it must release it on success AND failure: `withLock` does that.
 */
let holder: string | null = null
const releaseListeners = new Set<() => void>()
let demoLive = false

export const BUSY_MESSAGE = "Another change to your data is still in progress. Try again in a moment."

/** Takes the lock, or returns null if someone holds it. The returned function releases it (once; later calls do nothing). */
export function tryAcquire(who: string): (() => void) | null {
  if (holder !== null) return null
  holder = who
  let released = false
  return () => {
    if (released) return
    released = true
    if (holder === who) {
      holder = null
      for (const fn of [...releaseListeners]) {
        try {
          fn()
        } catch {
          /* a listener must never stop the lock from being released */
        }
      }
    }
  }
}

/**
 * Calls `fn` every time the lock is released. Background sync uses it to retry the incoming data it set aside while a
 * replacement was running. Returns the function that stops listening.
 */
export function onRelease(fn: () => void): () => void {
  releaseListeners.add(fn)
  return () => void releaseListeners.delete(fn)
}

/**
 * Whether demo data is on screen RIGHT NOW. Set by the page in the same step that starts or ends the demo, so background sync
 * (whose `paused` option only changes on the next render) can never apply incoming data over a demo that has just started.
 */
export const setDemoLive = (on: boolean): void => {
  demoLive = on
}
export const isDemoLive = (): boolean => demoLive

/** Who holds the lock now, for messages and tests */
export const lockHolder = (): string | null => holder

/** Runs `job` holding the lock; `busy` is returned (job not run) if it is taken. Released even if `job` throws. */
export async function withLock<T, B>(who: string, job: () => Promise<T> | T, busy: () => B): Promise<T | B> {
  const release = tryAcquire(who)
  if (!release) return busy()
  try {
    return await job()
  } finally {
    release()
  }
}

/** Test helper: forget any holder (a test that fails midway must not leak the lock into the next one) */
export function resetLockForTests(): void {
  holder = null
  demoLive = false
  releaseListeners.clear()
}
