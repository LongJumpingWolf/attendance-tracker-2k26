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
  /** Explicitly approve integrating a result. The preference is only saved for this Mate. */
  onApproveIntegration: (ping: Ping, alwaysIntegrate: boolean) => Promise<{ ok: boolean; message: string }>
  /** Dismiss an answer without touching attendance. */
  onDeclineIntegration: (ping: Ping) => Promise<{ ok: boolean; message: string }>
  displayName?: string
  autoIntegrate?: boolean
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

function Inner({ event, onAnswer, onApproveIntegration, onDeclineIntegration, displayName, autoIntegrate = false, onFinish, onLater, onAcknowledge, alertsOffer, onEnableAlerts }: Props) {
  useScrollLock(true)
  const { ping } = event
  const incoming = event.kind === "incoming"
  const [phase, setPhase] = useState<"ask" | "sending" | "sent">("ask")
  const [error, setError] = useState("")
  const [each, setEach] = useState(true)
  const [picked, setPicked] = useState<Record<string, "yes" | "no">>({})
  const [alwaysIntegrate, setAlwaysIntegrate] = useState(false)
  const [integrationBusy, setIntegrationBusy] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [offer, setOffer] = useState(alertsOffer)
  const primary = useRef<HTMLButtonElement>(null)

  const when = `${whenLabel(ping.date)} · ${formatDayMonth(ping.date)}`
  const name = incoming ? ping.fromName : (displayName?.trim() || ping.toName)
  const result = incoming ? null : resultSummary(ping)
  const needsApproval = !incoming && ping.status === "answered"
  const approvalAutomatic = needsApproval && autoIntegrate

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

  const approve = async () => {
    if (integrationBusy) return
    setIntegrationBusy(true)
    setError("")
    try {
      const response = await onApproveIntegration(ping, alwaysIntegrate)
      if (!response.ok) {
        setError(response.message)
        return
      }
      leave(onAcknowledge)
    } catch {
      setError("Attendance wasn't changed. Check your connection and try again.")
    } finally {
      setIntegrationBusy(false)
    }
  }

  const decline = async () => {
    if (integrationBusy) return
    setIntegrationBusy(true)
    setError("")
    try {
      const response = await onDeclineIntegration(ping)
      if (!response.ok) {
        setError(response.message)
        return
      }
      leave(onAcknowledge)
    } catch {
      setError("Couldn't save your decision. Attendance was not changed; try again.")
    } finally {
      setIntegrationBusy(false)
    }
  }

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
              {incoming ? `${name} is asking for attendance help` : needsApproval ? `${name} replied to your Ping` : result?.headline.replace(ping.toName, name)}
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
                    <span className={`rounded-full px-3 py-1 text-[12px] font-bold ${i.answer === "yes" ? "bg-good/15 text-good" : "bg-bad/10 text-bad"}`}>
                      {needsApproval ? (i.answer === "yes" ? "Answered yes" : "Answered no") : (i.answer === "yes" ? "Present" : "Not covered")}
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
                <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <button
                    onClick={() => leave(onLater)}
                    disabled={phase === "sending"}
                    className="min-h-12 w-full rounded-2xl border border-ink/15 bg-card px-4 text-[15px] font-semibold text-ink transition hover:bg-secondary disabled:opacity-45 sm:w-auto"
                  >
                    Later
                  </button>
                  {ping.items.length > 1 && (
                    <button
                      onClick={() => { setEach(!each); setPicked({}) }}
                      disabled={phase === "sending"}
                      className="min-h-11 w-full rounded-2xl px-4 text-[14px] font-semibold text-info hover:bg-secondary disabled:opacity-45 sm:w-auto"
                    >
                      {each ? "Switch to one answer for all" : "Answer each class"}
                    </button>
                  )}
                </div>
                <p className="text-[12px] text-mute mt-4 leading-snug">A YES response can mark the selected class present for {name} after they approve the result.</p>
              </div>
            ) : (
              <div className="wrap-rise w-full mt-7 text-left" style={{ animationDelay: "0.55s" }}>
                {needsApproval ? (
                  <>
                    <div className="rounded-2xl border border-info/20 bg-info/5 p-4">
                      <p className="text-[16px] font-bold">Review before updating attendance</p>
                      <p className="text-[14px] text-mute leading-relaxed mt-1.5">
                        {result && result.yes > 0
                          ? `${result.yes} Yes response${result.yes === 1 ? "" : "s"} can mark your selected classes present. Nothing has been changed yet.`
                          : "Your mate answered No for all selected classes. Nothing has been changed."}
                      </p>
                    </div>
                    {!ping.shareLink && !autoIntegrate && (
                      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl bg-card p-3.5 text-[13px] leading-snug">
                        <input
                          type="checkbox"
                          checked={alwaysIntegrate}
                          onChange={(e) => setAlwaysIntegrate(e.target.checked)}
                          disabled={integrationBusy}
                          className="mt-0.5 h-4 w-4 flex-shrink-0 accent-current"
                        />
                        <span><b className="block text-[14px]">Don't ask me again for {name}</b><span className="text-mute">Automatically integrate replies from this Mate, including any already waiting for review. Change this later in the Mates list. One-time WhatsApp links always require approval.</span></span>
                      </label>
                    )}
                    {approvalAutomatic && (
                      <div role="status" className="mt-3 rounded-2xl bg-secondary p-3 text-[13px] text-mute leading-snug">
                        <p>Your saved preference allows this response to integrate automatically. Attendance is only considered updated after this device verifies the saved records.</p>
                        <button
                          onClick={() => void approve()}
                          disabled={integrationBusy}
                          className="mt-3 min-h-11 w-full rounded-xl bg-ink px-4 text-[14px] font-bold text-paper disabled:opacity-45"
                        >
                          {integrationBusy ? "Retrying integration…" : "Retry integration now"}
                        </button>
                      </div>
                    )}
                    {error && <p role="alert" className="mt-3 text-[13px] font-medium text-bad leading-snug">{error}</p>}
                    {!approvalAutomatic && (
                      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                        <button
                          onClick={() => void approve()}
                          disabled={integrationBusy}
                          className="min-h-[52px] w-full rounded-2xl bg-good px-4 text-[15px] font-bold text-paper disabled:opacity-45"
                        >
                          {integrationBusy ? "Saving decision…" : "Approve & update attendance"}
                        </button>
                        <button
                          onClick={() => void decline()}
                          disabled={integrationBusy}
                          className="min-h-[52px] w-full rounded-2xl border border-ink/15 bg-card px-4 text-[15px] font-semibold disabled:opacity-45"
                        >
                          Don't integrate
                        </button>
                      </div>
                    )}
                    <button
                      onClick={() => leave(onLater)}
                      disabled={integrationBusy}
                      className="mt-2 min-h-12 w-full rounded-2xl border border-ink/15 px-4 text-[15px] font-semibold text-mute hover:bg-secondary disabled:opacity-45"
                    >
                      Later — decide after reviewing
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-[14px] text-mute leading-snug mb-4">
                      {result && result.yes > 0
                        ? `Attendance was updated with ${result.yes} present mark${result.yes === 1 ? "" : "s"}; a favour is logged with ${name} for connected mates.`
                        : "Nothing was changed in your attendance."}
                    </p>
                    {offer && <AlertsOffer onEnable={onEnableAlerts} onDone={() => setOffer(false)} />}
                    <button ref={primary} onClick={() => leave(onAcknowledge)} className="w-full h-[56px] rounded-2xl bg-ink text-paper text-[17px] font-semibold">
                      Done
                    </button>
                  </>
                )}
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
