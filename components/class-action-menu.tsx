"use client"

import { useState } from "react"
import { DotsThreeVertical, ArrowsLeftRight, MoonStars } from "@phosphor-icons/react"
import type { Subject } from "@/lib/types"

export interface ClassActionTarget {
  subjectId: string
  date: string
  slot: { day: number; start: string; end: string; kind?: string }
  subjectName?: string
  intent?: "replace" | "cancel"
}

export default function ClassActionMenu({
  subject,
  target,
  onReplace,
  onCancel,
  onSleep,
}: {
  subject: Subject
  target?: ClassActionTarget
  onReplace?: (target: ClassActionTarget) => void
  onCancel?: (target: ClassActionTarget) => void
  onSleep?: (subject: Subject) => void
}) {
  const [open, setOpen] = useState(false)
  const button = "w-full min-h-11 flex items-center gap-3 rounded-xl px-3 text-left text-[14px] font-semibold hover:bg-secondary active:scale-[0.99]"
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} aria-label={`More options for ${subject.name}`} aria-expanded={open} className="w-9 h-9 grid place-items-center rounded-full bg-secondary/90 text-ink border border-ink/10">
        <DotsThreeVertical weight="bold" className="w-5 h-5" />
      </button>
      {open && <>
        <button type="button" aria-label="Close options" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
        <div className="absolute z-40 right-0 top-10 w-60 rounded-2xl border border-ink/10 bg-card p-2 shadow-xl">
          {target && (onReplace || onCancel) && <button className={button} onClick={() => {
            setOpen(false)
            const openChange = onReplace ?? onCancel
            openChange?.({ ...target, intent: undefined })
          }}><ArrowsLeftRight className="w-4 h-4 text-info" />Replace / cancel lecture…</button>}
          {onSleep && <button className={button} onClick={() => { setOpen(false); onSleep(subject) }}><MoonStars className="w-4 h-4 text-mute" />{subject.sleeping && (subject.sleepUntil === "forever" || !subject.sleepUntil || subject.sleepUntil >= new Date().toISOString().slice(0, 10)) ? "Manage / wake subject" : "Put subject to sleep"}</button>}
        </div>
      </>}
    </div>
  )
}
