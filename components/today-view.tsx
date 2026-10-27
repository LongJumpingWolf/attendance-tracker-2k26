"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowClockwise, CaretRight, Check, WarningCircle, X } from "@phosphor-icons/react"
import ClassActionMenu from "./class-action-menu"
import type { ScheduleOverride } from "@/lib/types"
import type { Mate, Subject, Task } from "@/lib/types"
import {
  getAttendance,
  STATUS_STYLES,
  localDate,
  dayClasses,
  dayProgress,
  slotMeta,
  classVerdict,
  coveredBy,
  toMin,
  formatTime,
  type DayClass,
  type MarkMeta,
} from "@/lib/attendance"
import { dateAfterDays, deadlineRemindersForDate } from "@/lib/deadline-reminders"
import ProgressRing from "./progress-ring"
import { MateNote, WeekStrip } from "./done-extras"
import TodayWidgets from "./today-widgets"
import { SectionHeader, primaryButton, cardClass } from "./sheet"

export interface Banner {
  text: string
  tone: "warn" | "bad" | "info"
  target: string
}

interface TodayViewProps {
  subjects: Subject[]
  scheduleOverrides?: ScheduleOverride[]
  onClassActions?: (target: { subjectId: string; date: string; slot: { day: number; start: string; end: string; kind?: string }; subjectName?: string }) => void
  onSleep?: (subject: Subject) => void
  /** For the "a mate covered you this week" note once the day is done */
  mates: Mate[]
  /** For the deadline widget */
  tasks: Task[]
  banner: Banner | null
  onSet: (subjectId: string, date: string, status: "P" | "A" | null, meta?: MarkMeta) => void
  onOpenSubject: (id: string) => void
  onGoto: (page: string) => void
  onAddSubject: () => void
  onOpenTomorrow?: (date: string) => void
  onResolveReminder: (task: Task) => void
  onSnoozeReminder: (taskId: string, untilDate: string) => void
  demoActive?: boolean
}

const BANNER_TONE = {
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  info: "bg-info/15 text-info",
}

const divide = "divide-y divide-ink/10"

/** Colour carries the answer: green = fine to skip, orange = no skips left, red = below the target */
const VERDICT_TONE = {
  skip: "bg-good/15 text-good",
  must: "bg-warn/15 text-warn",
  reach: "bg-bad/15 text-bad",
  nodata: "bg-ink/10 text-mute",
} as const
const GUTTER = 16

/** A card in the carousel is one real class on today's timetable */
type Card = DayClass

const keyOf = (c: Card) => c.key
const attendanceSubjectName = (c: Card) => (c.attendanceSubject ?? c.subject).name
const metaOf = (c: Card): MarkMeta => slotMeta(c.slot) ?? {}

function duration(mins: number) {
  const m = Math.max(1, Math.round(mins))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
}

/** Stable per-label colour variables: new topic tags get a consistent identity without a hard-coded registry. */
function topicTagStyle(tag: string): React.CSSProperties {
  let hash = 2166136261
  for (const character of tag.trim().toLowerCase()) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16777619)
  }
  const value = hash >>> 0
  return {
    "--topic-tag-hue": value % 360,
    "--topic-tag-saturation": `${56 + ((value >>> 8) % 24)}%`,
    "--topic-tag-lightness": `${92 + ((value >>> 16) % 5)}%`,
  } as React.CSSProperties
}

/** A soft wash of the subject's own colour (8%), laid over the card colour so it works in light and dark */
const wash = (hex: string): React.CSSProperties => ({
  backgroundColor: "var(--card)",
  ...(/^#[0-9a-f]{6}$/i.test(hex) ? { backgroundImage: `linear-gradient(${hex}14, ${hex}14)` } : {}),
})

export default function TodayView(props: TodayViewProps) {
  const [now, setNow] = useState<Date | null>(null)

  useEffect(() => {
    setNow(new Date())
    const t = setInterval(() => setNow(new Date()), 20000)
    return () => clearInterval(t)
  }, [])

  if (!now) return <div className="h-96" aria-hidden />
  return <TodayContent {...props} now={now} />
}

function TodayContent({
  now,
  subjects,
  scheduleOverrides = [],
  onClassActions,
  onSleep,
  mates,
  tasks,
  banner,
  onSet,
  onOpenSubject,
  onGoto,
  onAddSubject,
  onOpenTomorrow,
  onResolveReminder,
  onSnoozeReminder,
  demoActive,
}: TodayViewProps & { now: Date }) {
  const scroller = useRef<HTMLDivElement>(null)
  const lastFocus = useRef<string | null>(null)
  const [leaving, setLeaving] = useState<Set<string>>(new Set())
  const [active, setActive] = useState(0)
  const [narrow, setNarrow] = useState(false) // phones: smaller ring to match the smaller type
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)")
    const sync = () => setNarrow(mq.matches)
    sync()
    mq.addEventListener("change", sync)
    return () => mq.removeEventListener("change", sync)
  }, [])
  const dragStart = useRef<{ x: number; y: number; scrollLeft: number; index: number } | null>(null)
  const pointerDidDrag = useRef(false)
  const touchDidDrag = useRef(false)
  const suppressClickUntil = useRef(0)
  const userNavigated = useRef(false)
  const lastDay = useRef<string | null>(null)

  const today = localDate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const reminderItems = deadlineRemindersForDate(tasks, today)
  const tomorrow = dateAfterDays(today, 1)

  // Only classes that are really on today's timetable. A subject with no timetable, or none today, has no card.
  const classes: Card[] = dayClasses(subjects, now, scheduleOverrides)
  const unscheduled = subjects.filter((s) => !s.slots?.length).length

  const stateOf = (c: Card) => c.state

  // Resolved cards dissolve out of the carousel
  const pending = classes.filter((c) => stateOf(c) === null || leaving.has(keyOf(c)))
  const live = pending.filter((c) => !leaving.has(keyOf(c)))
  const activeRef = useRef(active)
  activeRef.current = active
  const done = classes.filter((c) => stateOf(c) !== null && !leaving.has(keyOf(c)))
  const carouselCount = live.length + reminderItems.length
  // Keep the carousel alive after all lectures are marked if a deadline reminder remains.
  const allDone = dayProgress(classes).allDone && pending.length === 0 && reminderItems.length === 0

  const isOngoing = (c: Card) => toMin(c.slot.start) <= nowMin && nowMin < toMin(c.slot.end)
  const hasEnded = (c: Card) => toMin(c.slot.end) <= nowMin
  const startsLater = (c: Card) => toMin(c.slot.start) > nowMin
  // The carousel sits on whatever is happening now, else what is next, else the oldest unresolved card
  const ongoingCard = live.find(isOngoing)
  const firstUpcoming = live.find(startsLater)
  const focus = ongoingCard ?? firstUpcoming ?? live[0] ?? null
  const focusKey = reminderItems[0] ? "deadline-" + reminderItems[0].task.id : focus ? keyOf(focus) : null

  // Classes that ended without a mark: the notice reminds you
  const overdue = live.filter(hasEnded)

  useEffect(() => {
    if (lastDay.current !== today) {
      lastDay.current = today
      userNavigated.current = false
      lastFocus.current = null
    }
    const box = scroller.current
    if (!box || !focusKey || userNavigated.current) return
    const el = box.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)
    if (!el) return
    box.scrollTo({ left: el.offsetLeft - GUTTER, behavior: lastFocus.current === null ? "auto" : "smooth" })
    lastFocus.current = focusKey
  }, [focusKey, today])

  useEffect(() => {
    const box = scroller.current
    if (!box || typeof ResizeObserver === "undefined") return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const cards = Array.from(box.querySelectorAll<HTMLElement>('[data-carousel-active="true"]'))
        const target = cards[Math.min(activeRef.current, cards.length - 1)]
        if (!target) return
        const left = target.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft - GUTTER
        box.scrollTo({ left, behavior: "auto" })
      })
    })
    observer.observe(box)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [allDone, carouselCount])

  const clampIndex = (value: number) => Math.max(0, Math.min(carouselCount - 1, value))
  // Query all active cards in DOM order, including any deadline reminder cards.
  const cardElements = () => Array.from(scroller.current?.querySelectorAll<HTMLElement>('[data-carousel-active="true"]') ?? [])
  const leftForCard = (el: HTMLElement) => {
    const box = scroller.current
    if (!box) return 0
    return el.getBoundingClientRect().left - box.getBoundingClientRect().left + box.scrollLeft - GUTTER
  }
  const nearestCardIndex = () => {
    const box = scroller.current
    const items = cardElements()
    if (!box || !items.length) return 0
    let nearest = 0
    let distance = Number.POSITIVE_INFINITY
    items.forEach((el, i) => {
      const delta = Math.abs(leftForCard(el) - box.scrollLeft)
      if (delta < distance) { nearest = i; distance = delta }
    })
    return nearest
  }
  const onScroll = () => {
    if (!scroller.current) return
    setActive(clampIndex(nearestCardIndex()))
  }

  const jumpTo = (c: Card) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-key="${keyOf(c)}"]`)
    if (el && scroller.current) scroller.current.scrollTo({ left: leftForCard(el), behavior: "smooth" })
  }

  const jumpToIndex = (index: number) => {
    const els = cardElements()
    const target = els[clampIndex(index)]
    if (target && scroller.current) scroller.current.scrollTo({ left: leftForCard(target), behavior: "smooth" })
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || !scroller.current) return
    // A fresh interaction must not inherit the click suppression from a previous swipe.
    suppressClickUntil.current = 0
    // Attendance, menu and link controls remain normal clicks. The rest of the card can start a drag.
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return
    pointerDidDrag.current = false
    dragStart.current = { x: e.clientX, y: e.clientY, scrollLeft: scroller.current.scrollLeft, index: nearestCardIndex() }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return
    const start = dragStart.current
    const box = scroller.current
    if (!start || !box) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!pointerDidDrag.current && Math.abs(dx) < 8) return
    if (Math.abs(dx) < Math.abs(dy) * 1.15) return
    pointerDidDrag.current = true
    userNavigated.current = true
    if (!box.hasPointerCapture(e.pointerId)) box.setPointerCapture(e.pointerId)
    box.scrollLeft = start.scrollLeft - dx
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return
    const start = dragStart.current
    const box = scroller.current
    if (!start || !box) return
    const dx = e.clientX - start.x
    const didDrag = pointerDidDrag.current
    if (didDrag) {
      suppressClickUntil.current = Date.now() + 500
      if (Math.abs(dx) > 60) jumpToIndex(start.index + (dx < 0 ? 1 : -1))
      else jumpToIndex(nearestCardIndex())
      if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId)
    }
    dragStart.current = null
    pointerDidDrag.current = false
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return
    dragStart.current = null
    pointerDidDrag.current = false
  }

  const cardClick = (e: React.MouseEvent<HTMLElement>, subjectId: string) => {
    if (suppressClickUntil.current > Date.now()) {
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea")) return
    onOpenSubject(subjectId)
  }

  const resolve = (c: Card, status: "P" | "A") => {
    const k = keyOf(c)
    if (leaving.has(k)) return // a second tap on the same card while it is leaving does nothing
    setLeaving((s) => new Set(s).add(k))
    onSet((c.attendanceSubject ?? c.subject).id, today, status, metaOf(c))
    setTimeout(
      () =>
        setLeaving((s) => {
          const n = new Set(s)
          n.delete(k)
          return n
        }),
      420,
    )
  }

  if (subjects.length === 0 && reminderItems.length === 0) {
    return (
      <div>
        <h1 className="font-display text-[clamp(26px,7.2vw,34px)] leading-[1.1]">Let&rsquo;s set up your subjects</h1>
        <p className="text-[17px] text-mute mt-2 mb-5 leading-snug">
          Add each subject with the minimum attendance it needs, plus its class days and time. This screen then follows
          your day.
        </p>
        <div className="grid grid-cols-1 gap-2">
          <button onClick={onAddSubject} className={primaryButton}>
            Add a subject
          </button>
        </div>
        <div className="mt-6"><TodayWidgets subjects={subjects} tasks={tasks.filter((task) => !reminderItems.some((item) => item.task.id === task.id))} activeReminderCount={reminderItems.length} now={now} scheduleOverrides={scheduleOverrides} onOpenTomorrow={onOpenTomorrow} demoActive={demoActive} /></div>
        <footer className="pt-8 pb-3 text-center text-[12px] text-mute/80 tracking-wide">Made with ♥ by Aditya Waghmare</footer>
      </div>
    )
  }

  // ---- the headline: one plain sentence about right now ----
  let headline: string
  let subline: string
  if (ongoingCard) {
    headline = `${ongoingCard.subject.name} is on now`
    subline = `Ends in ${duration(toMin(ongoingCard.slot.end) - nowMin)}`
  } else if (firstUpcoming) {
    headline = `${firstUpcoming.subject.name} is next`
    subline = `At ${formatTime(firstUpcoming.slot.start)}, in ${duration(toMin(firstUpcoming.slot.start) - nowMin)}`
  } else if (live.length > 0) {
    headline = `${live.length} to mark today`
    subline = "Tap Present or Absent on each class card"
  } else if (reminderItems.length > 0) {
    headline = reminderItems.length === 1 ? "You have a deadline reminder" : `${reminderItems.length} deadline reminders`
    subline = "Review your reminders in the carousel below"
  } else if (classes.length === 0) {
    headline = "No classes today"
    subline = unscheduled > 0 ? `${unscheduled} ${unscheduled === 1 ? "subject has" : "subjects have"} no timetable yet` : "Nothing is on your timetable"
  } else {
    headline = "You're all caught up"
    subline = "Every class today is marked"
  }

  // One notice at a time. An unmarked class that has already ended comes first.
  let notice: { text: string; tone: Banner["tone"]; onClick: () => void } | null = null
  if (overdue.length > 0) {
    const first = overdue[0]
    const ago = duration(nowMin - toMin(first.slot.end))
    notice = {
      text:
        overdue.length === 1
          ? `${first.subject.name} ended ${ago} ago and isn't marked`
          : `${overdue.length} classes ended without a mark: ${overdue.map((c) => c.subject.name).join(", ")}`,
      tone: "warn",
      onClick: () => jumpTo(first),
    }
  } else if (banner) {
    notice = { text: banner.text, tone: banner.tone, onClick: () => onGoto(banner.target) }
  }

  return (
    <div>
      {/* Headline */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="font-display text-[clamp(26px,7.2vw,34px)] leading-[1.1]">{headline}</h1>
          <p className="text-[15px] sm:text-[17px] text-mute mt-1.5">{subline}</p>
        </div>
      </div>

      <div className="mt-6 lg:grid lg:grid-cols-12 lg:gap-x-10 lg:items-start">
      <div className="space-y-6 lg:col-span-7">
        {notice && (
          <button
            onClick={notice.onClick}
            className={`w-full flex items-center gap-3 rounded-2xl px-3.5 sm:px-4 py-3 sm:py-3.5 text-left ${BANNER_TONE[notice.tone]}`}
          >
            <WarningCircle weight="fill" className="w-6 h-6 flex-shrink-0" />
            <span className="flex-1 text-[13.5px] sm:text-[15px] font-semibold leading-snug">{notice.text}</span>
            <CaretRight weight="bold" className="w-4 h-4 opacity-70" />
          </button>
        )}

        {/* Carousel */}
        {!allDone && (
        <section data-tour="today-carousel">
          <SectionHeader
            action={carouselCount > 0 ? <span className="text-[13px] text-mute">{live.length > 0 ? `${live.length} to mark` : ""}{live.length > 0 && reminderItems.length > 0 ? " · " : ""}{reminderItems.length > 0 ? `${reminderItems.length} reminder${reminderItems.length === 1 ? "" : "s"}` : ""}</span> : undefined}
          >
            Today&rsquo;s classes &amp; reminders
          </SectionHeader>

          {pending.length === 0 && reminderItems.length === 0 ? (
            <div className="w-full">
              <article className={`w-full ${cardClass} px-5 py-6 flex items-center gap-4`}>
                <span className="w-12 h-12 rounded-full bg-good/15 text-good grid place-items-center flex-shrink-0">
                  <Check weight="bold" className="w-6 h-6" />
                </span>
                <div>
                  <p className="text-[17px] font-semibold">{classes.length === 0 ? "No classes today" : "All done for today"}</p>
                  <p className="text-[15px] text-mute">
                    {classes.length === 0
                      ? unscheduled > 0
                        ? "Subjects without a timetable can be marked from their own page."
                        : "Nothing is scheduled on your timetable."
                      : "Every class is marked."}
                  </p>
                </div>
              </article>
            </div>
          ) : (
            <>
              <div
                ref={scroller}
                onScroll={onScroll}
                onTouchStart={(e) => {
                  suppressClickUntil.current = 0
                  touchDidDrag.current = false
                  dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, scrollLeft: scroller.current?.scrollLeft ?? 0, index: nearestCardIndex() }
                }}
                onTouchMove={(e) => {
                  const start = dragStart.current
                  if (!start) return
                  const dx = e.touches[0].clientX - start.x
                  const dy = e.touches[0].clientY - start.y
                  if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                    touchDidDrag.current = true
                    userNavigated.current = true
                  }
                }}
                onTouchEnd={(e) => {
                  const start = dragStart.current
                  if (start) {
                    const dx = e.changedTouches[0].clientX - start.x
                    const dy = e.changedTouches[0].clientY - start.y
                    if (touchDidDrag.current && Math.abs(dx) > 18 && Math.abs(dx) > Math.abs(dy) * 1.2) {
                      userNavigated.current = true
                      suppressClickUntil.current = Date.now() + 650
                    }
                  }
                  // Let touch scrolling and CSS snap settle on their own. A second scrollTo here caused the tile to shift.
                  dragStart.current = null
                  touchDidDrag.current = false
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                style={{ touchAction: "pan-x pan-y", WebkitOverflowScrolling: "touch", overscrollBehaviorX: "contain" }}
                className="relative -mx-4 px-4 lg:mx-0 lg:px-0 flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-px-4 lg:scroll-px-0 pb-1 no-scrollbar cursor-grab active:cursor-grabbing select-none"
              >
                {reminderItems.map(({ task, daysUntilDue }) => {
                  const key = "deadline-" + task.id
                  const dueLabel = daysUntilDue < 0
                    ? `Overdue by ${Math.abs(daysUntilDue)} day${Math.abs(daysUntilDue) === 1 ? "" : "s"}`
                    : daysUntilDue === 0
                      ? "Due today"
                      : daysUntilDue === 1
                        ? "Due tomorrow"
                        : `Due in ${daysUntilDue} days`
                  const [dueYear, dueMonth, dueDay] = task.dueDate.split("-")
                  const taskForDate = dueYear && dueMonth && dueDay ? `${dueDay}/${dueMonth}/${dueYear}` : task.dueDate
                  const linkedSubject = task.subjectId ? subjects.find((subject) => subject.id === task.subjectId) : undefined
                  return (
                    <article
                      key={key}
                      data-key={key}
                      data-carousel-active="true"
                      data-testid="deadline-reminder-card"
                      tabIndex={0}
                      aria-label={`Deadline reminder: ${task.title}. ${dueLabel}.`}
                      className="snap-start shrink-0 w-[calc(100vw-3rem)] max-w-[680px] lg:w-full lg:max-w-none rounded-[24px] sm:rounded-[28px] bg-card border border-warn/25 p-4 sm:p-5 flex flex-col"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span data-testid="deadline-task-date" className="inline-flex items-center rounded-full bg-bad/15 text-bad border border-bad/35 px-2.5 py-1 text-[10px] sm:text-[11px] font-extrabold tracking-wide">
                          Task for: {taskForDate}
                        </span>
                        <span className="rounded-full bg-secondary text-ink px-2.5 py-1 text-[11px] font-bold">{dueLabel}</span>
                      </div>
                      <h3 className="font-display text-[clamp(22px,5.8vw,28px)] leading-tight font-bold tracking-tight mt-5 break-words">{task.title}</h3>
                      {linkedSubject && <p className="text-[13px] text-mute mt-1">Subject · {linkedSubject.name}</p>}
                      <p className="text-[13px] text-mute leading-snug mt-4 mb-4">Resolve this when it&rsquo;s done, or bring it back to the carousel tomorrow.</p>
                      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 mt-auto">
                        <button
                          type="button"
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onResolveReminder(task) }}
                          className="h-11 sm:h-[52px] rounded-2xl bg-good text-[#ffffff] dark:text-[#000000] text-[14px] sm:text-[16px] font-semibold flex items-center justify-center gap-2"
                        >
                          <Check weight="bold" className="w-5 h-5" /> Resolved
                        </button>
                        <button
                          type="button"
                          disabled={!tomorrow}
                          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (tomorrow) onSnoozeReminder(task.id, tomorrow) }}
                          className="h-11 sm:h-[52px] rounded-2xl bg-secondary text-ink text-[13px] sm:text-[15px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
                        >
                          <ArrowClockwise weight="bold" className="w-4 h-4 shrink-0" /> Remind me tomorrow
                        </button>
                      </div>
                    </article>
                  )
                })}
                {pending.map((c) => {
                  const k = keyOf(c)
                  const start = toMin(c.slot.start)
                  const end = toMin(c.slot.end)
                  const ongoing = isOngoing(c)
                  const ended = hasEnded(c)
                  const attendanceSubject = c.attendanceSubject ?? c.subject
                  const info = getAttendance(attendanceSubject.attended, attendanceSubject.missed, attendanceSubject.requirement)
                  const st = STATUS_STYLES[info.status]
                  const verdict = classVerdict(attendanceSubject)
                  const gone = leaving.has(k)

                  const badge = ongoing
                    ? { text: "NOW", cls: "bg-ink text-paper" }
                    : ended
                      ? { text: "ENDED", cls: "bg-card text-bad" }
                      : c.key === firstUpcoming?.key
                        ? { text: "UP NEXT", cls: "bg-card text-ink" }
                        : { text: "LATER", cls: "bg-card text-mute" }
                  const timing = ongoing
                    ? `Ends in ${duration(end - nowMin)}`
                    : ended
                      ? `Ended ${duration(nowMin - end)} ago`
                      : `Starts in ${duration(start - nowMin)}`

                  return (
                    <article
                      key={k}
                      data-key={k}
                      data-carousel-active={!gone ? "true" : undefined}
                      tabIndex={0}
                      aria-label={c.override?.kind === "substitute" ? `Open ${attendanceSubjectName(c)} attendance details; class held as ${c.subject.name}` : `Open ${c.subject.name} subject details`}
                      onClick={(e) => cardClick(e, (c.attendanceSubject ?? c.subject).id)}
                      onKeyDown={(e) => { if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onOpenSubject((c.attendanceSubject ?? c.subject).id) } }}
                      style={wash(c.subject.glowColor)}
                      className={`snap-start shrink-0 w-[calc(100vw-3rem)] max-w-[680px] lg:w-full lg:max-w-none rounded-[24px] sm:rounded-[28px] bg-card p-4 sm:p-5 transition-all duration-300 ease-out ${
                        gone ? "opacity-0 scale-90 blur-sm pointer-events-none" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="num text-[13px] text-mute">
                          {`${formatTime(c.slot.start)} – ${formatTime(c.slot.end)}`}
                        </span>
                        <div className="flex items-center gap-2">
                          <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide ${badge.cls}`}>
                            {badge.text}
                          </span>
                          <ClassActionMenu
                            subject={c.attendanceSubject ?? c.subject}
                            target={{ subjectId: c.originalSubjectId ?? c.subject.id, date: today, slot: c.slot, subjectName: c.originalSubjectName ?? c.subject.name }}
                            onReplace={onClassActions}
                            onCancel={onClassActions}
                            onSleep={onSleep}
                          />
                        </div>
                      </div>

                      <div className="flex items-center justify-between gap-3 mt-3 sm:mt-4">
                        <div className="text-left min-w-0 flex-1 pointer-events-none">
                          <h3 className="text-[clamp(20px,5.6vw,28px)] leading-[1.1] font-bold tracking-tight line-clamp-3 break-words hyphens-auto">
                            {c.subject.name}
                          </h3>
                          <span
                            data-testid="verdict"
                            className={`inline-block rounded-md px-2 py-0.5 mt-1.5 sm:mt-2 text-[11px] font-extrabold tracking-wide ${VERDICT_TONE[verdict.kind]}`}
                          >
                            {verdict.label}
                          </span>
                          <p data-testid="verdict-detail" className="text-[13px] text-mute mt-1 leading-snug">
                            {verdict.pct === null ? verdict.detail : `${verdict.pct}% now · ${attendanceSubject.requirement}% needed · ${verdict.detail}`}
                          </p>
                          {c.override?.kind === "substitute" && <p className="mt-1 text-[12px] font-medium text-info">Substitutes for {c.originalSubjectName}. Attendance is recorded under {attendanceSubject.name}.</p>}
                          {c.subject.tags?.some((tag) => tag.trim()) && (
                            <div data-testid="class-tags" className="flex flex-wrap items-center gap-1.5 mt-2">
                              {c.subject.tags.filter((tag) => tag.trim()).map((tag, index) => (
                                <span
                                  key={`${tag}-${index}`}
                                  data-testid="subject-topic-tag"
                                  data-topic-tag={tag}
                                  style={topicTagStyle(tag)}
                                  className="subject-topic-tag inline-flex items-center rounded-full border px-2.5 py-1.5 text-[11px] leading-none font-bold shadow-sm"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                        <ProgressRing
                          pct={info.pct}
                          color={st.color}
                          size={narrow ? 72 : 92}
                          requirement={attendanceSubject.requirement}
                        />
                      </div>

                      {/* Time bar: how far through the class we are */}
                      <div className="mt-4 sm:mt-5">
                        <div className="h-1 rounded-full bg-ink/10 overflow-hidden">
                          <div
                            className="h-full rounded-full bg-ink/70 transition-all duration-1000"
                            style={{ width: `${ongoing ? ((nowMin - start) / (end - start)) * 100 : ended ? 100 : 0}%` }}
                          />
                        </div>
                        <p className="text-[12px] text-mute mt-1.5">{timing}</p>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 mt-3 sm:mt-4">
                        <button
                          onClick={(e) => {
                            if (suppressClickUntil.current > Date.now()) { e.preventDefault(); e.stopPropagation(); return }
                            resolve(c, "P")
                          }}
                          className="h-11 sm:h-[52px] rounded-2xl bg-good text-[#ffffff] dark:text-[#000000] text-[15px] sm:text-[17px] font-semibold flex items-center justify-center gap-2"
                        >
                          <Check weight="bold" className="w-5 h-5" /> Present
                        </button>
                        <button
                          onClick={(e) => {
                            if (suppressClickUntil.current > Date.now()) { e.preventDefault(); e.stopPropagation(); return }
                            resolve(c, "A")
                          }}
                          className="h-11 sm:h-[52px] rounded-2xl bg-card text-bad text-[15px] sm:text-[17px] font-semibold flex items-center justify-center gap-2"
                        >
                          <X weight="bold" className="w-5 h-5" /> Absent
                        </button>
                      </div>
                    </article>
                  )
                })}
                <span className="shrink-0 w-1" aria-hidden />
              </div>

              {carouselCount > 1 && (
                <div className="flex justify-center gap-1.5 mt-3" aria-hidden>
                  {reminderItems.map(({ task }, i) => (
                    <span
                      key={"deadline-" + task.id}
                      className={`h-1.5 rounded-full transition-all ${i === active ? "w-4 bg-ink" : "w-1.5 bg-ink/25"}`}
                    />
                  ))}
                  {live.map((c, i) => (
                    <span
                      key={keyOf(c)}
                      className={`h-1.5 rounded-full transition-all ${i + reminderItems.length === active ? "w-4 bg-ink" : "w-1.5 bg-ink/25"}`}
                    />
                  ))}
                </div>
              )}
              {unscheduled > 0 && (
                <p className="text-[13px] text-mute text-center mt-3 px-4 leading-snug">
                  {unscheduled} {unscheduled === 1 ? "subject has" : "subjects have"} no class days yet, so {unscheduled === 1 ? "it isn't" : "they aren't"} listed here.
                  Add days and times, or mark {unscheduled === 1 ? "it" : "them"} from the subject page.
                </p>
              )}
            </>
          )}
        </section>
        )}

        {/* Keep widgets immediately below the carousel, even before all classes are marked. */}
        <div className="mt-6">
          <TodayWidgets subjects={subjects} tasks={tasks} now={now} scheduleOverrides={scheduleOverrides} onOpenTomorrow={onOpenTomorrow} demoActive={demoActive} />
        </div>
      </div>

      {/* The right-hand column on wide screens; on phones it simply continues below */}
      <div className="space-y-6 mt-6 lg:mt-0 lg:col-span-5">
        {allDone && (
          <>
            <WeekStrip subjects={subjects} now={now} />
            <MateNote mates={mates} now={now} onOpen={() => onGoto("mates")} />
          </>
        )}

        {/* Resolved today: kept here so a mark can still be changed */}
        {done.length > 0 && (
          <section>
            <SectionHeader>Marked today</SectionHeader>
            <ul className={`${cardClass} ${divide}`}>
              {done.map((c) => {
                const state = stateOf(c)
                const after = classVerdict(c.attendanceSubject ?? c.subject) // the result of the mark, straight from the same marks (a mark goes to the original subject, not a substitute)
                return (
                  <li key={keyOf(c)} className="flex items-center gap-3 px-4 py-3 min-h-[64px]">
                    <span
                      className={`w-8 h-8 rounded-full grid place-items-center flex-shrink-0 ${
                        state === "P" ? "bg-good/10 text-good" : "bg-bad/10 text-bad"
                      }`}
                    >
                      {state === "P" ? <Check weight="bold" className="w-4 h-4" /> : <X weight="bold" className="w-4 h-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-semibold truncate">{c.subject.name}</p>
                      <p className="num text-[12px] text-mute">
                        {formatTime(c.slot.start)}
                        {after.pct !== null && <span data-testid="marked-pct"> · {after.pct}% · {after.label.toLowerCase()}</span>}
                        {coveredBy(c.attendanceSubject ?? c.subject, today, c.slot.start) && ` · Covered by ${coveredBy(c.attendanceSubject ?? c.subject, today, c.slot.start)}`}
                      </p>
                    </div>
                    <button
                      onClick={() => onSet((c.attendanceSubject ?? c.subject).id, today, null, metaOf(c))}
                      aria-label={`Clear mark for ${c.subject.name}`}
                      className="h-8 px-2 text-[13px] text-mute"
                    >
                      Undo
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </div>
      </div>
      <footer className="pt-10 pb-3 text-center text-[12px] text-mute/80 tracking-wide">Made with ♥ by Aditya Waghmare</footer>
    </div>
  )
}
