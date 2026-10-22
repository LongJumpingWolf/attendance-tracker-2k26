/** One marked class: date (YYYY-MM-DD) and P(resent) / A(bsent) */
export interface LogEntry {
  d: string
  s: "P" | "A"
  /** Class start time ("HH:MM") when marked from a timetable slot */
  t?: string
  /** Class type, e.g. Lecture or Practical */
  k?: string
  /** Name of the mate who covered this class for you (a confirmed cover) */
  by?: string
}

/** A weekly class slot. day: 0 = Sunday ... 6 = Saturday, times are "HH:MM" (24h) */
export interface Slot {
  day: number
  start: string
  end: string
  /** Lecture, Practical, Tutorial ... */
  kind?: string
}

export interface Subject {
  id: string
  name: string
  attended: number
  missed: number
  requirement: number
  glowColor: string
  tags: string[]
  /** Optional weekly timetable */
  slots?: Slot[]
  /** History of marks made in the app (counts above stay the source of truth) */
  log?: LogEntry[]
  /** Planned future lectures: date -> attend / skip */
  plan?: Record<string, "attend" | "skip">
  /** Hide recurring classes without deleting the subject or attendance history. */
  sleeping?: boolean
  /** Inclusive local YYYY-MM-DD wake date, or "forever". Missing with sleeping=true means forever for legacy safety. */
  sleepUntil?: string | "forever"
  /** Inclusive local YYYY-MM-DD start date for a scheduled sleep. Missing means active from the past (legacy-safe). */
  sleepFrom?: string
}

/** A user-created holiday. `date` is the first day; optional `endDate` is inclusive. */
export interface Holiday {
  id: string
  date: string
  endDate?: string
  name: string
}

/** A date-specific exception to one weekly timetable slot. */
export interface ScheduleOverride {
  id: string
  date: string
  originalSubjectId: string
  start: string
  kind: "cancelled" | "substitute"
  substituteSubjectId?: string
}

/** Anything with a due date: an exam, an assignment, a submission. They are all just deadlines. */
export interface Task {
  id: string
  title: string
  /** YYYY-MM-DD */
  dueDate: string
  /** Old data used to split deadlines into exams and assignments. Nothing reads or writes it any more. */
  type?: "exam" | "assignment"
  /** How many days ahead to start reminding: 0 = on the day itself, -1 = never. Default 1. */
  remindDaysBefore?: number
  /** Optional link to one of your subjects */
  subjectId?: string
  /** Ticked off. Stays in the Completed list so it can be brought back. */
  done?: boolean
}

/**
 * A friend who marks you present. covered = times they did, repaid = times you paid them back.
 * The favour ledger is private and stays on this device; `uid` is set when the mate is a connected account.
 */
export interface Mate {
  id: string
  name: string
  covered: number
  repaid: number
  uid?: string
  /** This user's chosen display alias. Never inferred from an account ID. */
  alias?: string
  /** When true, answers from this connected mate are safely integrated without a per-Ping approval. */
  autoIntegrateResponses?: boolean
  /** Dates (YYYY-MM-DD) each favour happened, so the monthly wrap-up can count them */
  coveredLog?: string[]
  repaidLog?: string[]
  /**
   * The favours that came from a Ping, one entry per class it helped, as "YYYY-MM-DD|<pingId>:<classKey>". This is
   * what makes a favour happen once: the same Ping applied again (after a crash, or on another device) finds its
   * entry and does nothing.
   */
  coveredPings?: string[]
}

/** One class you are asking a mate about. `key` is unique per class per day (subject + start time). */
export interface PingItem {
  key: string
  /** Subject id in the asker's app, used to mark the right class when the answer is yes */
  subjectId: string
  /** Subject name as the asker calls it. The mate only reads it, so names never need to match. */
  name: string
  /** Class start time ("HH:MM"), when the class has one */
  t?: string
  /** This occurrence exists because the original subject was substituted for this date; its start may not be in the replacement's weekly slots. */
  substituted?: boolean
  answer: "yes" | "no" | null
}

/**
 * A ping: someone who was away asks a mate "did you mark me present in these classes?".
 * `from` is the person asking and `to` is the mate being asked. A yes on a class is what
 * confirms it: it marks that class present for the asker and counts as a favour.
 */
export interface Ping {
  id: string
  from: string
  to: string
  fromName: string
  toName: string
  participants: string[]
  /** The accepted connection between the two people. The rules check it, so only real mates can ping. */
  requestId?: string
  /** YYYY-MM-DD the classes were on */
  date: string
  items: PingItem[]
  /** asking -> answered (by the mate) -> processed (the asker's device applied the answer, exactly once) */
  status: "asking" | "answered" | "processed" | "dismissed" | "cancelled"
  /** When the mate answered. A Firestore timestamp from the server (null while pending), a number elsewhere. */
  respondedAt?: unknown
  /** When the asker explicitly chose not to apply this answer to attendance. */
  dismissedAt?: unknown
  /** When the server created it (its own clock). Direct in-app Pings live 3 days from this. */
  createdAt?: unknown
  /** Explicit deadline for one-time share-link Pings (24 hours). */
  expiresAt?: unknown
  /** The device of the asker that is applying the answer, and since when (a lease that runs out) */
  claimedBy?: string
  claimedAt?: unknown
  /** This Ping was created for a one-time share link, answered by a recipient in a browser. */
  shareLink?: boolean
}

/** A connection request between two accounts. Accepted requests are the mate connections. */
export interface FriendRequest {
  id: string
  from: string
  to: string
  fromName: string
  toName: string
  participants: string[]
  status: "pending" | "accepted" | "declined"
}
