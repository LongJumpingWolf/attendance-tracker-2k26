"use client"

import { useEffect, useRef, useState } from "react"
import { CaretRight, Check, WarningCircle, X } from "@phosphor-icons/react"
import type { Mate, Subject, Task } from "@/lib/types"
import {
  getAttendance,
  STATUS_STYLES,
  localDate,
  classesOn,
  markFor,
  coveredBy,
  toMin,
  formatTime,
  formatDayMonth,
  timeParts,
  type ClassSlot,
  type MarkMeta,
} from "@/lib/attendance"
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
  /** For the "a mate covered you this week" note once the day is done */
  mates: Mate[]
  /** For the deadline widget */
  tasks: Task[]
  banner: Banner | null
  onSet: (subjectId: string, date: string, status: "P" | "A" | null, meta?: MarkMeta) => void
  onOpenSubject: (id: string) => void
  onGoto: (page: string) => void
  onAddSubject: () => void
}

const BANNER_TONE = {
  warn: "bg-warn/15 text-warn",
  bad: "bg-bad/15 text-bad",
  info: "bg-info/15 text-info",
}

const divide = "divide-y divide-ink/10"
const GUTTER = 16

/** A card in the carousel: a timed class, a subject with no timetable, or one that just isn't on today */
type Card = { subject: Subject; slot: ClassSlot["slot"] | null; elsewhere?: boolean }

const keyOf = (c: Card) => `${c.subject.id}-${c.slot?.start ?? "anytime"}`
const metaOf = (c: Card): MarkMeta => ({ t: c.slot?.start, k: c.slot?.kind })

function duration(mins: number) {
  const m = Math.max(1, Math.round(mins))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const r = m % 60
  return r ? `${h}h ${r}m` : `${h}h`
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
  mates,
  tasks,
  banner,
  onSet,
  onOpenSubject,
  onGoto,
  onAddSubject,
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
  const dragStart = useRef<{ x: number; scrollLeft: number } | null>(null)

  const today = localDate(now)
  const nowMin = now.getHours() * 60 + now.getMinutes()

  // Every subject is a card: today's timed classes, then subjects with no time, then the rest
  const timed: Card[] = classesOn(subjects, now)
  const untimed: Card[] = subjects.filter((s) => !s.slots?.length).map((s) => ({ subject: s, slot: null }))
  const timedIds = new Set(timed.map((c) => c.subject.id))
  const elsewhere: Card[] = subjects
    .filter((s) => s.slots?.length && !timedIds.has(s.id))
    .map((s) => ({ subject: s, slot: null, elsewhere: true }))
  const classes: Card[] = [...timed, ...untimed, ...elsewhere]

  const stateOf = (c: Card) => markFor(c.subject, today, c.slot?.start ?? "")

  // Resolved cards dissolve out of the carousel
  const pending = classes.filter((c) => stateOf(c) === null || leaving.has(keyOf(c)))
  const live = pending.filter((c) => !leaving.has(keyOf(c)))
  const done = classes.filter((c) => stateOf(c) !== null && !leaving.has(keyOf(c)))
  // Nothing left to answer: the screen shows the evening scene instead of the carousel
  const allDone = pending.length === 0 && classes.length > 0

  const isOngoing = (c: Card) => !!c.slot && toMin(c.slot.start) <= nowMin && nowMin < toMin(c.slot.end)
  const hasEnded = (c: Card) => !!c.slot && toMin(c.slot.end) <= nowMin
  const startsLater = (c: Card) => !!c.slot && toMin(c.slot.start) > nowMin
  // The carousel sits on whatever is happening now, else what is next, else the oldest unresolved card
  const ongoingCard = live.find(isOngoing)
  const firstUpcoming = live.find(startsLater)
  const focus = ongoingCard ?? firstUpcoming ?? live[0] ?? null
  const focusKey = focus ? keyOf(focus) : null

  // Classes that ended without a mark: the notice reminds you
  const overdue = live.filter(hasEnded)

  useEffect(() => {
    const box = scroller.current
    if (!box || !focusKey) return
    const el = box.querySelector<HTMLElement>(`[data-key="${focusKey}"]`)
    if (!el) return
    box.scrollTo({ left: el.offsetLeft - GUTTER, behavior: lastFocus.current === null ? "auto" : "smooth" })
    lastFocus.current = focusKey
  }, [focusKey])

  const stepWidth = () => {
    const first = scroller.current?.querySelector<HTMLElement>("[data-key]")
    return first ? first.offsetWidth + 12 : 0
  }

  const clampIndex = (value: number) => Math.max(0, Math.min(live.length - 1, value))

  const onScroll = () => {
    const box = scroller.current
    const step = stepWidth()
    if (!box || !step) return
    setActive(clampIndex(Math.round(box.scrollLeft / step)))
  }

  const jumpTo = (c: Card) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-key="${keyOf(c)}"]`)
    if (el && scroller.current) scroller.current.scrollTo({ left: el.offsetLeft - GUTTER, behavior: "smooth" })
  }

  const jumpToIndex = (index: number) => {
    const target = live[clampIndex(index)]
    if (target) jumpTo(target)
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!scroller.current) return
    dragStart.current = { x: e.clientX, scrollLeft: scroller.current.scrollLeft }
    scroller.current.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current
    const box = scroller.current
    if (!start || !box) return
    const dx = e.clientX - start.x
    box.scrollLeft = start.scrollLeft - dx
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStart.current
    const box = scroller.current
    if (!start || !box) return

    const dx = e.clientX - start.x
    const step = stepWidth()
    if (Math.abs(dx) > 60 && step > 0) {
      jumpToIndex(active + (dx < 0 ? 1 : -1))
    } else if (step > 0) {
      jumpToIndex(Math.round(box.scrollLeft / step))
    }

    if (box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId)
    dragStart.current = null
  }

  const onPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    const box = scroller.current
    if (box && box.hasPointerCapture(e.pointerId)) box.releasePointerCapture(e.pointerId)
    dragStart.current = null
  }

  const resolve = (c: Card, status: "P" | "A") => {
    const k = keyOf(c)
    setLeaving((s) => new Set(s).add(k))
    onSet(c.subject.id, today, status, metaOf(c))
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

  if (subjects.length === 0) {
    return (
      <div>
        <h1 className="font-display text-[clamp(26px,7.2vw,34px)] leading-[1.1]">Let&rsquo;s set up your subjects</h1>
        <p className="text-[17px] text-mute mt-2 mb-5 leading-snug">
          Add each subject with the minimum attendance it needs, plus its class days and time. This screen then follows
          your day.
        </p>
        <button onClick={onAddSubject} className={primaryButton}>
          Add a subject
        </button>
      </div>
    )
  }

  // ---- the headline: one plain sentence about right now ----
  let headline: string
  let subline: string
  if (ongoingCard) {
    headline = `${ongoingCard.subject.name} is on now`
    subline = `Ends in ${duration(toMin(ongoingCard.slot!.end) - nowMin)}`
  } else if (firstUpcoming) {
    headline = `${firstUpcoming.subject.name} is next`
    subline = `At ${formatTime(firstUpcoming.slot!.start)}, in ${duration(toMin(firstUpcoming.slot!.start) - nowMin)}`
  } else if (live.length > 0) {
    headline = `${live.length} to mark today`
    subline = "Tap Present or Absent on each card"
  } else {
    headline = "You're all caught up"
    subline = "Every class today is marked"
  }

  const missed = subjects
    .flatMap((s) => (s.log || []).filter((e) => e.s === "A").map((e) => ({ id: s.id, name: s.name, ...e })))
    .sort((a, b) => (a.d === b.d ? (b.t ?? "").localeCompare(a.t ?? "") : a.d < b.d ? 1 : -1))
    .slice(0, 4)

  // One notice at a time. An unmarked class that has already ended comes first.
  let notice: { text: string; tone: Banner["tone"]; onClick: () => void } | null = null
  if (overdue.length > 0) {
    const first = overdue[0]
    const ago = duration(nowMin - toMin(first.slot!.end))
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
      <h1 className="font-display text-[clamp(26px,7.2vw,34px)] leading-[1.1]">{headline}</h1>
      <p className="text-[15px] sm:text-[17px] text-mute mt-1.5">{subline}</p>

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

        {/* Day strip: the whole timetable at a glance */}
        {timed.length > 0 && !allDone && (
          <section aria-label="Today's timetable">
            <div className="flex gap-2 overflow-x-auto -mx-4 px-4 lg:mx-0 lg:px-0 no-scrollbar">
              {timed.map((c) => {
                const st = stateOf(c)
                const ongoing = isOngoing(c)
                const late = hasEnded(c) && st === null
                const tone =
                  st === "P"
                    ? "bg-good/10 text-good"
                    : st === "A"
                      ? "bg-bad/10 text-bad"
                      : ongoing
                        ? "bg-ink text-paper"
                        : late
                          ? "bg-bad/10 text-bad"
                          : "bg-card text-ink"
                return (
                  <button
                    key={keyOf(c)}
                    onClick={() => (st === null ? jumpTo(c) : onOpenSubject(c.subject.id))}
                    aria-label={`${c.subject.name} at ${formatTime(c.slot!.start)}${st ? (st === "P" ? ", present" : ", absent") : late ? ", not marked" : ""}`}
                    className={`shrink-0 h-10 pl-3.5 pr-4 rounded-full flex items-center gap-2 text-[13px] font-semibold ${tone}`}
                  >
                    {st === "P" ? (
                      <Check weight="bold" className="w-4 h-4" />
                    ) : st === "A" ? (
                      <X weight="bold" className="w-4 h-4" />
                    ) : (
                      <span className="num">{timeParts(c.slot!.start).time}</span>
                    )}
                    <span className="max-w-[104px] truncate">{c.subject.name}</span>
                  </button>
                )
              })}
            </div>
          </section>
        )}

        {/* The person's own widgets, or an invitation to choose some the first time */}
        {allDone && <TodayWidgets subjects={subjects} tasks={tasks} now={now} />}

        {/* Carousel */}
        {!allDone && (
        <section>
          <SectionHeader
            action={live.length > 0 ? <span className="text-[13px] text-mute">{live.length} to mark</span> : undefined}
          >
            Today&rsquo;s classes
          </SectionHeader>

          {pending.length === 0 ? (
            <div className="w-full">
              <article className={`w-full ${cardClass} px-5 py-6 flex items-center gap-4`}>
                <span className="w-12 h-12 rounded-full bg-good/15 text-good grid place-items-center flex-shrink-0">
                  <Check weight="bold" className="w-6 h-6" />
                </span>
                <div>
                  <p className="text-[17px] font-semibold">All done for today</p>
                  <p className="text-[15px] text-mute">Every class is marked.</p>
                </div>
              </article>
            </div>
          ) : (
            <>
              <div
                ref={scroller}
                onScroll={onScroll}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerCancel}
                className="relative -mx-4 px-4 lg:mx-0 lg:px-0 flex gap-3 overflow-x-auto snap-x snap-mandatory scroll-px-4 lg:scroll-px-0 pb-1 no-scrollbar touch-pan-y cursor-grab active:cursor-grabbing select-none"
              >
                {pending.map((c) => {
                  const k = keyOf(c)
                  const start = c.slot ? toMin(c.slot.start) : 0
                  const end = c.slot ? toMin(c.slot.end) : 0
                  const ongoing = isOngoing(c)
                  const ended = hasEnded(c)
                  const info = getAttendance(c.subject.attended, c.subject.missed, c.subject.requirement)
                  const st = STATUS_STYLES[info.status]
                  const gone = leaving.has(k)

                  const badge = !c.slot
                    ? { text: c.elsewhere ? "NOT TODAY" : "ANY TIME", cls: "bg-card text-mute" }
                    : ongoing
                      ? { text: "NOW", cls: "bg-ink text-paper" }
                      : ended
                        ? { text: "ENDED", cls: "bg-card text-bad" }
                        : c === firstUpcoming
                          ? { text: "UP NEXT", cls: "bg-card text-ink" }
                          : { text: "LATER", cls: "bg-card text-mute" }
                  const timing = !c.slot
                    ? c.elsewhere
                      ? "Not on today's timetable"
                      : "No class time set"
                    : ongoing
                      ? `Ends in ${duration(end - nowMin)}`
                      : ended
                        ? `Ended ${duration(nowMin - end)} ago`
                        : `Starts in ${duration(start - nowMin)}`

                  return (
                    <article
                      key={k}
                      data-key={k}
                      style={wash(c.subject.glowColor)}
                      className={`snap-start shrink-0 w-[calc(100vw-3rem)] max-w-[680px] lg:w-full lg:max-w-none rounded-[24px] sm:rounded-[28px] bg-card p-4 sm:p-5 transition-all duration-300 ease-out ${
                        gone ? "opacity-0 scale-90 blur-sm pointer-events-none" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="num text-[13px] text-mute">
                          {c.slot ? `${formatTime(c.slot.start)} – ${formatTime(c.slot.end)}` : "Any time today"}
                        </span>
                        <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold tracking-wide ${badge.cls}`}>
                          {badge.text}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-3 mt-3 sm:mt-4">
                        <button onClick={() => onOpenSubject(c.subject.id)} className="text-left min-w-0 flex-1">
                          <h3 className="text-[clamp(20px,5.6vw,28px)] leading-[1.1] font-bold tracking-tight line-clamp-3 break-words hyphens-auto">
                            {c.subject.name}
                          </h3>
                          <p className={`text-[13.5px] sm:text-[15px] mt-1.5 sm:mt-2 font-medium ${st.text}`}>{info.short}</p>
                          {(c.slot?.kind || c.subject.tags?.[0]) && (
                            <p className="text-[13px] text-mute mt-0.5">
                              {[c.slot?.kind, c.subject.tags?.[0]].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </button>
                        <ProgressRing
                          pct={info.pct}
                          color={st.color}
                          size={narrow ? 72 : 92}
                          requirement={c.subject.requirement}
                        />
                      </div>

                      {/* Time bar: how far through the class we are */}
                      <div className="mt-4 sm:mt-5">
                        <div className={`h-1 rounded-full bg-ink/10 overflow-hidden ${c.slot ? "" : "opacity-40"}`}>
                          <div
                            className="h-full rounded-full bg-ink/70 transition-all duration-1000"
                            style={{ width: `${ongoing ? ((nowMin - start) / (end - start)) * 100 : ended ? 100 : 0}%` }}
                          />
                        </div>
                        <p className="text-[12px] text-mute mt-1.5">{timing}</p>
                      </div>

                      <div className="grid grid-cols-2 gap-2.5 sm:gap-3 mt-3 sm:mt-4">
                        <button
                          onClick={() => resolve(c, "P")}
                          className="h-11 sm:h-[52px] rounded-2xl bg-good text-[#ffffff] dark:text-[#000000] text-[15px] sm:text-[17px] font-semibold flex items-center justify-center gap-2"
                        >
                          <Check weight="bold" className="w-5 h-5" /> Present
                        </button>
                        <button
                          onClick={() => resolve(c, "A")}
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

              {live.length > 1 && (
                <div className="flex justify-center gap-1.5 mt-3" aria-hidden>
                  {live.map((c, i) => (
                    <span
                      key={keyOf(c)}
                      className={`h-1.5 rounded-full transition-all ${i === active ? "w-4 bg-ink" : "w-1.5 bg-ink/25"}`}
                    />
                  ))}
                </div>
              )}
              {untimed.length > 0 && live.some((c) => !c.slot && !c.elsewhere) && (
                <p className="text-[13px] text-mute text-center mt-3 px-4 leading-snug">
                  Add class days and times to a subject and its card will follow the clock.
                </p>
              )}
            </>
          )}
        </section>
        )}

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
                        {c.slot ? formatTime(c.slot.start) : "Any time"}
                        {coveredBy(c.subject, today, c.slot?.start ?? "") && ` · Covered by ${coveredBy(c.subject, today, c.slot?.start ?? "")}`}
                      </p>
                    </div>
                    <button
                      onClick={() => onSet(c.subject.id, today, null, metaOf(c))}
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

        {/* Missed classes */}
        {missed.length > 0 && (
          <section>
            <SectionHeader>Recently missed</SectionHeader>
            <ul className={`${cardClass} ${divide}`}>
              {missed.map((m, i) => (
                <li key={`${m.id}-${m.d}-${m.t ?? ""}-${i}`}>
                  <button
                    onClick={() => onOpenSubject(m.id)}
                    className="w-full flex items-center justify-between px-4 py-3 min-h-[56px] text-left"
                  >
                    <span className="min-w-0">
                      <span className="block text-[15px] font-medium truncate">{m.name}</span>
                      {(m.k || m.t) && (
                        <span className="block text-[12px] text-mute">
                          {[m.k, m.t ? formatTime(m.t) : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                    <span className="text-[13px] text-mute whitespace-nowrap ml-3">{formatDayMonth(m.d)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      </div>
    </div>
  )
}
