"use client"

import { useRef, useState } from "react"
import { CaretDown, CaretLeft, CaretRight, Check, Plus } from "@phosphor-icons/react"
import type { Subject, Task } from "@/lib/types"
import { classesOn, countdown, coveredBy, daysUntil, formatShortDate, formatTime, localDate, markFor, parseLocalDate } from "@/lib/attendance"
import { SectionHeader, cardClass, primaryButton } from "./sheet"

interface CalendarViewProps {
  tasks: Task[]
  subjects: Subject[]
  /** Add a deadline; the date is the day currently picked on the calendar */
  onAdd: (date: string) => void
  onEdit: (task: Task) => void
  onToggleDone: (task: Task) => void
}

/** Monday first, like the rest of the newer screens */
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]

const relative = (date: string) => {
  const n = daysUntil(date)
  return n === 0 ? "Today" : n === 1 ? "Tomorrow" : n === -1 ? "Yesterday" : null
}

/** A month grid with a dot for every deadline, the day you pick, and everything due and scheduled that day */
export default function CalendarView({ tasks, subjects, onAdd, onEdit, onToggleDone }: CalendarViewProps) {
  const today = localDate()
  const [offset, setOffset] = useState(0)
  const [selected, setSelected] = useState(today)
  const [showDone, setShowDone] = useState(false)
  const touchX = useRef<number | null>(null)

  const base = new Date()
  const month = new Date(base.getFullYear(), base.getMonth() + offset, 1)
  const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const lead = (month.getDay() + 6) % 7

  const subjectOf = (t: Task) => subjects.find((s) => s.id === t.subjectId)
  const open = tasks.filter((t) => !t.done)
  const byDate = new Map<string, Task[]>()
  for (const t of open) byDate.set(t.dueDate, [...(byDate.get(t.dueDate) ?? []), t])

  const cells: (null | { date: string; day: number })[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => ({ date: localDate(new Date(month.getFullYear(), month.getMonth(), i + 1)), day: i + 1 })),
  ]

  const dotColor = (t: Task, date: string) => (date < today ? "var(--color-bad)" : (subjectOf(t)?.glowColor ?? "var(--color-ink)"))

  // ---- the picked day ----
  const dayTasks = byDate.get(selected) ?? []
  const dayClasses = classesOn(subjects, parseLocalDate(selected))
  const isPast = selected < today
  const isFuture = selected > today
  const pickedDate = parseLocalDate(selected)

  // ---- every deadline, grouped by how soon ----
  const items = open.map((t) => ({ t, d: daysUntil(t.dueDate) })).sort((a, b) => a.d - b.d)
  const groups = [
    { title: "Overdue", list: items.filter((x) => x.d < 0) },
    { title: "Today", list: items.filter((x) => x.d === 0) },
    { title: "This week", list: items.filter((x) => x.d >= 1 && x.d <= 7) },
    { title: "Later", list: items.filter((x) => x.d > 7) },
  ].filter((g) => g.list.length > 0)
  const completed = tasks.filter((t) => t.done)
  const overdue = items.filter((x) => x.d < 0).length
  const thisWeek = items.filter((x) => x.d >= 0 && x.d <= 7).length

  const goMonth = (n: number) => {
    setOffset((o) => o + n)
  }
  const goToday = () => {
    setOffset(0)
    setSelected(today)
  }

  const DeadlineRow = ({ t, d, done }: { t: Task; d?: number; done?: boolean }) => {
    const s = subjectOf(t)
    const c = d !== undefined ? countdown(d) : null
    return (
      <li className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => onToggleDone(t)}
          aria-label={done ? `Mark ${t.title} not done` : `Mark ${t.title} done`}
          className={`w-7 h-7 rounded-full grid place-items-center flex-shrink-0 border-2 transition ${done ? "bg-ink border-ink text-paper" : "border-faint hover:border-ink"}`}
        >
          {done && <Check weight="bold" className="w-4 h-4" />}
        </button>
        <button onClick={() => onEdit(t)} className="min-w-0 flex-1 text-left flex items-center gap-3">
          <span className="min-w-0 flex-1">
            <span className={`block text-[17px] font-semibold truncate leading-snug ${done ? "line-through text-mute" : ""}`}>{t.title}</span>
            <span className="flex items-center gap-1.5 text-[13px] text-mute">
              {s && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.glowColor }} />}
              <span className="truncate">{[s?.name, formatShortDate(t.dueDate)].filter(Boolean).join(" · ")}</span>
            </span>
          </span>
          {c && (
            <span className="text-right flex-shrink-0">
              <span className={`block num text-[20px] font-bold leading-none ${c.tone}`}>{c.big}</span>
              {c.small && <span className="block text-[11px] text-mute mt-1">{c.small}</span>}
            </span>
          )}
        </button>
      </li>
    )
  }

  return (
    <div className="space-y-6 lg:space-y-0 lg:grid lg:grid-cols-[minmax(0,480px)_minmax(0,1fr)] lg:gap-x-12 lg:items-start">
      <div className="space-y-6">
      {/* Summary */}
      <div className="flex gap-2 flex-wrap">
        <span className="rounded-full bg-card px-3.5 py-2 text-[13px] font-semibold">{open.length} open</span>
        {thisWeek > 0 && <span className="rounded-full bg-card px-3.5 py-2 text-[13px] font-semibold">{thisWeek} due this week</span>}
        {overdue > 0 && <span className="rounded-full bg-bad/10 text-bad px-3.5 py-2 text-[13px] font-semibold">{overdue} overdue</span>}
      </div>

      {/* Month */}
      <section
        className={`${cardClass} p-4`}
        onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
        onTouchEnd={(e) => {
          if (touchX.current === null) return
          const dx = e.changedTouches[0].clientX - touchX.current
          touchX.current = null
          if (Math.abs(dx) > 60) goMonth(dx < 0 ? 1 : -1)
        }}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[19px] font-bold tracking-tight">{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</h2>
          <div className="flex items-center gap-1.5">
            {(offset !== 0 || selected !== today) && (
              <button onClick={goToday} className="h-8 px-3 rounded-full bg-secondary text-[13px] font-semibold">
                Today
              </button>
            )}
            <button onClick={() => goMonth(-1)} aria-label="Previous month" className="w-8 h-8 grid place-items-center rounded-full bg-secondary">
              <CaretLeft weight="bold" className="w-4 h-4" />
            </button>
            <button onClick={() => goMonth(1)} aria-label="Next month" className="w-8 h-8 grid place-items-center rounded-full bg-secondary">
              <CaretRight weight="bold" className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-7 gap-y-0.5">
          {WEEKDAYS.map((w, i) => (
            <span key={i} className="text-center text-[11px] font-semibold text-mute pb-1.5">
              {w}
            </span>
          ))}
          {cells.map((c, i) => {
            if (c === null) return <span key={`b${i}`} />
            const list = byDate.get(c.date) ?? []
            const isSel = selected === c.date
            const isToday = c.date === today
            return (
              <button
                key={c.date}
                onClick={() => setSelected(c.date)}
                aria-pressed={isSel}
                aria-label={`${parseLocalDate(c.date).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })}${list.length ? `, ${list.length} due` : ""}${isToday ? ", today" : ""}`}
                className="h-[46px] grid place-items-center"
              >
                <span className="flex flex-col items-center gap-[3px]">
                  <span className={`w-8 h-8 rounded-full grid place-items-center text-[15px] num ${isSel ? "bg-ink text-paper font-semibold" : isToday ? "ring-2 ring-ink font-semibold" : ""}`}>{c.day}</span>
                  <span className="flex gap-[3px] h-[5px]">
                    {list.slice(0, 3).map((t) => (
                      <span key={t.id} className="w-[5px] h-[5px] rounded-full" style={{ background: dotColor(t, c.date) }} />
                    ))}
                  </span>
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {/* The picked day */}
      <section data-tour="calendar-day">
        <div className="flex items-end justify-between mb-2.5 px-1">
          <div>
            <h2 className="text-[22px] font-bold tracking-tight leading-tight">{relative(selected) ?? pickedDate.toLocaleDateString("en-US", { weekday: "long" })}</h2>
            <p className="text-[13px] text-mute">{pickedDate.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })}</p>
          </div>
          <button onClick={() => onAdd(selected)} className="h-9 pl-3 pr-4 rounded-full bg-ink text-paper text-[14px] font-semibold flex items-center gap-1.5">
            <Plus weight="bold" className="w-4 h-4" /> Deadline
          </button>
        </div>

        <div className={`${cardClass} divide-y divide-ink/[0.08]`}>
          {dayTasks.length === 0 && dayClasses.length === 0 ? (
            <p className="px-4 py-6 text-[15px] text-mute text-center">{isPast ? "Nothing was scheduled." : "Nothing due and no classes. A free day."}</p>
          ) : (
            <>
              {dayTasks.length > 0 && (
                <div>
                  <p className="px-4 pt-3 text-[12px] font-medium uppercase tracking-wider text-mute">Due</p>
                  <ul className="divide-y divide-ink/[0.08]">
                    {dayTasks.map((t) => (
                      <DeadlineRow key={t.id} t={t} />
                    ))}
                  </ul>
                </div>
              )}
              {dayClasses.length > 0 && (
                <div>
                  <p className="px-4 pt-3 text-[12px] font-medium uppercase tracking-wider text-mute">Classes · {dayClasses.length}</p>
                  <ul className="divide-y divide-ink/[0.08]">
                    {dayClasses.map(({ subject, slot }) => {
                      const st = markFor(subject, selected, slot.start)
                      const by = coveredBy(subject, selected, slot.start)
                      const plan = subject.plan?.[selected]
                      return (
                        <li key={`${subject.id}-${slot.start}`} className="flex items-center gap-3 px-4 py-3">
                          <span className="w-1.5 self-stretch rounded-full flex-shrink-0" style={{ background: subject.glowColor }} />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[16px] font-semibold truncate leading-snug">{subject.name}</span>
                            <span className="block num text-[13px] text-mute">
                              {formatTime(slot.start)} – {formatTime(slot.end)}
                              {slot.kind ? ` · ${slot.kind}` : ""}
                            </span>
                          </span>
                          {st ? (
                            <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold whitespace-nowrap ${st === "P" ? "bg-good/15 text-good" : "bg-bad/10 text-bad"}`}>
                              {st === "P" ? (by ? `Present · ${by}` : "Present") : "Absent"}
                            </span>
                          ) : isFuture ? (
                            plan && (
                              <span className={`rounded-full px-2.5 py-1 text-[12px] font-bold whitespace-nowrap ${plan === "skip" ? "bg-warn/15 text-warn" : "bg-secondary text-mute"}`}>
                                {plan === "skip" ? "Skip planned" : "Attending"}
                              </span>
                            )
                          ) : (
                            <span className="rounded-full bg-secondary px-2.5 py-1 text-[12px] font-bold text-mute whitespace-nowrap">Not marked</span>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      </div>

      {/* Every deadline */}
      <div>
      {tasks.length === 0 ? (
        <div className="rounded-2xl bg-card p-6">
          <h2 className="text-[22px] font-bold tracking-tight">No deadlines yet</h2>
          <p className="text-[15px] text-mute mt-2 mb-5 leading-snug">Add exams, assignments and submissions to see how many days you have left, and get a heads-up on Today.</p>
          <button onClick={() => onAdd(selected)} className={primaryButton}>
            Add a deadline
          </button>
        </div>
      ) : (
        <div className="space-y-7">
          {groups.length === 0 && <p className="text-[15px] text-mute text-center py-4">Everything is done. Nicely done.</p>}
          {groups.map((g) => (
            <section key={g.title}>
              <SectionHeader>{g.title}</SectionHeader>
              <ul className={`${cardClass} divide-y divide-ink/[0.08]`}>
                {g.list.map(({ t, d }) => (
                  <DeadlineRow key={t.id} t={t} d={d} />
                ))}
              </ul>
            </section>
          ))}

          {completed.length > 0 && (
            <section>
              <button onClick={() => setShowDone(!showDone)} aria-expanded={showDone} className="w-full flex items-center justify-between px-1 mb-2.5">
                <span className="text-[12px] font-medium uppercase tracking-wider text-mute">Completed · {completed.length}</span>
                <CaretDown weight="bold" className={`w-4 h-4 text-mute transition-transform ${showDone ? "rotate-180" : ""}`} />
              </button>
              {showDone && (
                <ul className={`${cardClass} divide-y divide-ink/[0.08]`}>
                  {completed.map((t) => (
                    <DeadlineRow key={t.id} t={t} done />
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
      </div>
    </div>
  )
}
