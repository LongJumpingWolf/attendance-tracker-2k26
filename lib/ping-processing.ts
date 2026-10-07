/**
 * Applying an answered Ping to your own data, so that its result can never be lost.
 *
 * The two stores involved (Firestore, and this device's IndexedDB) can't be changed in one step, so the order matters
 * and the Ping stays "answered" (not "processed") until the very end:
 *
 *   1. LEASE      take the lease on the answer (one device at a time; a lease that runs out can be taken over)
 *   2. APPLY      write the result into this device's data (idempotent, so doing it twice is harmless), and read it
 *                 back to be sure it is really saved
 *   3. FINALIZE   only now mark the Ping processed, for good
 *
 * A crash anywhere leaves the Ping answered, with the answer still on the server. The next run (this device straight
 * away, another one once the lease has run out) simply does it again, and the second time changes nothing. So a Ping is
 * never processed while its result has no way back: that is the invariant.
 */
import type { Ping } from "./types"

export type ProcessResult = "processed" | "not-leased" | "lease-failed" | "apply-failed" | "finalize-failed" | "busy"

export interface ProcessDeps {
  /** True when this device now holds the lease. May throw when the server can't be reached. */
  lease: (id: string) => Promise<boolean>
  /** Applies the answer to this device's data, saves it, and confirms by reading it back. False = not safely saved. */
  apply: (ping: Ping) => Promise<boolean>
  /** Marks the Ping processed on the server */
  finalize: (id: string) => Promise<unknown>
}

const running = new Set<string>()

export async function processAnswered(ping: Ping, deps: ProcessDeps): Promise<ProcessResult> {
  if (running.has(ping.id)) return "busy" // already being handled in this window: never two at once, whatever re-triggers us
  running.add(ping.id)
  try {
    let leased: boolean
    try {
      leased = await deps.lease(ping.id)
    } catch {
      return "lease-failed"
    }
    if (!leased) return "not-leased"

    let saved = false
    try {
      saved = await deps.apply(ping)
    } catch {
      saved = false
    }
    if (!saved) return "apply-failed" // still answered: tried again next time

    try {
      await deps.finalize(ping.id)
    } catch {
      return "finalize-failed" // applied and saved, just not marked: next time applies nothing new and finishes the job
    }
    return "processed"
  } finally {
    running.delete(ping.id)
  }
}
