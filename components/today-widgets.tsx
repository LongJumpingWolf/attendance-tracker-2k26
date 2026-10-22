"use client"

import { useEffect, useRef, useState } from "react"
import { PencilSimple, Plus } from "@phosphor-icons/react"
import Sheet, { primaryButton } from "./sheet"
import { classesOn, daysUntil, formatShortDate, formatTime, getAttendance, localDate } from "@/lib/attendance"
import { loadWidgets, saveWidgets, WIDGETS, type WidgetId } from "@/lib/today-widgets"
import type { ScheduleOverride, Subject, Task } from "@/lib/types"

interface Data {
  subjects: Subject[]
  tasks: Task[]
  now: Date
  scheduleOverrides?: ScheduleOverride[]
  onOpenTomorrow?: (date: string) => void
  demoActive?: boolean
}

/* ---------- the widgets: each is one fixed-height card ---------- */

const CARD = "relative h-[286px] w-full rounded-[24px] overflow-hidden p-4 flex flex-col text-left"
const KICKER = "text-[12px] font-extrabold uppercase tracking-[0.09em] opacity-80"

function TomorrowLectures({ subjects, now, scheduleOverrides = [], onOpenTomorrow }: Data) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const date = localDate(tomorrow)
  const rows = classesOn(subjects, tomorrow, scheduleOverrides)
    .filter((entry) => !entry.cancelled)
    .sort((a, b) => a.slot.start.localeCompare(b.slot.start))
  const shown = rows.slice(0, 4)

  return (
    <button
      type="button"
      onClick={() => onOpenTomorrow?.(date)}
      data-tour="tomorrow-lectures-widget"
      aria-label={`Open Calendar for tomorrow, ${rows.length} scheduled ${rows.length === 1 ? "lecture" : "lectures"}`}
      className={`${CARD} text-white text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink`}
      style={{ background: "linear-gradient(145deg,#1e3a5f,#276c8e 58%,#479ca4)" }}
    >
      <p className={KICKER}>Tomorrow · {rows.length} {rows.length === 1 ? "lecture" : "lectures"}</p>
      <div className="flex items-center justify-between gap-2 mt-0.5 mb-2">
        <h3 className="font-display text-[23px] leading-tight">Lectures scheduled</h3>
        <span className="w-8 h-8 shrink-0 rounded-full bg-white/15 grid place-items-center text-[16px]" aria-hidden>↗</span>
      </div>
      {rows.length === 0 ? (
        <p className="my-auto text-[15px] font-semibold leading-snug">No lectures scheduled for tomorrow. Enjoy the breathing room.</p>
      ) : (
        <>
          <ul className="space-y-1.5 flex-1 min-h-0">
            {shown.map((entry, index) => {
              const name = entry.override?.kind === "substitute" && entry.attendanceSubject
                ? `${entry.attendanceSubject.name} · held as ${entry.subject.name}`
                : entry.subject.name
              return (
                <li key={`${entry.originalSubjectId ?? entry.subject.id}-${entry.slot.start}-${index}`} className="flex items-center gap-2.5 rounded-xl bg-white/12 px-2.5 py-1.5 min-w-0">
                  <span className="num text-[12px] font-bold text-white/80 w-[58px] shrink-0">{formatTime(entry.slot.start)}</span>
                  <span className="text-[13.5px] font-semibold truncate">{name}</span>
                </li>
              )
            })}
          </ul>
          <p className="mt-2 text-[12px] font-semibold opacity-90">
            {rows.length > shown.length ? `+ ${rows.length - shown.length} more · Tap to open Calendar` : "Tap to view the full day in Calendar"}
          </p>
        </>
      )}
    </button>
  )
}

const RING_C = 2 * Math.PI * 26

function WhereYouStand({ subjects }: Data) {
  const items = subjects
    .map((s) => ({ s, info: getAttendance(s.attended, s.missed, s.requirement) }))
    .sort((a, b) => (a.info.total ? a.info.pct - a.s.requirement : 999) - (b.info.total ? b.info.pct - b.s.requirement : 999))
  const shown = items.slice(0, 4)
  return (
    <div data-tour="where-you-stand-widget" className={`${CARD} bg-card text-ink !p-[18px]`}>
      <p className={`${KICKER} !opacity-100 text-mute`}>Where you stand</p>
      <h3 className="font-display text-[24px] leading-tight mt-0.5">
        {items.length === 1 ? "One subject" : `${items.length} subjects`}, one glance
      </h3>
      <ul className="grid grid-cols-2 gap-2.5 mt-3 flex-1 min-h-0 content-start">
        {shown.map(({ s, info }) => {
          const risk = info.status === "risk"
          const color = risk ? "#ff3b30" : info.status === "new" ? "#8e8e93" : info.canSkip === 0 ? "#ff9f0a" : "#34c759"
          return (
            <li key={s.id} className="grid grid-cols-[50px_minmax(0,1fr)] gap-2 items-center rounded-[20px] bg-secondary p-2.5 min-w-0">
              <svg viewBox="0 0 64 64" className="w-[50px] h-[50px] -rotate-90" aria-hidden>
                <circle cx="32" cy="32" r="26" fill="none" strokeWidth="7" className="stroke-ink/10" />
                <circle cx="32" cy="32" r="26" fill="none" strokeWidth="7" strokeLinecap="round" stroke={color} strokeDasharray={`${(Math.min(100, info.pct) / 100) * RING_C} ${RING_C}`} />
              </svg>
              <span className="min-w-0">
                <small className="block text-[13px] font-bold truncate">{s.name}</small>
                <b className="block num text-[19px] tracking-tight leading-[1.1]">{info.total ? `${info.pct}%` : "–"}</b>
                <small className={`block text-[12px] font-bold leading-tight ${risk ? "text-bad" : "text-mute"}`}>
                  {info.status === "new" ? "No marks yet" : risk ? (info.needed ? `Attend next ${info.needed}` : "Below limit") : info.canSkip === 0 ? "No skips left" : info.canSkip === null ? "No minimum" : `${info.canSkip} ${info.canSkip === 1 ? "skip" : "skips"} left`}
                </small>
              </span>
            </li>
          )
        })}
      </ul>
      {items.length > shown.length && <p className="text-[12px] font-semibold text-mute mt-2">Showing the {shown.length} that need you most. {items.length - shown.length} more in Subjects.</p>}
    </div>
  )
}

function DeadlineWidget({ tasks, subjects }: Data) {
  const upcoming = tasks
    .filter((t) => !t.done)
    .map((t) => ({ t, days: daysUntil(t.dueDate) }))
    .filter((x) => x.days >= 0)
    .sort((a, b) => a.days - b.days)
  const first = upcoming[0]
  const second = upcoming[1]
  const when = (n: number) => (n === 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`)

  return (
    <div data-tour="deadline-widget" className={`${CARD} text-white`} style={{ background: "linear-gradient(160deg,#3b1c6b,#6a2fa0 55%,#a44bb8)" }}>
      <p className={KICKER}>Next deadline</p>
      {!first ? (
        <p className="my-auto text-[22px] font-semibold leading-snug">Nothing due soon. Add deadlines in Calendar and the next one shows up here.</p>
      ) : (
        <>
          <p className="font-display leading-none mt-1 text-[96px] tracking-[-0.05em]">
            {first.days === 0 ? <span className="text-[64px]">Today</span> : first.days === 1 ? <span className="text-[64px]">Tomorrow</span> : (
              <>
                {first.days}
                <small className="text-[26px] font-bold opacity-85 ml-1.5 tracking-tight">days</small>
              </>
            )}
          </p>
          <h3 className="font-display text-[22px] leading-tight mt-1.5 line-clamp-2">{first.t.title}</h3>
          <p className="text-[13px] font-semibold opacity-80 mt-1.5">
            {[subjects.find((s) => s.id === first.t.subjectId)?.name, formatShortDate(first.t.dueDate)].filter(Boolean).join(" · ")}
          </p>
          {second && (
            <div className="mt-auto flex items-center justify-between gap-3 rounded-2xl bg-white/15 px-3.5 py-3 text-[14px] font-bold">
              <span className="truncate">{second.t.title}</span>
              <span className="font-semibold opacity-80 whitespace-nowrap">{when(second.days)}</span>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function Widget({ id, ...data }: Data & { id: WidgetId }) {
  if (id === "skip") return <TomorrowLectures {...data} />
  if (id === "stand") return <WhereYouStand {...data} />
  return <DeadlineWidget {...data} />
}

/** The "where you stand" card is light, so its edit button is too */
const isLight = (id: WidgetId) => id === "stand"

/* ---------- the stack, the invitation and the chooser ---------- */

export default function TodayWidgets(data: Data) {
  const [list, setList] = useState<WidgetId[] | null>(() => loadWidgets())
  const [open, setOpen] = useState(false)
  useEffect(() => {
    // The demo shows all three widgets without overwriting the user's saved widget choices.
    setList(data.demoActive ? ["skip", "stand", "deadline"] : loadWidgets())
  }, [data.demoActive])
  const box = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const activeRef = useRef(active)
  activeRef.current = active
  const gestureStart = useRef<{ x: number; y: number; scrollLeft: number; index: number } | null>(null)
  const pointerDidDrag = useRef(false)
  const suppressClickUntil = useRef(0)

  const listSignature = list?.join("|") ?? "unset"

  useEffect(() => {
    const viewport = box.current
    if (!viewport || typeof ResizeObserver === "undefined") return
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const items = Array.from(viewport.children).filter((node): node is HTMLElement => node instanceof HTMLElement)
        const card = items[Math.min(activeRef.current, items.length - 1)]
        if (!card) return
        const left = card.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft
        viewport.scrollTo({ left, behavior: "auto" })
      })
    })
    observer.observe(viewport)
    return () => { observer.disconnect(); cancelAnimationFrame(frame) }
  }, [listSignature])

  const update = (next: WidgetId[]) => {
    setList(next)
    saveWidgets(next)
  }
  // The order you tap them is the order they swipe in
  const toggle = (id: WidgetId) => update(list?.includes(id) ? list.filter((x) => x !== id) : [...(list ?? []), id])

  // Use each card's actual offset instead of assuming every viewport has an identical width.
  // This avoids drift when mobile browser chrome changes the available width or fonts wrap differently.
  const cards = () => Array.from(box.current?.children ?? []).filter((node): node is HTMLElement => node instanceof HTMLElement)
  const leftFor = (card: HTMLElement) => {
    const viewport = box.current
    if (!viewport) return 0
    return card.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft
  }
  const closestIndex = () => {
    const viewport = box.current
    const items = cards()
    if (!viewport || !items.length) return 0
    let nearest = 0
    let distance = Number.POSITIVE_INFINITY
    items.forEach((card, i) => {
      const delta = Math.abs(leftFor(card) - viewport.scrollLeft)
      if (delta < distance) { nearest = i; distance = delta }
    })
    return nearest
  }
  const onScroll = () => {
    if (!box.current || !list) return
    const next = Math.min(list.length - 1, Math.max(0, closestIndex()))
    setActive((current) => current === next ? current : next)
  }
  const goTo = (i: number) => {
    const items = cards()
    if (!items.length || !box.current) return
    const index = Math.max(0, Math.min(items.length - 1, i))
    const card = items[index]
    box.current.scrollTo({ left: leftFor(card), behavior: "smooth" })
  }
  const startPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse" || !box.current) return
    suppressClickUntil.current = 0
    pointerDidDrag.current = false
    gestureStart.current = { x: e.clientX, y: e.clientY, scrollLeft: box.current.scrollLeft, index: closestIndex() }
  }
  const movePointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return
    const start = gestureStart.current
    const viewport = box.current
    if (!start || !viewport) return
    const dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.15) return
    pointerDidDrag.current = true
    if (!viewport.hasPointerCapture(e.pointerId)) viewport.setPointerCapture(e.pointerId)
    viewport.scrollLeft = start.scrollLeft - dx
  }
  const finishPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return
    const start = gestureStart.current
    const viewport = box.current
    if (!start || !viewport) return
    const dx = e.clientX - start.x
    if (pointerDidDrag.current) {
      suppressClickUntil.current = Date.now() + 550
      // The drag has already moved the track. Snap to the card that actually ended nearest the viewport,
      // rather than assuming a fixed one-card jump from where the drag started.
      goTo(closestIndex())
      if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId)
    }
    gestureStart.current = null
    pointerDidDrag.current = false
  }
  const cancelPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "mouse") return
    gestureStart.current = null
    pointerDidDrag.current = false
  }
  const startTouch = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!box.current) return
    suppressClickUntil.current = 0
    gestureStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, scrollLeft: box.current.scrollLeft, index: closestIndex() }
  }
  const finishTouch = (e: React.TouchEvent<HTMLDivElement>) => {
    const start = gestureStart.current
    if (!start) return
    const dx = e.changedTouches[0].clientX - start.x
    const dy = e.changedTouches[0].clientY - start.y
    if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy) * 1.2) {
      // Native horizontal scrolling + CSS snap already chooses the settled card. An extra smooth goTo here fights
      // the finger and causes visible tile shifting on mobile.
      suppressClickUntil.current = Date.now() + 550
    }
    gestureStart.current = null
  }
  const suppressDraggedClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (suppressClickUntil.current > Date.now()) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  return (
    <section aria-label="Your widgets" data-tour="widget-stack">
      {list === null ? (
        <div className="relative h-[286px] rounded-[24px] border-2 border-dashed border-ink/20 bg-card/70 flex flex-col items-center justify-center text-center px-6">
          <span className="absolute top-4 right-4 rounded-full bg-ink px-2.5 py-1 text-[11px] font-extrabold tracking-widest text-paper">NEW</span>
          <button onClick={() => setOpen(true)} aria-label="Choose widgets" className="widget-plus relative w-14 h-14 rounded-full bg-ink text-paper grid place-items-center">
            <Plus weight="bold" className="w-7 h-7" />
          </button>
          <h3 className="font-display text-[23px] leading-tight mt-3">Make this space yours</h3>
          <p className="text-[14px] text-mute mt-1.5 max-w-[17rem] leading-snug">You&rsquo;re all caught up. Choose what you&rsquo;d like to see here when the day is done.</p>
          <button onClick={() => setOpen(true)} className="widget-cta mt-3 h-10 px-5 rounded-full bg-ink text-paper text-[15px] font-bold">
            Choose widgets
          </button>
          <div className="flex flex-wrap justify-center gap-1.5 mt-3.5">
            {WIDGETS.map((w) => (
              <span key={w.id} className="rounded-full bg-secondary px-2.5 py-1 text-[12px] font-bold text-mute">
                {w.title}
              </span>
            ))}
          </div>
        </div>
      ) : list.length === 0 ? (
        <button onClick={() => setOpen(true)} className="w-full flex items-center gap-3 rounded-2xl bg-card px-4 py-3.5 text-left">
          <span className="w-10 h-10 rounded-full bg-secondary grid place-items-center flex-shrink-0">
            <Plus weight="bold" className="w-5 h-5" />
          </span>
          <span>
            <span className="block text-[16px] font-semibold">Add a widget</span>
            <span className="block text-[13px] text-mute">Tomorrow lectures, where you stand, deadlines</span>
          </span>
        </button>
      ) : (
        <>
          <div
            ref={box}
            onScroll={onScroll}
            onPointerDown={startPointer}
            onPointerMove={movePointer}
            onPointerUp={finishPointer}
            onPointerCancel={cancelPointer}
            onTouchStart={startTouch}
            onTouchEnd={finishTouch}
            onClickCapture={suppressDraggedClick}
            style={{ touchAction: "pan-x pan-y", WebkitOverflowScrolling: "touch", overscrollBehaviorX: "contain", scrollSnapStop: "always" }}
            className="flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar scroll-px-0 cursor-grab active:cursor-grabbing select-none"
          >
            {list.map((id) => (
              <div key={id} className="relative snap-start shrink-0 w-full">
                <Widget id={id} {...data} />
                <button
                  onClick={() => setOpen(true)}
                  aria-label="Edit widgets"
                  className={`absolute top-2.5 right-2.5 w-9 h-9 rounded-full grid place-items-center ${isLight(id) ? "bg-secondary text-ink" : "bg-black/30 text-white backdrop-blur"}`}
                >
                  <PencilSimple weight="bold" className="w-[18px] h-[18px]" />
                </button>
              </div>
            ))}
          </div>
          {list.length > 1 && (
            <div className="flex justify-center gap-1.5 mt-3" role="tablist" aria-label="Widgets">
              {list.map((id, i) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={i === active}
                  aria-label={`Show ${WIDGETS.find((w) => w.id === id)?.title}`}
                  onClick={() => goTo(i)}
                  className={`h-2 rounded-full transition-all ${i === active ? "w-5 bg-ink" : "w-2 bg-ink/25"}`}
                />
              ))}
            </div>
          )}
        </>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Your widgets">
        <p className="text-[14px] text-mute leading-snug -mt-1 mb-4">
          Tap the ones you want. They swipe in the order you pick them, like a widget stack.
        </p>
        <ul>
          {WIDGETS.map((w) => {
            const at = list?.indexOf(w.id) ?? -1
            const selected = at !== -1
            return (
              <li key={w.id}>
                <button
                  onClick={() => toggle(w.id)}
                  aria-pressed={selected}
                  className={`w-full flex items-center gap-3 rounded-2xl bg-secondary p-2.5 mb-2.5 text-left border-2 transition ${selected ? "border-ink" : "border-transparent"}`}
                >
                  <span className="relative w-[118px] h-[115px] rounded-[14px] overflow-hidden bg-card flex-shrink-0" aria-hidden>
                    <span className="block w-[340px] origin-top-left pointer-events-none" style={{ transform: "scale(0.347)" }}>
                      <Widget id={w.id} {...data} />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <b className="block text-[16px] tracking-tight leading-snug">{w.title}</b>
                    <small className="block text-[12.5px] text-mute leading-snug mt-0.5">{w.description}</small>
                  </span>
                  <span className={`w-7 h-7 rounded-full grid place-items-center text-[13px] font-bold flex-shrink-0 ${selected ? "bg-ink text-paper" : "border-2 border-ink/25"}`}>
                    {selected ? at + 1 : ""}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        <button onClick={() => setOpen(false)} className={`${primaryButton} mt-3`}>
          Done
        </button>
        {list && list.length > 0 && (
          <button onClick={() => update([])} className="block mx-auto mt-3 text-[15px] font-medium text-mute">
            Clear all
          </button>
        )}
      </Sheet>
    </section>
  )
}
