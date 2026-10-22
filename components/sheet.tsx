"use client"

import type React from "react"
import { useEffect, useRef } from "react"
import { X, CaretLeft } from "@phosphor-icons/react"
import { useScrollLock } from "@/lib/use-scroll-lock"

/* Shared building blocks: sheets, fields, segmented control, buttons */

/** The one card: 16px radius, #1c1c1e, 16px horizontal padding on rows */
export const cardClass = "rounded-2xl bg-card overflow-hidden"
export const rowClass = "px-4 min-h-[64px] flex items-center"
/** Section headings: small, uppercase, muted */
export const sectionLabel = "text-[12px] font-medium uppercase tracking-wider text-mute"
export const fieldLabel = "block text-[13px] font-medium text-mute mb-1.5"
export const inputClass =
  "w-full h-12 rounded-xl bg-secondary px-4 text-[17px] outline-none placeholder:text-mute focus:ring-1 focus:ring-ink/40"
export const primaryButton =
  "w-full h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold hover:bg-ink/90 transition"
export const tintButton =
  "inline-flex items-center justify-center gap-2 h-11 px-4 rounded-xl bg-card border border-ink/15 text-ink text-[15px] font-semibold transition hover:bg-secondary disabled:opacity-45"

interface SheetProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  wide?: boolean
  /** When set, a back arrow shows before the title (for sheets that navigate between pages) */
  onBack?: () => void
  /** Optional action placed immediately beside the close button. */
  headerActions?: React.ReactNode
  /** Elevate a follow-up sheet above another sheet during a state transition. */
  priority?: "normal" | "high"
}

const openSheets: symbol[] = []

/** Bottom sheet on phones, centred dialog on larger screens. */
export default function Sheet({ open, onClose, title, children, wide, onBack, headerActions, priority = "normal" }: SheetProps) {
  const dragStartY = useRef<number | null>(null)

  const startHandleDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    dragStartY.current = event.clientY
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const endHandleDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartY.current
    dragStartY.current = null
    if (start !== null && event.clientY - start > 64) onClose()
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  // Escape closes only the sheet on top, not every sheet stacked beneath it
  useEffect(() => {
    if (!open) return
    const token = Symbol("sheet")
    openSheets.push(token)
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && openSheets[openSheets.length - 1] === token && onClose()
    window.addEventListener("keydown", onKey)
    return () => {
      window.removeEventListener("keydown", onKey)
      openSheets.splice(openSheets.indexOf(token), 1)
    }
  }, [open, onClose])

  // The page behind must not scroll while a sheet is open
  useScrollLock(open)

  if (!open) return null

  return (
    <div className={`fixed inset-0 ${priority === "high" ? "z-[80]" : "z-50"} flex items-end sm:items-center justify-center bg-black/40 sm:p-4`}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`animate-sheet w-full ${wide ? "sm:max-w-4xl" : "sm:max-w-md"} bg-card rounded-t-[28px] sm:rounded-[28px] max-h-[92dvh] overflow-y-auto overscroll-contain`}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="sm:hidden -mt-0.5 h-9 w-full flex items-center justify-center touch-none select-none cursor-grab active:cursor-grabbing"
          onPointerDown={startHandleDrag}
          onPointerUp={endHandleDrag}
          onPointerCancel={() => { dragStartY.current = null }}
          aria-hidden="true"
        >
          <span className="h-1 w-10 rounded-full bg-ink/25" />
        </div>
        <div className="flex items-center justify-between px-5 pt-4 pb-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {onBack && (
              <button
                onClick={onBack}
                aria-label="Back"
                className="w-8 h-8 -ml-1 grid place-items-center rounded-full bg-secondary text-ink flex-shrink-0"
              >
                <CaretLeft weight="bold" className="w-4 h-4" />
              </button>
            )}
            <h2 className="text-[22px] font-bold tracking-tight truncate">{title}</h2>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {headerActions}
            <button
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 grid place-items-center rounded-full bg-secondary text-mute hover:text-ink"
            >
              <X weight="bold" className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">{children}</div>
      </div>
    </div>
  )
}

export function Field({ label, children, error }: { label: string; children: React.ReactNode; error?: string }) {
  return (
    <div className="mb-5">
      <span className={fieldLabel}>{label}</span>
      {children}
      {error && <p className="text-[13px] text-bad mt-1.5">{error}</p>}
    </div>
  )
}

export function Stepper({
  label,
  value,
  onChange,
  min = 0,
  max = 999,
  step = 1,
  suffix,
}: {
  label: string
  value: number
  onChange: (n: number) => void
  min?: number
  max?: number
  step?: number
  suffix?: string
}) {
  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  return (
    <div>
      <span className={fieldLabel}>{label}</span>
      <div className="flex items-stretch h-12 rounded-xl bg-secondary focus-within:ring-1 focus-within:ring-ink/40">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= min}
          className="w-9 grid place-items-center text-xl text-mute hover:text-ink disabled:opacity-30"
        >
          −
        </button>
        <div className="flex-1 min-w-0 flex items-center justify-center">
          <input
            inputMode="numeric"
            aria-label={label}
            value={value}
            onChange={(e) => onChange(clamp(parseInt(e.target.value.replace(/\D/g, ""), 10) || 0))}
            onFocus={(e) => e.target.select()}
            className={`num bg-transparent text-center text-[17px] font-semibold outline-none ${suffix ? "w-[2.7ch] flex-none" : "w-full min-w-0"}`}
          />
          {suffix && <span className="text-mute pr-1 text-[15px]">{suffix}</span>}
        </div>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          onClick={() => onChange(clamp(value + step))}
          disabled={value >= max}
          className="w-9 grid place-items-center text-xl text-mute hover:text-ink disabled:opacity-30"
        >
          +
        </button>
      </div>
    </div>
  )
}

/** iOS-style segmented control */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
}: {
  value: T
  onChange: (v: T) => void
  options: { id: T; label: string }[]
  label: string
}) {
  return (
    <div role="tablist" aria-label={label} className="flex p-0.5 rounded-[10px] bg-secondary">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={value === o.id}
          onClick={() => onChange(o.id)}
          className={`flex-1 h-8 rounded-lg text-[13px] font-semibold whitespace-nowrap transition ${
            value === o.id ? "bg-card text-ink shadow-sm" : "text-mute"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function SectionHeader({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-2.5">
      <h2 className={sectionLabel}>{children}</h2>
      {action}
    </div>
  )
}
