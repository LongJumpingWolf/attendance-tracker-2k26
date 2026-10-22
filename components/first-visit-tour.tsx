"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  CalendarBlank,
  CheckCircle,
  ClipboardText,
  Clock,
  Sparkle,
  Tag,
  UsersThree,
  X,
} from "@phosphor-icons/react"

export type GuidedTab = "subjects" | "calendar" | "mates"

interface TourCard {
  eyebrow: string
  title: string
  body: string
  bullets: string[]
  visual: "subjects" | "calendar" | "mates"
}

const TOURS: Record<GuidedTab, TourCard[]> = {
  subjects: [
    {
      eyebrow: "SUBJECTS · 1 OF 2",
      title: "Your subjects, easy to scan.",
      body: "This is the home for each course and its attendance record.",
      bullets: ["See attendance and minimum requirements together.", "Use tags to group theory, practicals or postings.", "Open a subject for its history and timetable."],
      visual: "subjects",
    },
    {
      eyebrow: "SUBJECTS · 2 OF 2",
      title: "Keep every record in your control.",
      body: "Add a subject manually or bring in a timetable photo from Today. You can edit class slots whenever your college schedule changes.",
      bullets: ["Use the subject menu to edit or delete with confirmation.", "Back up your data from Settings → Account.", "Check your actual college attendance if anything looks off."],
      visual: "subjects",
    },
  ],
  calendar: [
    {
      eyebrow: "CALENDAR · 1 OF 2",
      title: "See a whole day before it begins.",
      body: "Calendar combines scheduled classes, attendance marks and planned deadlines for the date you select.",
      bullets: ["Choose a date to review its classes.", "Add exam or assignment deadlines.", "Mark holidays where your college is closed."],
      visual: "calendar",
    },
    {
      eyebrow: "CALENDAR · 2 OF 2",
      title: "Use it as your planning view.",
      body: "The deadline list is grouped by urgency so overdue work and upcoming tasks are easier to spot.",
      bullets: ["Keep dates aligned with official notices.", "Complete a task when it is finished.", "The Today lecture card opens Calendar on tomorrow."],
      visual: "calendar",
    },
  ],
  mates: [
    {
      eyebrow: "MATES · 1 OF 2",
      title: "Coordinate attendance with friends.",
      body: "Mates helps you connect accounts and keep a record of attendance-cover requests and favours.",
      bullets: ["Sign in with Google to use account-linked features.", "Connect with a friend's unique account code.", "The other person must accept a connection."],
      visual: "mates",
    },
    {
      eyebrow: "MATES · 2 OF 2",
      title: "Share Pings carefully.",
      body: "Quick WhatsApp Ping creates a temporary Yes/No link for selected classes; In-app Ping is for accepted Mate connections.",
      bullets: ["Only share a link with the intended person.", "A Yes response can update the selected attendance records.", "A Ping response is coordination, not independent proof of attendance."],
      visual: "mates",
    },
  ],
}

function Preview({ visual }: { visual: TourCard["visual"] }) {
  if (visual === "subjects") return (
    <div className="space-y-2.5">
      {[["Pathology","74%","text-warn"],["Pharmacology","82%","text-good"],["Microbiology","79%","text-info"]].map(([name,pct,tone]) => (
        <div key={name} className="rounded-xl border border-ink/10 bg-card px-3.5 py-3 flex items-center gap-3">
          <span className={`w-10 h-10 rounded-full border-4 border-secondary grid place-items-center text-[10px] font-bold ${tone}`}>{pct}</span>
          <span className="flex-1 min-w-0"><b className="block text-[13px]">{name}</b><small className="text-mute">Attendance summary</small></span>
          <Tag size={16} className="text-mute"/>
        </div>
      ))}
    </div>
  )
  if (visual === "calendar") return (
    <div className="rounded-2xl border border-ink/10 bg-card p-4">
      <div className="flex items-center justify-between"><span className="text-[12px] font-bold uppercase tracking-widest text-mute">Selected day</span><CalendarBlank size={22}/></div>
      <div className="grid grid-cols-7 gap-1.5 mt-4 text-center">{["M","T","W","T","F","S","S"].map((day,i)=><span key={i} className="text-[11px] text-mute">{day}</span>)}</div>
      <div className="grid grid-cols-7 gap-1.5 mt-2 text-center">{Array.from({length:14},(_,i)=><span key={i} className={`h-8 rounded-lg grid place-items-center text-[12px] ${i===3 ? "bg-ink text-paper font-bold" : "bg-secondary"}`}>{i+1}</span>)}</div>
      <div className="rounded-xl bg-secondary p-3 mt-4 flex items-center gap-3"><Clock size={18}/><span><b className="block text-[13px]">Upcoming deadline</b><small className="text-mute">Exam or assignment</small></span></div>
    </div>
  )
  return (
    <div className="space-y-3">
      <div className="rounded-2xl border border-ink/10 bg-card p-4 flex items-center gap-3"><span className="w-10 h-10 rounded-xl bg-good/10 text-good grid place-items-center"><UsersThree size={22}/></span><span><b className="block text-[14px]">Quick WhatsApp Ping</b><small className="text-mute">Temporary Yes/No link</small></span></div>
      <div className="grid grid-cols-2 gap-2"><div className="rounded-xl bg-good/10 text-good p-3 text-center text-[13px] font-semibold">Yes</div><div className="rounded-xl bg-secondary p-3 text-center text-[13px] font-semibold">No</div></div>
      <div className="rounded-xl bg-secondary p-3 flex gap-2.5"><ClipboardText size={18}/><p className="text-[12px] text-mute leading-snug">Connected friends and requests appear here.</p></div>
    </div>
  )
}

export default function FirstVisitTour({ page, onClose }: { page: GuidedTab | null; onClose: () => void }) {
  const [step, setStep] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const cards = page ? TOURS[page] : []
  const card = cards[step]
  const final = step >= cards.length - 1

  useEffect(() => setStep(0), [page])

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0
  }, [page, step])

  useEffect(() => {
    if (!page) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose()
      if (event.key === "ArrowRight") setStep((v) => Math.min(cards.length - 1, v + 1))
      if (event.key === "ArrowLeft") setStep((v) => Math.max(0, v - 1))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [page, onClose, cards.length])

  if (!page || !card) return null

  const next = () => final ? onClose() : setStep((v) => Math.min(cards.length - 1, v + 1))
  const previous = () => setStep((v) => Math.max(0, v - 1))

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="first-visit-title" className="fixed inset-0 z-[100] bg-black/45 backdrop-blur-[2px] flex items-center justify-center p-3 sm:p-4 overflow-hidden">
      <div
        className="w-full max-w-md max-h-[90dvh] flex flex-col overflow-hidden rounded-[28px] bg-background text-foreground shadow-2xl"
        onTouchStart={(event) => { touchStartX.current = event.changedTouches[0]?.clientX ?? null }}
        onTouchEnd={(event) => {
          const startX = touchStartX.current
          touchStartX.current = null
          const endX = event.changedTouches[0]?.clientX
          if (startX === null || endX === undefined || Math.abs(endX - startX) < 48) return
          if (endX < startX) next()
          else previous()
        }}
      >
        <header className="flex-shrink-0 px-4 pt-4 pb-2 flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-bold tracking-[0.16em] uppercase text-mute">FIRST VISIT GUIDE</p>
            <p className="text-[12px] text-mute mt-1">{step + 1} of {cards.length} · {page === "mates" ? "Mates" : page === "calendar" ? "Calendar" : "Subjects"}</p>
          </div>
          <button type="button" onClick={onClose} className="text-[12px] underline underline-offset-2 text-mute hover:text-ink rounded-lg p-1.5" aria-label="Skip this guide">Skip guide</button>
        </header>
        <div ref={contentRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2 pb-3">
          <div className="rounded-2xl bg-secondary p-3"><Preview visual={card.visual}/></div>
          <p className="text-[10px] font-extrabold tracking-[0.15em] uppercase text-mute mt-3">{card.eyebrow}</p>
          <h2 id="first-visit-title" className="font-display text-[24px] leading-[1.08] tracking-tight mt-1.5">{card.title}</h2>
          <p className="text-[13px] text-mute leading-relaxed mt-2">{card.body}</p>
          <ul className="mt-3 space-y-2">{card.bullets.map((bullet) => <li key={bullet} className="flex gap-2 text-[12px] leading-snug"><CheckCircle size={16} className="text-good flex-shrink-0 mt-0.5"/><span>{bullet}</span></li>)}</ul>
        </div>
        <footer className="flex-shrink-0 border-t border-ink/10 bg-background px-4 pt-2 pb-3">
          <div className="flex gap-1.5 mb-2" aria-hidden="true">{cards.map((item, index) => <span key={item.eyebrow} className={index === step ? "h-1.5 flex-1 rounded-full bg-ink" : "h-1.5 flex-1 rounded-full bg-ink/15"}/>)}</div>
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={previous} disabled={step === 0} className="h-10 px-2 rounded-xl text-[13px] font-semibold text-ink disabled:opacity-30 inline-flex items-center gap-1"><ArrowLeft size={16}/> Back</button>
            <p className="text-[10px] text-mute">Swipe between slides</p>
            <button type="button" onClick={next} className="h-11 px-4 rounded-xl bg-ink text-paper text-[14px] font-bold inline-flex items-center gap-1.5">{final ? "Got it" : "Next"} {!final && <ArrowRight size={16}/>}</button>
          </div>
        </footer>
      </div>
    </div>
  )
}
