"use client"

import { useEffect, useState } from "react"
import { Check, QrCode } from "@phosphor-icons/react"
import { formatTime, getAttendance, type ClassSlot } from "@/lib/attendance"
import { scanTargetKey, type ScanResult } from "@/lib/scan"
import type { Subject } from "@/lib/types"
import { useScrollLock } from "@/lib/use-scroll-lock"
import { copyText } from "@/lib/clipboard"
import { isInAppBrowser } from "@/lib/in-app"

/** The scan review is not committed until the person confirms their selection. */
export interface ScanState {
  result: ScanResult
  /** First class marked after confirmation, also used to tint the success animation. */
  marked: ClassSlot | null
  /** Only showing the animation: nothing was changed, so Undo just closes. */
  preview?: boolean
  phase?: "review" | "complete"
  /** Local date on which these slots were selected, to prevent a review crossing midnight. */
  date?: string
  /** Today's unchecked classes available for this scan review. */
  options?: ClassSlot[]
  /** The timing algorithm's unique match; checked by default, but fully deselectable. */
  suggested?: ClassSlot | null
  /** All classes actually marked by the confirmation. */
  completed?: ClassSlot[]
}

interface Props {
  scan: ScanState | null
  /** Live subjects, so percentages shown are the ones after the mark. */
  subjects: Subject[]
  onConfirm: (targets: ClassSlot[]) => void
  onUndo: () => void
  onClose: () => void
}

const BURST = Array.from({ length: 14 }, (_, i) => i)

const className = (c: ClassSlot) =>
  c.override?.kind === "substitute"
    ? `${c.attendanceSubject?.name ?? c.originalSubjectName ?? c.subject.name} (held as ${c.subject.name})`
    : c.subject.name

export default function ScanCheckIn({ scan, subjects, onConfirm, onUndo, onClose }: Props) {
  useScrollLock(!!scan)
  const [selectedKeys, setSelectedKeys] = useState<string[]>([])
  // Set defaults only when a new scan/review is opened. Toggling a checkbox does not reset the choice.
  useEffect(() => {
    if (scan?.phase === "review") setSelectedKeys(scan.suggested ? [scanTargetKey(scan.suggested)] : [])
  }, [scan])
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
  const options = scan.options ?? []
  const selected = options.filter((c) => selectedKeys.includes(scanTargetKey(c)))
  const suggestedKey = scan.suggested ? scanTargetKey(scan.suggested) : null
  const completed = scan.completed ?? (marked ? [marked] : [])
  const showSuccess = scan.phase === "complete" ? completed.length > 0 : Boolean(marked)
  const live = marked ? (subjects.find((s) => s.id === (marked.attendanceSubject ?? marked.subject).id) ?? (marked.attendanceSubject ?? marked.subject)) : null
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
      {showSuccess && (
        <div
          aria-hidden
          className="scan-wash pointer-events-none absolute inset-0"
          style={{ background: `radial-gradient(70% 50% at 50% 34%, ${tint}33, transparent 70%)` }}
        />
      )}

      <div className={`relative mx-auto min-h-dvh max-w-md px-5 py-8 flex flex-col items-center justify-center text-center ${scan.phase === "review" ? "justify-start" : ""}`}>
        {scan.phase === "review" && options.length > 0 ? (
          <div className="w-full pt-5 text-left">
            <div className="mx-auto w-14 h-14 rounded-2xl bg-card grid place-items-center text-mute">
              <QrCode weight="bold" className="w-7 h-7" />
            </div>
            <h2 className="font-display text-[clamp(26px,7vw,32px)] leading-[1.1] mt-5 text-center">Review attendance</h2>
            <p className="text-[14px] text-mute mt-3 leading-relaxed text-center">
              {scan.suggested
                ? "The timing rule suggests the class below, selected by default. You can uncheck it or add any earlier unchecked classes you attended. Nothing is marked until you confirm."
                : result.kind === "choose" && result.reason === "ambiguous"
                  ? "The timing windows overlap, so no lecture is preselected. Choose the class you attended, and add any other unchecked classes you attended today."
                  : result.kind === "choose" && result.reason === "several"
                    ? "Several classes match the current time. Nothing is preselected; choose the class you attended and any other unchecked classes you need to recover."
                    : result.kind === "already"
                      ? "The lecture matching this time is already marked. You can still select other unchecked classes from today."
                      : "No class could be selected confidently from the scan time. Choose the unchecked classes you attended today."}
            </p>

            <div className="mt-6 flex items-center justify-between gap-3">
              <p className="text-[12px] font-semibold uppercase tracking-wider text-mute">Unchecked classes today</p>
              <span className="rounded-full bg-card px-3 py-1 text-[12px] font-semibold tabular-nums">
                {selected.length} selected
              </span>
            </div>

            <div className="mt-3 space-y-2.5">
              {options.map((c) => {
                const key = scanTargetKey(c)
                const checked = selectedKeys.includes(key)
                const isSuggested = key === suggestedKey
                return (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={checked}
                    onClick={() => setSelectedKeys((current) =>
                      current.includes(key) ? current.filter((k) => k !== key) : [...current, key]
                    )}
                    className={`w-full rounded-2xl border px-4 py-3.5 text-left flex items-center gap-3 transition-colors ${checked ? "border-ink bg-card" : "border-line bg-paper"}`}
                  >
                    <span
                      aria-hidden
                      className={`w-6 h-6 shrink-0 rounded-md border grid place-items-center ${checked ? "border-ink bg-ink text-paper" : "border-line bg-card text-transparent"}`}
                    >
                      {checked && <Check weight="bold" className="w-4 h-4" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 flex-wrap">
                        <span className="text-[15px] font-semibold break-words">{className(c)}</span>
                        {isSuggested && (
                          <span className="rounded-full bg-good/15 text-good px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide">
                            Suggested
                          </span>
                        )}
                      </span>
                      <span className="num block text-[13px] text-mute mt-1">
                        {formatTime(c.slot.start)} – {formatTime(c.slot.end)}{c.slot.kind ? ` · ${c.slot.kind}` : ""}
                      </span>
                    </span>
                  </button>
                )
              })}
            </div>

            <div className="mt-7 grid gap-2.5">
              <button
                type="button"
                disabled={selected.length === 0}
                onClick={() => onConfirm(selected)}
                className="h-[52px] rounded-2xl bg-ink text-paper text-[16px] font-semibold disabled:opacity-35 disabled:cursor-not-allowed"
              >
                {selected.length === 0
                  ? "Select at least one class"
                  : `Mark ${selected.length} class${selected.length === 1 ? "" : "es"} present`}
              </button>
              <button type="button" onClick={onClose} className="h-11 text-[15px] font-medium text-mute">
                Cancel
              </button>
            </div>
            {inApp && <InAppNote />}
          </div>
        ) : showSuccess ? (
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
              {completed.length === 1 ? className(completed[0]) : `${completed.length} classes marked`}
            </h2>
            {completed.length === 1 ? (
              <p className="scan-rise scan-rise-2 num text-[15px] text-mute mt-2">
                {formatTime(completed[0].slot.start)} – {formatTime(completed[0].slot.end)}
                {completed[0].slot.kind ? ` · ${completed[0].slot.kind}` : ""}
              </p>
            ) : (
              <ul className="scan-rise scan-rise-2 mt-4 w-full max-w-sm space-y-2 text-left">
                {completed.map((c) => {
                  const owner = c.attendanceSubject ?? c.subject
                  const current = subjects.find((s) => s.id === owner.id) ?? owner
                  const currentInfo = getAttendance(current.attended, current.missed, current.requirement)
                  return (
                    <li key={scanTargetKey(c)} className="rounded-xl bg-card px-4 py-3 flex items-center gap-3">
                      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: tint }} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] font-semibold break-words">{className(c)}</span>
                        <span className="num block text-[12px] text-mute mt-0.5">
                          {formatTime(c.slot.start)} – {formatTime(c.slot.end)}
                        </span>
                      </span>
                      <span className="num text-[12px] font-semibold text-mute">{currentInfo.pct}%</span>
                    </li>
                  )
                })}
              </ul>
            )}
            {info && completed.length === 1 && (
              <p className="scan-rise scan-rise-3 mt-5 rounded-full bg-card px-4 py-2 text-[15px] font-semibold">
                <span className="num">{info.pct}%</span> <span className="text-mute font-medium">attendance now</span>
              </p>
            )}

            {inApp && <InAppNote />}

            <div className="scan-rise scan-rise-3 mt-10 w-full max-w-sm grid gap-3">
              <button onClick={onClose} className="h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold">
                Done
              </button>
              <button onClick={onUndo} className="h-11 text-[15px] font-medium text-mute">
                {completed.length > 1 ? "Undo all" : "Undo"}
              </button>
            </div>
          </>
        ) : (
          <>
            <Plain result={result} onClose={onClose} />
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

/** Error/fallback states where there are no unchecked classes to select. */
function Plain({ result, onClose }: { result: ScanResult; onClose: () => void }) {
  const [copied, setCopied] = useState<boolean | null>(null)
  let title = ""
  let body = ""
  if (result.kind === "already") {
    title = result.status === "P" ? "Already marked present" : "Already marked absent"
    body = result.target.override?.kind === "substitute"
      ? `${result.target.attendanceSubject?.name ?? result.target.originalSubjectName ?? result.target.subject.name}, held as ${result.target.subject.name}, ${formatTime(result.target.slot.start)}`
      : `${result.target.subject.name}, ${formatTime(result.target.slot.start)}`
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
    title = result.reason === "ambiguous" ? "Which class are you checking in for?" : "No class around this time"
    body =
      result.reason === "ambiguous"
        ? "A class just ended and another starts soon, so the tap could mean either."
        : "Pick the class you are at, or close this."
  } else {
    // Defensive fallback: a mark result normally always supplies its selected class in the review options.
    title = "Review attendance"
    body = "Choose an unchecked class from today, or close this screen."
  }

  return (
    <>
      <span className="w-16 h-16 rounded-full bg-card grid place-items-center text-mute">
        {result.kind === "already" ? <Check weight="bold" className="w-8 h-8" /> : <QrCode weight="bold" className="w-8 h-8" />}
      </span>
      <h2 className="font-display text-[clamp(24px,7vw,30px)] leading-[1.1] mt-6">{title}</h2>
      <p className="text-[15px] text-mute mt-2 leading-snug">{body}</p>

      {result.kind === "idle" && result.reason === "no-subjects" && (
        <button
          onClick={async () => setCopied(await copyText(`${window.location.origin}/scan`))}
          className="mt-6 h-11 px-5 rounded-2xl bg-card text-[15px] font-semibold"
        >
          {copied === null ? "Copy link" : copied ? "Link copied" : "Couldn’t copy"}
        </button>
      )}

      <button onClick={onClose} className="mt-8 h-11 px-6 text-[15px] font-medium text-mute">
        Close
      </button>
    </>
  )
}
