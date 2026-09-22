"use client"

import { useEffect, useState } from "react"
import { CalendarBlank, CaretLeft, CaretRight } from "@phosphor-icons/react"
import { localDate, parseLocalDate } from "@/lib/attendance"

interface DatePickerProps {
  /** YYYY-MM-DD */
  value: string
  onChange: (date: string) => void
  label?: string
}

/** Monday first, like the rest of the app */
const WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"]

/**
 * The app's own date picker: a field that opens a month grid in place. It replaces the browser's built-in
 * calendar popup, which looks different on every device and doesn't match the rest of the screens.
 */
export default function DatePicker({ value, onChange, label = "Due date" }: DatePickerProps) {
  const [open, setOpen] = useState(false)
  const picked = value ? parseLocalDate(value) : new Date()
  const [view, setView] = useState(() => new Date(picked.getFullYear(), picked.getMonth(), 1))

  // Follow the value when it changes from outside (the quick chips), so the grid is never on the wrong month
  useEffect(() => {
    if (value) setView(new Date(parseLocalDate(value).getFullYear(), parseLocalDate(value).getMonth(), 1))
  }, [value])

  const today = localDate()
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate()
  const lead = (view.getDay() + 6) % 7
  const cells: (null | { date: string; day: number })[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => ({ date: localDate(new Date(view.getFullYear(), view.getMonth(), i + 1)), day: i + 1 })),
  ]

  const step = (n: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + n, 1))

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={`${label}: ${value ? picked.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "not set"}. Change date`}
        className={`w-full h-12 rounded-xl bg-secondary px-4 flex items-center justify-between text-[17px] text-left outline-none transition ${open ? "ring-1 ring-ink/40" : ""}`}
      >
        <span className="num">{value ? picked.toLocaleDateString("en-US", { weekday: "short", day: "numeric", month: "long", year: "numeric" }) : "Pick a date"}</span>
        <CalendarBlank weight="regular" className="w-5 h-5 text-mute" />
      </button>

      {open && (
        <div className="mt-2 rounded-2xl bg-secondary p-3">
          <div className="flex items-center justify-between px-1 pb-2">
            <span className="text-[16px] font-bold tracking-tight">{view.toLocaleDateString("en-US", { month: "long", year: "numeric" })}</span>
            <span className="flex gap-1.5">
              <button type="button" onClick={() => step(-1)} aria-label="Previous month" className="w-8 h-8 grid place-items-center rounded-full bg-card">
                <CaretLeft weight="bold" className="w-4 h-4" />
              </button>
              <button type="button" onClick={() => step(1)} aria-label="Next month" className="w-8 h-8 grid place-items-center rounded-full bg-card">
                <CaretRight weight="bold" className="w-4 h-4" />
              </button>
            </span>
          </div>

          <div className="grid grid-cols-7">
            {WEEKDAYS.map((w, i) => (
              <span key={i} className="text-center text-[11px] font-semibold text-mute pb-1">
                {w}
              </span>
            ))}
            {cells.map((c, i) =>
              c === null ? (
                <span key={`b${i}`} />
              ) : (
                <button
                  key={c.date}
                  type="button"
                  onClick={() => {
                    onChange(c.date)
                    setOpen(false)
                  }}
                  aria-pressed={c.date === value}
                  aria-label={parseLocalDate(c.date).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })}
                  className="h-10 grid place-items-center"
                >
                  <span
                    className={`w-9 h-9 rounded-full grid place-items-center text-[15px] num transition ${
                      c.date === value ? "bg-ink text-paper font-semibold" : c.date === today ? "ring-2 ring-ink font-semibold" : "hover:bg-ink/10"
                    }`}
                  >
                    {c.day}
                  </span>
                </button>
              ),
            )}
          </div>
        </div>
      )}
    </div>
  )
}
