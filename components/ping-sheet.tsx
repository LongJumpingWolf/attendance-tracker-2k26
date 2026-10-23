"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Check, ShareNetwork, X } from "@phosphor-icons/react"
import Sheet, { Segmented, primaryButton } from "./sheet"
import { classesOn, formatTime, localDate, markFor } from "@/lib/attendance"
import { MAX_PING_ITEMS } from "@/lib/pings"
import type { Mate, Ping, ScheduleOverride, Subject } from "@/lib/types"
import type { PingInput } from "@/lib/use-social"

interface Props {
  open: boolean
  online: boolean
  onClose: () => void
  mate: Mate | null
  subjects: Subject[]
  scheduleOverrides?: ScheduleOverride[]
  /** Direct in-app delivery is allowed only for a Google-authenticated, accepted Mate connection. */
  canDirect?: boolean
  /** Offers navigation to the connected-friend picker from the generic WhatsApp flow. */
  canChooseDirectMate?: boolean
  onChooseDirectMate?: () => void
  /** Pings already sent to this mate that still wait for a reply, so the same class isn't asked twice */
  waiting: Ping[]
  onAsk: (mate: Mate, date: string, items: PingInput[]) => Promise<{ ok: boolean; message: string }>
  onCreateSharePing?: (toName: string, date: string, items: PingInput[]) => Promise<{ ok: boolean; message: string; link?: string }>
  onToast: (message: string) => void
}

type Row = { key: string; subject: Subject; attendanceSubjectId: string; displayName?: string; t?: string; kind?: string; substituted?: boolean; mark: "P" | "A" | null; waiting: boolean }

const dayDate = (offset: number) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - offset)

export default function PingSheet({ open, online, onClose, mate, subjects, scheduleOverrides = [], canDirect = false, canChooseDirectMate = false, onChooseDirectMate, waiting, onAsk, onCreateSharePing, onToast }: Props) {
  const [offset, setOffset] = useState(0)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [showOther, setShowOther] = useState(false)
  const [deliveryMode, setDeliveryMode] = useState<"in-app" | "whatsapp">("whatsapp")
  const [phase, setPhase] = useState<"pick" | "sending" | "sent">("pick")
  const [shareLink, setShareLink] = useState<string | null>(null)
  const [shareMessage, setShareMessage] = useState<string>("")
  const [shareFallback, setShareFallback] = useState(false)
  const [shareFailureReason, setShareFailureReason] = useState("")
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const date = localDate(dayDate(offset))
  const connected = Boolean(mate?.uid)

  const { scheduled, other } = useMemo(() => {
    const isWaiting = (key: string) => waiting.some((p) => p.date === date && p.items.some((i) => i.key === key && i.answer === null))
    const timed: Row[] = classesOn(subjects, dayDate(offset), scheduleOverrides).filter((entry) => !entry.cancelled).map((entry) => {
      const { subject, slot } = entry
      const attendanceSubject = entry.attendanceSubject ?? subjects.find((s) => s.id === (entry.originalSubjectId ?? subject.id)) ?? subject
      const key = `${attendanceSubject.id}@${slot.start}`
      const displayName = entry.override?.kind === "substitute" ? `${attendanceSubject.name} (held as ${subject.name})` : subject.name
      return { key, subject, attendanceSubjectId: attendanceSubject.id, ...(displayName !== subject.name ? { displayName } : {}), t: slot.start, kind: slot.kind, ...(entry.override?.kind === "substitute" ? { substituted: true } : {}), mark: markFor(attendanceSubject, date, slot.start), waiting: isWaiting(key) }
    })
    const used = new Set(timed.flatMap((r) => [r.subject.id, r.attendanceSubjectId]))
    const rest: Row[] = subjects
      .filter((s) => !used.has(s.id))
      .map((subject) => {
        const key = `${subject.id}@`
        return { key, subject, attendanceSubjectId: subject.id, mark: markFor(subject, date, ""), waiting: isWaiting(key) }
      })
    return { scheduled: timed, other: rest }
  }, [subjects, scheduleOverrides, offset, date, waiting])

  // Start with the classes that still need a present mark
  useEffect(() => {
    if (!open) return
    setPhase("pick")
    setShareLink(null)
    setShareMessage("")
    setShareFallback(false)
    setShareFailureReason("")
    setOffset(0)
    setShowOther(false)
    setDeliveryMode(canDirect && mate?.id !== "__general__" ? "in-app" : "whatsapp")
  }, [open, canDirect, mate?.id])
  useEffect(() => {
    if (!open) return
    setPicked(new Set(scheduled.filter((r) => r.mark !== "P" && !r.waiting).map((r) => r.key).slice(0, MAX_PING_ITEMS)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offset])
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])

  if (!mate) return null
  const general = mate.id === "__general__"
  const directAvailable = canDirect && connected && !general

  const all = [...scheduled, ...other]
  const chosen = all.filter((r) => picked.has(r.key))
  const toggle = (key: string) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else if (next.size >= MAX_PING_ITEMS) onToast(`A Ping can ask about up to ${MAX_PING_ITEMS} classes at a time.`)
      else next.add(key)
      return next
    })

  const label = (r: Row) => `${r.displayName ?? r.subject.name}${r.t ? ` (${formatTime(r.t)})` : ""}`
  const share = async () => {
    if (!online || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      onToast("You're offline. Ping wasn't sent or created.")
      return
    }
    if (!onCreateSharePing) {
      const text = `Hi, could you please confirm whether you marked me present for ${chosen.map(label).join(", ")} ${offset === 0 ? "today" : "yesterday"}?`
      try {
        if (navigator.share) await navigator.share({ text })
        else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener,noreferrer")
      } catch { /* share sheet dismissed */ }
      return
    }
    setPhase("sending")
    const items: PingInput[] = chosen.map((r) => ({ key: r.key, subjectId: r.attendanceSubjectId, name: r.displayName ?? r.subject.name, ...(r.t ? { t: r.t } : {}), ...(r.substituted ? { substituted: true } : {}) }))
    const result = await onCreateSharePing(mate?.id === "__general__" ? "" : mate?.name ?? "", date, items)
    if (!result.ok || !result.link) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setPhase("pick")
        onToast("Your connection was lost. The Ping wasn't created.")
        return
      }
      // Even without a configured cloud account/rules, keep the plain WhatsApp workflow available.
      // Make the limitation explicit: this message has no interactive link and cannot auto-update attendance.
      const who = general ? "Hi!" : `Hey ${mate.name},`
      const when = offset === 0 ? "today" : "yesterday"
      const details = chosen.map(label).join(", ")
      const localPreview = /localhost|private network|public https|preview has no firebase configuration/i.test(result.message)
      const text = `${who} could you please confirm whether you marked me present for ${details} ${when}?

Please reply YES or NO. ${localPreview ? "This local preview needs NEXT_PUBLIC_APP_URL set to the deployed HTTPS site before it can create the interactive link." : "An interactive response link could not be created for this request."} I will need to record your reply manually.`
      setShareFailureReason(result.message)
      setShareLink(null)
      setShareMessage(text)
      setShareFallback(true)
      setPhase("sent")
      onToast("An interactive 24-hour link was not created. Review the reason below; plain-message sharing is optional and requires manual attendance updates.")
      return
    }
    const who = mate?.id === "__general__" ? "Hi!" : `Hey ${mate?.name},`
    const when = offset === 0 ? "today" : "yesterday"
    const details = chosen.map(label).join(", ")
    const text = `${who} could you please confirm whether you marked me present for ${details} ${when}?

Open this secure, one-time Ping link to answer Yes/No: ${result.link}

This link expires in 24 hours. The selected classes and times are listed on the response page.`
    setShareLink(result.link)
    setShareMessage(text)
    setShareFallback(false)
    setShareFailureReason("")
    setPhase("sent")
    // Do not open navigator.share after awaiting Firestore: user activation may have expired. Show the created link
    // first, then let the user explicitly choose Share or WhatsApp with a fresh click.
    onToast("Official 24-hour Ping link created. Copy it or choose Share / WhatsApp below.")
  }

  const ask = async () => {
    if (!online || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      onToast("You're offline. Ping wasn't sent or created.")
      return
    }
    if (deliveryMode === "whatsapp" || !directAvailable) {
      await share()
      return
    }
    setPhase("sending")
    const items: PingInput[] = chosen.map((r) => ({ key: r.key, subjectId: r.attendanceSubjectId, name: r.displayName ?? r.subject.name, ...(r.t ? { t: r.t } : {}), ...(r.substituted ? { substituted: true } : {}) }))
    const res = await onAsk(mate as Mate, date, items)
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
            <span className="block text-[16px] font-semibold leading-snug truncate">{r.displayName ?? r.subject.name}</span>
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
    <Sheet open={open} onClose={onClose} title={connected ? "Ask a mate" : "24-hour Ping link"}>
      {phase === "sent" ? (
        <div className="py-8 text-center">
          <div className="relative mx-auto w-24 h-24 grid place-items-center">
            <span className={`ping-ring absolute inset-0 rounded-full ${shareFallback ? "bg-bad/15" : "bg-good/25"}`} />
            <span className={`wrap-pop relative w-24 h-24 rounded-full grid place-items-center ${shareFallback ? "bg-bad" : "bg-good"}`}>
              {shareFallback ? <X weight="bold" className="w-11 h-11 text-paper" /> : (
                <svg viewBox="0 0 24 24" className="w-11 h-11" fill="none" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path className="ping-draw" d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              )}
            </span>
          </div>
          <p className="wrap-rise text-[22px] font-bold tracking-tight mt-5" style={{ animationDelay: "0.4s" }}>
            {shareLink ? "24-hour Ping link ready" : shareFallback ? "Interactive link not created" : `Ping sent to ${mate.name}`}
          </p>
          <p className="wrap-rise text-[15px] text-mute mt-1.5 leading-snug max-w-[17rem] mx-auto" style={{ animationDelay: "0.55s" }}>
            {shareLink ? "Once the recipient answers, your app can apply the reply when it is open or next syncs." : shareFallback ? "No official response link exists for this message. A plain-message reply must be recorded manually." : "You’ll get a bubble on Mates when they reply."}
          </p>
          {(shareLink || shareFallback) && <div className="mt-5 min-w-0 rounded-2xl bg-secondary p-3 sm:p-4 text-left overflow-hidden">
            <p className="text-[12px] text-mute mb-1">{shareLink ? "Unique response link · expires in 24 hours" : "Message without interactive link"}</p>
            {shareFallback && shareFailureReason && <div className="mb-2 rounded-xl border border-warn/20 bg-warn/10 p-2.5 text-[12px] leading-snug break-words"><b>Why no link was created:</b> {shareFailureReason}</div>}
            <p className="text-[13px] whitespace-pre-wrap break-all leading-snug">{shareLink || shareMessage}</p>
            <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button onClick={async()=>{try{await navigator.clipboard.writeText(shareLink || shareMessage);onToast(shareLink ? "Ping link copied" : "Message copied")}catch{onToast("Copy was blocked. Select the text and copy it.")}}} className="min-w-0 min-h-10 px-3 py-2 rounded-xl bg-card font-semibold text-[13px] leading-tight text-center whitespace-normal">{shareLink ? "Copy link" : "Copy plain message"}</button>
              {shareLink && typeof navigator !== "undefined" && typeof navigator.share === "function" && <button onClick={async()=>{try{await navigator.share({title:"Attendance Tracker Ping",text:shareMessage,url:shareLink});onToast("Ping message shared")}catch(error){if (!(error instanceof DOMException && error.name === "AbortError")) onToast("The share sheet could not open. Copy the link or use WhatsApp.")}}} className="min-w-0 min-h-10 px-3 py-2 rounded-xl bg-card font-semibold text-[13px] leading-tight text-center whitespace-normal">Share…</button>}
              <button onClick={()=>{window.open(`https://wa.me/?text=${encodeURIComponent(shareMessage)}`,"_blank","noopener,noreferrer")}} className="min-w-0 min-h-10 px-3 py-2 rounded-xl bg-ink text-paper font-semibold text-[13px] leading-tight text-center whitespace-normal sm:col-span-2">{shareLink ? "Open WhatsApp" : "Share plain message"}</button>
            </div>
            {shareFallback && <button onClick={()=>{setPhase("pick");setShareMessage("");setShareFallback(false);setShareFailureReason("")}} className="w-full mt-2 min-h-10 px-3 py-2 rounded-xl bg-card text-[13px] leading-tight font-semibold whitespace-normal">Try creating the official link again</button>}
            <p className="text-[12px] text-mute mt-3 leading-snug">{shareLink ? "A Yes response may update the selected attendance record." : "No interactive link was created. Plain-message replies do not update attendance automatically."}</p>
            <button onClick={onClose} className="w-full mt-3 min-h-10 px-3 py-2 rounded-xl bg-card text-[13px] leading-tight font-semibold">Done</button>
          </div>}
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
              <h3 className="text-[22px] font-bold tracking-tight leading-tight truncate">{general ? "Create a 24-hour Ping link" : mate.name}</h3>
              <p className="text-[15px] text-mute leading-snug">
                {directAvailable ? "Send directly inside Attendance Tracker or create a 24-hour WhatsApp link." : connected ? "In-app Pings require Google sign-in. You can still create a 24-hour WhatsApp link." : "Create a 24-hour link the recipient can open to answer Yes or No. Connect through a unique account code to enable in-app Pings."}
              </p>
            </div>
          </div>

          {general && canChooseDirectMate && onChooseDirectMate && (
            <div className="mb-4 rounded-2xl bg-secondary p-3.5">
              <p className="text-[14px] font-semibold">Prefer an in-app Ping?</p>
              <p className="text-[12px] text-mute leading-snug mt-1">Choose one of your Google-signed-in, connected friends instead of creating a response link.</p>
              <button type="button" onClick={() => { onClose(); onChooseDirectMate() }} className="mt-2 h-10 w-full rounded-xl bg-card text-[13px] font-semibold">Choose a connected friend</button>
            </div>
          )}
          {general && !canChooseDirectMate && (
            <p className="mb-4 rounded-2xl bg-secondary p-3 text-[12px] text-mute leading-snug">This one-time link is valid for 24 hours. Direct in-app Pings need Google sign-in and a friend connection accepted by both accounts.</p>
          )}

          {directAvailable && (
            <div className="mb-4">
              <Segmented
                label="Delivery method"
                value={deliveryMode}
                onChange={(value) => setDeliveryMode(value)}
                options={[{ id: "in-app", label: "In-app Ping" }, { id: "whatsapp", label: "Official link · 24h" }]}
              />
              <p className="text-[12px] text-mute mt-2">In-app sends to this accepted connection. WhatsApp creates a separate one-time response link.</p>
            </div>
          )}

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

          {!online && <p className="mt-4 rounded-xl bg-warn/10 px-3 py-2.5 text-[13px] text-warn leading-snug">You&apos;re offline. You can review the selected classes, but sending is paused until you reconnect.</p>}
          {online && !directAvailable && connected && <p className="text-[12px] text-mute mt-4 leading-snug">Sign in with Google to enable direct in-app Pings. WhatsApp links remain available without a Mates connection.</p>}
          {!connected && !general && <p className="text-[12px] text-mute mt-4 leading-snug">This person is not connected in the app. You can use a WhatsApp link now; direct in-app Pings require both people to connect and accept the request.</p>}
          <button
            type="button"
            onClick={ask}
            disabled={!online || chosen.length === 0 || phase === "sending"}
            title={!online ? "Requires an internet connection" : undefined}
            className={`${primaryButton} mt-6 flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed`}
          >
            {phase === "sending" ? (
              "Sending…"
            ) : chosen.length === 0 ? (
              "Pick a class"
            ) : deliveryMode === "in-app" && directAvailable ? (
              `Send in-app Ping to ${mate.name}`
            ) : (
              <>
                <ShareNetwork weight="bold" className="w-5 h-5" /> Create official 24-hour link
              </>
            )}
          </button>
          {directAvailable && deliveryMode === "in-app" && chosen.length > 0 && (
            <button type="button" onClick={() => setDeliveryMode("whatsapp")} className="block mx-auto mt-3 text-[15px] font-medium text-mute">
              Create the official 24-hour link instead
            </button>
          )}
        </div>
      )}
    </Sheet>
  )
}
