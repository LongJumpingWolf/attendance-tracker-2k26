"use client"

import { useEffect, useState } from "react"
import { Plus, Trash } from "@phosphor-icons/react"
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
  slots: Slot[]
}

interface SubjectSheetProps {
  open: boolean
  onClose: () => void
  /** Present when editing an existing subject */
  subject?: (Omit<SubjectValues, "slots"> & { slots?: Slot[] }) | null
  existingTags: string[]
  onSubmit: (values: SubjectValues) => void
  onDelete?: () => void
}

const COLORS = ["#30d158", "#0a84ff", "#bf5af2", "#ff375f", "#ff9f0a", "#64d2ff"]

const EMPTY = { name: "", attended: 0, missed: 0, requirement: 75, glowColor: COLORS[1], tags: [] as string[] }

export default function SubjectSheet({ open, onClose, subject, existingTags, onSubmit, onDelete }: SubjectSheetProps) {
  const [values, setValues] = useState(EMPTY)
  // Every class is its own row, so a subject can meet at different times on different days
  const [slots, setSlots] = useState<Slot[]>([])
  const [newTag, setNewTag] = useState("")
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    const { slots, ...rest } = subject ?? { ...EMPTY, slots: [] as Slot[] }
    setValues({ ...rest, tags: rest.tags || [] })
    setSlots((slots || []).map((x) => ({ ...x })))
    setNewTag("")
    setError("")
  }, [open, subject])

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

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!values.name.trim()) return setError("Give the subject a name")
    const bad = slots.findIndex((x) => x.end <= x.start)
    if (bad !== -1) return setError(`${DAY_NAMES[slots[bad].day]}: the class must end after it starts`)
    const seen = new Set<string>()
    for (const x of slots) {
      const k = `${x.day}|${x.start}`
      if (seen.has(k)) return setError(`${DAY_NAMES[x.day]} has two classes starting at the same time`)
      seen.add(k)
    }
    const sorted = [...slots].sort((a, b) => DAY_ORDER.indexOf(a.day) - DAY_ORDER.indexOf(b.day) || toMin(a.start) - toMin(b.start))
    onSubmit({ ...values, name: values.name.trim(), slots: sorted })
  }

  return (
    <Sheet open={open} onClose={onClose} title={subject ? "Edit subject" : "New subject"}>
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
        {subject && onDelete && (
          <button type="button" onClick={onDelete} className="w-full mt-2 h-12 text-[17px] font-semibold text-bad">
            Delete subject
          </button>
        )}
      </form>
    </Sheet>
  )
}
