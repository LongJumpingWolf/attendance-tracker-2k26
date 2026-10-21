"use client"

import { useEffect, useMemo, useState } from "react"
import { ArrowsLeftRight, CaretLeft, CaretRight, CheckCircle, XCircle, CalendarDots, Tag, CalendarBlank } from "@phosphor-icons/react"
import Sheet, { cardClass, primaryButton, tintButton } from "./sheet"
import type { ScheduleOverride, Subject } from "@/lib/types"
import type { ClassActionTarget } from "./class-action-menu"
import { formatTime, localDate, parseLocalDate, isSubjectSleeping } from "@/lib/attendance"

const dateString = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]
function monthCells(month: Date) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1)
  const days = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const lead = (first.getDay() + 6) % 7
  return [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => dateString(new Date(month.getFullYear(), month.getMonth(), i + 1)))] as (string | null)[]
}
function nextOccurrence(from: string, weekday: number) {
  const date = parseLocalDate(from)
  const delta = (weekday - date.getDay() + 7) % 7
  date.setDate(date.getDate() + delta)
  return dateString(date)
}

export default function ClassChangeSheet({
  target, subjects, overrides, onClose, onCancelClass, onReplaceClass, onRestore,
}: {
  target: ClassActionTarget | null
  subjects: Subject[]
  overrides: ScheduleOverride[]
  onClose: () => void
  onCancelClass: (subjectId: string, date: string, start: string) => void
  onReplaceClass: (subjectId: string, date: string, start: string, replacementId: string) => void
  onRestore: (subjectId: string, date: string, start: string) => void
}) {
  const [mode, setMode] = useState<"replace" | "cancel">("replace")
  const [scope, setScope] = useState<"today" | "custom">("today")
  const [date, setDate] = useState(localDate())
  const [month, setMonth] = useState(() => new Date())
  const [query, setQuery] = useState("")
  const [tag, setTag] = useState<string | null>(null)
  const [selected, setSelected] = useState("")
  const [confirmCancel, setConfirmCancel] = useState(false)

  useEffect(() => {
    if (!target) return
    const today = localDate()
    const canUseToday = parseLocalDate(today).getDay() === target.slot.day
    const startingDate = target.date === today && canUseToday ? today : target.date >= today && parseLocalDate(target.date).getDay() === target.slot.day ? target.date : nextOccurrence(today, target.slot.day)
    setMode(target.intent ?? "replace")
    setDate(startingDate)
    setScope(startingDate === today ? "today" : "custom")
    setMonth(new Date(parseLocalDate(startingDate).getFullYear(), parseLocalDate(startingDate).getMonth(), 1))
    setQuery("")
    setTag(null)
    setSelected("")
    setConfirmCancel(false)
  }, [target?.subjectId, target?.date, target?.slot.start, target?.intent])

  const today = localDate()
  const source = subjects.find((s) => s.id === target?.subjectId)
  const activeDate = scope === "today" ? today : date
  const existing = overrides.find((o) => o.originalSubjectId === target?.subjectId && o.date === activeDate && o.start === target?.slot.start)
  const tags = useMemo(() => Array.from(new Set(subjects.filter((s) => s.id !== target?.subjectId && !s.sleeping).flatMap((s) => s.tags || []))).sort((a, b) => a.localeCompare(b)), [subjects, target?.subjectId])
  const options = subjects.filter((s) => s.id !== target?.subjectId && !isSubjectSleeping(s, activeDate) && (!tag || s.tags?.includes(tag)) && s.name.toLowerCase().includes(query.trim().toLowerCase()))
  const cells = monthCells(month)
  const validDay = (d: string) => d >= today && parseLocalDate(d).getDay() === target?.slot.day
  const todayValid = !!target && parseLocalDate(today).getDay() === target.slot.day
  const marked = new Set(overrides.filter((o) => o.originalSubjectId === target?.subjectId && o.start === target?.slot.start).map((o) => o.date))
  const canSave = !!target && !!source && validDay(activeDate) && !!selected && selected !== target.subjectId

  if (!target) return null
  return (
    <Sheet open={!!target} onClose={onClose} title={mode === "cancel" ? "Cancel this lecture" : "Replace this lecture"} wide>
      <div className="space-y-5">
        <div className="rounded-2xl bg-secondary p-4 flex items-start gap-3">
          <span className="w-10 h-10 rounded-xl bg-card grid place-items-center flex-shrink-0"><CalendarDots className="w-5 h-5" /></span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] text-mute font-semibold uppercase tracking-wider">Original timetable slot</p>
            <p className="text-[18px] font-bold leading-tight mt-1">{source?.name ?? target.subjectName ?? "Subject"}</p>
            <p className="text-[14px] text-mute mt-1">{formatTime(target.slot.start)} – {formatTime(target.slot.end)}{target.slot.kind ? ` · ${target.slot.kind}` : ""}</p>
            <p className="text-[12px] text-mute mt-1">This changes one occurrence only. Your weekly timetable and previous attendance marks stay untouched.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 rounded-2xl bg-secondary p-1">
          <button type="button" onClick={() => { setMode("replace"); setConfirmCancel(false) }} aria-pressed={mode === "replace"} className={`min-h-11 rounded-xl text-[14px] font-semibold flex items-center justify-center gap-2 ${mode === "replace" ? "bg-card shadow-sm" : "text-mute"}`}><ArrowsLeftRight className="w-4 h-4" />Replace</button>
          <button type="button" onClick={() => { setMode("cancel"); setConfirmCancel(false) }} aria-pressed={mode === "cancel"} className={`min-h-11 rounded-xl text-[14px] font-semibold flex items-center justify-center gap-2 ${mode === "cancel" ? "bg-card shadow-sm text-bad" : "text-mute"}`}><XCircle className="w-4 h-4" />Cancel class</button>
        </div>

        <section className="space-y-3">
          <h3 className="text-[15px] font-bold">When should this apply?</h3>
          <div className="grid grid-cols-2 gap-2 rounded-2xl bg-secondary p-1">
            <button type="button" disabled={!todayValid} onClick={() => { setScope("today"); setDate(today); setConfirmCancel(false) }} aria-pressed={scope === "today"} className={`min-h-11 rounded-xl text-[14px] font-semibold ${scope === "today" ? "bg-card shadow-sm" : "text-mute"} disabled:opacity-35`}>
              Today
            </button>
            <button type="button" onClick={() => { setScope("custom"); setDate((d) => validDay(d) ? d : nextOccurrence(today, target.slot.day)); setMonth((m) => new Date(parseLocalDate(validDay(date) ? date : nextOccurrence(today, target.slot.day)).getFullYear(), parseLocalDate(validDay(date) ? date : nextOccurrence(today, target.slot.day)).getMonth(), 1)); setConfirmCancel(false) }} aria-pressed={scope === "custom"} className={`min-h-11 rounded-xl text-[14px] font-semibold ${scope === "custom" ? "bg-card shadow-sm" : "text-mute"}`}>
              Choose a date
            </button>
          </div>
          {scope === "today" ? (
            <div className="flex items-center gap-3 rounded-2xl border border-ink/[0.07] bg-card p-3.5">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-secondary"><CalendarBlank className="h-5 w-5" /></span>
              <div className="min-w-0 flex-1"><p className="text-[14px] font-bold">Today · {parseLocalDate(today).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short" })}</p><p className="text-[12px] text-mute">{formatTime(target.slot.start)} – {formatTime(target.slot.end)}</p></div>
              <span className="rounded-full bg-good/10 px-2.5 py-1 text-[11px] font-bold text-good">Today only</span>
            </div>
          ) : (
            <div className={`${cardClass} p-4`}>
              <div className="mb-3 flex items-center justify-between gap-2 px-0.5">
                <h2 className="text-[19px] font-bold tracking-tight">{month.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</h2>
                <div className="flex gap-1.5">
                  <button type="button" aria-label="Previous month" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() - 1, 1))} className="grid h-8 w-8 place-items-center rounded-full bg-secondary"><CaretLeft className="h-4 w-4" /></button>
                  <button type="button" aria-label="Next month" onClick={() => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + 1, 1))} className="grid h-8 w-8 place-items-center rounded-full bg-secondary"><CaretRight className="h-4 w-4" /></button>
                </div>
              </div>
              <div className="grid grid-cols-7 gap-y-0.5">
                {WEEKDAYS.map((weekday, i) => <span key={`${weekday}-${i}`} className="pb-1.5 text-center text-[11px] font-semibold text-mute">{weekday}</span>)}
                {cells.map((cell, i) => {
                  if (!cell) return <span key={`blank-${i}`} className="h-[46px]" />
                  const disabled = !validDay(cell)
                  const selected = date === cell
                  const isToday = today === cell
                  return <button key={cell} type="button" disabled={disabled} onClick={() => { setDate(cell); setConfirmCancel(false) }} aria-pressed={selected} aria-label={parseLocalDate(cell).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })} className="grid h-[46px] place-items-center disabled:cursor-not-allowed">
                    <span className="flex flex-col items-center gap-[3px]">
                      <span className={`grid h-8 w-8 place-items-center rounded-full text-[15px] num transition ${selected ? "bg-ink text-paper font-semibold" : isToday ? "ring-2 ring-ink font-semibold" : disabled ? "text-mute/30" : "hover:bg-ink/10"}`}>{Number(cell.slice(-2))}</span>
                      <span className={`h-[5px] w-[5px] rounded-full ${marked.has(cell) ? "bg-amber-500" : "bg-transparent"}`} aria-hidden />
                    </span>
                  </button>
                })}
              </div>
              <p className="mt-2 border-t border-ink/[0.06] pt-2 text-[12px] text-mute">Selected: <b className="text-ink">{parseLocalDate(date).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}</b>. Other weekdays are disabled because this is a recurring weekly slot.</p>
            </div>
          )}
        </section>

        {existing && <div className="rounded-2xl bg-warn/10 p-3 text-[13px] text-warn">This class already has a {existing.kind} change for this date. You can restore the original lecture below.</div>}
        {mode === "replace" && (
          <section className="space-y-3">
            <div><h3 className="text-[15px] font-bold">Choose the replacement subject</h3><p className="mt-1 text-[12px] text-mute">It will use the original {formatTime(target.slot.start)} – {formatTime(target.slot.end)} time on {activeDate === today ? "today" : parseLocalDate(activeDate).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short" })}.</p></div>
            <label className="block"><span className="sr-only">Search subjects</span><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search subjects…" className="h-11 w-full rounded-xl bg-secondary px-3.5 text-[15px] outline-none focus:ring-2 focus:ring-ink/20" /></label>
            {tags.length > 0 && <div className="flex gap-2 overflow-x-auto no-scrollbar pb-1"><button type="button" onClick={() => setTag(null)} className={`flex-shrink-0 rounded-full px-3 h-8 text-[12px] font-semibold ${!tag ? "bg-ink text-paper" : "bg-secondary text-mute"}`}>All tags</button>{tags.map((t) => <button type="button" key={t} onClick={() => setTag(tag === t ? null : t)} className={`flex-shrink-0 rounded-full px-3 h-8 text-[12px] font-semibold flex items-center gap-1 ${tag === t ? "bg-ink text-paper" : "bg-secondary text-mute"}`}><Tag className="w-3 h-3" />{t}</button>)}</div>}
            <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto pr-0.5 sm:grid-cols-2">{options.map((s) => <button type="button" key={s.id} onClick={() => setSelected(s.id)} aria-pressed={selected === s.id} className={`rounded-2xl border p-3 text-left transition ${selected === s.id ? "border-ink bg-ink/[0.05] ring-1 ring-ink/20" : "border-ink/10 bg-card hover:bg-secondary"}`}><span className="flex items-start gap-2"><span className="mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full" style={{ background: s.glowColor }} /><span className="min-w-0 flex-1"><span className="block truncate text-[14px] font-bold">{s.name}</span><span className="block truncate text-[11px] text-mute">{(s.tags || []).join(" · ") || "No tags"}</span></span>{selected === s.id && <CheckCircle className="h-5 w-5 text-good" />}</span></button>)}{options.length === 0 && <p className="col-span-full py-6 text-center text-[13px] text-mute">No active subject matches. Add one or clear the filters.</p>}</div>
            <button type="button" disabled={!canSave} onClick={() => { onReplaceClass(target.subjectId, activeDate, target.slot.start, selected); onClose() }} className={`${primaryButton} disabled:opacity-40`}>Save substitution</button>
          </section>
        )}
        {mode === "cancel" && <section className="space-y-3 rounded-2xl border border-bad/15 bg-bad/[0.04] p-4"><h3 className="text-[16px] font-bold">Cancel this occurrence?</h3><p className="text-[14px] leading-relaxed text-mute">{source?.name} will be hidden from Today on {activeDate === today ? "today" : parseLocalDate(activeDate).toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" })}. Your subject, attendance history, and weekly timetable will not be deleted.</p>{!confirmCancel ? <button type="button" onClick={() => setConfirmCancel(true)} className="h-12 w-full rounded-2xl bg-bad font-bold text-white">Continue to cancel</button> : <div className="grid grid-cols-2 gap-2"><button type="button" onClick={() => setConfirmCancel(false)} className={tintButton}>Go back</button><button type="button" onClick={() => { onCancelClass(target.subjectId, activeDate, target.slot.start); onClose() }} className="h-12 rounded-xl bg-bad font-bold text-white">Confirm cancellation</button></div>}</section>}
        {existing && <button type="button" onClick={() => { onRestore(target.subjectId, activeDate, target.slot.start); onClose() }} className="h-11 w-full rounded-xl bg-secondary text-[14px] font-semibold">Restore original lecture</button>}
      </div>
    </Sheet>
  )
}
