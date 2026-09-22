"use client"

import { useEffect, useState } from "react"
import { Check, QrCode } from "@phosphor-icons/react"
import { formatTime, getAttendance, type ClassSlot } from "@/lib/attendance"
import type { ScanResult } from "@/lib/scan"
import type { Subject } from "@/lib/types"
import { useScrollLock } from "@/lib/use-scroll-lock"
import { copyText } from "@/lib/clipboard"
import { isInAppBrowser } from "@/lib/in-app"

/** What the scan screen is showing: the outcome, and the class that was marked (if one was) */
export interface ScanState {
  result: ScanResult
  marked: ClassSlot | null
  /** Only showing the animation: nothing was changed, so Undo just closes */
  preview?: boolean
}

interface Props {
  scan: ScanState | null
  /** Live subjects, so the percentage shown is the one after the mark */
  subjects: Subject[]
  onPick: (target: ClassSlot) => void
  onUndo: (target: ClassSlot) => void
  onClose: () => void
}

const BURST = Array.from({ length: 14 }, (_, i) => i)

/**
 * The screen a scanned QR code or tapped NFC tag opens. Marking present here is the only place this celebration
 * plays; marking by hand on the Today tab stays quiet.
 */
export default function ScanCheckIn({ scan, subjects, onPick, onUndo, onClose }: Props) {
  useScrollLock(!!scan)
  // Apps that scan QR codes often open the link in their own built-in browser, which forgets everything when closed.
  const [inApp, setInApp] = useState(false)
  useEffect(() => setInApp(isInAppBrowser(navigator.userAgent)), [])
  useEffect(() => {
    if (!scan) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [scan, onClose])

  if (!scan) return null
  const { result, marked } = scan
  const live = marked ? (subjects.find((s) => s.id === marked.subject.id) ?? marked.subject) : null
  const info = live ? getAttendance(live.attended, live.missed, live.requirement) : null
  const tint = marked && /^#[0-9a-f]{6}$/i.test(marked.subject.glowColor) ? marked.subject.glowColor : "#30d158"

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Scan check-in"
      className="fixed inset-0 z-[70] bg-paper overflow-y-auto overscroll-contain no-scrollbar"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {marked && (
        <div
          aria-hidden
          className="scan-wash pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(70% 50% at 50% 34%, ${tint}33, transparent 70%)` }}
        />
      )}

      <div className="relative mx-auto min-h-dvh max-w-md px-6 py-10 flex flex-col items-center justify-center text-center">
        {marked ? (
          <>
            <div className="relative w-36 h-36 grid place-items-center">
              <span className="scan-ring absolute inset-0 rounded-full" style={{ borderColor: tint }} />
              <span className="scan-ring scan-ring-late absolute inset-0 rounded-full" style={{ borderColor: tint }} />
              {BURST.map((i) => (
                <span
                  key={i}
                  aria-hidden
                  className="scan-dot absolute left-1/2 top-1/2 w-2 h-2 rounded-full"
                  style={{ background: tint, ["--a" as string]: `${(360 / BURST.length) * i}deg`, ["--d" as string]: `${74 + (i % 3) * 14}px` }}
                />
              ))}
              <span className="scan-disc relative w-28 h-28 rounded-full grid place-items-center" style={{ background: tint }}>
                <svg viewBox="0 0 52 52" className="w-14 h-14" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path className="scan-tick" d="M14 27 l8 8 l16 -17" />
                </svg>
              </span>
            </div>

            <p className="scan-rise mt-8 text-[13px] font-semibold uppercase tracking-wider text-good">Marked present</p>
            <h2 className="scan-rise scan-rise-2 font-display text-[clamp(28px,8vw,38px)] leading-[1.1] mt-1.5 break-words max-w-full">
              {marked.subject.name}
            </h2>
            <p className="scan-rise scan-rise-2 num text-[15px] text-mute mt-2">
              {formatTime(marked.slot.start)} – {formatTime(marked.slot.end)}
              {marked.slot.kind ? ` · ${marked.slot.kind}` : ""}
            </p>
            {info && (
              <p className="scan-rise scan-rise-3 mt-5 rounded-full bg-card px-4 py-2 text-[15px] font-semibold">
                <span className="num">{info.pct}%</span> <span className="text-mute font-medium">attendance now</span>
              </p>
            )}

            {inApp && <InAppNote />}

            <div className="scan-rise scan-rise-3 mt-10 w-full grid gap-3">
              <button onClick={onClose} className="h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold">
                Done
              </button>
              <button onClick={() => onUndo(marked)} className="h-11 text-[15px] font-medium text-mute">
                Undo
              </button>
            </div>
          </>
        ) : (
          <>
            <Plain result={result} onPick={onPick} onClose={onClose} />
            {inApp && <InAppNote />}
          </>
        )}
      </div>
    </div>
  )
}

function InAppNote() {
  return (
    <p className="mt-6 rounded-2xl bg-warn/15 text-warn text-[13px] font-medium leading-snug px-4 py-3">
      This looks like a scanner app&rsquo;s built-in browser, which forgets your data each time. Scan with your phone&rsquo;s camera instead, or
      tap the browser&rsquo;s menu and open the link in Safari or Chrome.
    </p>
  )
}

/** Every outcome that is not a mark: already marked, nothing today, or a choice to make */
function Plain({ result, onPick, onClose }: { result: ScanResult; onPick: (t: ClassSlot) => void; onClose: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  let title = ""
  let body = ""
  if (result.kind === "already") {
    title = result.status === "P" ? "Already marked present" : "Already marked absent"
    body = `${result.target.subject.name}, ${formatTime(result.target.slot.start)}`
  } else if (result.kind === "idle") {
    title =
      result.reason === "no-subjects" ? "No subjects yet" : result.reason === "no-classes" ? "No classes today" : "Everything is marked"
    body =
      result.reason === "no-subjects"
        ? "This browser has no timetable. It is kept separately in each browser and in the home-screen app, so open this link where you use the app (Safari, if that is where you added your subjects)."
        : result.reason === "no-classes"
          ? "Your timetable has nothing on for today."
          : "Every class today already has a mark."
  } else if (result.kind === "choose") {
    title = result.reason === "several" ? "Which class is this?" : "No class around this time"
    body =
      result.reason === "several"
        ? "Two classes fit right now. Pick yours."
        : "Pick the class you are at, or close this."
  }

  return (
    <>
      <span className="w-16 h-16 rounded-full bg-card grid place-items-center text-mute">
        {result.kind === "already" ? <Check weight="bold" className="w-8 h-8" /> : <QrCode weight="bold" className="w-8 h-8" />}
      </span>
      <h2 className="font-display text-[clamp(24px,7vw,30px)] leading-[1.1] mt-6">{title}</h2>
      <p className="text-[15px] text-mute mt-2 leading-snug">{body}</p>

      {result.kind === "choose" && (
        <ul className="mt-6 w-full space-y-2.5">
          {result.options.map((c) => (
            <li key={`${c.subject.id}-${c.slot.start}`}>
              <button
                onClick={() => onPick(c)}
                className="w-full rounded-2xl bg-card px-4 py-3.5 text-left flex items-center gap-3"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold truncate">{c.subject.name}</span>
                  <span className="num block text-[13px] text-mute">
                    {formatTime(c.slot.start)} – {formatTime(c.slot.end)}
                  </span>
                </span>
                <span className="text-[13px] font-semibold text-good">Present</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {result.kind === "idle" && result.reason === "no-subjects" && (
        <button
          onClick={async () => setCopied(await copyText(`${window.location.origin}/scan`))}
          className="mt-6 h-11 px-5 rounded-2xl bg-card text-[15px] font-semibold"
        >
          {copied === null ? "Copy link" : copied ? "Link copied" : "Couldn’t copy"}
        </button>
      )}

      <button onClick={onClose} className="mt-8 h-11 px-6 text-[15px] font-medium text-mute">
        {result.kind === "choose" ? "Cancel" : "Close"}
      </button>
    </>
  )
}
