"use client"

import { CaretLeft, Check, X, PencilSimple } from "@phosphor-icons/react"
import type { Subject } from "@/lib/types"
import {
  getAttendance,
  STATUS_STYLES,
  futureClassDates,
  projection,
  localDate,
  DAY_SHORT,
  formatTime,
} from "@/lib/attendance"
import ProgressRing from "./progress-ring"
import { SectionHeader } from "./sheet"

interface SubjectDetailProps {
  subject: Subject
  onBack: () => void
  onPresent: () => void
  onAbsent: () => void
  onEdit: () => void
  onPlan: (date: string, value: "attend" | "skip" | null) => void
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"]

export default function SubjectDetail({ subject, onBack, onPresent, onAbsent, onEdit, onPlan }: SubjectDetailProps) {
  const info = getAttendance(subject.attended, subject.missed, subject.requirement)
  const st = STATUS_STYLES[info.status]
  const dates = futureClassDates(subject, 35)
  const proj = projection(subject, dates)
  const plan = subject.plan || {}
  const classDates = new Set(dates)

  // Calendar: five weeks starting from the Sunday of the week containing tomorrow
  const t0 = new Date()
  const start = new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + 1)
  start.setDate(start.getDate() - start.getDay())
  const firstFuture = localDate(new Date(t0.getFullYear(), t0.getMonth(), t0.getDate() + 1))
  const cells = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i)
    return { date: localDate(d), day: d.getDate() }
  })

  const cycle = (date: string) => {
    const cur = plan[date]
    onPlan(date, !cur ? "skip" : cur === "skip" ? "attend" : null)
  }

  return (
    <div>
      <div className="flex items-center justify-between -mt-1 mb-2">
        <button onClick={onBack} className="flex items-center gap-0.5 text-[17px] text-ink -ml-1.5">
          <CaretLeft weight="bold" className="w-5 h-5" /> Subjects
        </button>
        <button
          onClick={onEdit}
          aria-label="Edit subject"
          className="w-9 h-9 grid place-items-center rounded-full bg-secondary text-ink"
        >
          <PencilSimple weight="bold" className="w-[18px] h-[18px]" />
        </button>
      </div>

      <div className="flex flex-col items-center text-center pt-2">
        <ProgressRing pct={info.pct} color={st.color} size={168} requirement={subject.requirement} />
        <h2 className="text-[clamp(22px,6.4vw,28px)] font-bold tracking-tight leading-tight mt-5 break-words max-w-full">{subject.name}</h2>
        {subject.tags?.length > 0 && <p className="text-[15px] text-mute mt-0.5">{subject.tags.join(" · ")}</p>}
        <p className={`text-[15px] font-medium mt-2 ${st.text}`}>{info.message}</p>
      </div>

      <div className="grid grid-cols-3 rounded-2xl bg-card mt-6 py-4 text-center">
        {[
          ["Attended", subject.attended],
          ["Missed", subject.missed],
          ["Required", `${subject.requirement}%`],
        ].map(([label, value], i) => (
          <div key={label} className={i > 0 ? "border-l border-ink/[0.08]" : ""}>
            <p className="num text-[24px] font-bold leading-none">{value}</p>
            <p className="text-[12px] text-mute mt-1.5">{label}</p>
          </div>
        ))}
      </div>
      {subject.slots && subject.slots.length > 0 && (
        <p className="text-[13px] text-mute text-center mt-3">
          {subject.slots.map((s) => DAY_SHORT[s.day]).join(", ")} · {formatTime(subject.slots[0].start)} –{" "}
          {formatTime(subject.slots[0].end)}
        </p>
      )}

      <div className="grid grid-cols-2 gap-3 mt-5">
        <button
          onClick={onPresent}
          className="h-[52px] rounded-2xl bg-good/10 text-good text-[17px] font-semibold flex items-center justify-center gap-2"
        >
          <Check weight="bold" className="w-5 h-5" /> Present
        </button>
        <button
          onClick={onAbsent}
          className="h-[52px] rounded-2xl bg-bad/10 text-bad text-[17px] font-semibold flex items-center justify-center gap-2"
        >
          <X weight="bold" className="w-5 h-5" /> Absent
        </button>
      </div>

      {/* Planner */}
      <section className="mt-9">
        <SectionHeader>Plan upcoming lectures</SectionHeader>
        {dates.length === 0 ? (
          <div className="rounded-2xl bg-card p-5">
            <p className="text-[15px] text-mute">
              Add class days and a time to this subject (tap the pencil) and its upcoming lectures show up here, so you
              can plan which to attend and which to skip.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl bg-card p-4">
            <p className="text-[13px] text-mute mb-3">Tap a lecture: once to skip, twice to attend, three times to clear.</p>
            <div className="grid grid-cols-7 gap-y-1.5">
              {WEEKDAYS.map((w, i) => (
                <span key={i} className="text-center text-[11px] font-semibold text-mute mb-1">
                  {w}
                </span>
              ))}
              {cells.map((c) => {
                const isClass = classDates.has(c.date)
                const value = plan[c.date]
                const past = c.date < firstFuture
                if (!isClass || past) {
                  return (
                    <span key={c.date} className={`h-10 grid place-items-center text-[14px] num ${past ? "text-mute/60" : "text-mute"}`}>
                      {c.day}
                    </span>
                  )
                }
                return (
                  <span key={c.date} className="h-10 grid place-items-center">
                    <button
                      onClick={() => cycle(c.date)}
                      aria-label={`${c.date}: ${value ?? "unplanned"}`}
                      className={`w-9 h-9 rounded-full grid place-items-center text-[14px] num font-semibold transition ${
                        value === "skip"
                          ? "bg-bad text-paper"
                          : value === "attend"
                            ? "bg-good text-paper"
                            : "border-[1.5px] border-ink/35 text-ink"
                      }`}
                    >
                      {c.day}
                    </button>
                  </span>
                )
              })}
            </div>
            <div className="flex gap-4 mt-3 text-[12px] text-mute">
              <span className="flex items-center gap-1.5">
                <i className="w-2.5 h-2.5 rounded-full bg-bad" /> Skip
              </span>
              <span className="flex items-center gap-1.5">
                <i className="w-2.5 h-2.5 rounded-full bg-good" /> Attend
              </span>
              <span className="flex items-center gap-1.5">
                <i className="w-2.5 h-2.5 rounded-full border border-ink/40" /> Unplanned
              </span>
            </div>
          </div>
        )}

        {dates.length > 0 && (
          <div className={`rounded-2xl p-5 mt-3 ${proj.ok ? "bg-good/15" : "bg-bad/15"}`}>
            <p className="text-[13px] text-mute">If you follow this plan</p>
            <p className={`num text-[40px] leading-none font-bold tracking-tight mt-1.5 ${proj.ok ? "text-good" : "text-bad"}`}>
              {proj.pct}
              <span className="text-[20px]">%</span>
            </p>
            <p className="text-[15px] mt-2.5 leading-snug">
              {proj.ok
                ? `You stay above the ${subject.requirement}% you need.`
                : `That is below the ${subject.requirement}% you need. Plan fewer skips.`}{" "}
              You can skip at most <b>{proj.maxSkips}</b> of the next {proj.F} lectures ({proj.skips} planned).
            </p>
          </div>
        )}
      </section>
    </div>
  )
}
