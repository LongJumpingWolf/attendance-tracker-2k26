"use client"

import { useState } from "react"
import { SpinnerGap, ThumbsDown, ThumbsUp, X } from "@phosphor-icons/react"
import { sendFixFeedback, type FeedbackRecord } from "@/lib/feedback"
import { ticketTitle } from "@/lib/feedback-threads"
import { useScrollLock } from "@/lib/use-scroll-lock"

/**
 * A day after the developer answered a bug report: did the fix work? One tap, with an optional word. It lands in the
 * same conversation, so the developer sees praise or "still happening" next to the report it is about.
 */
export default function FixCheckIn({ ticket, onDone, onLater, onToast }: { ticket: FeedbackRecord | null; onDone: () => void; onLater: () => void; onToast: (message: string) => void }) {
  useScrollLock(!!ticket)
  const [helpful, setHelpful] = useState<boolean | null>(null)
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  if (!ticket) return null

  const send = async () => {
    if (helpful === null) return
    setBusy(true)
    setError("")
    try {
      await sendFixFeedback(ticket, helpful, comment)
      onToast(helpful ? "Thanks, glad it works now" : "Thanks, the developer will take another look")
      onDone()
    } catch (e) {
      setError(e instanceof Error && /permission|insufficient/i.test(e.message) ? "This couldn't be sent right now. Try again later." : e instanceof Error ? e.message : "Couldn't send. Try again.")
    } finally {
      setBusy(false)
    }
  }
  const choice = (value: boolean, label: string, Icon: typeof ThumbsUp) => (
    <button type="button" aria-pressed={helpful === value} onClick={() => setHelpful(value)} className={`flex h-12 flex-1 items-center justify-center gap-2 rounded-xl text-[15px] font-semibold transition ${helpful === value ? "bg-ink text-paper" : "bg-secondary text-ink"}`}>
      <Icon size={19} weight={helpful === value ? "fill" : "bold"} /> {label}
    </button>
  )

  return (
    <div className="fixed inset-0 z-[99] grid place-items-end bg-black/45 p-3 sm:place-items-center" role="dialog" aria-modal="true" aria-labelledby="fix-title" onClick={onLater}>
      <div className="max-h-[90dvh] w-full max-w-[380px] justify-self-center overflow-y-auto rounded-3xl bg-card p-5 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-bold uppercase tracking-wider text-ink">Quick check-in</p>
            <h2 id="fix-title" className="mt-1 text-[19px] font-bold leading-tight text-ink">Did the fix work?</h2>
          </div>
          <button aria-label="Not now" onClick={onLater} className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-secondary text-ink"><X size={15} weight="bold" /></button>
        </div>
        <p className="mt-2 text-[14px] leading-snug text-ink/85">You reported a bug and the developer replied. How is it now?</p>
        <p className="mt-3 line-clamp-3 rounded-2xl bg-secondary px-3.5 py-2.5 text-[14px] leading-snug text-ink">{ticketTitle(ticket)}</p>
        <div className="mt-4 flex gap-2.5">{choice(true, "It works", ThumbsUp)}{choice(false, "Still broken", ThumbsDown)}</div>
        <label className="mt-4 block text-[13px] font-semibold text-ink" htmlFor="fix-comment">Anything to add? <span className="font-medium text-ink/65">Optional</span></label>
        <textarea id="fix-comment" value={comment} onChange={(e) => setComment(e.target.value.slice(0, 1000))} rows={3} placeholder={helpful === false ? "What is still happening?" : "A thank-you, or an idea to make it better…"} className="mt-1.5 w-full resize-y rounded-xl bg-secondary p-3 text-[15px] leading-snug text-ink outline-none placeholder:text-ink/50 focus:ring-1 focus:ring-ink/40" />
        {error && <p role="alert" className="mt-2 text-[13px] font-medium text-bad">{error}</p>}
        <div className="mt-4 flex gap-2.5">
          <button onClick={onLater} disabled={busy} className="h-11 flex-1 rounded-xl bg-secondary text-[15px] font-semibold text-ink disabled:opacity-50">Not now</button>
          <button onClick={() => void send()} disabled={busy || helpful === null} className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-ink text-[15px] font-semibold text-paper disabled:opacity-40">{busy ? <><SpinnerGap size={18} className="animate-spin" /> Sending…</> : "Send"}</button>
        </div>
      </div>
    </div>
  )
}
