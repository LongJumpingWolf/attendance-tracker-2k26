"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, Copy, PencilSimple, Plus, Trash } from "@phosphor-icons/react"
import Sheet, { inputClass, primaryButton, tintButton, fieldLabel } from "./sheet"
import { DAY_SHORT, formatTime } from "@/lib/attendance"
import { copyText } from "@/lib/clipboard"
import type { Slot, Subject } from "@/lib/types"
import {
  IMPORT_PROMPT,
  parseTimetable,
  findIssues,
  cleanAnswer,
  resolveImport,
  isExisting,
  type ImportSummary,
  DEFAULT_REQUIREMENT,
  type DraftSubject,
  type FinalSubject,
  type Issue,
} from "@/lib/timetable-import"

interface Props {
  open: boolean
  onClose: () => void
  existing: Subject[]
  /** Adds the subjects and returns what changed, plus a way to undo it */
  onImport: (subjects: FinalSubject[], notes: string[]) => { summary: ImportSummary; undo: () => void }
  onEditSubject: (id: string) => void
}

type Step = "paste" | "fill" | "review" | "done"

const INVALID: Record<Issue["field"], string> = {
  name: "Type a name.",
  day: "Pick a day.",
  start: "Enter a time like 09:30.",
  end: "Enter a time like 10:30.",
  requirement: "Enter a number from 1 to 100.",
}

export default function TimetableImportSheet({ open, onClose, existing, onImport, onEditSubject }: Props) {
  const [step, setStep] = useState<Step>("paste")
  const [text, setText] = useState("")
  const [error, setError] = useState("")
  const [copied, setCopied] = useState(false)
  const [copyFailed, setCopyFailed] = useState(false)
  const [showPrompt, setShowPrompt] = useState(false)
  const [drafts, setDrafts] = useState<DraftSubject[]>([])
  const [issues, setIssues] = useState<Issue[]>([])
  const [at, setAt] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string | number>>({})
  const [value, setValue] = useState("")
  const [fieldError, setFieldError] = useState("")
  const [reviewSubjects, setReviewSubjects] = useState<FinalSubject[] | null>(null)
  const [reviewEditIndex, setReviewEditIndex] = useState<number | null>(null)
  const [reviewError, setReviewError] = useState("")
  const live = (id: string) => existing.find((s) => s.id === id) // edits made after importing show up here
  const [result, setResult] = useState<{ summary: ImportSummary; undo: () => void } | null>(null)
  const [undone, setUndone] = useState(false)

  useEffect(() => {
    if (!open) return
    setStep("paste")
    setText("")
    setError("")
    setCopied(false)
    setCopyFailed(false)
    setShowPrompt(false)
    setDrafts([])
    setIssues([])
    setAt(0)
    setAnswers({})
    setValue("")
    setFieldError("")
    setReviewSubjects(null)
    setReviewEditIndex(null)
    setReviewError("")
    setResult(null)
    setUndone(false)
  }, [open])

  const resolved = useMemo(() => resolveImport(drafts, answers), [drafts, answers])
  const editableSubjects = reviewSubjects ?? resolved.subjects
  const total = editableSubjects.length

  useEffect(() => {
    if (step === "review" && reviewSubjects === null) {
      setReviewSubjects(resolved.subjects.map((subject) => ({
        ...subject,
        slots: subject.slots.map((slot) => ({ ...slot })),
      })))
    }
  }, [step, resolved.subjects, reviewSubjects])

  const updateReviewSubject = (index: number, patch: Partial<FinalSubject>) => {
    setReviewSubjects((current) => {
      const base = current ?? resolved.subjects
      return base.map((subject, i) => i === index ? { ...subject, ...patch } : subject)
    })
    setReviewError("")
  }

  const updateReviewSlot = (index: number, slotIndex: number, patch: Partial<Slot>) => {
    const subject = (reviewSubjects ?? resolved.subjects)[index]
    if (!subject) return
    updateReviewSubject(index, {
      slots: subject.slots.map((slot, i) => i === slotIndex ? { ...slot, ...patch } : slot),
    })
  }

  const validateReview = () => {
    for (const subject of editableSubjects) {
      if (!subject.name.trim()) return "Every subject needs a name."
      if (!Number.isFinite(subject.requirement) || subject.requirement < 1 || subject.requirement > 100) return "Attendance requirements must be between 1% and 100%."
      for (const slot of subject.slots) {
        if (!Number.isInteger(slot.day) || slot.day < 0 || slot.day > 6) return "Choose a day for every class time."
        if (!slot.start || !slot.end) return "Complete or remove every class time before importing."
        if (slot.end <= slot.start) return "Each class must end after it starts."
      }
    }
    return ""
  }

  const copyPrompt = async () => {
    setCopyFailed(false)
    if (await copyText(IMPORT_PROMPT)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } else {
      // Nothing worked, so show the text to copy by hand and say so
      setCopyFailed(true)
      setShowPrompt(true)
    }
  }

  const readPaste = () => {
    const r = parseTimetable(text)
    if (!r.ok) return setError(r.error)
    setError("")
    setDrafts(r.subjects)
    setReviewSubjects(null)
    setReviewEditIndex(null)
    setReviewError("")
    const found = findIssues(r.subjects)
    setIssues(found)
    setAt(0)
    setAnswers({})
    setValue(found[0]?.field === "requirement" ? String(DEFAULT_REQUIREMENT) : "")
    setStep(found.length ? "fill" : "review")
  }

  const goTo = (n: number, list = issues) => {
    if (n >= list.length) return setStep("review")
    setAt(n)
    setValue(list[n].field === "requirement" ? String(DEFAULT_REQUIREMENT) : "")
    setFieldError("")
  }

  const issue = issues[at]

  const submitAnswer = () => {
    const clean = cleanAnswer(issue.field, value)
    if (clean === null) return setFieldError(INVALID[issue.field])
    setAnswers((a) => ({ ...a, [issue.id]: clean }))
    goTo(at + 1)
  }

  const skip = () => goTo(at + 1)

  return (
    <Sheet open={open} onClose={onClose} title="Import timetable">
      {step === "paste" && (
        <div>
          <ol className="space-y-3 text-[15px] leading-snug mb-4">
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-ink text-paper grid place-items-center text-[13px] font-bold flex-shrink-0">1</span>
              <span>Copy the prompt below.</span>
            </li>
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-ink text-paper grid place-items-center text-[13px] font-bold flex-shrink-0">2</span>
              <span>Open ChatGPT, attach a photo of your timetable, paste the prompt and send.</span>
            </li>
            <li className="flex gap-3">
              <span className="w-6 h-6 rounded-full bg-ink text-paper grid place-items-center text-[13px] font-bold flex-shrink-0">3</span>
              <span>Copy the code block it replies with and paste it here.</span>
            </li>
          </ol>

          <button type="button" onClick={copyPrompt} className={`${tintButton} w-full`}>
            {copied ? <Check weight="bold" className="w-4 h-4" /> : <Copy weight="bold" className="w-4 h-4" />}
            {copied ? "Prompt copied" : "Copy prompt"}
          </button>
          <button type="button" onClick={() => setShowPrompt(!showPrompt)} className="mt-2 text-[13px] text-mute">
            {showPrompt ? "Hide" : "Show"} the prompt
          </button>
          {copyFailed && <p className="text-[13px] text-bad mt-2 leading-snug">Couldn&rsquo;t copy automatically. Tap the box below, select all, and copy it.</p>}
          {showPrompt && (
            <textarea
              readOnly
              value={IMPORT_PROMPT}
              onFocus={(e) => e.target.select()}
              className="mt-2 w-full h-40 rounded-xl bg-secondary p-3 text-[12px] leading-snug font-mono outline-none"
            />
          )}

          <span className={`${fieldLabel} mt-5`}>Paste ChatGPT&rsquo;s code block</span>
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setError("")
            }}
            placeholder={'{ "subjects": [ ... ] }'}
            spellCheck={false}
            className="w-full h-36 rounded-xl bg-secondary p-3 text-[13px] leading-snug font-mono outline-none placeholder:text-mute focus:ring-1 focus:ring-ink/40"
          />
          {error && <p className="text-[13px] text-bad mt-1.5">{error}</p>}
          <button type="button" onClick={readPaste} disabled={!text.trim()} className={`${primaryButton} mt-4 disabled:opacity-40`}>
            Continue
          </button>
        </div>
      )}

      {step === "fill" && issue && (
        <div>
          <p className="text-[13px] text-mute">
            Missing detail {at + 1} of {issues.length}
          </p>
          <div className="h-1 rounded-full bg-ink/10 mt-2 mb-5 overflow-hidden">
            <div className="h-full bg-ink rounded-full transition-all" style={{ width: `${((at + 1) / issues.length) * 100}%` }} />
          </div>

          <h3 className="text-[19px] font-semibold leading-snug">{issue.question}</h3>
          <div className="mt-4">
            {issue.field === "day" ? (
              <div className="flex justify-between">
                {DAY_SHORT.map((d, i) => (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={value === String(i)}
                    onClick={() => {
                      setValue(String(i))
                      setFieldError("")
                    }}
                    className={`w-11 h-11 rounded-full text-[13px] font-semibold transition ${value === String(i) ? "bg-ink text-paper" : "bg-secondary text-mute"}`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            ) : issue.field === "start" || issue.field === "end" ? (
              <input
                type="time"
                value={value}
                onChange={(e) => {
                  setValue(e.target.value)
                  setFieldError("")
                }}
                className={`${inputClass} num`}
              />
            ) : (
              <div className="relative">
                <input
                  autoFocus
                  inputMode={issue.field === "requirement" ? "numeric" : "text"}
                  value={value}
                  onChange={(e) => {
                    setValue(e.target.value)
                    setFieldError("")
                  }}
                  onKeyDown={(e) => e.key === "Enter" && submitAnswer()}
                  placeholder={issue.field === "name" ? "e.g. Database Systems" : ""}
                  className={inputClass}
                />
                {issue.field === "requirement" && <span className="absolute right-4 top-1/2 -translate-y-1/2 text-mute">%</span>}
              </div>
            )}
          </div>
          {fieldError && <p className="text-[13px] text-bad mt-1.5">{fieldError}</p>}
          <p className="text-[13px] text-mute mt-3 leading-snug">If you skip: {issue.ifSkipped}</p>

          <div className="grid grid-cols-2 gap-2 mt-5">
            <button type="button" onClick={skip} className={`${tintButton} h-[52px] text-[17px]`}>
              Skip
            </button>
            <button type="button" onClick={submitAnswer} className="h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold">
              {at + 1 === issues.length ? "Review" : "Next"}
            </button>
          </div>
          <button type="button" onClick={() => setStep("review")} className="w-full mt-3 text-[15px] text-mute font-medium">
            Skip the rest and continue
          </button>
        </div>
      )}

      {step === "review" && (
        <div>
          {total === 0 ? (
            <p className="text-[15px] text-mute leading-snug">Nothing can be added: every subject was missing its name.</p>
          ) : (
            <p className="text-[14px] text-mute leading-snug mb-3">{total} {total === 1 ? "subject" : "subjects"} detected. Review or edit anything below before importing.</p>
          )}
          <ul className="rounded-2xl bg-secondary divide-y divide-ink/[0.08] overflow-hidden">
            {editableSubjects.map((subject, i) => (
              <li key={i} className="px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[15px] font-semibold leading-snug break-words">
                      {subject.name || "Unnamed subject"}
                      {isExisting(existing, subject.name) && <span className="ml-2 align-middle text-[10px] font-bold tracking-wide text-mute bg-ink/10 rounded px-1.5 py-0.5">UPDATES EXISTING</span>}
                    </span>
                    <span className="block text-[12px] text-mute leading-snug mt-1">
                      {subject.slots.length ? subject.slots.map((slot) => `${slot.day >= 0 ? DAY_SHORT[slot.day] : "Choose day"} ${slot.start ? formatTime(slot.start) : "—"}–${slot.end ? formatTime(slot.end) : "—"}${slot.kind ? " · " + slot.kind : ""}`).join(" · ") : "No class times"}
                      {subject.requirementKnown ? ` · needs ${subject.requirement}%` : ` · default ${subject.requirement}%`}
                    </span>
                  </span>
                  <button type="button" onClick={() => { setReviewEditIndex(reviewEditIndex === i ? null : i); setReviewError("") }} aria-expanded={reviewEditIndex === i} className="flex-shrink-0 min-h-9 px-3 rounded-xl bg-card border border-ink/10 text-[13px] font-semibold inline-flex items-center gap-1.5">
                    <PencilSimple size={15} /> {reviewEditIndex === i ? "Done" : "Edit"}
                  </button>
                </div>
                {reviewEditIndex === i && (
                  <div className="mt-3 pt-3 border-t border-ink/10 space-y-3">
                    <label className="block"><span className={fieldLabel}>Subject name</span><input value={subject.name} onChange={(event) => updateReviewSubject(i, { name: event.target.value })} className={inputClass} maxLength={60}/></label>
                    <label className="block"><span className={fieldLabel}>Minimum attendance (%)</span><input type="number" inputMode="numeric" min={1} max={100} value={subject.requirement} onChange={(event) => updateReviewSubject(i, { requirement: event.target.value === "" ? 0 : Number(event.target.value), requirementKnown: true })} className={inputClass}/></label>
                    <div>
                      <p className={fieldLabel}>Class times</p>
                      {subject.slots.map((slot, slotIndex) => (
                        <div key={slotIndex} className="rounded-xl bg-card border border-ink/10 p-3 mb-2 space-y-2.5">
                          <div className="flex items-center justify-between gap-2">
                            <label className="flex-1 min-w-0"><span className="sr-only">Class day</span><select value={slot.day >= 0 ? slot.day : ""} onChange={(event) => updateReviewSlot(i, slotIndex, { day: event.target.value === "" ? -1 : Number(event.target.value) })} className={inputClass + " h-10 px-2 text-[14px]"}><option value="">Choose a day</option>{DAY_SHORT.map((day, dayIndex) => <option key={dayIndex} value={dayIndex}>{day}</option>)}</select></label>
                            <button type="button" aria-label="Remove class time" onClick={() => updateReviewSubject(i, { slots: subject.slots.filter((_, j) => j !== slotIndex) })} className="w-10 h-10 flex-shrink-0 rounded-xl text-bad bg-bad/10 grid place-items-center"><Trash size={17}/></button>
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <label className="min-w-0"><span className={fieldLabel}>Starts</span><input type="time" value={slot.start} onChange={(event) => updateReviewSlot(i, slotIndex, { start: event.target.value })} className={inputClass + " h-10 px-2 text-[14px] min-w-0"}/></label>
                            <label className="min-w-0"><span className={fieldLabel}>Ends</span><input type="time" value={slot.end} onChange={(event) => updateReviewSlot(i, slotIndex, { end: event.target.value })} className={inputClass + " h-10 px-2 text-[14px] min-w-0"}/></label>
                          </div>
                          <label className="block"><span className={fieldLabel}>Class type</span><select value={slot.kind ?? ""} onChange={(event) => updateReviewSlot(i, slotIndex, { kind: event.target.value || undefined })} className={inputClass + " h-10 px-2 text-[14px]"}><option value="">Not set</option><option value="Lecture">Lecture</option><option value="Practical">Practical</option><option value="Tutorial">Tutorial</option></select></label>
                        </div>
                      ))}
                      <button type="button" onClick={() => updateReviewSubject(i, { slots: [...subject.slots, { day: -1, start: "", end: "", kind: "Lecture" }] })} className="w-full min-h-10 rounded-xl border border-dashed border-ink/20 text-[13px] font-semibold text-mute inline-flex items-center justify-center gap-2"><Plus size={16}/> Add class time</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {reviewError && <p role="alert" className="mt-3 rounded-xl bg-bad/10 px-3 py-2 text-[13px] text-bad">{reviewError}</p>}
          {resolved.notes.length > 0 && <div className="mt-3 rounded-xl bg-secondary/60 px-3 py-2">{resolved.notes.map((note) => <p key={note} className="text-[12px] text-mute leading-snug">{note}</p>)}</div>}
          <p className="text-[12px] text-mute leading-snug mt-3">Existing subjects keep their attendance; only their timetable is replaced. Edit the details here before importing.</p>
          <div className="grid grid-cols-[auto_1fr] gap-2 mt-4">
            <button type="button" onClick={() => setStep("paste")} className={tintButton + " h-[52px] px-5 text-[17px]"}>Back</button>
            <button type="button" disabled={total === 0} onClick={() => {
              const issue = validateReview()
              if (issue) { setReviewError(issue); return }
              const finalSubjects = editableSubjects.map((subject) => ({ ...subject, name: subject.name.trim(), slots: subject.slots.map((slot) => ({ ...slot })) }))
              setResult(onImport(finalSubjects, resolved.notes))
              setUndone(false)
              setStep("done")
            }} className="h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold disabled:opacity-40">Add {total} {total === 1 ? "subject" : "subjects"}</button>
          </div>
        </div>
      )}

      {step === "done" && result && (
        <div>
          <div className="flex items-center gap-3 mb-4">
            <span className={`w-11 h-11 rounded-full grid place-items-center flex-shrink-0 ${undone ? "bg-ink/[0.08] text-mute" : "bg-good/15 text-good"}`}>
              <Check weight="bold" className="w-6 h-6" />
            </span>
            <div className="min-w-0">
              <h3 className="text-[20px] font-bold tracking-tight leading-tight">{undone ? "Import undone" : "Import complete"}</h3>
              <p className="text-[14px] text-mute leading-snug">
                {undone
                  ? "Your subjects are back as they were."
                  : [
                      result.summary.added.length ? `${result.summary.added.length} added` : "",
                      result.summary.updated.filter((u) => u.changed).length ? `${result.summary.updated.filter((u) => u.changed).length} updated` : "",
                      result.summary.updated.some((u) => !u.changed) ? `${result.summary.updated.filter((u) => !u.changed).length} unchanged` : "",
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Nothing changed"}
              </p>
            </div>
          </div>

          {!undone && (
            <div className="space-y-5">
              {result.summary.added.length > 0 && (
                <section>
                  <h4 className="text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1">New subjects</h4>
                  <ul className="rounded-2xl bg-secondary divide-y divide-ink/[0.08] overflow-hidden">
                    {result.summary.added.map((a) => (
                      <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                        <span className="min-w-0 flex-1">
                          <span className="block text-[16px] font-semibold leading-snug truncate">{live(a.id)?.name ?? a.name}</span>
                          <span className="block text-[13px] text-mute leading-snug">{(live(a.id)?.slots ?? a.slots).length ? slotList(live(a.id)?.slots ?? a.slots) : "No classes on the timetable"}</span>
                        </span>
                        <EditButton onClick={() => onEditSubject(a.id)} />
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {result.summary.updated.length > 0 && (
                <section>
                  <h4 className="text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1">Existing subjects</h4>
                  <ul className="rounded-2xl bg-secondary divide-y divide-ink/[0.08] overflow-hidden">
                    {result.summary.updated.map((u) => {
                      const diff = diffSlots(u.before, u.after)
                      return (
                        <li key={u.id} className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="min-w-0 flex-1 text-[16px] font-semibold leading-snug truncate">{live(u.id)?.name ?? u.name}</span>
                            {!u.changed && <span className="text-[12px] text-mute">No change</span>}
                            <EditButton onClick={() => onEditSubject(u.id)} />
                          </div>
                          {u.changed && (
                            <ul className="mt-1.5 space-y-0.5 text-[13px] leading-snug">
                              {diff.removed.map((x) => (
                                <li key={`r${x.day}${x.start}`} className="text-bad line-through">
                                  {slotText(x)}
                                </li>
                              ))}
                              {diff.added.map((x) => (
                                <li key={`a${x.day}${x.start}`} className="text-good font-medium">
                                  + {slotText(x)}
                                </li>
                              ))}
                              {diff.kept.length > 0 && <li className="text-mute">{diff.kept.length} unchanged</li>}
                              {u.requirementTo !== undefined && (
                                <li className="text-mute">
                                  Needs {u.requirementFrom}% → {u.requirementTo}%
                                </li>
                              )}
                            </ul>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                </section>
              )}

              {result.summary.notes.length > 0 && (
                <ul className="space-y-1">
                  {result.summary.notes.map((n) => (
                    <li key={n} className="text-[13px] text-mute leading-snug">
                      {n}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <div className={`grid gap-2 mt-6 ${undone ? "grid-cols-1" : "grid-cols-2"}`}>
            {!undone && (
              <button
                type="button"
                onClick={() => {
                  result.undo()
                  setUndone(true)
                }}
                className={`${tintButton} h-[52px] text-[17px]`}
              >
                Undo import
              </button>
            )}
            <button type="button" onClick={onClose} className={`${primaryButton}`}>
              Done
            </button>
          </div>
        </div>
      )}
    </Sheet>
  )
}

const slotText = (x: Slot) => `${DAY_SHORT[x.day]} ${formatTime(x.start)}–${formatTime(x.end)}${x.kind ? ` · ${x.kind}` : ""}`
const slotList = (slots: Slot[]) => slots.map(slotText).join("  ·  ")

/** Which classes were removed, added, or left alone (a class is the same day + start + end) */
function diffSlots(before: Slot[], after: Slot[]) {
  const k = (x: Slot) => `${x.day}|${x.start}|${x.end}`
  const b = new Set(before.map(k))
  const a = new Set(after.map(k))
  return { removed: before.filter((x) => !a.has(k(x))), added: after.filter((x) => !b.has(k(x))), kept: after.filter((x) => b.has(k(x))) }
}

function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} aria-label="Edit this subject" className="h-9 px-3 rounded-full bg-card text-[13px] font-semibold flex items-center gap-1.5 flex-shrink-0">
      <PencilSimple weight="bold" className="w-3.5 h-3.5" /> Edit
    </button>
  )
}
