"use client"

import { useState } from "react"
import { DotsThreeVertical, PencilSimple, Trash, MoonStars } from "@phosphor-icons/react"
import type { Subject } from "@/lib/types"

export default function SubjectActionMenu({
  subject, onEdit, onDelete, onSleep,
}: { subject: Subject; onEdit: () => void; onDelete: () => void; onSleep?: (subject: Subject) => void }) {
  const [open, setOpen] = useState(false)
  const itemClass = "w-full min-h-11 flex items-center gap-3 rounded-xl px-3 text-left text-[14px] font-semibold hover:bg-secondary active:scale-[0.99]"
  return (
    <div className="relative">
      <button type="button" onClick={(event) => { event.stopPropagation(); setOpen((value) => !value) }} aria-label={"More options for " + subject.name} aria-expanded={open} className="w-9 h-9 grid place-items-center rounded-full bg-secondary/90 text-ink border border-ink/10">
        <DotsThreeVertical weight="bold" className="w-5 h-5" />
      </button>
      {open && <>
        <button type="button" aria-label="Close subject options" className="fixed inset-0 z-30 cursor-default" onClick={() => setOpen(false)} />
        <div className="absolute z-40 right-0 top-10 w-56 rounded-2xl border border-ink/10 bg-card p-2 shadow-xl">
          <button type="button" className={itemClass} onClick={() => { setOpen(false); onEdit() }}><PencilSimple className="w-4 h-4 text-mute" /> Edit subject</button>
          {onSleep && <button type="button" className={itemClass} onClick={() => { setOpen(false); onSleep(subject) }}><MoonStars className="w-4 h-4 text-mute" /> {subject.sleeping ? "Manage sleep schedule" : "Sleep subject…"}</button>}
          <div className="my-1 border-t border-ink/10" />
          <button type="button" className={itemClass + " text-bad hover:bg-bad/10"} onClick={() => { setOpen(false); onDelete() }}><Trash className="w-4 h-4" /> Delete subject…</button>
        </div>
      </>}
    </div>
  )
}