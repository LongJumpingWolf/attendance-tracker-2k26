/**
 * What a Ping's answer does to your own data, and exactly when it counts as a favour.
 *
 * It is a pure function, safe to run any number of times with the same Ping (after a crash, a reload, or on another
 * device): the result of running it twice is the result of running it once.
 *
 *   A "yes" on a class that is Absent or not marked yet  ->  the class becomes Present (credited to the mate) and that
 *                                                            is ONE favour, recorded under the Ping's id.
 *   A "yes" on a class that is already Present          ->  nothing changes, no favour.
 *   A "yes" on a class that no longer exists            ->  nothing changes, no favour (the subject was deleted, or
 *                                                            its timetable no longer has that class).
 *   A "yes" that was already applied                    ->  skipped, whatever has happened to the class since.
 *   A "no"                                              ->  nothing changes.
 */
import type { Mate, Ping, Subject } from "./types"
import { markFor, withSet } from "./attendance"

/** One favour per class a Ping helped. The date is part of the entry so a merge can undo a double count. */
export const favourId = (ping: Pick<Ping, "id" | "date">, itemKey: string) => `${ping.date}|${ping.id}:${itemKey}`

export type SkipReason = "no" | "already-applied" | "subject-missing" | "class-missing" | "already-present"

export interface ApplyOutcome {
  subjects: Subject[]
  mates: Mate[]
  /** Favour entries created by this run */
  helped: string[]
  /** Classes that must read Present afterwards (helped now, or already Present), to check the result really was saved */
  expectPresent: { subjectId: string; date: string; t: string }[]
  skipped: { key: string; reason: SkipReason }[]
}

const norm = (s: string) => s.trim().toLowerCase()

/** The mate this Ping came from: by account, or an unconnected row with the same name (which then takes the account) */
function findMate(mates: Mate[], ping: Ping) {
  const byUid = mates.findIndex((m) => m.uid === ping.to)
  if (byUid !== -1) return byUid
  return mates.findIndex((m) => !m.uid && norm(m.name) === norm(ping.toName))
}

export function applyPingResult(subjects: Subject[], mates: Mate[], ping: Ping): ApplyOutcome {
  const at = findMate(mates, ping)
  const already = new Set(at !== -1 ? (mates[at].coveredPings ?? []) : [])
  let nextSubjects = subjects
  const helped: string[] = []
  const expectPresent: ApplyOutcome["expectPresent"] = []
  const skipped: ApplyOutcome["skipped"] = []

  for (const item of ping.items) {
    if (item.answer !== "yes") {
      skipped.push({ key: item.key, reason: "no" })
      continue
    }
    const id = favourId(ping, item.key)
    const t = item.t ?? ""
    if (already.has(id)) {
      skipped.push({ key: item.key, reason: "already-applied" })
      expectPresent.push({ subjectId: item.subjectId, date: ping.date, t })
      continue
    }
    const subject = nextSubjects.find((s) => s.id === item.subjectId)
    if (!subject) {
      skipped.push({ key: item.key, reason: "subject-missing" })
      continue
    }
    const slot = item.t ? subject.slots?.find((x) => x.start === item.t) : undefined
    if (item.t && !slot) {
      skipped.push({ key: item.key, reason: "class-missing" })
      continue
    }
    if (markFor(subject, ping.date, t) === "P") {
      skipped.push({ key: item.key, reason: "already-present" })
      expectPresent.push({ subjectId: subject.id, date: ping.date, t })
      continue
    }
    nextSubjects = nextSubjects.map((s) => (s.id === subject.id ? withSet(s, ping.date, "P", { ...(item.t ? { t: item.t } : {}), ...(slot?.kind ? { k: slot.kind } : {}), by: ping.toName }) : s))
    helped.push(id)
    expectPresent.push({ subjectId: subject.id, date: ping.date, t })
  }

  let nextMates = mates
  if (helped.length > 0) {
    const bump = (m: Mate): Mate => ({
      ...m,
      uid: m.uid ?? ping.to,
      covered: m.covered + helped.length,
      coveredLog: [...(m.coveredLog ?? []), ...helped.map(() => ping.date)],
      coveredPings: [...(m.coveredPings ?? []), ...helped],
    })
    nextMates =
      at === -1
        ? [...mates, bump({ id: ping.to, uid: ping.to, name: ping.toName, covered: 0, repaid: 0 })]
        : mates.map((m, i) => (i === at ? bump(m) : m))
  }
  return { subjects: nextSubjects, mates: nextMates, helped, expectPresent, skipped }
}

/** Reads back what was actually saved and checks the result is really there. Finalizing waits for this to be true. */
export function resultIsSaved(saved: { subjects: Subject[]; mates: Mate[] }, outcome: Pick<ApplyOutcome, "helped" | "expectPresent">, ping: Ping): boolean {
  for (const e of outcome.expectPresent) {
    const s = saved.subjects.find((x) => x.id === e.subjectId)
    if (!s || markFor(s, e.date, e.t) !== "P") return false
  }
  if (outcome.helped.length === 0) return true
  const m = saved.mates.find((x) => x.uid === ping.to) ?? saved.mates.find((x) => !x.uid && norm(x.name) === norm(ping.toName))
  const have = new Set(m?.coveredPings ?? [])
  return outcome.helped.every((id) => have.has(id))
}
