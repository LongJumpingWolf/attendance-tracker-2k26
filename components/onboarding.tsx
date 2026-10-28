"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, CalendarPlus, CheckCircle, PencilSimple, Sparkle } from "@phosphor-icons/react"
import type { Subject } from "@/lib/types"

interface Props {
  open: boolean
  /** Show scan-specific guidance when a first-time visitor arrives through the QR/NFC check-in link. */
  scanWelcome?: boolean
  /** Called after the setup guide is completed or skipped */
  onClose: () => void
  subjects: Subject[]
  currentName: string
  onSetName: (name: string) => void
  onImportTimetable: () => void
  onAddSubject: () => void
  notificationSupported: boolean
  notificationPermission: NotificationPermission | null
  onEnableNotifications: () => Promise<void>
  onOpenMates: () => void
  onToast: (message: string) => void
  showGoogleSyncPrompt: boolean
  onOpenAccount: () => void
}

function Choice({ icon, title, hint, onClick }: { icon: React.ReactNode; title: string; hint: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3.5 rounded-2xl border border-ink/10 bg-card p-4 text-left transition-colors hover:bg-secondary active:scale-[0.99]">
      <span className="w-11 h-11 rounded-xl grid place-items-center flex-shrink-0 bg-secondary text-ink">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-semibold leading-snug">{title}</span>
        <span className="block text-[12.5px] text-mute leading-snug mt-0.5">{hint}</span>
      </span>
      <ArrowRight size={17} className="text-mute flex-shrink-0" />
    </button>
  )
}

/**
 * A compact, full-screen first-run setup instead of a live-DOM product tour.
 * The consent gate is handled separately before this guide is shown.
 */
export default function Onboarding(p: Props) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState("")
  const touchStartX = useRef<number | null>(null)

  useEffect(() => {
    if (p.open) {
      let savedName = ""
      let savedStep = 0
      try {
        savedName = localStorage.getItem("attendance-onboarding-name-draft") || ""
        savedStep = Number(localStorage.getItem("attendance-onboarding-step-draft") || 0) === 1 ? 1 : 0
      } catch { /* fall back to the profile name */ }
      setStep(p.scanWelcome ? 0 : savedStep)
      setName(savedName || (p.currentName === "You" ? "" : p.currentName))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open, p.scanWelcome])
  // The profile name can arrive after the screen opens: fill an empty field with it, never replace what was typed
  useEffect(() => {
    if (p.open && p.currentName && p.currentName !== "You") setName((typed) => typed || p.currentName)
  }, [p.open, p.currentName])

  useEffect(() => {
    if (!p.open) return
    try { localStorage.setItem("attendance-onboarding-step-draft", String(step)) } catch {}
  }, [p.open, step])

  useEffect(() => {
    if (!p.open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") setStep(1)
      if (event.key === "ArrowLeft") setStep(0)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [p.open])

  if (!p.open) return null

  const saveName = () => {
    const cleaned = name.trim().replace(/\s+/g, " ").slice(0, 40)
    if (cleaned) {
      try { localStorage.setItem("attendance-onboarding-name-draft", cleaned) } catch {}
      p.onSetName(cleaned)
    }
  }

  const choose = (action: () => void) => {
    saveName()
    p.onClose()
    action()
  }

  const skip = () => {
    saveName()
    p.onClose()
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="first-run-title"
      className="fixed inset-0 z-[90] bg-background text-foreground flex flex-col"
      onTouchStart={(event) => { touchStartX.current = event.changedTouches[0]?.clientX ?? null }}
      onTouchEnd={(event) => {
        const start = touchStartX.current
        touchStartX.current = null
        const end = event.changedTouches[0]?.clientX
        if (start === null || end === undefined || Math.abs(end - start) < 55) return
        setStep(end < start ? 1 : 0)
      }}
    >
      <header className="w-full max-w-2xl mx-auto px-5 sm:px-8 pt-[calc(env(safe-area-inset-top)+14px)] pb-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.16em] font-bold text-mute">College Tracker</p>
          <p className="text-[13px] text-mute mt-0.5">A quick start · {step + 1} of 2</p>
        </div>
        <button type="button" onClick={skip} className="h-9 px-3 rounded-full text-[12px] font-medium text-mute hover:text-ink hover:bg-secondary">
          Skip setup
        </button>
      </header>

      <main className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4 sm:py-8 flex items-center justify-center">
        <div className="w-full max-w-lg mx-auto">
          <div className="flex gap-1.5 mb-6" aria-hidden="true">
            {[0,1].map(i => <span key={i} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-ink" : "bg-ink/15"}`} />)}
          </div>

          {step === 0 ? (
            <section className="space-y-6">
              <div className="rounded-[28px] bg-ink text-paper p-5 sm:p-7 min-h-[180px] flex flex-col justify-between">
                <span className="w-11 h-11 rounded-2xl bg-white/15 grid place-items-center"><Sparkle size={23} weight="duotone" /></span>
                <div className="mt-8">
                  <p className="text-[11px] uppercase tracking-[0.17em] font-bold text-white/60">{p.scanWelcome ? "YOU OPENED AN ATTENDANCE CHECK-IN LINK" : "One calm place for college"}</p>
                  <h1 id="first-run-title" className="font-display text-[clamp(30px,8vw,42px)] leading-[1.02] tracking-tight mt-2">{p.scanWelcome ? "Let’s get you ready to check in." : "Know where you stand."}</h1>
                  <p className="text-[14px] text-white/75 leading-relaxed mt-3">{p.scanWelcome ? "College Tracker helps you organise classes, track attendance and keep up with deadlines." : "Attendance, classes and deadlines—without digging through menus."}</p>
                </div>
              </div>

              {p.scanWelcome && (
                <div className="rounded-2xl border border-ink/10 bg-card p-4">
                  <p className="text-[14px] font-semibold">This browser isn’t set up yet.</p>
                  <p className="text-[13px] text-mute leading-relaxed mt-1">Add your timetable once. Future QR scans or NFC taps can then open your check-in. This first scan will not mark attendance.</p>
                </div>
              )}

              {!p.scanWelcome && <div>
                <label htmlFor="first-run-name" className="block text-[14px] font-semibold mb-2">What should we call you?</label>
                <input
                  id="first-run-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value)
                    try { localStorage.setItem("attendance-onboarding-name-draft", event.target.value) } catch {}
                  }}
                  onKeyDown={(event) => { if (event.key === "Enter") setStep(1) }}
                  placeholder="Your name"
                  maxLength={40}
                  autoComplete="nickname"
                  className="w-full h-12 rounded-xl bg-card border border-ink/15 px-4 text-[15px] outline-none focus:ring-2 focus:ring-ink/20"
                />
                <p className="text-[12px] text-mute leading-relaxed mt-2">Used on your profile and when friends connect with you. You can change it later in Account.</p>
              </div>}

              <button type="button" onClick={() => { saveName(); setStep(1) }} className="w-full h-12 rounded-xl bg-ink text-paper text-[15px] font-semibold inline-flex items-center justify-center gap-2">
                {p.scanWelcome ? "Set up my timetable" : "Continue"} <ArrowRight size={18} />
              </button>
              {p.scanWelcome && p.showGoogleSyncPrompt && (
                <button type="button" onClick={() => { saveName(); p.onOpenAccount() }} className="w-full h-11 rounded-xl bg-card border border-ink/10 text-[14px] font-semibold">
                  I already use College Tracker
                </button>
              )}
              <p className="text-[11px] text-mute text-center">{p.scanWelcome ? "You can also sign in to bring your existing timetable to this browser." : "Swipe left to continue. You can skip setup at any time."}</p>
            </section>
          ) : (
            <section className="space-y-5">
              <div>
                <p className="text-[11px] uppercase tracking-[0.16em] font-bold text-mute">START WITH YOUR TIMETABLE</p>
                <h2 className="font-display text-[clamp(27px,7vw,36px)] leading-[1.05] tracking-tight mt-2">How would you like to add your classes?</h2>
                <p className="text-[14px] leading-relaxed text-mute mt-3">{p.scanWelcome ? "Add your timetable here so future QR scans or NFC taps can match your check-in to a class. You can edit it any time." : "Choose one to get started. You can add or edit subjects later, and your first-visit guides will explain the other tabs when you open them."}</p>
              </div>

              <div className="space-y-3">
                <Choice
                  icon={<CalendarPlus size={23} weight="duotone" />}
                  title="Import timetable from a photo"
                  hint="Use the timetable helper, review the extracted details, then apply them."
                  onClick={() => choose(p.onImportTimetable)}
                />
                <Choice
                  icon={<PencilSimple size={23} weight="duotone" />}
                  title="Add subjects manually"
                  hint="Enter a subject, attendance requirement, and class days and times."
                  onClick={() => choose(p.onAddSubject)}
                />
              </div>

              {p.showGoogleSyncPrompt && (
                <section className="rounded-2xl border border-ink/10 bg-secondary/65 p-4">
                  <p className="text-[14px] font-semibold">{p.scanWelcome ? "Already use College Tracker?" : "Keep your progress across devices"}</p>
                  <p className="text-[12.5px] text-mute leading-relaxed mt-1">{p.scanWelcome ? "Sign in with Google to bring your existing timetable and attendance to this browser." : "Sign in with Google to sync your subjects and attendance. Nothing will sign in automatically."}</p>
                  <button type="button" onClick={() => { saveName(); p.onOpenAccount() }} className="mt-3 h-10 px-3.5 rounded-xl bg-ink text-paper text-[13px] font-semibold">{p.scanWelcome ? "Sign in and sync existing data" : "Set up Google sync"}</button>
                </section>
              )}

              {p.subjects.length > 0 && <p className="text-[13px] text-good font-semibold inline-flex items-center gap-2"><CheckCircle size={17} /> {p.subjects.length} subjects already added</p>}

              <div className="pt-2 flex items-center justify-between gap-3">
                <button type="button" onClick={() => setStep(0)} className="h-10 px-3 rounded-xl text-[13px] font-semibold text-ink hover:bg-secondary inline-flex items-center gap-1.5"><ArrowLeft size={16} /> Back</button>
                <button type="button" onClick={skip} className="h-10 px-3 rounded-xl text-[12px] font-medium text-mute hover:bg-secondary">I’ll set this up later</button>
              </div>
            </section>
          )}
        </div>
      </main>
    </div>
  )
}
