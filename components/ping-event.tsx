"use client"

import { useEffect, useRef, useState } from "react"
import { Bell, Check, X } from "@phosphor-icons/react"
import { formatDayMonth, formatTime } from "@/lib/attendance"
import { whenLabel } from "@/lib/pings"
import { resultSummary, type PingEvent } from "@/lib/ping-presentation"
import { useScrollLock } from "@/lib/use-scroll-lock"

interface Props {
  event: PingEvent
  /** Send the answers. Resolves ok only once the server has them. */
  onAnswer: (answers: Record<string, "yes" | "no">) => Promise<{ ok: boolean; message: string }>
  /** The confirmation has played */
  onFinish: () => void
  /** Put this request off for now (it stays pending) */
  onLater: () => void
  /** The answer to my Ping has been seen */
  onAcknowledge: () => void
  /** Notifications aren't on yet: offer to turn Ping alerts on */
  alertsOffer: boolean
  onEnableAlerts: () => Promise<boolean>
}

const BURST_MS = 1500

/**
 * The full-screen moment for a Ping: either someone asking me for attendance help, or the answer to my own request.
 * Fast and lightweight (CSS only), with its own colours so it reads as an event rather than another page.
 */
export default function PingEventView(props: Props) {
  // Keyed by the Ping, so moving to the next one starts clean
  return <Inner key={`${props.event.kind}-${props.event.ping.id}`} {...props} />
}

function Inner({ event, onAnswer, onFinish, onLater, onAcknowledge, alertsOffer, onEnableAlerts }: Props) {
  useScrollLock(true)
  const { ping } = event
  const incoming = event.kind === "incoming"
  const [phase, setPhase] = useState<"ask" | "sending" | "sent">("ask")
  const [error, setError] = useState("")
  const [each, setEach] = useState(false)
  const [picked, setPicked] = useState<Record<string, "yes" | "no">>({})
  const [leaving, setLeaving] = useState(false)
  const [offer, setOffer] = useState(alertsOffer)
  const primary = useRef<HTMLButtonElement>(null)

  const when = `${whenLabel(ping.date)} · ${formatDayMonth(ping.date)}`
  const name = incoming ? ping.fromName : ping.toName
  const result = incoming ? null : resultSummary(ping)

  useEffect(() => primary.current?.focus(), [phase, each])

  const leave = (then: () => void) => {
    setLeaving(true)
    setTimeout(then, 180)
  }

  const send = async (answers: Record<string, "yes" | "no">) => {
    setPhase("sending")
    setError("")
    const r = await onAnswer(answers)
    if (!r.ok) {
      setPhase("ask")
      setError(r.message)
      return
    }
    setPhase("sent")
  }
  const all = (v: "yes" | "no") => send(Object.fromEntries(ping.items.map((i) => [i.key, v])))

  // The confirmation holds for a moment, then hands the screen back (it waits if there is an alerts offer to read)
  useEffect(() => {
    if (phase !== "sent" || offer) return
    const t = setTimeout(() => leave(onFinish), BURST_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, offer])

  // Escape: "Later" on a request, "Done" on an answer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || phase === "sending") return
      if (phase === "sent") leave(onFinish)
      else if (incoming) leave(onLater)
      else leave(onAcknowledge)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, incoming])

  const tone = incoming ? "#3a86ff" : result?.kind === "none" ? "#ff453a" : "#30d158"
  const complete = ping.items.every((i) => picked[i.key])

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ping-event-title"
      className={`fixed inset-0 z-[80] bg-paper overflow-y-auto overscroll-contain no-scrollbar ${leaving ? "ping-event-out" : "ping-event-in"}`}
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div aria-hidden className="pointer-events-none absolute inset-0" style={{ background: `radial-gradient(70% 45% at 50% 30%, ${tone}2b, transparent 70%)` }} />

      <div className="relative mx-auto min-h-dvh max-w-md px-6 py-10 flex flex-col items-center justify-center text-center">
        {phase === "sent" ? (
          <>
            <div className="relative w-28 h-28 grid place-items-center">
              <span className="ping-ring absolute inset-0 rounded-full bg-good/25" />
              <span className="wrap-pop relative w-28 h-28 rounded-full bg-good grid place-items-center">
                <svg viewBox="0 0 24 24" className="w-12 h-12" fill="none" stroke="#ffffff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path className="ping-draw" d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </span>
            </div>
            <h2 id="ping-event-title" className="wrap-rise font-display text-[clamp(26px,7.4vw,34px)] leading-[1.1] mt-7" style={{ animationDelay: "0.35s" }}>
              Sent to {name}
            </h2>
            <p className="wrap-rise text-[15px] text-mute mt-2" style={{ animationDelay: "0.5s" }}>
              Your answer is on its way.
            </p>
            {offer && <AlertsOffer onEnable={onEnableAlerts} onDone={() => setOffer(false)} />}
            {offer && (
              <button ref={primary} onClick={() => leave(onFinish)} className="mt-6 h-12 px-8 rounded-2xl bg-ink text-paper text-[16px] font-semibold">
                Done
              </button>
            )}
          </>
        ) : (
          <>
            {incoming ? (
              <div className="relative w-28 h-28 grid place-items-center">
                <span className="ping-ring absolute inset-0 rounded-full" style={{ background: `${tone}33` }} />
                <span className="ping-ring ping-ring-2 absolute inset-0 rounded-full" style={{ background: `${tone}33` }} />
                <span className="wrap-pop relative w-24 h-24 rounded-full bg-ink text-paper grid place-items-center text-[38px] font-bold">
                  {name.trim().slice(0, 1).toUpperCase() || "?"}
                </span>
              </div>
            ) : (
              <span className="wrap-pop w-24 h-24 rounded-full grid place-items-center text-paper" style={{ background: tone }}>
                {result?.kind === "none" ? <X weight="bold" className="w-12 h-12" /> : <Check weight="bold" className="w-12 h-12" />}
              </span>
            )}

            <p className="wrap-rise mt-7 text-[13px] font-extrabold uppercase tracking-[0.14em]" style={{ color: tone, animationDelay: "0.15s" }}>
              {incoming ? "Ping" : "Ping answered"}
            </p>
            <h2 id="ping-event-title" className="wrap-rise font-display text-[clamp(26px,7.4vw,36px)] leading-[1.1] mt-2 break-words max-w-full" style={{ animationDelay: "0.25s" }}>
              {incoming ? `${name} is asking for attendance help` : result?.headline}
            </h2>
            <p className="wrap-rise text-[16px] text-mute mt-2.5 leading-snug" style={{ animationDelay: "0.35s" }}>
              {incoming ? `Did you mark them present? ${when}` : when}
            </p>

            <ul className="wrap-rise w-full mt-6 space-y-2 text-left" style={{ animationDelay: "0.45s" }}>
              {ping.items.map((i) => (
                <li key={i.key} className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[16px] font-semibold leading-snug truncate">{i.name}</span>
                    {i.t && <span className="block text-[13px] text-mute num">{formatTime(i.t)}</span>}
                  </span>
                  {incoming && each ? (
                    <span className="flex gap-1.5 flex-shrink-0">
                      {(["no", "yes"] as const).map((v) => (
                        <button
                          key={v}
                          onClick={() => setPicked((p) => ({ ...p, [i.key]: v }))}
                          aria-pressed={picked[i.key] === v}
                          className={`h-10 px-4 rounded-full text-[14px] font-semibold transition ${
                            picked[i.key] === v ? (v === "yes" ? "bg-good text-paper" : "bg-bad text-paper") : "bg-secondary text-mute"
                          }`}
                        >
                          {v === "yes" ? "Yes" : "No"}
                        </button>
                      ))}
                    </span>
                  ) : !incoming ? (
                    <span className={`rounded-full px-3 py-1 text-[13px] font-bold ${i.answer === "yes" ? "bg-good/15 text-good" : "bg-bad/10 text-bad"}`}>
                      {i.answer === "yes" ? "Present" : "Not covered"}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>

            {error && (
              <p role="alert" className="mt-4 text-[14px] font-medium text-bad leading-snug">
                {error}
              </p>
            )}

            {incoming ? (
              <div className="wrap-rise w-full mt-7" style={{ animationDelay: "0.55s" }}>
                {each ? (
                  <button
                    ref={primary}
                    disabled={!complete || phase === "sending"}
                    onClick={() => send(picked)}
                    className="w-full h-[56px] rounded-2xl bg-ink text-paper text-[17px] font-semibold disabled:opacity-40"
                  >
                    {phase === "sending" ? "Sending…" : "Send my answers"}
                  </button>
                ) : (
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      ref={primary}
                      disabled={phase === "sending"}
                      onClick={() => all("yes")}
                      className="h-[60px] rounded-2xl bg-good text-[#ffffff] dark:text-[#000000] text-[19px] font-extrabold tracking-wide disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <Check weight="bold" className="w-6 h-6" /> {phase === "sending" ? "Sending…" : "YES"}
                    </button>
                    <button
                      disabled={phase === "sending"}
                      onClick={() => all("no")}
                      className="h-[60px] rounded-2xl bg-card text-bad text-[19px] font-extrabold tracking-wide disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                      <X weight="bold" className="w-6 h-6" /> NO
                    </button>
                  </div>
                )}
                <div className="flex items-center justify-center gap-6 mt-4">
                  {ping.items.length > 1 && (
                    <button onClick={() => setEach(!each)} disabled={phase === "sending"} className="text-[14px] font-medium text-mute">
                      {each ? "Answer all at once" : "Answer each class"}
                    </button>
                  )}
                  <button onClick={() => leave(onLater)} disabled={phase === "sending"} className="text-[14px] font-medium text-mute">
                    Later
                  </button>
                </div>
                <p className="text-[12px] text-mute mt-4 leading-snug">YES marks that class present for {name}. Only say yes if you really did.</p>
              </div>
            ) : (
              <div className="wrap-rise w-full mt-7" style={{ animationDelay: "0.55s" }}>
                <p className="text-[14px] text-mute leading-snug mb-4">
                  {result && result.yes > 0
                    ? `Present marks go into your attendance automatically, and a favour is logged with ${name}.`
                    : "Nothing was changed in your attendance."}
                </p>
                {offer && <AlertsOffer onEnable={onEnableAlerts} onDone={() => setOffer(false)} />}
                <button ref={primary} onClick={() => leave(onAcknowledge)} className="w-full h-[56px] rounded-2xl bg-ink text-paper text-[17px] font-semibold">
                  Done
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** Shown once, only when notifications haven't been decided yet: the person has just seen what a Ping is worth */
function AlertsOffer({ onEnable, onDone }: { onEnable: () => Promise<boolean>; onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        await onEnable()
        setBusy(false)
        onDone()
      }}
      className="mt-6 mb-1 w-full max-w-xs mx-auto h-12 rounded-2xl bg-card text-[15px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
    >
      <Bell weight="fill" className="w-5 h-5" /> {busy ? "Asking…" : "Get an alert when mates Ping you"}
    </button>
  )
}
