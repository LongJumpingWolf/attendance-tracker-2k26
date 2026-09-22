"use client"

import { useEffect, useState } from "react"
import Sheet, { Field, inputClass, primaryButton, fieldLabel } from "./sheet"
import DatePicker from "./date-picker"
import { daysUntil, localDate, parseLocalDate } from "@/lib/attendance"
import type { Subject, Task } from "@/lib/types"

export interface DeadlineValues {
  title: string
  dueDate: string
  remindDaysBefore: number
  subjectId?: string
}

interface DeadlineSheetProps {
  open: boolean
  onClose: () => void
  /** The deadline being edited; empty when adding a new one */
  task: Task | null
  /** The date a new deadline starts with (the day picked on the calendar) */
  defaultDate: string
  subjects: Subject[]
  onSubmit: (values: DeadlineValues) => void
  onDelete?: () => void
}

const REMIND: { value: number; label: string }[] = [
  { value: -1, label: "Off" },
  { value: 0, label: "On the day" },
  { value: 1, label: "1 day before" },
  { value: 2, label: "2 days" },
  { value: 3, label: "3 days" },
  { value: 7, label: "1 week" },
]

const shift = (n: number) => {
  const d = new Date()
  return localDate(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n))
}

const chip = (on: boolean) =>
  `h-9 px-3.5 rounded-full text-[14px] font-semibold whitespace-nowrap transition ${on ? "bg-ink text-paper" : "bg-secondary text-mute"}`

/** "Thursday, 24 September · in 3 days" */
function describe(date: string) {
  if (!date) return ""
  const n = daysUntil(date)
  const label = parseLocalDate(date).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })
  return `${label} · ${n === 0 ? "today" : n === 1 ? "tomorrow" : n === -1 ? "yesterday" : n > 1 ? `in ${n} days` : `${-n} days ago`}`
}

export default function DeadlineSheet({ open, onClose, task, defaultDate, subjects, onSubmit, onDelete }: DeadlineSheetProps) {
  const [title, setTitle] = useState("")
  const [dueDate, setDueDate] = useState(defaultDate)
  const [remind, setRemind] = useState(1)
  const [subjectId, setSubjectId] = useState<string | undefined>(undefined)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setTitle(task?.title ?? "")
    setDueDate(task?.dueDate ?? defaultDate)
    setRemind(task?.remindDaysBefore ?? 1)
    setSubjectId(task?.subjectId)
    setError("")
  }, [open, task, defaultDate])

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim()) return setError("Give it a title")
    if (!dueDate) return setError("Pick a date")
    onSubmit({ title: title.trim(), dueDate, remindDaysBefore: remind, ...(subjectId ? { subjectId } : {}) })
  }

  return (
    <Sheet open={open} onClose={onClose} title={task ? "Edit deadline" : "New deadline"}>
      <form onSubmit={submit}>
        <Field label="What is it?" error={error}>
          <input
            autoFocus={!task}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value)
              setError("")
            }}
            placeholder="e.g. Physics midterm, Lab report"
            className={inputClass}
          />
        </Field>

        <div className="mb-5">
          <span className={fieldLabel}>Due</span>
          <div className="flex gap-2 mb-2.5 overflow-x-auto no-scrollbar">
            {[
              { label: "Today", v: shift(0) },
              { label: "Tomorrow", v: shift(1) },
              { label: "In a week", v: shift(7) },
            ].map((q) => (
              <button key={q.label} type="button" onClick={() => setDueDate(q.v)} aria-pressed={dueDate === q.v} className={chip(dueDate === q.v)}>
                {q.label}
              </button>
            ))}
          </div>
          <DatePicker value={dueDate} onChange={setDueDate} />
          <p className="text-[13px] text-mute mt-2 px-1">{describe(dueDate)}</p>
        </div>

        {subjects.length > 0 && (
          <div className="mb-5">
            <span className={fieldLabel}>Subject (optional)</span>
            <div className="flex gap-2 overflow-x-auto -mx-5 px-5 no-scrollbar">
              <button type="button" onClick={() => setSubjectId(undefined)} aria-pressed={!subjectId} className={chip(!subjectId)}>
                None
              </button>
              {subjects.map((s) => (
                <button key={s.id} type="button" onClick={() => setSubjectId(s.id)} aria-pressed={subjectId === s.id} className={`${chip(subjectId === s.id)} flex items-center gap-2`}>
                  <span className="w-2 h-2 rounded-full" style={{ background: s.glowColor }} />
                  {s.name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="mb-6">
          <span className={fieldLabel}>Remind me</span>
          <div className="flex flex-wrap gap-2">
            {REMIND.map((r) => (
              <button key={r.value} type="button" onClick={() => setRemind(r.value)} aria-pressed={remind === r.value} className={chip(remind === r.value)}>
                {r.label}
              </button>
            ))}
          </div>
          <p className="text-[13px] text-mute mt-2 px-1 leading-snug">The Today screen shows a notice once the deadline is that close.</p>
        </div>

        <button type="submit" className={primaryButton}>
          {task ? "Save changes" : "Add deadline"}
        </button>

        {task && onDelete && (
          <button type="button" onClick={onDelete} className="w-full mt-1 h-12 text-[16px] font-semibold text-bad">
            Delete deadline
          </button>
        )}
      </form>
    </Sheet>
  )
}
