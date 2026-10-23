"use client"

import { useEffect, useRef } from "react"
import { Bug, ChatCircleText, Lightbulb, Star, X } from "@phosphor-icons/react"
import type { FeedbackRecord } from "@/lib/feedback"
import { KIND_LABEL, STATE_LABEL, msOf, ticketState } from "@/lib/feedback-threads"
import { useScrollLock } from "@/lib/use-scroll-lock"

const dateText = (value: unknown) => {
  const ms = msOf(value)
  return ms ? new Date(ms).toLocaleDateString([], { day: "numeric", month: "short" }) : "just now"
}

const COPY = {
  bug: { Icon: Bug, title: "Bug swatted!", lead: "The developer looked into your report and replied." },
  suggestion: { Icon: Lightbulb, title: "Your idea was read", lead: "The developer replied to your feature request." },
  rating: { Icon: Star, title: "Thanks for the rating", lead: "The developer replied to your note." },
} as const

/**
 * The developer's first reply to something you sent: what you wrote, what they said, and where to carry on.
 * It stays until you close it (a reply is worth reading), and Escape or a tap outside closes it too.
 */
export default function FeedbackCelebration({ ticket, onClose, onViewThread }: { ticket: FeedbackRecord | null; onClose: () => void; onViewThread?: () => void }) {
  useScrollLock(!!ticket)
  const done = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!ticket) return
    done.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [ticket, onClose])
  if (!ticket) return null

  const { Icon, title, lead } = COPY[ticket.kind]
  const state = ticketState(ticket)
  const reply = ticket.developerReply?.trim() || ""
  const wrote = ticket.message.trim()

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-black/45 p-4" role="dialog" aria-modal="true" aria-labelledby="reply-title" onClick={onClose}>
      <div className="animate-feedback-pop flex max-h-[88dvh] w-full max-w-[380px] flex-col overflow-hidden rounded-3xl bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 px-5 pb-3 pt-5">
          <span className={`${ticket.kind === "bug" ? "animate-feedback-bug bg-good/15 text-good" : "animate-feedback-icon bg-ink text-paper"} grid h-12 w-12 flex-shrink-0 place-items-center rounded-2xl`}>
            <Icon size={26} weight="duotone" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="reply-title" className="text-[19px] font-bold leading-tight text-ink">{title}</h2>
            <p className="mt-1 text-[14px] leading-snug text-ink/85">{lead}</p>
          </div>
          <button aria-label="Close" onClick={onClose} className="-mr-1.5 -mt-1 grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-secondary text-ink"><X size={15} weight="bold" /></button>
        </div>

        <div className="flex flex-wrap gap-1.5 px-5 pb-3 text-[12px] font-semibold text-ink">
          <span className="rounded-full bg-secondary px-2.5 py-1">{KIND_LABEL[ticket.kind]}</span>
          <span className="rounded-full bg-secondary px-2.5 py-1">Sent {dateText(ticket.createdAt)}</span>
          <span className={`rounded-full px-2.5 py-1 ${state === "closed" ? "bg-good/15 text-good" : "bg-secondary"}`}>{STATE_LABEL[state]}</span>
        </div>

        <div className="space-y-3 overflow-y-auto px-5 pb-4">
          {(wrote || ticket.rating) && (
            <section>
              <p className="mb-1.5 text-[12px] font-bold uppercase tracking-wider text-ink">You wrote{ticket.rating ? ` · ${"★".repeat(ticket.rating)}${"☆".repeat(5 - ticket.rating)}` : ""}</p>
              {wrote && <p className="whitespace-pre-wrap break-words rounded-2xl bg-secondary px-3.5 py-2.5 text-[14px] leading-snug text-ink">{wrote}</p>}
            </section>
          )}
          <section>
            <p className="mb-1.5 flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider text-ink">
              Developer&apos;s reply
              <span className="font-medium normal-case tracking-normal text-ink/65">{dateText(ticket.repliedAt)}</span>
            </p>
            <p className="whitespace-pre-wrap break-words rounded-2xl border-2 border-ink px-3.5 py-3 text-[15px] font-medium leading-snug text-ink">{reply}</p>
          </section>
        </div>

        <div className="flex gap-2.5 border-t border-ink/10 px-5 py-4">
          <button ref={done} onClick={onClose} className="h-11 flex-1 rounded-xl bg-ink text-[15px] font-semibold text-paper">Done</button>
          {onViewThread && state !== "closed" && (
            <button onClick={onViewThread} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-secondary text-[15px] font-semibold text-ink"><ChatCircleText size={18} weight="bold" /> Reply</button>
          )}
          {onViewThread && state === "closed" && (
            <button onClick={onViewThread} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-secondary text-[15px] font-semibold text-ink"><ChatCircleText size={18} weight="bold" /> View thread</button>
          )}
        </div>
      </div>
      <style jsx>{`
        @keyframes feedback-pop { 0% { opacity:0; transform:translateY(18px) scale(.94) } 70% { opacity:1; transform:translateY(-2px) scale(1.01) } 100% { opacity:1; transform:translateY(0) scale(1) } }
        @keyframes feedback-icon { 0% { transform:scale(.4) rotate(-14deg) } 65% { transform:scale(1.12) rotate(6deg) } 100% { transform:scale(1) rotate(0) } }
        @keyframes feedback-bug { 0% { transform:translateY(-10px) rotate(-16deg) scale(1.08) } 40% { transform:translateY(3px) rotate(12deg) scale(.94) } 70% { transform:translateY(-1px) rotate(-6deg) scale(1.04,.94) } 100% { transform:translateY(0) rotate(0) scale(1) } }
        .animate-feedback-pop { animation:feedback-pop .38s cubic-bezier(.2,.8,.2,1) both }
        .animate-feedback-icon { animation:feedback-icon .55s cubic-bezier(.2,.8,.2,1) both }
        .animate-feedback-bug { animation:feedback-bug .8s cubic-bezier(.2,.8,.2,1) both }
        @media (prefers-reduced-motion: reduce) { .animate-feedback-pop,.animate-feedback-icon,.animate-feedback-bug { animation:none } }
      `}</style>
    </div>
  )
}
