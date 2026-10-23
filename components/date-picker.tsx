"use client"

import { useEffect, useMemo, useState } from "react"
import { CalendarBlank, CaretLeft, CaretRight, X } from "@phosphor-icons/react"
import { localDate, parseLocalDate } from "@/lib/attendance"

interface DatePickerProps {
  /** YYYY-MM-DD; an empty value means no date selected yet. */
  value: string
  onChange: (date: string) => void
  label?: string
  minDate?: string
  maxDate?: string
  allowClear?: boolean
  /** Dates rendered with the small app-style marker below the day number. */
  markedDates?: string[]
  /** Optional domain rule, e.g. only dates matching a recurring lecture weekday. */
  isDateDisabled?: (date: string) => boolean
  /** A range being chosen (e.g. a holiday break): the days from `rangeFrom` to `rangeTo` are shaded, so both ends show in either calendar. */
  rangeFrom?: string
  rangeTo?: string
}

const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]
const dateString = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

/** The shared Attendance Tracker calendar. Never relies on the browser's native date-picker UI. */
export default function DatePicker({ value, onChange, label = "Date", minDate, maxDate, allowClear = false, markedDates = [], isDateDisabled, rangeFrom, rangeTo }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const picked = value ? parseLocalDate(value) : new Date()
  const [view, setView] = useState(() => new Date(picked.getFullYear(), picked.getMonth(), 1))
  const today = localDate()
  const markers = useMemo(() => new Set(markedDates), [markedDates])

  useEffect(() => {
    if (!value) return
    const date = parseLocalDate(value)
    setView(new Date(date.getFullYear(), date.getMonth(), 1))
  }, [value])

  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()
  const lead = (view.getDay() + 6) % 7
  const cells: (null | { date: string; day: number })[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => ({ date: dateString(new Date(view.getFullYear(), view.getMonth(), i + 1)), day: i + 1 })),
  ]
  const step = (n: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + n, 1))
  const disabled = (date: string) => Boolean((minDate && date < minDate) || (maxDate && date > maxDate) || isDateDisabled?.(date))

  return (
    <div className="w-full min-w-0">
      <div className={`flex w-full items-center gap-2 rounded-2xl bg-secondary px-3.5 ${open ? "ring-1 ring-ink/35" : ""}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${label}: ${value ? picked.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "not set"}. Change date`}
          className="flex h-12 min-w-0 flex-1 items-center justify-between gap-2 text-left outline-none"
        >
          <span className={`truncate text-[15px] font-semibold ${value ? "text-ink" : "text-mute"}`}>{value ? picked.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : `Pick ${label.toLowerCase()}`}</span>
          <CalendarBlank weight="regular" className="h-5 w-5 flex-shrink-0 text-mute" />
        </button>
        {allowClear && value && (
          <button type="button" aria-label={`Clear ${label}`} onClick={() => { onChange(""); setOpen(false) }} className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full bg-card text-mute">
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-2xl bg-card p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-2 px-0.5">
            <h2 className="text-[19px] font-bold tracking-tight">{view.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</h2>
            <div className="flex gap-1.5">
              <button type="button" onClick={() => step(-1)} aria-label="Previous month" className="grid h-8 w-8 place-items-center rounded-full bg-secondary transition hover:bg-ink/10">
                <CaretLeft weight="bold" className="h-4 w-4" />
              </button>
              <button type="button" onClick={() => step(1)} aria-label="Next month" className="grid h-8 w-8 place-items-center rounded-full bg-secondary transition hover:bg-ink/10">
                <CaretRight weight="bold" className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {WEEKDAYS.map((weekday, i) => <span key={`${weekday}-${i}`} className="pb-1.5 text-center text-[11px] font-semibold text-mute">{weekday}</span>)}
            {cells.map((cell, i) => {
              if (!cell) return <span key={`blank-${i}`} className="h-[46px]" />
              const isSelected = value === cell.date
              const isToday = cell.date === today
              const isDisabled = disabled(cell.date)
              const inRange = Boolean(rangeFrom && rangeTo && cell.date >= rangeFrom && cell.date <= rangeTo)
              const isRangeEnd = Boolean(rangeFrom && (cell.date === rangeFrom || cell.date === rangeTo))
              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={isDisabled}
                  onClick={() => { onChange(cell.date); setOpen(false) }}
                  aria-pressed={isSelected}
                  aria-label={parseLocalDate(cell.date).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })}
                  className="grid h-[46px] place-items-center disabled:cursor-not-allowed"
                >
                  <span className="flex flex-col items-center gap-[3px]">
                    <span className={`grid h-8 w-8 place-items-center rounded-full text-[15px] num transition ${isSelected ? "bg-ink font-semibold text-paper" : isRangeEnd ? "bg-ink/25 font-semibold" : inRange ? "bg-ink/10" : isToday ? "font-semibold ring-2 ring-ink" : isDisabled ? "text-mute/30" : "hover:bg-ink/10"}`}>
                      {cell.day}
                    </span>
                    <span className={`h-[5px] w-[5px] rounded-full ${markers.has(cell.date) ? "bg-amber-500" : "bg-transparent"}`} aria-hidden />
                  </span>
                </button>
              )
            })}
          </div>
          {allowClear && <div className="mt-2 flex justify-between border-t border-ink/[0.06] pt-2 text-[12px]"><button type="button" onClick={() => { onChange(""); setOpen(false) }} className="font-semibold text-info">Clear date</button><button type="button" disabled={disabled(today)} onClick={() => { onChange(today); setOpen(false) }} className="font-semibold text-info disabled:cursor-not-allowed disabled:opacity-40">Today</button></div>}
        </div>
      )}
    </div>
  )
}
