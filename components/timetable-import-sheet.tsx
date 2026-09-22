"use client"

import { useEffect, useMemo, useState } from "react"
import { Check, Copy, PencilSimple } from "@phosphor-icons/react"
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
    setResult(null)
    setUndone(false)
  }, [open])

  const resolved = useMemo(() => resolveImport(drafts, answers), [drafts, answers])

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

  const total = resolved.subjects.length

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
            <p className="text-[15px] text-mute leading-snug mb-3">
              {total} {total === 1 ? "subject" : "subjects"} ready. Check them, then add.
            </p>
          )}
          <ul className="rounded-2xl bg-secondary divide-y divide-ink/[0.08] overflow-hidden">
            {resolved.subjects.map((s, i) => (
              <li key={`${s.name}-${i}`} className="px-4 py-3">
                <p className="text-[16px] font-semibold leading-snug">
                  {s.name}
                  {isExisting(existing, s.name) && (
                    <span className="ml-2 align-middle text-[10px] font-bold tracking-wide text-mute bg-ink/10 rounded px-1.5 py-0.5">
                      UPDATES EXISTING
                    </span>
                  )}
                </p>
                <p className="text-[13px] text-mute leading-snug mt-0.5">
                  {s.slots.length
                    ? s.slots.map((x) => `${DAY_SHORT[x.day]} ${formatTime(x.start)}–${formatTime(x.end)}${x.kind ? ` · ${x.kind}` : ""}`).join("  ·  ")
                    : "No timetable"}
                  {s.requirementKnown ? ` · needs ${s.requirement}%` : ""}
                </p>
              </li>
            ))}
          </ul>
          {resolved.notes.length > 0 && (
            <ul className="mt-3 space-y-1">
              {resolved.notes.map((n) => (
                <li key={n} className="text-[13px] text-mute leading-snug">
                  {n}
                </li>
              ))}
            </ul>
          )}
          <p className="text-[13px] text-mute mt-3 leading-snug">
            Existing subjects keep their attendance; only their timetable is replaced. Anything left blank is simply not shown.
          </p>
          <div className="grid grid-cols-[auto_1fr] gap-2 mt-5">
            <button type="button" onClick={() => setStep("paste")} className={`${tintButton} h-[52px] px-5 text-[17px]`}>
              Back
            </button>
            <button
              type="button"
              disabled={total === 0}
              onClick={() => {
                setResult(onImport(resolved.subjects, resolved.notes))
                setUndone(false)
                setStep("done")
              }}
              className="h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold disabled:opacity-40"
            >
              Add {total} {total === 1 ? "subject" : "subjects"}
            </button>
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
