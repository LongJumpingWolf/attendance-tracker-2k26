"use client"

import { useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { CaretDown, Plus, Trash } from "@phosphor-icons/react"
import Sheet, { Field, Stepper, inputClass, primaryButton, fieldLabel } from "./sheet"
import { DAY_SHORT, toMin } from "@/lib/attendance"
import { DAY_ORDER, DAY_NAMES } from "@/lib/reminders"
import type { Slot } from "@/lib/types"

export interface SubjectValues {
  name: string
  attended: number
  missed: number
  requirement: number
  glowColor: string
  tags: string[]
  /** Inclusive local dates for when this timetable is active; blank means unbounded. */
  scheduleFrom: string
  scheduleUntil: string
  slots: Slot[]
}

interface SubjectSheetProps {
  open: boolean
  onClose: () => void
  /** Present when editing an existing subject */
  subject?: (Omit<SubjectValues, "slots" | "scheduleFrom" | "scheduleUntil"> & { slots?: Slot[]; scheduleFrom?: string; scheduleUntil?: string }) | null
  /** Which subject is being edited (null when adding): changing it, not the subject object, restarts the form */
  subjectKey?: string | null
  existingTags: string[]
  onSubmit: (values: SubjectValues) => void
}

const COLORS = ["#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#ff9f0a", "#64d2ff"]

const EMPTY = { name: "", attended: 0, missed: 0, requirement: 75, glowColor: COLORS[1], tags: [] as string[], scheduleFrom: "", scheduleUntil: "" }

export default function SubjectSheet({ open, onClose, subject, subjectKey = null, existingTags, onSubmit }: SubjectSheetProps) {
  const [values, setValues] = useState(EMPTY)
  const baseline = useRef("")
  // Every class is its own row, so a subject can meet at different times on different days
  const [slots, setSlots] = useState<Slot[]>([])
  const [newTag, setNewTag] = useState("")
  const [error, setError] = useState("")
  const [scheduleError, setScheduleError] = useState("")
  const [durationOpen, setDurationOpen] = useState(false)
  const [showUnsavedPrompt, setShowUnsavedPrompt] = useState(false)

  // The form starts from the subject when it opens. A sync or a mark made elsewhere replaces the subject object while
  // it is open; that must not wipe what is being typed, so only a different subject (or reopening) resets it.
  const latestSubject = useRef(subject)
  useEffect(() => { latestSubject.current = subject })
  useEffect(() => {
    if (!open) return
    const subject = latestSubject.current
    const { slots: subjectSlots, ...rest } = subject ?? { ...EMPTY, slots: [] as Slot[] }
    const nextValues = { ...rest, tags: rest.tags || [], scheduleFrom: rest.scheduleFrom ?? "", scheduleUntil: rest.scheduleUntil ?? "" }
    const nextSlots = (subjectSlots || []).map((x) => ({ ...x }))
    baseline.current = JSON.stringify({ values: nextValues, slots: nextSlots, newTag: "" })
    setValues(nextValues)
    setSlots(nextSlots)
    setNewTag("")
    setError("")
    setScheduleError("")
    setDurationOpen(Boolean(nextValues.scheduleFrom || nextValues.scheduleUntil))
    setShowUnsavedPrompt(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, subjectKey])

  const set = <K extends keyof typeof EMPTY>(key: K, v: (typeof EMPTY)[K]) => setValues((p) => ({ ...p, [key]: v }))

  const allTags = Array.from(new Set([...existingTags, ...values.tags]))
  const toggleTag = (t: string) =>
    set("tags", values.tags.includes(t) ? values.tags.filter((x) => x !== t) : [...values.tags, t])
  const patchSlot = (i: number, patch: Partial<Slot>) => {
    setError("")
    setSlots((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  }
  const removeSlot = (i: number) => setSlots((prev) => prev.filter((_, j) => j !== i))
  const addSlot = () =>
    setSlots((prev) => {
      // Start from the previous class's times, on the next weekday that has none yet
      const last = prev[prev.length - 1]
      const used = new Set(prev.map((x) => x.day))
      const day = DAY_ORDER.find((d) => !used.has(d)) ?? 1
      return [...prev, { day, start: last?.start ?? "09:00", end: last?.end ?? "10:00", kind: last?.kind ?? "Lecture" }]
    })

  const addTag = () => {
    const t = newTag.trim()
    if (t && !values.tags.includes(t)) set("tags", [...values.tags, t])
    setNewTag("")
  }

  const saveChanges = (): boolean => {
    setError("")
    setScheduleError("")
    if (values.scheduleFrom && values.scheduleUntil && values.scheduleFrom > values.scheduleUntil) {
      setScheduleError("End date must be on or after start date")
      setDurationOpen(true)
      return false
    }
    if (!values.name.trim()) {
      setError("Give the subject a name")
      return false
    }
    const bad = slots.findIndex((x) => x.end <= x.start)
    if (bad !== -1) {
      setError(`${DAY_NAMES[slots[bad].day]}: the class must end after it starts`)
      return false
    }
    const seen = new Set<string>()
    for (const x of slots) {
      const k = `${x.day}|${x.start}`
      if (seen.has(k)) {
        setError(`${DAY_NAMES[x.day]} has two classes starting at the same time`)
        return false
      }
      seen.add(k)
    }
    const sorted = [...slots].sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || toMin(a.start) - toMin(b.start))
    baseline.current = JSON.stringify({ values, slots: sorted, newTag: "" })
    onSubmit({ ...values, name: values.name.trim(), slots: sorted })
    return true
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    saveChanges()
  }

  const canDismiss = () => {
    const changed = JSON.stringify({ values, slots, newTag }) !== baseline.current
    if (changed) {
      setShowUnsavedPrompt(true)
      return false
    }
    return true
  }

  const requestClose = () => {
    if (canDismiss()) onClose()
  }

  return (
    <>
      <Sheet open={open} onClose={requestClose} canDismiss={canDismiss} title={subject ? "Edit subject" : "New subject"}>
        <form onSubmit={submit}>
        <Field label="Name" error={error}>
          <input
            autoFocus={!subject}
            value={values.name}
            onChange={(e) => {
              set("name", e.target.value)
              setError("")
            }}
            placeholder="e.g. Biology"
            className={inputClass}
          />
        </Field>

        <div className="grid grid-cols-3 gap-3 mb-5">
          <Stepper label="Attended" value={values.attended} onChange={(n) => set("attended", n)} />
          <Stepper label="Missed" value={values.missed} onChange={(n) => set("missed", n)} />
          <Stepper label="Required" value={values.requirement} onChange={(n) => set("requirement", n)} min={1} max={100} step={5} suffix="%" />
        </div>

        <Field label="Classes">
          {slots.length === 0 ? (
            <p className="text-[14px] text-mute leading-snug mb-3">No classes yet. Add each time this subject meets to see it on your Today timetable and plan which lectures to skip.</p>
          ) : (
            <ul className="space-y-3 mb-3">
              {slots.map((x, i) => (
                <li key={i} className="rounded-2xl bg-secondary p-3.5">
                  <div className="flex items-center justify-between mb-2.5">
                    <div className="flex gap-1" role="group" aria-label="Day">
                      {DAY_ORDER.map((d) => (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={x.day === d}
                          aria-label={DAY_NAMES[d]}
                          onClick={() => patchSlot(i, { day: d })}
                          className={`w-9 h-9 rounded-full text-[12px] font-semibold transition ${x.day === d ? "bg-ink text-paper" : "bg-card text-mute"}`}
                        >
                          {DAY_SHORT[d].slice(0, 2)}
                        </button>
                      ))}
                    </div>
                    <button type="button" onClick={() => removeSlot(i)} aria-label="Remove this class" className="w-9 h-9 grid place-items-center rounded-full text-mute hover:text-bad">
                      <Trash weight="regular" className="w-5 h-5" />
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <label>
                      <span className={fieldLabel}>Starts</span>
                      <input type="time" value={x.start} onChange={(e) => patchSlot(i, { start: e.target.value })} className={`${inputClass} num h-11 px-2.5 text-[15px] min-w-0`} />
                    </label>
                    <label>
                      <span className={fieldLabel}>Ends</span>
                      <input type="time" value={x.end} onChange={(e) => patchSlot(i, { end: e.target.value })} className={`${inputClass} num h-11 px-2.5 text-[15px]`} />
                    </label>
                    <label className="col-span-2">
                      <span className={fieldLabel}>Type</span>
                      <select value={x.kind ?? ""} onChange={(e) => patchSlot(i, { kind: e.target.value || undefined })} className={`${inputClass} h-11 px-2.5 text-[15px]`}>
                        <option value="">Not set</option>
                        <option value="Lecture">Lecture</option>
                        <option value="Practical">Practical</option>
                        <option value="Tutorial">Tutorial</option>
                      </select>
                    </label>
                  </div>
                </li>
              ))}
            </ul>
          )}
          <button type="button" onClick={addSlot} className="w-full h-11 rounded-xl bg-secondary text-[15px] font-semibold flex items-center justify-center gap-2">
            <Plus weight="bold" className="w-4 h-4" /> Add a class
          </button>
        </Field>

        <section className="rounded-2xl border border-ink/10 bg-card overflow-hidden mb-5">
          <button
            type="button"
            aria-expanded={durationOpen}
            onClick={() => setDurationOpen((open) => !open)}
            className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold">Schedule duration <span className="font-normal text-mute">(optional)</span></span>
              <span className="block text-[12px] text-mute mt-0.5">Only show these classes within a date range</span>
            </span>
            <CaretDown weight="bold" className={`w-4 h-4 text-mute transition-transform ${durationOpen ? "rotate-180" : ""}`} />
          </button>
          {durationOpen && (
            <div className="px-4 pb-4">
              <div className="grid grid-cols-2 gap-3">
                <label className="min-w-0">
                  <span className={fieldLabel}>From (inclusive)</span>
                  <input
                    type="date"
                    value={values.scheduleFrom}
                    max={values.scheduleUntil || undefined}
                    onChange={(e) => { set("scheduleFrom", e.target.value); setScheduleError("") }}
                    className={`${inputClass} h-11 px-2.5 text-[13px] min-w-0`}
                  />
                </label>
                <label className="min-w-0">
                  <span className={fieldLabel}>Until (inclusive)</span>
                  <input
                    type="date"
                    value={values.scheduleUntil}
                    min={values.scheduleFrom || undefined}
                    onChange={(e) => { set("scheduleUntil", e.target.value); setScheduleError("") }}
                    className={`${inputClass} h-11 px-2.5 text-[13px] min-w-0`}
                  />
                </label>
              </div>
              <p className="text-[12px] text-mute leading-snug mt-2.5">Leave either date blank for an open-ended range, or leave both blank for a regular year-round timetable. Dates are inclusive.</p>
              {scheduleError && <p role="alert" className="text-[13px] text-bad font-semibold mt-2">{scheduleError}</p>}
              {(values.scheduleFrom || values.scheduleUntil) && (
                <button
                  type="button"
                  onClick={() => { set("scheduleFrom", ""); set("scheduleUntil", ""); setScheduleError("") }}
                  className="text-[13px] text-info font-semibold mt-3"
                >
                  Clear schedule duration
                </button>
              )}
            </div>
          )}
        </section>

        <Field label="Colour">
          <div className="flex justify-between">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set("glowColor", c)}
                aria-label={`Colour ${c}`}
                aria-pressed={values.glowColor === c}
                className={`w-10 h-10 rounded-full transition ${
                  values.glowColor === c ? "ring-2 ring-ink ring-offset-2 ring-offset-card" : ""
                }`}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>

        <Field label="Tags">
          {allTags.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2.5">
              {allTags.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => toggleTag(t)}
                  aria-pressed={values.tags.includes(t)}
                  className={`h-8 px-3.5 rounded-full text-[14px] font-semibold transition ${
                    values.tags.includes(t) ? "bg-ink text-paper" : "bg-secondary text-mute"
                  }`}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-2">
            <input
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault()
                  addTag()
                }
              }}
              placeholder="New tag"
              className={inputClass}
            />
            <button type="button" onClick={addTag} className="px-5 h-12 rounded-xl bg-secondary text-[15px] font-semibold">
              Add
            </button>
          </div>
        </Field>

        <button type="submit" className={`${primaryButton} mt-1`}>
          {subject ? "Save changes" : "Add subject"}
        </button>
        </form>
      </Sheet>
      {showUnsavedPrompt && typeof document !== "undefined" && createPortal(
        <div
          role="alertdialog"
          aria-modal="false"
          aria-labelledby="unsaved-subject-title"
          className="fixed left-3 right-3 z-[100] mx-auto max-w-md rounded-2xl border border-ink/10 bg-card/95 p-4 shadow-xl backdrop-blur-xl"
          style={{ bottom: "calc(env(safe-area-inset-bottom) + 16px)" }}
        >
          <h3 id="unsaved-subject-title" className="text-[15px] font-bold">Save your changes?</h3>
          <p className="mt-1 text-[12px] leading-snug text-mute">You have edits that have not been saved yet.</p>
          <div className="grid grid-cols-2 gap-2 mt-3">
            <button type="button" onClick={() => setShowUnsavedPrompt(false)} className="h-10 rounded-xl bg-secondary text-ink text-[13px] font-semibold">Keep editing</button>
            <button type="button" onClick={() => { if (saveChanges()) setShowUnsavedPrompt(false) }} className="h-10 rounded-xl bg-ink text-paper text-[13px] font-semibold">Save changes</button>
          </div>
          <button type="button" onClick={() => { setShowUnsavedPrompt(false); onClose() }} className="w-full h-8 mt-1 text-[12px] font-semibold text-bad">Discard changes</button>
        </div>,
        document.body,
      )}
    </>
  )
}
