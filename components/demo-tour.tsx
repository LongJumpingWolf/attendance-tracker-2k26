"use client"

import { useEffect, useRef, useState } from "react"
import { CaretLeft, X } from "@phosphor-icons/react"
import { useScrollLock } from "@/lib/use-scroll-lock"

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

interface Props {
  open: boolean
  onGoto: (page: string) => void
  onOpenWrapped: () => void
  onEnd: () => void
}

/**
 * A guided, forced walkthrough over the demo data: it drives the tabs itself and spotlights one real part of the
 * screen per step, so the tour is a tour of the actual app, not a set of screenshots. The backdrop is inert —
 * only the caption's own controls move it along — so it reads as a tour, not just a highlight on a page you can
 * still wander off from.
 */
export default function DemoTour({ open, onGoto, onOpenWrapped, onEnd }: Props) {
  const [i, setI] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const frames = useRef<number[]>([])

  useScrollLock(open)

  useEffect(() => {
    if (open) setI(0)
  }, [open])

  const step = STEPS[i]

  useEffect(() => {
    if (!open) return
    onGoto(step.page)
    frames.current.forEach(cancelAnimationFrame)
    frames.current = []

    const measure = () => {
      const el = step.selector ? document.querySelector<HTMLElement>(`[data-tour="${step.selector}"]`) : null
      if (!el) return setRect(null)
      el.scrollIntoView({ block: "center", behavior: "auto" })
      const a = requestAnimationFrame(() => {
        const b = requestAnimationFrame(() => setRect(el.getBoundingClientRect()))
        frames.current.push(b)
      })
      frames.current.push(a)
    }
    // Two frames give the page-switch above time to render before anything is measured
    const a = requestAnimationFrame(() => {
      const b = requestAnimationFrame(measure)
      frames.current.push(b)
    })
    frames.current.push(a)

    window.addEventListener("resize", measure)
    return () => {
      frames.current.forEach(cancelAnimationFrame)
      window.removeEventListener("resize", measure)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, i])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onEnd()
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, onEnd])

  if (!open) return null
  const last = i === STEPS.length - 1
  const pad = 10

  return (
    <div role="dialog" aria-modal="true" aria-label="Demo tour" className="fixed inset-0 z-[75]">
      {/* Dims the whole screen; has no click handler of its own, so tapping the app underneath does nothing */}
      <div className="absolute inset-0 bg-black/55 transition-opacity" aria-hidden />

      {rect && (
        <div
          aria-hidden
          className="absolute rounded-2xl ring-2 ring-white/90 pointer-events-none transition-[top,left,width,height] duration-300 ease-out"
          style={{
            top: rect.top - pad,
            left: rect.left - pad,
            width: rect.width + pad * 2,
            height: rect.height + pad * 2,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        />
      )}

      <div className="absolute inset-x-0 bottom-0 px-4 pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <div className="mx-auto max-w-md rounded-[28px] bg-paper p-5 shadow-2xl">
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
