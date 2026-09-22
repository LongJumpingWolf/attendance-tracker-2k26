"use client"

import { useEffect, useRef, useState } from "react"
import { CaretLeft, X } from "@phosphor-icons/react"

interface Step {
  page: "today" | "subjects" | "calendar" | "mates"
  /** data-tour value of the element to spotlight, or null for an intro/closing card with no target */
  selector: string | null
  title: string
  body: string
}

const STEPS: Step[] = [
  {
    page: "today",
    selector: null,
    title: "Welcome to the demo",
    body: "This is what the app looks like after a few weeks of real use — sample subjects, deadlines and mates. Nothing here is real, and you can exit any time.",
  },
  {
    page: "today",
    selector: "today-strip",
    title: "Your day at a glance",
    body: "Every class today, in order. Tap one to jump straight to it below, without hunting for it.",
  },
  {
    page: "today",
    selector: "today-carousel",
    title: "Mark as you go",
    body: "Swipe between today's classes. One's ended without a mark, one's happening right now, one's still ahead — the app always knows which is which.",
  },
  {
    page: "subjects",
    selector: "subjects-list",
    title: "Every subject, one place",
    body: "Attendance percentage, colour-coded by how safe you are. Switch to the tag or timetable view with the icons above.",
  },
  {
    page: "calendar",
    selector: "calendar-day",
    title: "Deadlines that don't hide",
    body: "Exams and assignments sit right next to your classes for the day, not in a separate list you forget to check.",
  },
  {
    page: "mates",
    selector: "mates-leaderboard",
    title: "Proxy-mates",
    body: "Friends who mark you present when you can't make it. Ping one to ask if they covered you, and the favour is logged automatically.",
  },
  {
    page: "mates",
    selector: "mates-wrapped",
    title: "Your week, wrapped",
    body: "Every Monday, a quick recap: your best subject, your longest streak, who covered you. Let's take a look.",
  },
]

/** Class toggled directly on the real target element — see the `.demo-tour-spot` rule in globals.css */
const SPOT_CLASS = "demo-tour-spot"
/** The fixed "Viewing demo data" bar (app/page.tsx), so its real on-screen height can be read rather than guessed */
const TOPBAR_SELECTOR = "[data-tour-topbar]"
const MARGIN = 16

interface Props {
  open: boolean
  onGoto: (page: string) => void
  onOpenWrapped: () => void
  onEnd: () => void
}

/**
 * A guided, forced walkthrough over the demo data: it drives the tabs itself and highlights one real part of the
 * screen per step, so the tour is a tour of the actual app, not a set of screenshots.
 *
 * Two things this has to get right, on any phone, at any point in a long scrolling page:
 *  1. The highlight is a class put directly on the real element (an outline plus a brightness lift), not a
 *     floating copy guessing its position — so it can never drift out of sync with what's actually on screen.
 *  2. The caption card at the bottom of the screen, and the "Viewing demo data" bar at the top, both cover real
 *     screen space throughout the tour. The page is deliberately left free to scroll (nothing here locks it), and
 *     each step scrolls the page itself so the highlighted element lands in whatever room is left between the two
 *     — never behind either of them — reading their real, current heights rather than assuming fixed numbers.
 */
export default function DemoTour({ open, onGoto, onOpenWrapped, onEnd }: Props) {
  const [i, setI] = useState(0)
  const target = useRef<HTMLElement | null>(null)
  const frames = useRef<number[]>([])
  const captionRef = useRef<HTMLDivElement>(null)
  const [captionH, setCaptionH] = useState(0)

  const unspot = () => {
    target.current?.classList.remove(SPOT_CLASS)
    target.current = null
  }

  useEffect(() => {
    if (open) setI(0)
    else unspot()
  }, [open])

  // The caption's height changes a little from step to step (some are one line longer than others); this tracks
  // its real, current height rather than assuming one number
  useEffect(() => {
    if (!open || !captionRef.current) return
    const el = captionRef.current
    const ro = new ResizeObserver(() => setCaptionH(el.offsetHeight))
    ro.observe(el)
    setCaptionH(el.offsetHeight)
    return () => ro.disconnect()
  }, [open])

  // While the tour is open, the page can always be scrolled far enough to clear the caption card — including for
  // something that sits near the very bottom of a page, which would otherwise have nowhere left to scroll to.
  // Measured as "everything from the caption's real top edge down to the true bottom of the screen", so it already
  // includes whatever safe-area padding sits below the caption, rather than assuming a number for it.
  useEffect(() => {
    if (!open) return
    const captionTop = captionRef.current?.getBoundingClientRect().top ?? window.innerHeight
    const reserve = window.innerHeight - captionTop + MARGIN
    const prev = document.body.style.paddingBottom
    document.body.style.paddingBottom = `${reserve}px`
    return () => {
      document.body.style.paddingBottom = prev
    }
  }, [open, captionH])

  const step = STEPS[i]

  /** Scrolls the page so `el` sits centred in whatever room is left between the top bar and the caption card, or,
   *  if it's taller than that, at least starts just clear of the top bar rather than ending up behind either */
  const position = (el: HTMLElement) => {
    // Read the top bar's and the caption's own real, current edges — both already account for their own CSS
    // (padding, safe-area insets) correctly; reconstructing those edges from a height and a viewport size instead
    // is exactly how this went wrong the first time, silently dropping the safe-area amount baked into their padding.
    const topReserve = (document.querySelector<HTMLElement>(TOPBAR_SELECTOR)?.getBoundingClientRect().bottom ?? 0) + MARGIN
    const bottomBoundary = (captionRef.current?.getBoundingClientRect().top ?? window.innerHeight) - MARGIN
    const safeHeight = Math.max(120, bottomBoundary - topReserve)
    const rect = el.getBoundingClientRect()
    const desiredTop = rect.height <= safeHeight ? topReserve + (safeHeight - rect.height) / 2 : topReserve
    const delta = rect.top - desiredTop
    if (Math.abs(delta) > 1) window.scrollBy({ top: delta, left: 0, behavior: "auto" })
  }

  useEffect(() => {
    if (!open) return
    onGoto(step.page)
    unspot()
    frames.current.forEach(cancelAnimationFrame)
    frames.current = []

    // Two frames give the page-switch above time to render before anything is measured or scrolled
    const a = requestAnimationFrame(() => {
      const b = requestAnimationFrame(() => {
        const el = step.selector ? document.querySelector<HTMLElement>(`[data-tour="${step.selector}"]`) : null
        if (!el) return
        el.classList.add(SPOT_CLASS)
        target.current = el
        position(el)
      })
      frames.current.push(b)
    })
    frames.current.push(a)

    const onResize = () => target.current && position(target.current)
    window.addEventListener("resize", onResize)
    return () => {
      frames.current.forEach(cancelAnimationFrame)
      window.removeEventListener("resize", onResize)
      unspot()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i])

  // The caption growing or shrinking (a longer line wrapping, a font finishing loading) can shift how much room is
  // left; re-settle the current target against its latest height rather than leaving it slightly off
  useEffect(() => {
    if (open && target.current) position(target.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [captionH])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEnd()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onEnd])

  if (!open) return null
  const last = i === STEPS.length - 1

  return (
    <div role="dialog" aria-modal="true" aria-label="Demo tour" className="fixed inset-0 z-[75]">
      {/* Invisible — the real app is inert underneath (a tap here does nothing) — but a vertical drag is still let
          through as an ordinary scroll, so the odd step whose content is genuinely taller than the room between the
          top bar and the caption can still be read in full by scrolling, rather than being force-fitted or cut off */}
      <div className="absolute inset-0 pointer-events-auto touch-pan-y" aria-hidden />

      <div className="absolute inset-x-0 bottom-0 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <div ref={captionRef} className="mx-auto max-w-md rounded-[28px] bg-paper p-5 shadow-2xl">
          <div className="flex items-center justify-between">
            <span className="num text-[12px] font-semibold text-mute">
              {i + 1} / {STEPS.length}
            </span>
            <button onClick={onEnd} aria-label="End tour" className="w-8 h-8 -mr-1.5 grid place-items-center rounded-full text-mute">
              <X weight="bold" className="w-4 h-4" />
            </button>
          </div>
          <h2 className="font-display text-[22px] leading-[1.15] mt-2">{step.title}</h2>
          <p className="text-[14.5px] text-mute mt-1.5 leading-snug">{step.body}</p>

          <div className="flex items-center gap-2.5 mt-5">
            {i > 0 && (
              <button onClick={() => setI((n) => n - 1)} aria-label="Back" className="w-11 h-11 rounded-2xl bg-card grid place-items-center flex-shrink-0">
                <CaretLeft weight="bold" className="w-4 h-4" />
              </button>
            )}
            <button
              onClick={() => {
                if (last) {
                  onOpenWrapped()
                  onEnd()
                } else {
                  setI((n) => n + 1)
                }
              }}
              className="flex-1 h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold hover:bg-ink/90 transition"
            >
              {last ? "See your Wrapped" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
