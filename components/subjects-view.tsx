"use client"

import { useMemo, useState } from "react"
import { MagnifyingGlass, WarningCircle } from "@phosphor-icons/react"
import type { Subject } from "@/lib/types"
import { DAY_ORDER } from "@/lib/reminders"
import { getAttendance, needsAttention, bySafety, STATUS_STYLES, DAY_SHORT, type AttendanceInfo } from "@/lib/attendance"
import { primaryButton } from "./sheet"

interface SubjectsViewProps {
  subjects: Subject[]
  onOpen: (id: string) => void
  onAdd: () => void
  onImport: () => void
}

type Item = { s: Subject; info: AttendanceInfo }

/** The percentage in a tinted pill, coloured by status */
function PctPill({ info }: { info: AttendanceInfo }) {
  const st = STATUS_STYLES[info.status]
  return (
    <span className={`num inline-flex items-center rounded-full px-2.5 h-7 text-[14px] font-bold ${st.tint} ${info.status === "risk" ? st.text : "text-ink"}`}>
      {info.total ? `${info.pct}%` : "–"}
    </span>
  )
}

/** Colour matches the verdict on Today: red = below the target, orange = no skips left, otherwise quiet */
const STATUS_TEXT: Record<string, string> = { risk: "text-bad", edge: "text-warn", safe: "text-mute", new: "text-mute" }

/** "Mon · Wed · Fri" (Monday first), or "Every day" */
function classDays(s: Subject) {
  const days = new Set((s.slots ?? []).map((x) => x.day))
  if (days.size === 7) return "Every day"
  return days.size ? DAY_ORDER.filter((d) => days.has(d)).map((d) => DAY_SHORT[d]).join(" · ") : "No class days yet"
}

function SubjectRow({ s, info, onOpen }: Item & { onOpen: (id: string) => void }) {
  return (
    <li>
      <button
        data-testid="subject-row"
        onClick={() => onOpen(s.id)}
        className="w-full text-left rounded-2xl bg-card px-4 py-3.5 flex items-center gap-3.5 min-h-[76px] active:bg-ink/[0.04] transition"
      >
        <span className="w-1.5 self-stretch rounded-full flex-shrink-0" style={{ background: s.glowColor }} />
        <span className="min-w-0 flex-1">
          <span className="block text-[16px] font-semibold leading-snug truncate">{s.name}</span>
          <span className={`block text-[13px] leading-snug ${STATUS_TEXT[info.status]}`}>
            {info.total ? `${info.pct}% · ${s.requirement}% needed · ${info.short}` : `${s.requirement}% needed · Not started`}
          </span>
          <span className="block text-[12px] text-mute leading-snug truncate">{[s.tags?.length ? s.tags.join(", ") : null, classDays(s)].filter(Boolean).join(" · ")}</span>
        </span>
        <PctPill info={info} />
      </button>
    </li>
  )
}

/**
 * Every subject in one list, least safe first, each with where it stands and what it needs. Search finds a subject;
 * "Needs attention" and the tag chips narrow the list. Today's classes live on Today, not here.
 */
export default function SubjectsView({ subjects, onOpen, onAdd, onImport }: SubjectsViewProps) {
  const [tag, setTag] = useState<string | null>(null)
  const [attention, setAttention] = useState(false)
  const [query, setQuery] = useState("")

  const items: Item[] = useMemo(() => [...subjects].sort(bySafety).map((s) => ({ s, info: getAttendance(s.attended, s.missed, s.requirement) })), [subjects])
  const tags = useMemo(() => Array.from(new Set(subjects.flatMap((s) => s.tags || []))), [subjects])

  // Search and tag narrow the list first; the attention count then says how many of those need a look
  const base = items
    .filter(({ s }) => !tag || s.tags?.includes(tag))
    .filter(({ s }) => s.name.toLowerCase().includes(query.trim().toLowerCase()))
  const attentionCount = base.filter(({ info }) => needsAttention(info)).length
  const visible = attention ? base.filter(({ info }) => needsAttention(info)) : base

  const tagStats = (() => {
    if (!tag) return null
    const withData = base.filter((x) => x.info.total > 0)
    const avg = withData.length ? Math.round(withData.reduce((n, x) => n + x.info.pct, 0) / withData.length) : null
    return { count: base.length, avg }
  })()

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

  const chip = (on: boolean) => `h-7 px-2.5 rounded-full text-[12px] font-semibold whitespace-nowrap flex items-center gap-1.5 transition ${on ? "bg-ink text-paper" : "bg-secondary text-mute"}`

  return (
    <div>
      <label className="relative block">
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

      {(attentionCount > 0 || attention || tags.length > 0) && (
        <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar mt-3 -mx-4 px-4 pb-0.5" role="group" aria-label="Filters">
          {(attentionCount > 0 || attention) && (
            <button onClick={() => setAttention(!attention)} aria-pressed={attention} className={chip(attention)}>
              <WarningCircle weight="fill" className={`w-3.5 h-3.5 ${attention ? "" : "text-warn"}`} />
              Needs attention <span className="num opacity-70">{attentionCount}</span>
            </button>
          )}
          {tags.length > 0 && (attentionCount > 0 || attention) && <span className="w-px h-4 bg-ink/15 mx-1 flex-shrink-0" aria-hidden />}
          {tags.map((t) => (
            <button key={t} onClick={() => setTag(tag === t ? null : t)} aria-pressed={tag === t} className={chip(tag === t)}>
              {t}
            </button>
          ))}
        </div>
      )}
      {tagStats && (
        <p className="text-[12px] text-mute num mt-2.5 px-1">
          {tag} · {tagStats.count} {tagStats.count === 1 ? "subject" : "subjects"}
          {tagStats.avg !== null && ` · avg ${tagStats.avg}%`}
        </p>
      )}

      <div data-tour="subjects-list">
        {visible.length === 0 ? (
          <p className="text-mute py-16 text-center text-[15px]">No subjects match.</p>
        ) : (
          <ul className="space-y-2 lg:space-y-0 lg:grid lg:grid-cols-2 2xl:grid-cols-3 lg:gap-3 mt-4">
            {visible.map((it) => (
              <SubjectRow key={it.s.id} {...it} onOpen={onOpen} />
            ))}
          </ul>
        )}
      </div>

      <button onClick={onImport} className="block mx-auto mt-6 text-[15px] font-medium text-mute">
        Import timetable
      </button>
    </div>
  )
}
