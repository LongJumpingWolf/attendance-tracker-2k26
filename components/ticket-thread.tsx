"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { ThumbsDown, ThumbsUp } from "@phosphor-icons/react"
import { watchThread, type FeedbackRecord } from "@/lib/feedback"
import { buildThread, type ThreadMessage } from "@/lib/feedback-threads"

const timeText = (at: number | null) => {
  if (!at) return "Just now"
  const d = new Date(at)
  const sameDay = d.toDateString() === new Date().toDateString()
  return sameDay ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " · " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
}

/** The conversation on a ticket as chat bubbles. `viewer` decides which side is "me". */
export default function TicketThread({ ticket, viewer, userLabel = "You" }: { ticket: FeedbackRecord; viewer: "user" | "developer"; userLabel?: string }) {
  const [later, setLater] = useState<ThreadMessage[]>([])
  const [failed, setFailed] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  useEffect(() => watchThread(ticket.id, (m) => { setFailed(false); setLater(m) }, () => setFailed(true)), [ticket.id])
  const thread = useMemo(() => buildThread(ticket, later), [ticket, later])
  useEffect(() => { end.current?.scrollIntoView({ block: "nearest" }) }, [thread.length])

  if (thread.length === 0) return <p className="rounded-2xl bg-secondary px-4 py-3 text-[14px] leading-snug text-ink">{ticket.kind === "rating" ? "Add a note below to tell the developer more about your rating." : "No messages yet."}</p>

  return (
    <div className="space-y-3" aria-live="polite">
      {thread.map((m) => {
        const mine = m.from === viewer
        const who = m.from === "developer" ? "Developer" : viewer === "user" ? userLabel : ticket.userName || "User"
        return (
          <div key={m.id} className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
            <p className="mb-1 px-1 text-[12px] font-semibold text-ink">
              {who}
              <span className="ml-2 font-medium text-ink/65">{timeText(m.at)}</span>
            </p>
            <div className={`max-w-[88%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[14px] leading-snug ${mine ? "rounded-br-md bg-ink text-paper" : "rounded-bl-md bg-secondary text-ink"}`}>
              {m.helpful !== undefined && (
                <span className="mb-1 flex items-center gap-1.5 text-[13px] font-semibold">
                  {m.helpful ? <ThumbsUp size={15} weight="fill" /> : <ThumbsDown size={15} weight="fill" />}
                  {m.helpful ? "The fix worked" : "Not fixed yet"}
                </span>
              )}
              {m.text}
            </div>
          </div>
        )
      })}
      {failed && <p role="alert" className="text-[13px] font-medium text-bad">Couldn&apos;t load the latest messages. Check your connection.</p>}
      <div ref={end} />
    </div>
  )
}
