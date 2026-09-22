"use client"

import { useRef, useState } from "react"
import { PencilSimple, Plus } from "@phosphor-icons/react"
import Sheet, { primaryButton } from "./sheet"
import { classesOn, daysUntil, formatShortDate, formatTime, getAttendance } from "@/lib/attendance"
import { loadWidgets, saveWidgets, WIDGETS, type WidgetId } from "@/lib/today-widgets"
import type { Subject, Task } from "@/lib/types"

interface Data {
  subjects: Subject[]
  tasks: Task[]
  now: Date
}

/* ---------- the widgets: each is one fixed-height card ---------- */

const CARD = "relative h-[330px] w-full rounded-[30px] overflow-hidden p-5 flex flex-col text-left"
const KICKER = "text-[12px] font-extrabold uppercase tracking-[0.09em] opacity-80"

function SkipTomorrow({ subjects, now }: Data) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  const rows = classesOn(subjects, tomorrow).map(({ subject, slot }) => {
    const info = getAttendance(subject.attended, subject.missed, subject.requirement)
    const after = Math.round((subject.attended / (info.total + 1)) * 100)
    const verdict = info.total === 0 ? "nodata" : info.status !== "risk" && (info.canSkip === null || info.canSkip > 0) ? "skip" : "attend"
    return { subject, slot, info, after, verdict }
  })
  const shown = rows.slice(0, 3)
  const firstSafe = rows.find((r) => r.verdict === "skip")

  return (
    <div className={`${CARD} text-white`} style={{ background: "linear-gradient(160deg,#0f4c5c,#16787f 60%,#1fa37a)" }}>
      <p className={KICKER}>Tomorrow · {rows.length} {rows.length === 1 ? "class" : "classes"}</p>
      <h3 className="font-display text-[28px] leading-[1.05] mt-0.5">Can I skip?</h3>
      {rows.length === 0 ? (
        <p className="mt-auto mb-auto text-[18px] font-semibold leading-snug">No classes tomorrow. Enjoy the day off.</p>
      ) : (
        <>
          <ul className="mt-1.5">
            {shown.map((r) => (
              <li key={`${r.subject.id}-${r.slot.start}`} className="flex items-center gap-2.5 rounded-2xl bg-white/15 px-3 py-2 mt-1.5">
                <span className="min-w-0 flex-1">
                  <b className="block text-[16px] tracking-tight truncate">{r.subject.name}</b>
                  <small className="block text-[12px] font-semibold opacity-80">
                    {formatTime(r.slot.start)} · now {r.info.total ? `${r.info.pct}%` : "no marks"}
                  </small>
                </span>
                <span
                  className={`rounded-full px-2.5 py-1 text-[12px] font-extrabold whitespace-nowrap ${
                    r.verdict === "skip" ? "bg-[#d9f7e4] text-[#0d5a2c]" : r.verdict === "attend" ? "bg-[#ffe0dd] text-[#a4160c]" : "bg-white/25 text-white"
                  }`}
                >
                  {r.verdict === "skip" ? "Safe to skip" : r.verdict === "attend" ? "Must attend" : "No data yet"}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-auto pt-2 text-[13.5px] font-semibold leading-snug">
            {firstSafe
              ? `Skip ${firstSafe.subject.name} and you're still at ${firstSafe.after}%.${rows.filter((r) => r.verdict === "attend").length ? " The others need you." : ""}`
              : "Every class tomorrow needs you. No skips to spare."}
            {rows.length > shown.length && <span className="opacity-80"> +{rows.length - shown.length} more</span>}
          </p>
        </>
      )}
    </div>
  )
}

const RING_C = 2 * Math.PI * 26

function WhereYouStand({ subjects }: Data) {
  const items = subjects
    .map((s) => ({ s, info: getAttendance(s.attended, s.missed, s.requirement) }))
    .sort((a, b) => (a.info.total ? a.info.pct - a.s.requirement : 999) - (b.info.total ? b.info.pct - b.s.requirement : 999))
  const shown = items.slice(0, 4)
  return (
    <div className={`${CARD} bg-card text-ink !p-[18px]`}>
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
    <div className={`${CARD} text-white`} style={{ background: "linear-gradient(160deg,#3b1c6b,#6a2fa0 55%,#a44bb8)" }}>
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
  if (id === "skip") return <SkipTomorrow {...data} />
  if (id === "stand") return <WhereYouStand {...data} />
  return <DeadlineWidget {...data} />
}

/** The "where you stand" card is light, so its edit button is too */
const isLight = (id: WidgetId) => id === "stand"

/* ---------- the stack, the invitation and the chooser ---------- */

export default function TodayWidgets(data: Data) {
  const [list, setList] = useState<WidgetId[] | null>(() => loadWidgets())
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)

  const update = (next: WidgetId[]) => {
    setList(next)
    saveWidgets(next)
  }
  // The order you tap them is the order they swipe in
  const toggle = (id: WidgetId) => update(list?.includes(id) ? list.filter((x) => x !== id) : [...(list ?? []), id])

  const step = () => {
    const first = box.current?.firstElementChild as HTMLElement | null
    return first ? first.offsetWidth + 12 : 0
  }
  const onScroll = () => {
    const el = box.current
    const w = step()
    if (!el || !w || !list) return
    setActive(Math.min(list.length - 1, Math.max(0, Math.round(el.scrollLeft / w))))
  }
  const goTo = (i: number) => box.current?.scrollTo({ left: i * step(), behavior: "smooth" })

  return (
    <section aria-label="Your widgets">
      {list === null ? (
        <div className="relative h-[330px] rounded-[30px] border-2 border-dashed border-ink/20 bg-card/70 flex flex-col items-center justify-center text-center px-6">
          <span className="absolute top-4 right-4 rounded-full bg-ink px-2.5 py-1 text-[11px] font-extrabold tracking-widest text-paper">NEW</span>
          <button onClick={() => setOpen(true)} aria-label="Choose widgets" className="widget-plus relative w-16 h-16 rounded-full bg-ink text-paper grid place-items-center">
            <Plus weight="bold" className="w-7 h-7" />
          </button>
          <h3 className="font-display text-[26px] leading-tight mt-4">Make this space yours</h3>
          <p className="text-[15px] text-mute mt-1.5 max-w-[17rem] leading-snug">You&rsquo;re all caught up. Choose what you&rsquo;d like to see here when the day is done.</p>
          <button onClick={() => setOpen(true)} className="widget-cta mt-4 h-11 px-6 rounded-full bg-ink text-paper text-[15px] font-bold">
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
            <span className="block text-[13px] text-mute">Skip forecast, where you stand, deadlines</span>
          </span>
        </button>
      ) : (
        <>
          <div
            ref={box}
            onScroll={onScroll}
            className="flex gap-3 overflow-x-auto snap-x snap-mandatory no-scrollbar"
          >
            {list.map((id) => (
              <div key={id} className="relative snap-center shrink-0 w-full">
                <Widget id={id} {...data} />
                <button
                  onClick={() => setOpen(true)}
                  aria-label="Edit widgets"
                  className={`absolute top-3.5 right-3.5 w-[38px] h-[38px] rounded-full grid place-items-center ${isLight(id) ? "bg-secondary text-ink" : "bg-black/30 text-white backdrop-blur"}`}
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
