"use client"

import { Bug, Star, Lightbulb, X } from "@phosphor-icons/react"

export default function FeedbackNudge({ onRate, onReportBug, onSuggest, onDismiss }: {
  onRate: () => void
  onReportBug: () => void
  onSuggest: () => void
  onDismiss: () => void
}) {
  return (
    <aside className="fixed z-[65] bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-3 right-3 sm:left-auto sm:right-5 sm:max-w-sm rounded-2xl bg-ink text-paper shadow-xl p-3 flex items-start gap-2.5" role="status" aria-live="polite">
      <span className="w-8 h-8 rounded-xl bg-white/15 grid place-items-center flex-shrink-0"><Star size={17} weight="fill" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold">Help improve College Tracker</p>
        <p className="text-[11px] text-paper/75 leading-snug mt-0.5">Pick one quick action.</p>
        <div className="flex flex-wrap gap-1.5 mt-2">
          <button onClick={onRate} className="inline-flex items-center gap-1 rounded-lg bg-paper text-ink px-2.5 py-1.5 text-[11px] font-bold"><Star size={13}/> Rate</button>
          <button onClick={onReportBug} className="inline-flex items-center gap-1 rounded-lg bg-white/15 text-paper px-2.5 py-1.5 text-[11px] font-semibold"><Bug size={13}/> Report bug</button>
          <button onClick={onSuggest} className="inline-flex items-center gap-1 rounded-lg bg-white/15 text-paper px-2.5 py-1.5 text-[11px] font-semibold"><Lightbulb size={13}/> Suggest</button>
        </div>
      </div>
      <button aria-label="Dismiss feedback prompt" onClick={onDismiss} className="text-paper/75 text-lg leading-none px-1">×</button>
    </aside>
  )
}
