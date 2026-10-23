"use client"

import { useEffect, useMemo, useState } from "react"
import { Bug, CaretRight, ChatCircleText, Lightbulb, SpinnerGap, Star } from "@phosphor-icons/react"
import Sheet, { primaryButton } from "./sheet"
import TicketThread from "./ticket-thread"
import { markTicketSeen, saveRating, sendUserMessage, type FeedbackRecord } from "@/lib/feedback"
import { KIND_LABEL, STATE_LABEL, TICKET_GROUPS, devReplies, isFirstReplyUnseen, isFollowUpUnseen, msOf, ticketState, ticketTitle, type FeedbackKind } from "@/lib/feedback-threads"

const ICON = { rating: Star, bug: Bug, suggestion: Lightbulb } as const
const dateText = (v: unknown) => {
  const ms = msOf(v)
  return ms ? new Date(ms).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "Just now"
}
const unseen = (t: FeedbackRecord) => isFollowUpUnseen(t) || isFirstReplyUnseen(t)

const errorText = (e: unknown) =>
  e instanceof Error && /permission|insufficient/i.test(e.message) ? "The developer closed this conversation or it can't take more messages right now." : e instanceof Error ? e.message : "Couldn't send. Try again."

/** Every ticket the person has sent, as three lists (ratings, bug reports, feature requests), with the conversation inside each */
export default function TicketsSheet({ open, onClose, tickets, openId, onOpenFeedback, onToast }: {
  open: boolean
  onClose: () => void
  tickets: FeedbackRecord[]
  /** A ticket to open straight away (from a notification of a reply) */
  openId?: string | null
  onOpenFeedback: (kind: FeedbackKind) => void
  onToast: (message: string) => void
}) {
  const [tab, setTab] = useState<FeedbackKind>("bug")
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setDraft("")
    setError("")
    const target = openId ? tickets.find((t) => t.id === openId) : null
    if (target) {
      setTab(target.kind)
      setSelectedId(target.id)
    } else {
      setSelectedId(null)
      // land on the list that has something new, else the one with the most tickets
      const withNews = tickets.find(unseen)
      setTab(withNews ? withNews.kind : (TICKET_GROUPS.map((g) => g.kind).sort((a, b) => tickets.filter((t) => t.kind === b).length - tickets.filter((t) => t.kind === a).length)[0] ?? "bug"))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openId])

  const selected = tickets.find((t) => t.id === selectedId) ?? null
  // Opening a conversation reads it: the red dot goes away
  useEffect(() => {
    if (open && selected && selected.seenByUser === false && devReplies(selected) > 0) void markTicketSeen(selected.id).catch(() => {})
  }, [open, selected])

  const inTab = useMemo(() => tickets.filter((t) => t.kind === tab), [tickets, tab])
  const closed = selected ? ticketState(selected) === "closed" && selected.kind !== "rating" : false
  const SelectedIcon = selected ? ICON[selected.kind] : Star

  const send = async () => {
    if (!selected || !draft.trim()) return
    setBusy(true)
    setError("")
    try {
      await sendUserMessage(selected, draft)
      setDraft("")
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const rate = async (n: number) => {
    if (!selected) return
    try {
      await saveRating(selected, n)
      onToast("Rating updated")
    } catch (e) {
      onToast(errorText(e))
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title={selected ? KIND_LABEL[selected.kind] : "Your tickets"} onBack={selected ? () => { setSelectedId(null); setDraft(""); setError("") } : undefined} priority="high">
      {selected ? (
        <div className="space-y-4 pb-2">
          <div>
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-secondary text-ink"><SelectedIcon size={21} weight="duotone" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-[16px] font-bold leading-snug text-ink">{ticketTitle(selected)}</p>
                <p className="mt-1 text-[13px] font-medium text-ink/70">Sent {dateText(selected.createdAt)}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1.5 text-[12px] font-semibold text-ink">
              <span className={`rounded-full px-2.5 py-1 ${ticketState(selected) === "closed" ? "bg-good/15 text-good" : ticketState(selected) === "replied" ? "bg-ink text-paper" : "bg-secondary"}`}>{selected.kind === "rating" ? "Rating" : STATE_LABEL[ticketState(selected)]}</span>
              {selected.fixFeedback && <span className="rounded-full bg-secondary px-2.5 py-1">You said: {selected.fixFeedback === "up" ? "fixed" : "not fixed"}</span>}
            </div>
          </div>

          {selected.kind === "rating" && (
            <section className="rounded-2xl bg-secondary p-3.5">
              <p className="text-[13px] font-semibold text-ink">Your rating. Tap a star to change it.</p>
              <div className="mt-2 flex gap-1.5" role="radiogroup" aria-label="Your rating">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button key={n} type="button" role="radio" aria-checked={selected.rating === n} aria-label={`${n} star${n === 1 ? "" : "s"}`} onClick={() => void rate(n)} className={`grid h-11 w-11 place-items-center rounded-xl ${selected.rating !== null && n <= selected.rating ? "bg-amber-300 text-black" : "bg-card text-ink/60"}`}>
                    <Star size={22} weight={selected.rating !== null && n <= selected.rating ? "fill" : "regular"} />
                  </button>
                ))}
              </div>
            </section>
          )}

          <TicketThread ticket={selected} viewer="user" />

          {closed ? (
            <section className="rounded-2xl bg-secondary p-3.5">
              <p className="text-[14px] font-semibold leading-snug text-ink">The developer closed this conversation.</p>
              <p className="mt-1 text-[13px] leading-snug text-ink/80">If it is still a problem, send a new report and mention this one.</p>
              <button onClick={() => onOpenFeedback(selected.kind)} className="mt-3 h-10 rounded-xl bg-ink px-4 text-[14px] font-semibold text-paper">{selected.kind === "bug" ? "Report it again" : "Send a new request"}</button>
            </section>
          ) : (
            <section>
              <label htmlFor="ticket-draft" className="mb-1.5 block text-[13px] font-semibold text-ink">{selected.kind === "rating" ? "Add a note" : "Reply to the developer"}</label>
              <textarea id="ticket-draft" value={draft} onChange={(e) => setDraft(e.target.value.slice(0, 1000))} rows={3} placeholder={selected.kind === "rating" ? "What would make it a 5?" : "Add more detail, or say how it is going…"} className="w-full resize-y rounded-xl bg-secondary p-3 text-[15px] leading-snug text-ink outline-none placeholder:text-ink/50 focus:ring-1 focus:ring-ink/40" />
              {error && <p role="alert" className="mt-1.5 text-[13px] font-medium text-bad">{error}</p>}
              <button onClick={() => void send()} disabled={busy || !draft.trim()} className={`${primaryButton} mt-3 inline-flex items-center justify-center gap-2 disabled:opacity-45`}>{busy ? <><SpinnerGap size={18} className="animate-spin" /> Sending…</> : <><ChatCircleText size={19} weight="bold" /> Send</>}</button>
            </section>
          )}
        </div>
      ) : (
        <div className="space-y-4 pb-2">
          <div className="grid grid-cols-3 gap-1.5 rounded-2xl bg-secondary p-1" role="tablist" aria-label="Ticket type">
            {TICKET_GROUPS.map(({ kind, title }) => {
              const items = tickets.filter((t) => t.kind === kind)
              const news = items.some(unseen)
              return (
                <button key={kind} role="tab" aria-selected={tab === kind} onClick={() => setTab(kind)} className={`relative min-h-[48px] rounded-xl px-1 text-[13px] font-semibold leading-tight ${tab === kind ? "bg-card text-ink shadow-sm" : "text-ink/70"}`}>
                  {title}
                  <span className="block text-[12px] font-medium tabular-nums">{items.length}</span>
                  {news && <span aria-label="New reply" className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-bad" />}
                </button>
              )
            })}
          </div>

          {inTab.length === 0 ? (
            <section className="rounded-2xl bg-secondary p-5 text-center">
              <p className="text-[15px] font-semibold text-ink">{tab === "rating" ? "You haven't rated the app yet" : tab === "bug" ? "No bug reports yet" : "No feature requests yet"}</p>
              <p className="mt-1 text-[13px] leading-snug text-ink/75">{tab === "rating" ? "Rate it once, change it any time." : "Anything you send shows up here, with the developer's replies."}</p>
              <button onClick={() => onOpenFeedback(tab)} className="mt-4 h-11 rounded-xl bg-ink px-5 text-[15px] font-semibold text-paper">{tab === "rating" ? "Rate the app" : tab === "bug" ? "Report a bug" : "Request a feature"}</button>
            </section>
          ) : (
            <ul className="space-y-2">
              {inTab.map((t, i) => {
                const state = ticketState(t)
                return (
                  <li key={t.id}>
                    <button onClick={() => setSelectedId(t.id)} className="flex w-full items-center gap-3 rounded-2xl bg-secondary px-4 py-3 text-left active:opacity-80">
                      <span className="min-w-0 flex-1">
                        <span className="block text-[15px] font-semibold leading-snug text-ink">
                          {t.kind === "rating" && t.rating ? <span className="text-amber-500">{"★".repeat(t.rating)}<span className="text-ink/30">{"★".repeat(5 - t.rating)}</span></span> : null}
                          {t.kind === "rating" && t.rating ? (t.message.trim() ? " " : "") : null}
                          {t.kind === "rating" ? (t.message.trim() ? ticketTitle(t) : i === 0 ? " Your rating" : " Earlier rating") : ticketTitle(t)}
                        </span>
                        <span className="mt-1 flex items-center gap-2 text-[12px] font-medium text-ink/70">
                          <span className={state === "replied" ? "font-semibold text-ink" : state === "closed" ? "text-good" : ""}>{t.kind === "rating" ? `Updated ${dateText(t.ratingUpdatedAt ?? t.createdAt)}` : STATE_LABEL[state]}</span>
                          {t.kind !== "rating" && <span aria-hidden>·</span>}
                          {t.kind !== "rating" && <span>{dateText(t.lastMessageAt ?? t.createdAt)}</span>}
                        </span>
                      </span>
                      {unseen(t) && <span className="rounded-full bg-bad px-2 py-0.5 text-[11px] font-bold text-white">New</span>}
                      <CaretRight size={16} weight="bold" className="flex-shrink-0 text-ink/60" />
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Sheet>
  )
}
