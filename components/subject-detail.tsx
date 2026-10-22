"use client"

import { CaretLeft, Check, X, PencilSimple, DownloadSimple, SpinnerGap, Trash } from "@phosphor-icons/react"
import { useRef, useState } from "react"
import ClassActionMenu from "./class-action-menu"
import type { ScheduleOverride, Subject } from "@/lib/types"
import {
  getAttendance,
  STATUS_STYLES,
  futureClassDates,
  projection,
  localDate,
  DAY_SHORT,
  formatTime,
  classesOn,
  isSubjectSleeping,
  markFor,
  slotMeta,
  recentMarks,
  formatShortDate,
  type MarkMeta,
} from "@/lib/attendance"
import ProgressRing from "./progress-ring"
import { downloadMonthlySubjectReport } from "@/lib/monthly-report"
import { SectionHeader } from "./sheet"

interface SubjectDetailProps {
  subject: Subject
  allSubjects?: Subject[]
  scheduleOverrides?: ScheduleOverride[]
  onClassActions?: (target: { subjectId: string; date: string; slot: { day: number; start: string; end: string; kind?: string }; subjectName?: string }) => void
  onSleep?: (subject: Subject) => void
  onBack: () => void
  /** The same call Today makes, so both screens write the same record for the same class */
  onSet: (date: string, status: "P" | "A" | null, meta?: MarkMeta) => void
  onEdit: () => void
  onDelete: () => void
  onPlan: (date: string, value: "attend" | "skip" | null) => void
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"]

export default function SubjectDetail({ subject, allSubjects = [subject], scheduleOverrides = [], onClassActions, onSleep, onBack, onSet, onEdit, onDelete, onPlan }: SubjectDetailProps) {
  const [reportBusy, setReportBusy] = useState(false)
  const reportActionRef = useRef(false)
  const [reportNotice, setReportNotice] = useState("")
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

  // Today's real classes of this subject. A subject with no timetable at all has a single "any time" class a day.
  const today = localDate()
  const todays = classesOn(allSubjects, new Date(), scheduleOverrides).filter((entry) => (entry.originalSubjectId ?? entry.subject.id) === subject.id && !entry.cancelled)
  const noTimetable = !(subject.slots && subject.slots.length > 0)

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
        <div className="flex items-center gap-2">
          <button
            onClick={async () => {
              if (reportActionRef.current) return
              reportActionRef.current = true
              setReportBusy(true)
              setReportNotice("")
              try {
                const result = await downloadMonthlySubjectReport(subject, scheduleOverrides)
                if (result === "downloaded") setReportNotice("The share sheet was busy or unavailable, so the report image was saved instead.")
                else if (result === "busy") setReportNotice("A monthly report is already being prepared. Please wait a moment.")
              } catch (error) {
                setReportNotice(error instanceof Error ? error.message : "Could not create the monthly report. Please try again.")
              } finally {
                reportActionRef.current = false
                setReportBusy(false)
              }
            }}
            disabled={reportBusy}
            aria-busy={reportBusy}
            aria-label={reportBusy ? "Preparing monthly report" : `Share ${subject.name} monthly attendance report`}
            title={reportBusy ? "Preparing monthly report…" : "Share monthly report image"}
            className="w-9 h-9 grid place-items-center rounded-full bg-secondary text-ink disabled:opacity-55"
          >
            {reportBusy ? <SpinnerGap weight="bold" className="w-[18px] h-[18px] animate-spin" /> : <DownloadSimple weight="bold" className="w-[18px] h-[18px]" />}
          </button>
          {onSleep && <ClassActionMenu subject={subject} onSleep={onSleep} />}
          <button
            onClick={onEdit}
            aria-label="Edit subject"
            title="Edit subject"
            className="w-9 h-9 grid place-items-center rounded-full bg-secondary text-ink"
          >
            <PencilSimple weight="bold" className="w-[18px] h-[18px]" />
          </button>
          <button
            onClick={onDelete}
            aria-label="Delete subject"
            title="Delete subject"
            className="w-9 h-9 grid place-items-center rounded-full bg-bad/10 text-bad"
          >
            <Trash weight="bold" className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
      {reportNotice && (
        <p role="status" aria-live="polite" className="mt-2 rounded-xl bg-secondary px-3 py-2 text-[12px] text-mute">
          {reportNotice}
        </p>
      )}

      <div className="flex flex-col items-center text-center pt-2">
        <ProgressRing pct={info.pct} color={st.color} size={168} requirement={subject.requirement} />
        <h2 className="text-[clamp(22px,6.4vw,28px)] font-bold tracking-tight leading-tight mt-5 break-words max-w-full">{subject.name}</h2>
        {subject.tags?.length > 0 && <p className="text-[15px] text-mute mt-0.5">{subject.tags.join(" · ")}</p>}
        {subject.sleeping && (subject.sleepUntil === "forever" || !subject.sleepUntil || subject.sleepUntil >= today) && <p className="mt-2 rounded-full bg-secondary px-3 py-1 text-[12px] font-semibold text-mute">{isSubjectSleeping(subject, today) ? "Sleeping" : "Sleep scheduled"} · {subject.sleepFrom && subject.sleepFrom > today ? `from ${subject.sleepFrom} · ` : ""}{subject.sleepUntil === "forever" || !subject.sleepUntil ? "until manually woken" : `through ${subject.sleepUntil}`}</p>}
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

      {/* Today's class(es): the same marks Today shows. Marked already means it shows that state, never a second count. */}
      <section className="mt-5" aria-label="Today">
        {noTimetable || todays.length > 0 ? (
          <div className="space-y-3">
            {(noTimetable ? [{ slot: null as null | (typeof todays)[number]["slot"], subject }] : todays).map((c) => {
              const slot = c.slot
              const state = markFor(subject, today, slot?.start ?? "")
              const meta = slotMeta(slot)
              return (
                <div key={slot?.start ?? "any"} data-testid="today-class">
                  <p className="text-[13px] text-mute mb-1.5 px-1">
                    {slot ? `Today · ${formatTime(slot.start)} – ${formatTime(slot.end)}${slot.kind ? ` · ${slot.kind}` : ""}` : "Today · any time"}
                    {"override" in c && c.override?.kind === "substitute" && <span className="block text-info">Conducted as {c.subject.name}; attendance is recorded under {subject.name}</span>}
                    {state && <span data-testid="today-state">{state === "P" ? " · Marked present" : " · Marked absent"}</span>}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => onSet(today, "P", meta)}
                      aria-pressed={state === "P"}
                      className={`h-[52px] rounded-2xl text-[17px] font-semibold flex items-center justify-center gap-2 ${
                        state === "P" ? "bg-good text-paper" : "bg-good/10 text-good"
                      }`}
                    >
                      <Check weight="bold" className="w-5 h-5" /> Add Present
                    </button>
                    <button
                      onClick={() => onSet(today, "A", meta)}
                      aria-pressed={state === "A"}
                      className={`h-[52px] rounded-2xl text-[17px] font-semibold flex items-center justify-center gap-2 ${
                        state === "A" ? "bg-bad text-paper" : "bg-bad/10 text-bad"
                      }`}
                    >
                      <X weight="bold" className="w-5 h-5" /> Add Absent
                    </button>
                  </div>
                  {state && (
                    <button onClick={() => onSet(today, null, meta)} className="block mx-auto mt-2 text-[13px] text-mute">
                      Clear today&rsquo;s mark
                    </button>
                  )}
                  {slot && onClassActions && <div className="flex justify-end"><ClassActionMenu subject={subject} target={{ subjectId: ("originalSubjectId" in c ? c.originalSubjectId : undefined) ?? subject.id, date: today, slot, subjectName: ("originalSubjectName" in c ? c.originalSubjectName : undefined) ?? subject.name }} onReplace={onClassActions} onCancel={onClassActions} /></div>}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="rounded-2xl bg-card px-4 py-4">
            <p className="text-[14px] text-mute text-center mb-3">No class scheduled today. You can still record a quick attendance mark for this subject.</p>
            <div className="grid grid-cols-2 gap-3">
              <button onClick={() => onSet(today, "P")} className="h-[52px] rounded-2xl bg-good/10 text-good text-[16px] font-semibold flex items-center justify-center gap-2"><Check weight="bold" className="w-5 h-5"/>Add Present</button>
              <button onClick={() => onSet(today, "A")} className="h-[52px] rounded-2xl bg-bad/10 text-bad text-[16px] font-semibold flex items-center justify-center gap-2"><X weight="bold" className="w-5 h-5"/>Add Absent</button>
            </div>
          </div>
        )}
      </section>

      {/* History: the latest marks for this subject. Fix an older day from the Calendar. */}
      {(subject.log?.length ?? 0) > 0 && (
        <section className="mt-9" data-testid="history">
          <SectionHeader>Recent marks</SectionHeader>
          <ul className="rounded-2xl bg-card divide-y divide-ink/[0.08] overflow-hidden">
            {recentMarks(subject, 6).map((e, i) => (
              <li key={`${e.d}-${e.t ?? ""}-${i}`} className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="min-w-0">
                  <span className="block text-[15px] font-medium">{formatShortDate(e.d)}</span>
                  <span className="block text-[12px] text-mute">{[e.t ? formatTime(e.t) : "No class time", e.k].filter(Boolean).join(" · ")}</span>
                </span>
                <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold whitespace-nowrap ${e.s === "P" ? "bg-good/15 text-good" : "bg-bad/10 text-bad"}`}>
                  {e.s === "P" ? "Present" : "Absent"}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[12px] text-mute mt-2 px-1">To correct an older day, pick it in the Calendar.</p>
        </section>
      )}

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
