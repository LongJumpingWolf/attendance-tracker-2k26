/**
 * Realtime is a nicety, never a dependency: the app reads and writes its own IndexedDB copy, and normal sync (on open,
 * on return to the app, on reconnect) works whether or not a listener is alive. This keeps a listener running for as
 * long as it can: when it fails it is restarted with a growing delay, and the caller is told whether it is live.
 */
type Start = (h: { ok: () => void; fail: (e: unknown) => void }) => () => void

/** Errors that retrying can't fix (signed out, not allowed): wait for a new sign-in instead of looping */
const hopeless = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code
  return code === "permission-denied" || code === "unauthenticated"
}

export function resilient(start: Start, onState?: (live: boolean, error?: unknown) => void): () => void {
  let stop: () => void = () => {}
  let timer: ReturnType<typeof setTimeout> | undefined
  let wait = 3000
  let dead = false

  const run = () => {
    if (dead) return
    try {
      stop = start({
        ok: () => {
          wait = 3000
          onState?.(true)
        },
        fail: (e) => {
          stop()
          onState?.(false, e)
          if (dead || hopeless(e)) return
          timer = setTimeout(run, wait)
          wait = Math.min(wait * 2, 120_000)
        },
      })
    } catch (e) {
      onState?.(false, e)
      if (!dead && !hopeless(e)) {
        timer = setTimeout(run, wait)
        wait = Math.min(wait * 2, 120_000)
      }
    }
  }
  run()

  return () => {
    dead = true
    if (timer) clearTimeout(timer)
    stop()
  }
}
