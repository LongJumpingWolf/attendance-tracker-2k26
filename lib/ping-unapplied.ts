import type { Ping } from "./types"
import type { ApplyOutcome } from "./ping-apply"
import { daysSince } from "./pings"

/** How long after the class day an answer that can't be applied yet is still waited for */
export const UNAPPLIED_GRACE_DAYS = 7

/**
 * A mate said "yes" to a class that this device could not find (the subject or its time slot is missing here). That is
 * usually a new browser, or one whose data hasn't synced yet, not a class that was removed on purpose. Marking such a
 * Ping processed would be permanent and the favour would never be applied anywhere, so it is left answered and tried
 * again later (the device that has the data, or this one after it syncs, will apply it). After the grace period the
 * class is taken as really gone and the Ping is let go, so a deleted subject doesn't keep it retrying forever.
 */
export function mustWaitToApply(ping: Ping, outcome: Pick<ApplyOutcome, "skipped">): boolean {
  const lost = outcome.skipped.some(
    (s) => (s.reason === "subject-missing" || s.reason === "class-missing") && ping.items.find((i) => i.key === s.key)?.answer === "yes",
  )
  return lost && daysSince(ping.date) <= UNAPPLIED_GRACE_DAYS
}
