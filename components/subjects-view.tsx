"use client"

import { useEffect, useMemo, useState } from "react"
import { Clock, MagnifyingGlass, SquaresFour, Tag } from "@phosphor-icons/react"
import type { Slot, Subject } from "@/lib/types"
import { DAY_NAMES } from "@/lib/reminders"
import {
  getAttendance,
  STATUS_STYLES,
  formatTime,
  timeParts,
  toMin,
  type AttendanceInfo,
  type AttendanceStatus,
} from "@/lib/attendance"
import { primaryButton } from "./sheet"

interface SubjectsViewProps {
  subjects: Subject[]
  onOpen: (id: string) => void
  onAdd: () => void
  onImport: () => void
}

type Filter = "all" | AttendanceStatus
type View = "cards" | "tags" | "timetable"

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "risk", label: "At risk" },
  { id: "edge", label: "Close" },
  { id: "safe", label: "On track" },
]

const VIEWS: { id: View; label: string; Icon: typeof SquaresFour }[] = [
  { id: "cards", label: "Cards", Icon: SquaresFour },
  { id: "tags", label: "By tag", Icon: Tag },
  { id: "timetable", label: "By timetable", Icon: Clock },
]

const VIEW_KEY = "subjectsView"

type Item = { s: Subject; info: AttendanceInfo }

/** Least safe first: how far each subject is from its minimum */
const bySafety = (a: Item, b: Item) =>
  (a.info.total ? a.info.pct - a.s.requirement : 999) - (b.info.total ? b.info.pct - b.s.requirement : 999)

/** The percentage in a tinted pill, coloured by status */
function PctPill({ info }: { info: AttendanceInfo }) {
  const st = STATUS_STYLES[info.status]
  return (
    <span className={`num inline-flex items-center rounded-full px-2.5 h-7 text-[14px] font-bold ${st.tint} ${info.status === "risk" ? st.text : "text-ink"}`}>
      {info.total ? `${info.pct}%` : "–"}
    </span>
  )
}

function SubjectCard({ s, info, onOpen }: Item & { onOpen: (id: string) => void }) {
  const st = STATUS_STYLES[info.status]
  return (
    <button onClick={() => onOpen(s.id)} className="w-full h-full min-h-[148px] text-left rounded-2xl bg-card p-4 flex flex-col">
      <span className="flex items-center gap-2 text-[12px] text-mute min-w-0">
        <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: s.glowColor }} />
        <span className="truncate">{s.tags?.[0] ?? "Subject"}</span>
      </span>
      <h3 className="mt-1.5 text-[16px] leading-snug font-semibold line-clamp-2 break-words">{s.name}</h3>
      <div className="mt-auto pt-4">
        <span className="num text-[32px] leading-none font-bold tracking-tight">
          {info.total ? info.pct : "–"}
          {info.total > 0 && <span className="text-[16px] text-mute font-semibold">%</span>}
        </span>
        <div className="h-1 rounded-full bg-ink/10 mt-3 overflow-hidden">
          <div className="h-full rounded-full" style={{ width: `${Math.min(100, info.pct)}%`, background: st.color }} />
        </div>
        <p className={`text-[12px] font-medium mt-2 leading-tight ${st.text}`}>{info.short}</p>
      </div>
    </button>
  )
}

/** A compact row for the grouped views. `lead` is an optional time block on the left. */
function SubjectRow({ s, info, onOpen, lead, sub, quiet }: Item & { onOpen: (id: string) => void; lead?: React.ReactNode; sub?: string; quiet?: boolean }) {
  const st = STATUS_STYLES[info.status]
  return (
    <li>
      <button onClick={() => onOpen(s.id)} className="w-full flex items-center gap-3.5 px-4 py-3 text-left min-h-[64px] active:bg-ink/[0.04] transition">
        {lead}
        <span className="w-1.5 self-stretch rounded-full flex-shrink-0" style={{ background: s.glowColor }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold leading-snug truncate">{s.name}</span>
          <span className={`block text-[13px] leading-snug truncate ${info.status === "risk" ? "text-bad" : "text-mute"}`}>
            {[sub, quiet && info.status !== "risk" ? "" : info.short].filter(Boolean).join(" · ")}
          </span>
        </span>
        <PctPill info={info} />
      </button>
      <span className="sr-only">{st.label}</span>
    </li>
  )
}

const groupHeader = "flex items-baseline justify-between mb-2 px-1"
const groupCard = "rounded-2xl bg-card overflow-hidden divide-y divide-ink/[0.08]"

export default function SubjectsView({ subjects, onOpen, onAdd, onImport }: SubjectsViewProps) {
  const [filter, setFilter] = useState<Filter>("all")
  const [tag, setTag] = useState<string | null>(null)
  const [query, setQuery] = useState("")
  const [view, setView] = useState<View>("cards")
  const [todayDow, setTodayDow] = useState(0)

  // Remember the last view, and learn today's weekday on the client
  useEffect(() => {
    try {
      const saved = localStorage.getItem(VIEW_KEY)
      if (saved === "cards" || saved === "tags" || saved === "timetable") setView(saved)
    } catch {
      /* private mode: just use the default */
    }
    setTodayDow(new Date().getDay())
  }, [])

  const pickView = (v: View) => {
    setView(v)
    try {
      localStorage.setItem(VIEW_KEY, v)
    } catch {
      /* not remembered, still works */
    }
  }

  const items: Item[] = useMemo(() => subjects.map((s) => ({ s, info: getAttendance(s.attended, s.missed, s.requirement) })), [subjects])
  const tags = useMemo(() => Array.from(new Set(subjects.flatMap((s) => s.tags || []))), [subjects])

  // Search and tag narrow the list first. The status pills then count what is left, so their numbers make sense.
  const base = items
    .filter(({ s }) => (view === "tags" ? true : !tag || s.tags?.includes(tag)))
    .filter(({ s }) => s.name.toLowerCase().includes(query.trim().toLowerCase()))
  const visible = base.filter(({ info }) => filter === "all" || info.status === filter).sort(bySafety)
  const countOf = (f: Filter) => (f === "all" ? base.length : base.filter(({ info }) => info.status === f).length)

  const tagGroups = useMemo(() => {
    const names = Array.from(new Set(visible.flatMap(({ s }) => s.tags || []))).sort((a, b) => a.localeCompare(b))
    const groups = names.map((name) => ({ name, list: visible.filter(({ s }) => s.tags?.includes(name)) }))
    const untagged = visible.filter(({ s }) => !s.tags?.length)
    return untagged.length ? [...groups, { name: "No tag", list: untagged }] : groups
  }, [visible])

  const dayGroups = useMemo(() => {
    const order = Array.from({ length: 7 }, (_, i) => (todayDow + i) % 7)
    return order
      .map((day) => ({
        day,
        rows: visible
          .flatMap((it) => (it.s.slots ?? []).filter((x) => x.day === day).map((slot) => ({ ...it, slot })))
          .sort((a, b) => toMin(a.slot.start) - toMin(b.slot.start)),
      }))
      .filter((g) => g.rows.length > 0)
  }, [visible, todayDow])
  const noTimetable = visible.filter(({ s }) => !s.slots?.length)

  if (subjects.length === 0) {
    return (
      <div className="rounded-2xl bg-card p-6">
        <h2 className="text-[22px] font-bold tracking-tight">No subjects yet</h2>
        <p className="text-[15px] text-mute mt-2 mb-5">Add a subject and the minimum attendance it needs.</p>
        <button onClick={onAdd} className={primaryButton}>
          Add a subject
        </button>
        <button onClick={onImport} className="w-full mt-2 h-12 text-[17px] font-semibold text-mute">
          Import from a timetable photo
        </button>
      </div>
    )
  }

  const dayLabel = (day: number) => (day === todayDow ? "Today" : day === (todayDow + 1) % 7 ? "Tomorrow" : DAY_NAMES[day])

  return (
    <div>
      {/* Search + view switcher */}
      <div className="flex items-center gap-2">
        <label className="relative block flex-1 min-w-0">
          <span className="sr-only">Search subjects</span>
          <MagnifyingGlass weight="bold" className="w-4 h-4 text-mute absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="w-full h-10 rounded-xl bg-secondary pl-10 pr-3 text-[17px] outline-none placeholder:text-mute focus:ring-2 focus:ring-ink/25"
          />
        </label>
        <div role="tablist" aria-label="View subjects as" className="flex p-0.5 rounded-[10px] bg-secondary flex-shrink-0">
          {VIEWS.map(({ id, label, Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={view === id}
              aria-label={label}
              title={label}
              onClick={() => pickView(id)}
              className={`w-10 h-9 rounded-lg grid place-items-center transition ${view === id ? "bg-card text-ink shadow-sm" : "text-mute"}`}
            >
              <Icon weight={view === id ? "fill" : "regular"} className="w-[18px] h-[18px]" />
            </button>
          ))}
        </div>
      </div>

      {/* One slim row: status pills, then tags (tags are the grouping in the tag view, so they hide there) */}
      <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mt-3 -mx-4 px-4 pb-0.5" role="group" aria-label="Filters">
        {FILTERS.map((f) => {
          const on = filter === f.id
          return (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              aria-pressed={on}
              className={`h-7 px-2.5 rounded-full text-[12px] font-semibold whitespace-nowrap flex items-center gap-1.5 transition ${
                on ? "bg-ink text-paper" : "bg-secondary text-mute"
              }`}
            >
              {f.id === "risk" && <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-paper" : "bg-bad"}`} />}
              {f.label}
              <span className={`num ${on ? "opacity-70" : "opacity-60"}`}>{countOf(f.id)}</span>
            </button>
          )
        })}
        {view !== "tags" && tags.length > 0 && <span className="w-px h-4 bg-ink/15 mx-1 flex-shrink-0" aria-hidden />}
        {view !== "tags" &&
          tags.map((t) => (
            <button
              key={t}
              onClick={() => setTag(tag === t ? null : t)}
              aria-pressed={tag === t}
              className={`h-7 px-2.5 rounded-full text-[12px] font-semibold whitespace-nowrap transition ${
                tag === t ? "bg-ink text-paper" : "bg-secondary text-mute"
              }`}
            >
              {t}
            </button>
          ))}
      </div>

      <div data-tour="subjects-list">
      {visible.length === 0 ? (
        <p className="text-mute py-16 text-center text-[15px]">No subjects match.</p>
      ) : view === "cards" ? (
        <ul className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-5 gap-3 mt-5">
          {visible.map((it) => (
            <li key={it.s.id}>
              <SubjectCard {...it} onOpen={onOpen} />
            </li>
          ))}
        </ul>
      ) : view === "tags" ? (
        <div className="mt-5 space-y-6 lg:space-y-0 lg:grid lg:grid-cols-2 2xl:grid-cols-3 lg:gap-x-8 lg:gap-y-6 lg:items-start">
          {tagGroups.map(({ name, list }) => {
            const withData = list.filter((x) => x.info.total > 0)
            const avg = withData.length ? Math.round(withData.reduce((n, x) => n + x.info.pct, 0) / withData.length) : null
            return (
              <section key={name}>
                <div className={groupHeader}>
                  <h2 className="text-[12px] font-medium uppercase tracking-wider text-mute">{name}</h2>
                  <span className="text-[12px] text-mute num">
                    {list.length} {list.length === 1 ? "subject" : "subjects"}
                    {avg !== null && ` · avg ${avg}%`}
                  </span>
                </div>
                <ul className={groupCard}>
                  {list.map((it) => (
                    <SubjectRow key={it.s.id} {...it} onOpen={onOpen} />
                  ))}
                </ul>
              </section>
            )
          })}
          {tags.length === 0 && (
            <p className="text-[13px] text-mute px-1 -mt-3 leading-snug">Tag your subjects (Theory, Practical…) when you edit them and they&rsquo;ll be grouped here.</p>
          )}
        </div>
      ) : (
        <div className="mt-5 space-y-6 lg:space-y-0 lg:grid lg:grid-cols-2 2xl:grid-cols-3 lg:gap-x-8 lg:gap-y-6 lg:items-start">
          {dayGroups.map(({ day, rows }) => (
            <section key={day}>
              <div className={groupHeader}>
                <h2 className={`text-[12px] font-medium uppercase tracking-wider ${day === todayDow ? "text-ink" : "text-mute"}`}>{dayLabel(day)}</h2>
                <span className="text-[12px] text-mute num">
                  {rows.length} {rows.length === 1 ? "class" : "classes"}
                </span>
              </div>
              <ul className={groupCard}>
                {rows.map(({ slot, ...it }) => (
                  <SubjectRow
                    key={`${it.s.id}-${slot.start}`}
                    {...it}
                    onOpen={onOpen}
                    sub={slotSub(slot)}
                    quiet
                    lead={<TimeBlock start={slot.start} />}
                  />
                ))}
              </ul>
            </section>
          ))}
          {noTimetable.length > 0 && (
            <section>
              <div className={groupHeader}>
                <h2 className="text-[12px] font-medium uppercase tracking-wider text-mute">No timetable</h2>
                <span className="text-[12px] text-mute num">{noTimetable.length}</span>
              </div>
              <ul className={groupCard}>
                {noTimetable.map((it) => (
                  <SubjectRow key={it.s.id} {...it} onOpen={onOpen} />
                ))}
              </ul>
              <p className="text-[13px] text-mute px-1 mt-2 leading-snug">Add class days when you edit a subject to see it on the timetable.</p>
            </section>
          )}
        </div>
      )}
      </div>

      <button onClick={onImport} className="block mx-auto mt-6 text-[15px] font-medium text-mute">
        Import timetable
      </button>
    </div>
  )
}

const slotSub = (slot: Slot) => `Until ${formatTime(slot.end)}${slot.kind ? ` · ${slot.kind}` : ""}`

/** "9:00 / am" stacked, like the Today timetable */
function TimeBlock({ start }: { start: string }) {
  const { time, ap } = timeParts(start)
  return (
    <span className="w-11 flex-shrink-0 text-center leading-tight">
      <span className="block num text-[15px] font-bold">{time}</span>
      <span className="block text-[11px] text-mute">{ap}</span>
    </span>
  )
}
