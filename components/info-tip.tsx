"use client"

import type { ReactNode } from "react"
import { Info } from "@phosphor-icons/react"

/** Compact, keyboard/touch-accessible disclosure for non-essential explanatory copy. */
export default function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="relative inline-block flex-shrink-0 align-middle">
      <summary
        aria-label={label}
        title={label}
        className="grid h-8 w-8 cursor-pointer list-none place-items-center rounded-full text-mute transition hover:bg-secondary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ink [&::-webkit-details-marker]:hidden"
      >
        <Info weight="bold" className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{label}</span>
      </summary>
      <div
        role="note"
        className="absolute right-0 top-full z-50 mt-2 w-[min(18rem,calc(100vw-2.5rem))] rounded-2xl border border-ink/10 bg-card p-3.5 text-left text-[12px] leading-relaxed text-mute shadow-xl"
      >
        {children}
      </div>
    </details>
  )
}
