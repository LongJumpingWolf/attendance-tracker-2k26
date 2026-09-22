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
  /** Dates (YYYY-MM-DD) each favour happened, so the monthly wrap-up can count them */
  coveredLog?: string[]
  repaidLog?: string[]
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
  status: "asking" | "answered"
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
