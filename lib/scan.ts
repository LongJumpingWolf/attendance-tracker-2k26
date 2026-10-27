import { classesOn, markFor, toMin, localDate, type ClassSlot } from "./attendance"
import type { ScheduleOverride, Subject } from "./types"

/** How far around a class a scan still counts for it, in minutes */
export const JUST_ENDED_MINUTES = 20
export const STARTING_SOON_MINUTES = 15

export type ScanResult =
  /** Exactly one class fits: mark it present */
  | { kind: "mark"; target: ClassSlot }
  /** The fitting class already has a mark */
  | { kind: "already"; target: ClassSlot; status: "P" | "A" }
  /** Unsure, so the person picks instead of guessing */
  | { kind: "choose"; options: ClassSlot[]; reason: "several" | "ambiguous" | "none" }
  /** There is nothing to mark today */
  | { kind: "idle"; reason: "no-subjects" | "no-classes" | "all-marked" }

/**
 * Which class does a scan at this moment mean?
 * 1. A class currently in progress.
 * 2. Otherwise, one that ended in the last 20 minutes.
 * 3. Otherwise, one starting within 15 minutes.
 *
 * Important safety fallback: if the "just ended" and "starting soon" windows overlap, we
 * cannot tell whether a tap is for the class someone is leaving or the one they are entering.
 * Ask them to confirm instead of silently marking the recently-ended class.
 *
 * A single fitting slot can be marked automatically. If multiple slots fit the same window,
 * require confirmation even when only one is unmarked: the tap could be a repeat for the class
 * already marked. Already-marked classes are never counted twice. If no time window fits,
 * today's unmarked classes are offered.
 */
export function pickScanTarget(subjects: Subject[], now: Date, overrides: ScheduleOverride[] = []): ScanResult {
  if (subjects.length === 0) return { kind: "idle", reason: "no-subjects" }
  const today = localDate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const all = classesOn(subjects, now, overrides).filter((entry) => !entry.cancelled)
  if (all.length === 0) return { kind: "idle", reason: "no-classes" }

  const statusOf = (c: ClassSlot) => markFor(c.attendanceSubject ?? c.subject, today, c.slot.start)
  const decide = (hits: ClassSlot[]): ScanResult => {
    const open = hits.filter((c) => statusOf(c) === null)
    if (open.length === 0) return { kind: "already", target: hits[0], status: statusOf(hits[0]) as "P" | "A" }
    // Multiple fitting slots remain ambiguous even if only one is unmarked. A repeat tap for
    // an already-marked overlapping class must not automatically mark a different class.
    if (hits.length > 1) return { kind: "choose", options: open, reason: "several" }
    return { kind: "mark", target: open[0] }
  }

  // An in-progress class is a strong signal and always takes priority over adjacent windows.
  const inProgress = all.filter((c) => toMin(c.slot.start) <= nowMin && nowMin < toMin(c.slot.end))
  if (inProgress.length > 0) return decide(inProgress)

  const justEnded = all.filter((c) => toMin(c.slot.end) <= nowMin && nowMin < toMin(c.slot.end) + JUST_ENDED_MINUTES)
  const startingSoon = all.filter((c) => toMin(c.slot.start) > nowMin && toMin(c.slot.start) - nowMin <= STARTING_SOON_MINUTES)

  // A tap could mean the class that recently ended OR the one starting shortly. Do not silently
  // award attendance to either; show the unmarked choices, even when only one remains unmarked.
  if (justEnded.length > 0 && startingSoon.length > 0) {
    const candidates = [...justEnded, ...startingSoon]
    const open = candidates.filter((c) => statusOf(c) === null)
    if (open.length > 0) return { kind: "choose", options: open, reason: "ambiguous" }
    // Everything in both windows is already marked. There is no new attendance to record.
    return decide(justEnded)
  }

  if (justEnded.length > 0) return decide(justEnded)
  if (startingSoon.length > 0) return decide(startingSoon)

  const open = all.filter((c) => statusOf(c) === null)
  if (open.length === 0) return { kind: "idle", reason: "all-marked" }
  return { kind: "choose", options: open, reason: "none" }
}
/** Stable identity for a specific timetable slot, including substituted classes. */
export const scanTargetKey = (target: ClassSlot): string =>
  `${(target.attendanceSubject ?? target.subject).id}@${target.slot.start}`

export interface ScanReview {
  /** The same timing decision the scanner already uses */
  result: ScanResult
  /** Every unchecked, non-cancelled class scheduled for today, in timetable order */
  options: ClassSlot[]
  /** The unique algorithm-selected class, preselected but not marked until the person confirms */
  suggested: ClassSlot | null
}

/**
 * Prepare the scan review screen without changing attendance. The timing algorithm's unique
 * target is suggested by default, but all other unchecked classes today are available so users
 * can recover missed check-ins in the same scan. Ambiguous timing never preselects a class.
 */
export function prepareScanReview(subjects: Subject[], now: Date, overrides: ScheduleOverride[] = []): ScanReview {
  const result = pickScanTarget(subjects, now, overrides)
  const date = localDate(now)
  const options = classesOn(subjects, now, overrides)
    .filter((entry) => !entry.cancelled && markFor(entry.attendanceSubject ?? entry.subject, date, entry.slot.start) === null)
  const suggested = result.kind === "mark" ? result.target : null

  // Normally the suggested target is already in today's unchecked list. Keep it as a defensive
  // fallback if schedule normalization ever returns a target that isn't present in that list.
  if (suggested && !options.some((entry) => scanTargetKey(entry) === scanTargetKey(suggested))) {
    options.push(suggested)
    options.sort((a, b) => toMin(a.slot.start) - toMin(b.slot.start) || a.subject.name.localeCompare(b.subject.name))
  }

  return { result, options, suggested }
}

