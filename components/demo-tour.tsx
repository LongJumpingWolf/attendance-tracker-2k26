"use client"

import { useEffect, useRef, useState } from "react"
import {
  ArrowLeft,
  ArrowRight,
  BellRinging,
  CalendarBlank,
  ChartLineUp,
  Check,
  CheckCircle,
  Clock,
  ListBullets,
  ShieldCheck,
  ShareNetwork,
  Sparkle,
  Tag,
  UserCircle,
  UsersThree,
  X,
} from "@phosphor-icons/react"

type Visual = "welcome" | "today" | "tomorrow" | "attendance" | "subjects" | "calendar" | "mates" | "account" | "notifications" | "finish"

interface DemoStep {
  eyebrow: string
  title: string
  body: string
  note: string
  visual: Visual
}

const STEPS: DemoStep[] = [
  {
    eyebrow: "A QUICK TOUR · 1 OF 10",
    title: "College life, a little more under control.",
    body: "College Tracker brings your classes, attendance, deadlines and proxy-mate coordination into one calm space.",
    note: "This is an illustrated product tour. Nothing on these cards edits your timetable or attendance.",
    visual: "welcome",
  },
  {
    eyebrow: "YOUR DAY · 2 OF 10",
    title: "Know what needs your attention now.",
    body: "Today's classes appear in time order. Mark a class Present or Absent, then check the attendance result without digging through menus.",
    note: "Always verify your actual attendance against your college records.",
    visual: "today",
  },
  {
    eyebrow: "PLAN AHEAD · 3 OF 10",
    title: "Tomorrow shouldn't be a surprise.",
    body: "The Lectures tomorrow widget shows the first four scheduled lectures. If there are more, it displays a remaining count. Tap it in the app to open Calendar on tomorrow.",
    note: "Cancelled classes are left out of the preview.",
    visual: "tomorrow",
  },
  {
    eyebrow: "ATTENDANCE · 4 OF 10",
    title: "Spot attendance risks at a glance.",
    body: "A compact ring for each subject helps you see where you stand relative to its minimum requirement. New subjects remain clearly marked as not yet established.",
    note: "The calculation depends on the marks and requirement you have entered.",
    visual: "attendance",
  },
  {
    eyebrow: "SUBJECTS · 5 OF 10",
    title: "Keep subjects tidy and editable.",
    body: "Organise subjects with tags and timetable slots. Open a subject to review its history, plan attendance, edit its settings or delete it with confirmation.",
    note: "A subject deletion affects that subject's saved attendance history; use the confirmation carefully.",
    visual: "subjects",
  },
  {
    eyebrow: "CALENDAR · 6 OF 10",
    title: "Classes and deadlines, in one place.",
    body: "Use Calendar to review a date, inspect scheduled classes, and add or update exam and assignment deadlines. Completed work can stay in your history.",
    note: "Keep your exam dates aligned with official college notices.",
    visual: "calendar",
  },
  {
    eyebrow: "MATES · 7 OF 10",
    title: "Make attendance coordination simpler.",
    body: "Quick WhatsApp Ping creates a temporary Yes/No link for selected classes. In-app Pings are available after Google sign-in and an accepted Mate connection.",
    note: "Only share a Ping link with the intended person: a response can update the attendance records you selected.",
    visual: "mates",
  },
  {
    eyebrow: "YOUR ACCOUNT · 8 OF 10",
    title: "Your profile and data tools belong together.",
    body: "Account brings together your Google sign-in, profile name, sync status, backup and restore, and reset controls. Your Google profile photo appears when available.",
    note: "Confirm that sync says Up to date on another device, and keep a recent backup before resetting or clearing browser data.",
    visual: "account",
  },
  {
    eyebrow: "NOTIFICATIONS · 9 OF 10",
    title: "Understand which alerts can reach you.",
    body: "Allowing browser notifications lets this device display alerts. Class reminders in this version run while the app is open; background Ping alerts additionally depend on browser support and server setup.",
    note: "Use Send me a test to check local display. One successful test does not guarantee background delivery.",
    visual: "notifications",
  },
  {
    eyebrow: "YOU'RE READY · 10 OF 10",
    title: "Now make College Tracker yours.",
    body: "Add your real subjects, review your timetable, choose the widgets you want and save a backup before relying on the app day to day.",
    note: "This tour never asks you to click through the live interface. Finish to return to your own data.",
    visual: "finish",
  },
]

function MiniCard({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl bg-card border border-ink/[0.06] shadow-sm ${className}`}>{children}</div>
}

function Preview({ visual }: { visual: Visual }) {
  if (visual === "welcome") {
    return (
      <div className="rounded-[28px] bg-ink p-5 text-paper min-h-[260px] flex flex-col justify-between">
        <div className="flex items-center justify-between"><span className="w-10 h-10 rounded-2xl bg-white/15 grid place-items-center"><Sparkle size={21} weight="duotone" /></span><span className="text-[11px] uppercase tracking-[0.16em] text-white/60">Your college companion</span></div>
        <div><p className="text-[12px] font-semibold uppercase tracking-widest text-white/65">Today, made clearer</p><h3 className="font-display text-[32px] leading-[1.06] mt-2">Less hunting.<br/>More knowing.</h3><p className="text-[13px] text-white/70 mt-3 leading-relaxed">Classes · Attendance · Deadlines · Mates</p></div>
        <div className="flex gap-2"><span className="rounded-full bg-white/15 px-3 py-1.5 text-[12px]">Local-first</span><span className="rounded-full bg-white/15 px-3 py-1.5 text-[12px]">Your choice</span></div>
      </div>
    )
  }
  if (visual === "today") {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between"><span className="text-[12px] uppercase tracking-widest text-mute font-bold">Today's classes</span><span className="text-[12px] text-mute">2 to mark</span></div>
        <MiniCard className="p-4"><div className="flex items-center justify-between text-[12px] text-mute"><span>09:00–10:00</span><span className="rounded-full bg-info/10 text-info px-2 py-1 font-bold">UP NEXT</span></div><h3 className="text-[22px] font-bold mt-3">Pathology</h3><p className="text-[13px] text-mute mt-1">74% attendance · 75% required</p><div className="grid grid-cols-2 gap-2 mt-4"><span className="rounded-xl bg-good text-white text-center py-2.5 font-semibold text-[13px]">✓ Present</span><span className="rounded-xl bg-secondary text-bad text-center py-2.5 font-semibold text-[13px]">Absent</span></div></MiniCard>
        <MiniCard className="flex items-center justify-between gap-3 p-3.5"><span><b className="block text-[14px]">Next up: Pharmacology</b><small className="text-mute">10:00–11:00</small></span><Clock size={20} className="text-mute"/></MiniCard>
      </div>
    )
  }
  if (visual === "tomorrow") {
    return (
      <div className="rounded-[26px] p-4 text-white min-h-[260px]" style={{background:"linear-gradient(145deg,#1e3a5f,#276c8e 58%,#479ca4)"}}>
        <p className="text-[11px] font-extrabold tracking-widest text-white/75 uppercase">Tomorrow · 7 lectures</p><h3 className="font-display text-[25px] mt-1">Lectures scheduled</h3>
        <div className="space-y-2 mt-4">{[["09:00","Pathology"],["10:00","Pharmacology"],["11:00","Microbiology"],["12:00","Community Medicine"]].map(([time,name])=><div key={time} className="flex items-center gap-3 rounded-xl bg-white/15 px-3 py-2.5"><span className="text-[12px] font-bold text-white/75 w-12">{time}</span><span className="text-[13px] font-semibold">{name}</span></div>)}</div>
        <p className="text-[12px] font-semibold mt-3 text-white/90">+ 3 more · Tap to open Calendar</p>
      </div>
    )
  }
  if (visual === "attendance") {
    return (
      <div className="grid grid-cols-2 gap-3">
        {[{name:"Pathology",pct:"74%",tone:"text-bad",note:"Attend next"},{name:"Pharmacology",pct:"82%",tone:"text-good",note:"On track"},{name:"ENT",pct:"—",tone:"text-mute",note:"New subject"},{name:"Microbiology",pct:"79%",tone:"text-warn",note:"1 skip left"}].map((item,i)=><MiniCard key={item.name} className="p-3.5"><div className="flex items-center gap-2.5"><div className="w-12 h-12 rounded-full border-[5px] border-secondary grid place-items-center"><span className={`text-[11px] font-bold ${item.tone}`}>{item.pct}</span></div><div className="min-w-0"><b className="block text-[13px] truncate">{item.name}</b><small className="text-[11px] text-mute">{item.note}</small></div></div></MiniCard>)}
      </div>
    )
  }
  if (visual === "subjects") {
    return (
      <MiniCard className="p-3.5">
        <div className="flex items-center justify-between mb-2"><b className="text-[13px]">Your subjects</b><span className="rounded-full bg-ink text-paper px-2.5 py-1 text-[11px]">+ Add</span></div>
        {[["Pathology","Theory"],["Pharmacology","Practical"],["Microbiology","Theory"]].map(([name,tag])=><div key={name} className="flex items-center justify-between gap-3 py-3 border-t border-ink/10"><span className="text-[14px] font-semibold">{name}</span><span className="rounded-full bg-secondary px-2.5 py-1 text-[11px] text-mute">{tag}</span></div>)}
        <p className="text-[12px] text-mute mt-2 flex items-center gap-2"><Tag size={15}/> Edit, plan or delete from subject details</p>
      </MiniCard>
    )
  }
  if (visual === "calendar") {
    return (
      <MiniCard className="p-4">
        <div className="flex items-center justify-between"><div><p className="text-[11px] text-mute uppercase tracking-widest font-bold">October 2026</p><h3 className="font-display text-[24px]">Thursday, 29</h3></div><CalendarBlank size={28}/></div>
        <div className="grid grid-cols-7 gap-1 mt-4 text-center text-[11px]">{["M","T","W","T","F","S","S"].map((day,i)=><span key={`${day}-${i}`} className="text-mute">{day}</span>)}</div>
        <div className="grid grid-cols-7 gap-1 mt-2 text-center">{Array.from({length:21},(_,i)=><span key={i} className={`h-8 rounded-lg grid place-items-center text-[12px] ${i===9 ? "bg-ink text-paper font-bold" : ""}`}>{i+1}</span>)}</div>
        <div className="rounded-xl bg-secondary p-3 mt-4"><p className="text-[11px] uppercase tracking-widest text-mute font-bold">Upcoming deadline</p><p className="text-[14px] font-semibold mt-1">Pediatrics case record · Tomorrow</p></div>
      </MiniCard>
    )
  }
  if (visual === "mates") {
    return (
      <div className="space-y-3">
        <MiniCard className="p-4"><div className="flex items-center gap-3"><span className="w-11 h-11 rounded-2xl bg-good/15 text-good grid place-items-center"><ShareNetwork size={20}/></span><div><b className="block text-[15px]">WhatsApp Ping · 24h</b><small className="text-mute">A private Yes/No link</small></div></div><div className="grid grid-cols-2 gap-2 mt-4"><span className="rounded-xl bg-good text-white py-2 text-center text-[13px] font-semibold">Yes</span><span className="rounded-xl bg-secondary text-ink py-2 text-center text-[13px] font-semibold">No</span></div></MiniCard>
        <MiniCard className="p-4 text-[13px] leading-relaxed text-mute">In-app Pings unlock after Google sign-in and the other person accepts your Mate connection.</MiniCard>
      </div>
    )
  }
  if (visual === "account") {
    return (
      <MiniCard className="p-4">
        <div className="flex items-center gap-3 border-b border-ink/10 pb-4"><span className="w-14 h-14 rounded-full bg-secondary grid place-items-center"><UserCircle size={38}/></span><span className="min-w-0"><b className="block text-[16px]">Your Google profile</b><small className="text-mute">Photo when available</small></span></div>
        {[["Account","Up to date"],["Backup & restore","Export or recover"],["Reset all data","Start fresh"]].map(([label,hint])=><div key={label} className="flex items-center justify-between gap-3 py-3 border-b last:border-b-0 border-ink/10"><b className="text-[13px]">{label}</b><small className="text-mute">{hint}</small></div>)}
      </MiniCard>
    )
  }
  if (visual === "notifications") {
    return (
      <MiniCard className="p-4">
        <div className="flex items-center gap-3"><span className="w-11 h-11 rounded-2xl bg-info/10 text-info grid place-items-center"><BellRinging size={22}/></span><span><b className="block text-[15px]">Notifications are on</b><small className="text-mute">Permission granted on this device</small></span></div>
        <div className="mt-4 space-y-2"><div className="rounded-xl bg-secondary px-3 py-3"><b className="text-[13px]">While the app is open</b><p className="text-[12px] text-mute mt-1">Class reminders can run here.</p></div><div className="rounded-xl bg-secondary px-3 py-3"><b className="text-[13px]">After you close it</b><p className="text-[12px] text-mute mt-1">Background delivery needs extra browser and server setup.</p></div></div>
      </MiniCard>
    )
  }
  return (
    <div className="rounded-[28px] bg-card border border-ink/10 p-5 min-h-[260px] flex flex-col justify-between">
      <span className="w-14 h-14 rounded-full bg-good/15 text-good grid place-items-center"><CheckCircle size={30}/></span>
      <div><h3 className="font-display text-[27px] leading-tight">Ready when you are.</h3><p className="text-[14px] text-mute mt-2">Start with your subjects. The rest can grow with your routine.</p></div>
      <div className="rounded-2xl bg-secondary p-3 flex items-center gap-2.5 text-[13px] font-semibold"><ShieldCheck size={18}/> Your real data returns when you finish.</div>
    </div>
  )
}

export default function DemoTour({ open, onEnd }: { open: boolean; onEnd: () => void }) {
  const [index, setIndex] = useState(0)
  const [chaptersOpen, setChaptersOpen] = useState(false)
  const touchStartX = useRef<number | null>(null)
  const step = STEPS[index]
  const last = index === STEPS.length - 1

  useEffect(() => {
    if (open) setIndex(0)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onEnd()
      if (event.key === "ArrowRight") setIndex((i) => Math.min(STEPS.length - 1, i + 1))
      if (event.key === "ArrowLeft") setIndex((i) => Math.max(0, i - 1))
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onEnd])

  if (!open) return null

  const previous = () => setIndex((i) => Math.max(0, i - 1))
  const next = () => last ? onEnd() : setIndex((i) => Math.min(STEPS.length - 1, i + 1))

  return (
    <div role="dialog" aria-modal="true" aria-label="College Tracker App guide" className="fixed inset-0 z-[100] flex flex-col bg-background text-foreground">
      <header className="flex items-center justify-between gap-3 px-4 sm:px-6 pt-[calc(env(safe-area-inset-top)+14px)] pb-3 border-b border-ink/10 flex-shrink-0">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.16em] font-bold text-mute">College Tracker</p>
          <p className="text-[13px] text-mute mt-0.5">App guide · {index + 1} of {STEPS.length}</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setChaptersOpen(true)} className="h-9 px-3 rounded-xl border border-ink/10 bg-card text-[12px] font-semibold inline-flex items-center gap-1.5"><ListBullets size={16}/> Chapters</button>
          <div className="hidden sm:flex gap-1.5" aria-label="Tour progress">{STEPS.map((s,i)=><span key={i} className={`h-1.5 w-5 rounded-full ${i===index ? "bg-ink" : "bg-ink/15"}`}/>)}</div>
          <button onClick={onEnd} aria-label="Close App guide" className="w-10 h-10 rounded-full bg-secondary text-ink grid place-items-center"><X size={18}/></button>
        </div>
      </header>
      {chaptersOpen && (
        <div className="fixed inset-0 z-[110] bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label="App guide chapters">
          <section className="w-full max-w-md max-h-[82dvh] rounded-[24px] bg-background text-foreground shadow-2xl overflow-hidden flex flex-col">
            <header className="px-4 py-3 border-b border-ink/10 flex items-center justify-between gap-3">
              <div><h2 className="font-bold text-[16px]">App guide chapters</h2><p className="text-[12px] text-mute mt-0.5">Jump straight to a feature.</p></div>
              <button type="button" onClick={() => setChaptersOpen(false)} aria-label="Close chapters" className="w-9 h-9 rounded-full bg-secondary grid place-items-center"><X size={17}/></button>
            </header>
            <div className="p-3 overflow-y-auto space-y-1.5">
              {STEPS.map((chapter, chapterIndex) => (
                <button key={chapter.eyebrow} type="button" onClick={() => { setIndex(chapterIndex); setChaptersOpen(false) }} className={chapterIndex === index ? "w-full rounded-xl p-3 text-left flex items-start gap-3 bg-secondary" : "w-full rounded-xl p-3 text-left flex items-start gap-3 hover:bg-secondary/70"}>
                  <span className="w-7 h-7 rounded-lg bg-card border border-ink/10 grid place-items-center text-[11px] font-bold flex-shrink-0">{chapterIndex + 1}</span>
                  <span className="min-w-0"><span className="block text-[10px] text-mute font-bold tracking-widest">{chapter.eyebrow.split(" · ")[0]}</span><span className="block text-[13px] font-semibold mt-0.5">{chapter.title}</span></span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      <main
        className="relative flex-1 min-h-0 overflow-y-auto touch-pan-y"
        onTouchStart={(event) => { touchStartX.current = event.changedTouches[0]?.clientX ?? null }}
        onTouchEnd={(event) => {
          const start = touchStartX.current
          touchStartX.current = null
          const end = event.changedTouches[0]?.clientX
          if (start === null || end === undefined) return
          const dx = end - start
          if (Math.abs(dx) < 48) return
          if (dx < 0) setIndex((i) => Math.min(STEPS.length - 1, i + 1))
          else setIndex((i) => Math.max(0, i - 1))
        }}
      >
        <div className="mx-auto grid min-h-full w-full max-w-5xl grid-cols-1 md:grid-cols-[0.92fr_1.08fr] items-center gap-5 sm:gap-8 px-5 sm:px-12 py-5 sm:py-8">
          <section className="space-y-4">
            <span className="inline-flex items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-[11px] font-extrabold tracking-widest text-mute"><Sparkle size={14}/> {step.eyebrow}</span>
            <h2 className="font-display text-[clamp(29px,5vw,46px)] leading-[1.04] tracking-tight">{step.title}</h2>
            <p className="text-[15px] sm:text-[16px] leading-relaxed text-mute">{step.body}</p>
            <div className="rounded-2xl border border-ink/10 bg-card/80 p-3.5 flex items-start gap-2.5"><span className="w-7 h-7 rounded-full bg-info/10 text-info grid place-items-center shrink-0"><ShieldCheck size={15}/></span><p className="text-[12px] leading-relaxed text-mute">{step.note}</p></div>
            <p className="text-[12px] text-mute sm:hidden">Swipe left or right to explore.</p>
          </section>
          <section aria-label="Illustrated app preview" className="w-full max-w-[460px] mx-auto md:max-w-none">
            <Preview visual={step.visual}/>
          </section>
        </div>
        <div className="hidden sm:flex pointer-events-none absolute inset-y-0 left-2 right-2 items-center justify-between">
          <button onClick={previous} disabled={index===0} aria-label="Previous card" className="pointer-events-auto w-10 h-10 rounded-full bg-card border border-ink/10 shadow-md text-ink grid place-items-center disabled:opacity-25"><ArrowLeft size={18}/></button>
          <button onClick={next} aria-label={last ? "Finish tour" : "Next card"} className="pointer-events-auto w-10 h-10 rounded-full bg-card border border-ink/10 shadow-md text-ink grid place-items-center">{last ? <Check size={18}/> : <ArrowRight size={18}/>}</button>
        </div>
      </main>

      <footer className="flex items-center justify-between gap-3 px-4 sm:px-6 pt-3 pb-[calc(env(safe-area-inset-bottom)+14px)] border-t border-ink/10 flex-shrink-0">
        <button onClick={previous} disabled={index===0} className="h-11 px-4 rounded-xl bg-secondary text-ink text-[14px] font-semibold disabled:opacity-35 sm:hidden">Back</button>
        <div className="flex items-center gap-1.5 sm:hidden" aria-label="Tour progress">{STEPS.map((s,i)=><span key={i} className={`h-1.5 w-2 rounded-full ${i===index ? "bg-ink w-4" : "bg-ink/20"}`}/>)}</div>
        <button onClick={next} className="h-11 min-w-32 px-5 rounded-xl bg-ink text-paper text-[14px] font-bold ml-auto">
          {last ? "Finish and return" : "Next card"}
        </button>
      </footer>
    </div>
  )
}
