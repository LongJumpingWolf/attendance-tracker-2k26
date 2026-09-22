import { classesOn, markFor, toMin, localDate, type ClassSlot } from "./attendance"
import type { Subject } from "./types"

/** How far around a class a scan still counts for it, in minutes */
export const JUST_ENDED_MINUTES = 20
export const STARTING_SOON_MINUTES = 15

export type ScanResult =
  /** Exactly one class fits: mark it present */
  | { kind: "mark"; target: ClassSlot }
  /** The fitting class already has a mark */
  | { kind: "already"; target: ClassSlot; status: "P" | "A" }
  /** Unsure, so the person picks (overlapping classes, or none around this time) */
  | { kind: "choose"; options: ClassSlot[]; reason: "several" | "none" }
  /** There is nothing to mark today */
  | { kind: "idle"; reason: "no-subjects" | "no-classes" | "all-marked" }

/**
 * Which class does a scan at this moment mean? The rules, in order:
 *  1. A class in progress.
 *  2. Otherwise one that ended in the last 20 minutes (you scanned on the way out).
 *  3. Otherwise one starting within 15 minutes (you scanned on the way in).
 * Within a rule, classes that already have a mark are set aside; if exactly one is left it is marked, if several are
 * left the person chooses, and if all of them are marked the scan says so instead of marking twice.
 * Nothing near this time: unmarked classes from today are offered, never guessed.
 */
export function pickScanTarget(subjects: Subject[], now: Date): ScanResult {
  if (subjects.length === 0) return { kind: "idle", reason: "no-subjects" }
  const today = localDate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const all = classesOn(subjects, now)
  if (all.length === 0) return { kind: "idle", reason: "no-classes" }

  const statusOf = (c: ClassSlot) => markFor(c.subject, today, c.slot.start)
  const tiers: ((c: ClassSlot) => boolean)[] = [
    (c) => toMin(c.slot.start) <= nowMin && nowMin < toMin(c.slot.end),
    (c) => toMin(c.slot.end) <= nowMin && nowMin < toMin(c.slot.end) + JUST_ENDED_MINUTES,
    (c) => toMin(c.slot.start) > nowMin && toMin(c.slot.start) - nowMin <= STARTING_SOON_MINUTES,
  ]

  for (const fits of tiers) {
    const hits = all.filter(fits)
    if (hits.length === 0) continue
    const open = hits.filter((c) => statusOf(c) === null)
    if (open.length === 1) return { kind: "mark", target: open[0] }
    if (open.length > 1) return { kind: "choose", options: open, reason: "several" }
    return { kind: "already", target: hits[0], status: statusOf(hits[0]) as "P" | "A" }
  }

  const open = all.filter((c) => statusOf(c) === null)
  if (open.length === 0) return { kind: "idle", reason: "all-marked" }
  return { kind: "choose", options: open, reason: "none" }
}
