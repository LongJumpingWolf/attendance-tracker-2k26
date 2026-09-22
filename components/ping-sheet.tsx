"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ShareNetwork } from "@phosphor-icons/react"
import Sheet, { Segmented, primaryButton } from "./sheet"
import { classesOn, formatTime, localDate, markFor } from "@/lib/attendance"
import type { Mate, Ping, Subject } from "@/lib/types"
import type { PingInput } from "@/lib/use-social"

interface Props {
  open: boolean
  onClose: () => void
  mate: Mate | null
  subjects: Subject[]
  /** Pings already sent to this mate that still wait for a reply, so the same class isn't asked twice */
  waiting: Ping[]
  onAsk: (mate: Mate, date: string, items: PingInput[]) => Promise<{ ok: boolean; message: string }>
  onToast: (message: string) => void
}

type Row = { key: string; subject: Subject; t?: string; kind?: string; mark: "P" | "A" | null; waiting: boolean }

const dayDate = (offset: number) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - offset)

export default function PingSheet({ open, onClose, mate, subjects, waiting, onAsk, onToast }: Props) {
  const [offset, setOffset] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [showOther, setShowOther] = useState(false)
  const [phase, setPhase] = useState<"pick" | "sending" | "sent">("pick")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const date = localDate(dayDate(offset))
  const connected = Boolean(mate?.uid)

  const { scheduled, other } = useMemo(() => {
    const isWaiting = (key: string) => waiting.some((p) => p.date === date && p.items.some((i) => i.key === key && i.answer === null))
    const timed: Row[] = classesOn(subjects, dayDate(offset)).map(({ subject, slot }) => {
      const key = `${subject.id}@${slot.start}`
      return { key, subject, t: slot.start, kind: slot.kind, mark: markFor(subject, date, slot.start), waiting: isWaiting(key) }
    })
    const used = new Set(timed.map((r) => r.subject.id))
    const rest: Row[] = subjects
      .filter((s) => !used.has(s.id))
      .map((subject) => {
        const key = `${subject.id}@`
        return { key, subject, mark: markFor(subject, date, ""), waiting: isWaiting(key) }
      })
    return { scheduled: timed, other: rest }
  }, [subjects, offset, date, waiting])

  // Start with the classes that still need a present mark
  useEffect(() => {
    if (!open) return
    setPhase("pick")
    setOffset(0)
    setShowOther(false)
  }, [open])
  useEffect(() => {
    if (!open) return
    setPicked(new Set(scheduled.filter((r) => r.mark !== "P" && !r.waiting).map((r) => r.key)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offset])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  if (!mate) return null

  const all = [...scheduled, ...other]
  const chosen = all.filter((r) => picked.has(r.key))
  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const label = (r: Row) => `${r.subject.name}${r.t ? ` (${formatTime(r.t)})` : ""}`
  const share = async () => {
    const when = offset === 0 ? "today" : "yesterday"
    const text = `Hey ${mate.name}, were you marking me present in ${chosen.map(label).join(", ")} ${when}? Let me know 🙏`
    try {
      if (navigator.share) await navigator.share({ text })
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank")
    } catch {
      /* share sheet dismissed */
    }
  }

  const ask = async () => {
    if (!mate.uid) {
      await share()
      onClose()
      return
    }
    setPhase("sending")
    const items: PingInput[] = chosen.map((r) => ({ key: r.key, subjectId: r.subject.id, name: r.subject.name, ...(r.t ? { t: r.t } : {}) }))
    const res = await onAsk(mate, date, items)
    if (!res.ok) {
      setPhase("pick")
      return onToast(res.message)
    }
    navigator.vibrate?.(18)
    setPhase("sent")
    timer.current = setTimeout(onClose, 2200)
  }

  const renderRow = (r: Row) => {
    const on = picked.has(r.key)
    const locked = r.mark === "P" || r.waiting
    return (
      <li key={r.key}>
        <button
          type="button"
          disabled={locked}
          aria-pressed={on}
          onClick={() => toggle(r.key)}
          className={`w-full flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition ${
            on ? "bg-ink/[0.07] ring-1 ring-ink/25" : "bg-secondary"
          } ${locked ? "opacity-55" : "active:scale-[0.99]"}`}
        >
          <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: r.subject.glowColor }} />
          <span className="min-w-0 flex-1">
            <span className="block text-[16px] font-semibold leading-snug truncate">{r.subject.name}</span>
            <span className="block text-[13px] text-mute leading-snug">
              {[r.t ? formatTime(r.t) : null, r.kind, r.waiting ? "Waiting for a reply" : r.mark === "P" ? "Already present" : r.mark === "A" ? "Marked absent" : null]
                .filter(Boolean)
                .join(" · ") || "Any time"}
            </span>
          </span>
          <span
            className={`w-6 h-6 rounded-full grid place-items-center flex-shrink-0 transition ${
              on ? "bg-ink text-paper" : "border-2 border-ink/25"
            }`}
          >
            {on && <Check weight="bold" className="w-3.5 h-3.5" />}
          </span>
        </button>
      </li>
    )
  }

  return (
    <Sheet open={open} onClose={onClose} title={connected ? "Ask a mate" : "Message a mate"}>
      {phase === "sent" ? (
        <div className="py-8 text-center">
          <div className="relative mx-auto w-24 h-24 grid place-items-center">
            <span className="ping-ring absolute inset-0 rounded-full bg-good/25" />
            <span className="wrap-pop relative w-24 h-24 rounded-full bg-good grid place-items-center">
              <svg viewBox="0 0 24 24" className="w-11 h-11" fill="none" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path className="ping-draw" d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </span>
          </div>
          <p className="wrap-rise text-[22px] font-bold tracking-tight mt-5" style={{ animationDelay: "0.4s" }}>
            Asked {mate.name}
          </p>
          <p className="wrap-rise text-[15px] text-mute mt-1.5 leading-snug max-w-[17rem] mx-auto" style={{ animationDelay: "0.55s" }}>
            You&rsquo;ll get a bubble on Mates when they reply.
          </p>
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-4 mb-5">
            <div className="relative w-16 h-16 flex-shrink-0 grid place-items-center">
              {connected && <span className="ping-ring absolute inset-0 rounded-full bg-ink/15" />}
              {connected && <span className="ping-ring ping-ring-2 absolute inset-0 rounded-full bg-ink/15" />}
              <span className="relative w-16 h-16 rounded-full bg-ink text-paper grid place-items-center text-[26px] font-bold">
                {mate.name.slice(0, 1).toUpperCase()}
              </span>
            </div>
            <div className="min-w-0">
              <h3 className="text-[22px] font-bold tracking-tight leading-tight truncate">{mate.name}</h3>
              <p className="text-[15px] text-mute leading-snug">
                {connected ? "Did they mark you present?" : "Not connected in the app. This opens your share sheet."}
              </p>
            </div>
          </div>

          <Segmented
            label="Which day"
            value={String(offset)}
            onChange={(v) => setOffset(Number(v))}
            options={[
              { id: "0", label: "Today" },
              { id: "1", label: "Yesterday" },
            ]}
          />

          <p className="text-[12px] font-medium uppercase tracking-wider text-mute mt-5 mb-2">Which classes were you away for?</p>
          {subjects.length === 0 ? (
            <p className="text-[15px] text-mute leading-snug">Add your subjects first, then you can pick the classes to ask about.</p>
          ) : (
            <>
              {scheduled.length > 0 ? (
                <ul className="space-y-2">{scheduled.map(renderRow)}</ul>
              ) : (
                <p className="text-[15px] text-mute leading-snug">No classes are scheduled {offset === 0 ? "today" : "yesterday"}. Pick one below.</p>
              )}
              {other.length > 0 && (
                <>
                  <button type="button" onClick={() => setShowOther(!showOther)} aria-expanded={showOther} className="mt-3 text-[15px] font-medium text-mute">
                    {showOther ? "Hide other subjects" : "Ask about another subject"}
                  </button>
                  {showOther && <ul className="space-y-2 mt-2">{other.map(renderRow)}</ul>}
                </>
              )}
            </>
          )}

          <button
            type="button"
            onClick={ask}
            disabled={chosen.length === 0 || phase === "sending"}
            className={`${primaryButton} mt-6 flex items-center justify-center gap-2 disabled:opacity-40`}
          >
            {phase === "sending" ? (
              "Sending…"
            ) : chosen.length === 0 ? (
              "Pick a class"
            ) : connected ? (
              `Ask ${mate.name} about ${chosen.length} ${chosen.length === 1 ? "class" : "classes"}`
            ) : (
              <>
                <ShareNetwork weight="bold" className="w-5 h-5" /> Share message
              </>
            )}
          </button>
          {connected && chosen.length > 0 && (
            <button type="button" onClick={share} className="block mx-auto mt-3 text-[15px] font-medium text-mute">
              Send on WhatsApp instead
            </button>
          )}
        </div>
      )}
    </Sheet>
  )
}
