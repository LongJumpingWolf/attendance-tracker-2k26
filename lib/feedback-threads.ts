/**
 * What a ticket (a bug report, a feature request or a rating) looks like to the person who sent it and to the developer.
 *
 * A ticket is one document: the person's first message (`message`, with `rating` for a rating), the developer's first
 * reply (`developerReply`), and the state of the conversation. Everything after that is in its `messages` list, so
 * tickets written before conversations existed read exactly the same way, with no migration.
 */

export type FeedbackKind = "bug" | "rating" | "suggestion"
export type TicketState = "waiting" | "replied" | "closed"
type Stamp = { toDate?: () => Date; toMillis?: () => number; seconds?: number } | Date | number | null | undefined

/** The parts of a ticket these rules read (the full record has more) */
export interface TicketLike {
  kind: FeedbackKind
  message: string
  rating: number | null
  status: "open" | "replied" | "resolved"
  developerReply?: string
  devReplyCount?: number
  seenByUser?: boolean
  lastFrom?: "user" | "developer"
  fixFeedback?: "up" | "down" | null
  createdAt?: Stamp
  repliedAt?: unknown
  lastMessageAt?: unknown
}

export interface ThreadMessage {
  id: string
  from: "user" | "developer"
  text: string
  at: number | null
  /** A "did the fix work?" answer */
  helpful?: boolean
}

export const msOf = (v: unknown): number | null => {
  if (v == null) return null
  if (typeof v === "number") return v
  if (v instanceof Date) return v.getTime()
  const s = v as { toMillis?: () => number; toDate?: () => Date; seconds?: number }
  if (typeof s.toMillis === "function") return s.toMillis()
  if (typeof s.toDate === "function") return s.toDate().getTime()
  if (typeof s.seconds === "number") return s.seconds * 1000
  return null
}

/** How many times the developer has answered. Tickets from before this was counted have one if they have a reply. */
export const devReplies = (t: Pick<TicketLike, "developerReply" | "devReplyCount">) =>
  typeof t.devReplyCount === "number" ? t.devReplyCount : t.developerReply?.trim() ? 1 : 0

export function ticketState(t: Pick<TicketLike, "status" | "developerReply" | "devReplyCount" | "lastFrom">): TicketState {
  if (t.status === "resolved") return "closed"
  if (devReplies(t) > 0 && t.lastFrom !== "user" && t.status === "replied") return "replied"
  return "waiting"
}

/** The developer's first answer, not yet opened: it gets the full-screen thank-you, not a red dot */
export const isFirstReplyUnseen = (t: TicketLike) => devReplies(t) === 1 && t.seenByUser === false && !!t.developerReply?.trim()

/** A later answer in a conversation, not yet opened: it gets the red dot and the note at the top of Settings */
export const isFollowUpUnseen = (t: TicketLike) => devReplies(t) >= 2 && t.seenByUser === false

/** One line to name a ticket in a list */
export function ticketTitle(t: Pick<TicketLike, "kind" | "message" | "rating">): string {
  const text = t.message.trim().replace(/\s+/g, " ")
  if (text) return text.length > 70 ? `${text.slice(0, 67).trimEnd()}…` : text
  if (t.kind === "rating") return t.rating ? `Your rating: ${t.rating} of 5` : "Your rating"
  return t.kind === "bug" ? "Bug report" : "Feature request"
}

export const KIND_LABEL: Record<FeedbackKind, string> = { bug: "Bug report", rating: "Rating", suggestion: "Feature request" }

export const STATE_LABEL: Record<TicketState, string> = {
  waiting: "Waiting for the developer",
  replied: "Developer replied",
  closed: "Closed",
}

/** The conversation in order: the first message, the developer's first reply, then everything after */
export function buildThread(t: TicketLike, later: ThreadMessage[]): ThreadMessage[] {
  const out: ThreadMessage[] = []
  if (t.message.trim()) out.push({ id: "first", from: "user", text: t.message.trim(), at: msOf(t.createdAt) })
  if (t.developerReply?.trim()) out.push({ id: "first-reply", from: "developer", text: t.developerReply.trim(), at: msOf(t.repliedAt) })
  const rest = [...later].sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity))
  return [...out, ...rest]
}

const DAY_MS = 86_400_000
export const FIX_CHECK_IN_AFTER_MS = DAY_MS

/**
 * Time to ask "did the fix work?": a bug the developer answered, which the person has read at least a day ago, which
 * they haven't commented on, and where the developer hasn't been waiting on them since. Asked once.
 */
export function fixCheckInDue(t: TicketLike, acknowledgedAt: number | null, now = Date.now()): boolean {
  if (t.kind !== "bug" || devReplies(t) === 0 || t.fixFeedback) return false
  if (t.seenByUser === false) return false
  if (t.lastFrom === "user") return false
  const since = acknowledgedAt ?? msOf(t.repliedAt)
  return since !== null && now - since >= FIX_CHECK_IN_AFTER_MS
}

/** The ticket kinds a person sees as separate lists */
export const TICKET_GROUPS: { kind: FeedbackKind; title: string }[] = [
  { kind: "rating", title: "Ratings" },
  { kind: "bug", title: "Bug reports" },
  { kind: "suggestion", title: "Feature requests" },
]

/** Newest activity first */
export const byActivity = <T extends TicketLike>(a: T, b: T) =>
  (msOf(b.lastMessageAt) ?? msOf(b.repliedAt) ?? msOf(b.createdAt) ?? 0) - (msOf(a.lastMessageAt) ?? msOf(a.repliedAt) ?? msOf(a.createdAt) ?? 0)
