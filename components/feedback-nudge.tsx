"use client"

import { Bug, Star } from "@phosphor-icons/react"

export default function FeedbackNudge({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  return <aside className="fixed z-[65] bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-3 right-3 sm:left-auto sm:right-5 sm:max-w-md rounded-2xl bg-ink text-paper shadow-xl p-3.5 flex items-start gap-3 animate-sheet" role="status" aria-live="polite">
    <span className="w-10 h-10 rounded-xl bg-white/15 grid place-items-center flex-shrink-0"><Star size={21} weight="fill" /></span>
    <div className="min-w-0 flex-1"><p className="text-[14px] font-semibold">Enjoying College Tracker?</p><p className="text-[12px] text-paper/75 leading-snug mt-0.5">Rate it, report a bug, or leave the developer a note. Screenshots are compressed before upload.</p><button onClick={onOpen} className="mt-2 inline-flex items-center gap-2 rounded-xl bg-paper text-ink px-3 py-2 text-[13px] font-bold"><Bug size={16}/> Rate or report</button></div>
    <button aria-label="Dismiss feedback prompt" onClick={onDismiss} className="text-paper/75 text-xl leading-none px-1">×</button>
  </aside>
}
