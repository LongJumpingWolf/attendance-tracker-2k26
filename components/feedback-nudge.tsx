"use client"

import { Star } from "@phosphor-icons/react"

export default function FeedbackNudge({ onRate, onDismiss }: {
  onRate: () => void
  onDismiss: () => void
}) {
  return (
    <aside className="fixed z-[65] bottom-[calc(5.5rem+env(safe-area-inset-bottom))] left-3 right-3 sm:left-auto sm:right-5 sm:max-w-sm rounded-2xl bg-ink text-paper shadow-xl p-3.5 flex items-start gap-3" role="status" aria-live="polite">
      <span className="w-9 h-9 rounded-xl bg-white/15 grid place-items-center flex-shrink-0"><Star size={19} weight="fill" /></span>
      <div className="min-w-0 flex-1">
        <p className="text-[14px] font-semibold">Enjoying College Tracker?</p>
        <p className="text-[12px] text-paper/75 leading-snug mt-0.5">A quick rating helps guide improvements.</p>
        <div className="flex items-center gap-2 mt-2.5">
          <button onClick={onRate} className="rounded-lg bg-paper text-ink px-3 py-2 text-[12px] font-bold">Rate the app</button>
          <button onClick={onDismiss} className="rounded-lg bg-white/15 text-paper px-3 py-2 text-[12px] font-semibold">Not now</button>
        </div>
      </div>
      <button aria-label="Dismiss rating prompt" onClick={onDismiss} className="text-paper/75 text-lg leading-none px-1">×</button>
    </aside>
  )
}
