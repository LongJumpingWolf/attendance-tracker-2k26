"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { DotsThreeVertical, ArrowsLeftRight, MoonStars } from "@phosphor-icons/react"
import type { Subject } from "@/lib/types"

export interface ClassActionTarget {
  subjectId: string
  date: string
  slot: { day: number; start: string; end: string; kind?: string }
  subjectName?: string
  intent?: "replace" | "cancel"
}

type MenuPosition = { top: number; left: number; placement: "above" | "below" }

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
  const [position, setPosition] = useState<MenuPosition | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current
    if (!trigger || typeof window === "undefined") return
    const rect = trigger.getBoundingClientRect()
    // The menu is portalled to document.body, so card/carousel overflow cannot clip it.
    const menuWidth = Math.min(240, window.innerWidth - 24)
    const menuHeight = menuRef.current?.getBoundingClientRect().height ?? (onSleep ? 104 : 64)
    const gap = 8
    const spaceBelow = window.innerHeight - rect.bottom
    const spaceAbove = rect.top
    const placement = spaceBelow >= menuHeight + gap || spaceBelow >= spaceAbove ? "below" : "above"
    const unclampedLeft = rect.right - menuWidth
    const left = Math.max(12, Math.min(unclampedLeft, window.innerWidth - menuWidth - 12))
    const top = placement === "below"
      ? Math.min(window.innerHeight - menuHeight - 12, rect.bottom + gap)
      : Math.max(12, rect.top - menuHeight - gap)
    setPosition({ top, left, placement })
  }, [onSleep])

  const toggle = () => {
    if (open) {
      setOpen(false)
      setPosition(null)
      return
    }
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    updatePosition()
    const reposition = () => updatePosition()
    window.addEventListener("resize", reposition)
    // Capture scroll events from nested scrollers as well as the window.
    window.addEventListener("scroll", reposition, true)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false)
        setPosition(null)
        triggerRef.current?.focus()
      }
    }
    document.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("resize", reposition)
      window.removeEventListener("scroll", reposition, true)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open, updatePosition])

  const close = () => {
    setOpen(false)
    setPosition(null)
  }
  const button = "w-full min-h-11 flex items-center gap-3 rounded-xl px-3 text-left text-[14px] font-semibold hover:bg-secondary active:scale-[0.99]"

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={toggle}
        aria-label={`More options for ${subject.name}`}
        aria-expanded={open}
        aria-haspopup="menu"
        className="w-9 h-9 grid place-items-center rounded-full bg-secondary/90 text-ink border border-ink/10"
      >
        <DotsThreeVertical weight="bold" className="w-5 h-5" />
      </button>
      {open && typeof document !== "undefined" && createPortal(
        <>
          <button
            type="button"
            aria-label="Close options"
            className="fixed inset-0 z-[89] cursor-default"
            onClick={close}
          />
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Actions for ${subject.name}`}
            className="fixed z-[90] w-[min(15rem,calc(100vw-1.5rem))] rounded-2xl border border-ink/10 bg-card p-2 shadow-xl"
            style={position ? { top: position.top, left: position.left, visibility: "visible" } : { top: 0, left: 0, visibility: "hidden" }}
          >
            {target && (onReplace || onCancel) && (
              <button
                type="button"
                role="menuitem"
                className={button}
                onClick={() => {
                  close()
                  const openChange = onReplace ?? onCancel
                  openChange?.({ ...target, intent: undefined })
                }}
              >
                <ArrowsLeftRight className="w-4 h-4 text-info" />
                Replace / cancel lecture…
              </button>
            )}
            {onSleep && (
              <button
                type="button"
                role="menuitem"
                className={button}
                onClick={() => { close(); onSleep(subject) }}
              >
                <MoonStars className="w-4 h-4 text-mute" />
                {subject.sleeping && (subject.sleepUntil === "forever" || !subject.sleepUntil || subject.sleepUntil >= new Date().toISOString().slice(0, 10)) ? "Manage / wake subject" : "Put subject to sleep"}
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
