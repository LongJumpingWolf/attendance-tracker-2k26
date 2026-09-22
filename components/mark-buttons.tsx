"use client"

import { Check, X } from "@phosphor-icons/react"

interface MarkButtonsProps {
  onPresent: () => void
  onAbsent: () => void
  label: string
}

/**
 * The one way to mark a class, everywhere in the app:
 * two compact buttons, aligned right. Green tick for present, red cross for missed.
 */
export default function MarkButtons({ onPresent, onAbsent, label }: MarkButtonsProps) {
  const base = "h-9 pl-3 pr-3.5 rounded-full text-[14px] font-semibold inline-flex items-center gap-1.5 transition"
  return (
    <div className="flex justify-end gap-2">
      <button onClick={onPresent} aria-label={`Mark present in ${label}`} className={`${base} bg-good/15 text-good`}>
        <Check weight="bold" className="w-4 h-4" /> Present
      </button>
      <button onClick={onAbsent} aria-label={`Mark missed in ${label}`} className={`${base} bg-bad/15 text-bad`}>
        <X weight="bold" className="w-4 h-4" /> Missed
      </button>
    </div>
  )
}
