"use client"

import { useEffect, useRef, useState } from "react"
import { BellRinging, CalendarPlus, Check, Plus } from "@phosphor-icons/react"
import { Field, Segmented, Stepper, fieldLabel, inputClass, primaryButton, tintButton } from "./sheet"
import { DAY_LETTERS, DAY_SHORT, formatTime, toMin } from "@/lib/attendance"
import {
  DAY_NAMES,
  DAY_ORDER,
  describeReminder,
  notifyClock,
  type ScheduleEntry,
} from "@/lib/reminders"
import type { Subject } from "@/lib/types"

/* ---------- the list: pick a day, see its reminders ---------- */

interface ListProps {
  subjects: Subject[]
  schedule: ScheduleEntry[]
  day: number
  onDay: (d: number) => void
  onAdd: () => void
  onEdit: (e: ScheduleEntry) => void
  /** Creates a reminder for every timetable slot; only offered when there are none yet */
  onFromTimetable: () => void
}

export function RemindersList({ subjects, schedule, day, onDay, onAdd, onEdit, onFromTimetable }: ListProps) {
  const touchX = useRef<number | null>(null)
  const entries = schedule.filter((s) => s.day === day).sort((a, b) => toMin(a.startTime) - toMin(b.startTime))
  const hasTimetable = subjects.some((s) => s.slots?.length)

  // Swiping sideways moves through the week
  const step = (dir: 1 | -1) => {
    const at = DAY_ORDER.indexOf(day)
    onDay(DAY_ORDER[Math.min(6, Math.max(0, at + dir))])
  }

  return (
    <div
      onTouchStart={(e) => (touchX.current = e.touches[0].clientX)}
      onTouchEnd={(e) => {
        if (touchX.current === null) return
        const dx = e.changedTouches[0].clientX - touchX.current
        touchX.current = null
        if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1)
      }}
    >
      <div role="tablist" aria-label="Day of the week" className="flex justify-between">
        {DAY_ORDER.map((d) => {
          const on = d === day
          const count = schedule.filter((s) => s.day === d).length
          return (
            <button
              key={d}
              role="tab"
              aria-selected={on}
              aria-label={`${DAY_NAMES[d]}, ${count} ${count === 1 ? "reminder" : "reminders"}`}
              onClick={() => onDay(d)}
              className={`relative w-[42px] h-[52px] rounded-2xl flex flex-col items-center justify-center gap-1 transition ${
                on ? "bg-ink text-paper" : "bg-secondary text-mute"
              }`}
            >
              <span className="text-[15px] font-semibold leading-none">{DAY_LETTERS[d]}</span>
              <span className={`w-1.5 h-1.5 rounded-full ${count ? (on ? "bg-paper" : "bg-ink/60") : "bg-transparent"}`} />
            </button>
          )
        })}
      </div>

      <div className="flex items-end justify-between mt-6 mb-3">
        <h3 className="text-[26px] font-bold tracking-tight leading-none">{DAY_NAMES[day]}</h3>
        <span className="text-[13px] text-mute">
          {entries.length} {entries.length === 1 ? "reminder" : "reminders"}
        </span>
      </div>

      {entries.length === 0 ? (
        <div className="rounded-2xl bg-secondary px-5 py-8 text-center">
          <span className="mx-auto w-12 h-12 rounded-full bg-card grid place-items-center text-mute">
            <BellRinging weight="duotone" className="w-6 h-6" />
          </span>
          <p className="text-[16px] font-semibold mt-3">Nothing on {DAY_NAMES[day]}</p>
          <p className="text-[14px] text-mute mt-1 leading-snug">Add a reminder and you&rsquo;ll get a nudge around your class.</p>
        </div>
      ) : (
        <ul className="space-y-2.5">
          {entries.map((e) => {
            const subject = subjects.find((s) => s.name === e.subjectName)
            return (
              <li key={e.id}>
                <button onClick={() => onEdit(e)} className="w-full text-left rounded-2xl bg-secondary p-4 flex items-center gap-3.5 active:scale-[0.99] transition">
                  <span className="w-1.5 self-stretch rounded-full flex-shrink-0" style={{ background: subject?.glowColor ?? "#8e8e93" }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[17px] font-semibold leading-snug truncate">{e.subjectName}</span>
                    <span className="block num text-[13px] text-mute mt-0.5">
                      {formatTime(e.startTime)} – {formatTime(e.endTime)}
                    </span>
                    <span className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-[12px] font-semibold text-ink">
                      <BellRinging weight="fill" className="w-3.5 h-3.5" />
                      {describeReminder(e)} · <span className="num">{notifyClock(e)}</span>
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      )}

      <button onClick={onAdd} className={`${primaryButton} mt-5 flex items-center justify-center gap-2`}>
        <Plus weight="bold" className="w-5 h-5" /> Add a reminder
      </button>

      {schedule.length === 0 && hasTimetable && (
        <button onClick={onFromTimetable} className={`${tintButton} w-full mt-2.5 h-12 text-[16px]`}>
          <CalendarPlus weight="bold" className="w-5 h-5" /> Set up from my timetable
        </button>
      )}
    </div>
  )
}

/* ---------- the editor: add or change a reminder ---------- */

interface EditorProps {
  subjects: Subject[]
  editing: ScheduleEntry | null
  defaultDay: number
  onSave: (entries: ScheduleEntry[]) => void
  onDelete: (id: string) => void
}

export function ReminderEditor({ subjects, editing, defaultDay, onSave, onDelete }: EditorProps) {
  const [subjectName, setSubjectName] = useState(editing?.subjectName ?? "")
  const [days, setDays] = useState<number[]>(editing ? [editing.day] : [defaultDay])
  const [start, setStart] = useState(editing?.startTime ?? "09:00")
  const [end, setEnd] = useState(editing?.endTime ?? "10:00")
  const [offset, setOffset] = useState(editing?.notifyOffset ?? 10)
  const [when, setWhen] = useState<"before" | "after">(editing?.notifyWhen ?? "before")
  const [error, setError] = useState("")
  const [confirmDelete, setConfirmDelete] = useState(false)

  // Picking a subject fills in its timetable time for the chosen day, so most reminders are two taps
  const fillFrom = (name: string, day: number) => {
    const slot = subjects.find((s) => s.name === name)?.slots?.find((x) => x.day === day)
    if (slot) {
      setStart(slot.start)
      setEnd(slot.end)
    }
  }

  const pickSubject = (name: string) => {
    setSubjectName(name)
    setError("")
    fillFrom(name, days[0])
  }

  const toggleDay = (d: number) => {
    setError("")
    if (editing) {
      setDays([d])
      return
    }
    setDays((prev) => {
      const next = prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]
      if (next.length === 1 && subjectName) fillFrom(subjectName, next[0])
      return next
    })
  }

  useEffect(() => {
    setConfirmDelete(false)
  }, [editing])

  const preview = notifyClock({ startTime: start, endTime: end, notifyOffset: offset, notifyWhen: when })

  const save = () => {
    if (!subjectName) return setError("Choose a subject.")
    if (days.length === 0) return setError("Choose at least one day.")
    if (end <= start) return setError("The end time must be after the start time.")
    const stamp = Date.now()
    onSave(
      [...days]
        .sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b))
        .map((day, i) => ({
          id: editing ? editing.id : `${stamp}-${i}`,
          day,
          startTime: start,
          endTime: end,
          subjectName,
          notifyOffset: offset,
          notifyWhen: when,
        })),
    )
  }

  return (
    <div>
      <Field label="Subject">
        {subjects.length === 0 ? (
          <p className="text-[15px] text-mute leading-snug">Add a subject first, then you can set reminders for it.</p>
        ) : (
          <ul className="space-y-2 max-h-56 overflow-y-auto -mx-1 px-1">
            {subjects.map((s) => {
              const on = s.name === subjectName
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => pickSubject(s.name)}
                    className={`w-full flex items-center gap-3 rounded-2xl px-3.5 py-3 text-left transition ${on ? "bg-ink/[0.07] ring-1 ring-ink/25" : "bg-secondary"}`}
                  >
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: s.glowColor }} />
                    <span className="min-w-0 flex-1 text-[16px] font-semibold truncate">{s.name}</span>
                    <span className={`w-6 h-6 rounded-full grid place-items-center flex-shrink-0 ${on ? "bg-ink text-paper" : "border-2 border-ink/25"}`}>
                      {on && <Check weight="bold" className="w-3.5 h-3.5" />}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Field>

      <Field label={editing ? "Day" : "Days"}>
        <div className="flex justify-between">
          {DAY_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={days.includes(d)}
              aria-label={DAY_NAMES[d]}
              onClick={() => toggleDay(d)}
              className={`w-11 h-11 rounded-full text-[13px] font-semibold transition ${days.includes(d) ? "bg-ink text-paper" : "bg-secondary text-mute"}`}
            >
              {DAY_SHORT[d]}
            </button>
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3 mb-5">
        <label>
          <span className={fieldLabel}>Class starts</span>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} className={`${inputClass} num`} />
        </label>
        <label>
          <span className={fieldLabel}>Class ends</span>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} className={`${inputClass} num`} />
        </label>
      </div>

      <div className="mb-5">
        <span className={fieldLabel}>Remind me</span>
        <Segmented
          label="Before or after"
          value={when}
          onChange={setWhen}
          options={[
            { id: "before", label: "Before it starts" },
            { id: "after", label: "After it ends" },
          ]}
        />
        <div className="mt-3">
          <Stepper label="Minutes" value={offset} onChange={setOffset} min={0} max={240} step={5} suffix="min" />
        </div>
        <p className="mt-3 rounded-xl bg-secondary px-3.5 py-2.5 text-[14px] text-mute leading-snug">
          You&rsquo;ll be reminded at <span className="num font-semibold text-ink">{preview}</span>.
        </p>
      </div>

      {error && <p className="text-[14px] text-bad mb-3">{error}</p>}
      <button type="button" onClick={save} className={primaryButton}>
        {editing ? "Save changes" : days.length > 1 ? `Add ${days.length} reminders` : "Add reminder"}
      </button>

      {editing &&
        (confirmDelete ? (
          <div className="grid grid-cols-2 gap-2 mt-2.5">
            <button type="button" onClick={() => setConfirmDelete(false)} className={`${tintButton} h-12`}>
              Keep it
            </button>
            <button type="button" onClick={() => onDelete(editing.id)} className="h-12 rounded-xl bg-bad text-paper text-[15px] font-semibold">
              Delete
            </button>
          </div>
        ) : (
          <button type="button" onClick={() => setConfirmDelete(true)} className="w-full mt-1 h-12 text-[16px] font-semibold text-bad">
            Delete reminder
          </button>
        ))}
    </div>
  )
}
