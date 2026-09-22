"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { X, Fire, ShareNetwork } from "@phosphor-icons/react"
import type { Mate } from "@/lib/types"
import { computeWrapped, type WrappedData } from "@/lib/wrapped"
import { renderWrappedImage, shareImage } from "@/lib/wrapped-image"
import { useScrollLock } from "@/lib/use-scroll-lock"

interface Props {
  open: boolean
  onClose: () => void
  subjects: Parameters<typeof computeWrapped>[0]
  mates: Mate[]
  onRepay: (id: string) => void
}

const SLIDE_MS = 5500

/** Every stop is dark enough for white text (contrast 5:1 or better) */
const GRADIENTS = [
  "linear-gradient(160deg,#3730a3 0%,#86198f 60%,#9f1239 100%)",
  "linear-gradient(160deg,#065f46 0%,#166534 100%)",
  "linear-gradient(160deg,#1e3a8a 0%,#0e7490 100%)",
  "linear-gradient(160deg,#9a3412 0%,#9f1239 100%)",
  "linear-gradient(160deg,#5b21b6 0%,#a21caf 100%)",
  "linear-gradient(160deg,#92400e 0%,#a16207 100%)",
  "linear-gradient(160deg,#111827 0%,#312e81 100%)",
]

/** Counts from 0 up to `target` once, easing out */
function useCountUp(target: number, ms = 1300) {
  const [n, setN] = useState(0)
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setN(target)
    let raf = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / ms)
      setN(Math.round(target * (1 - Math.pow(1 - k, 3))))
      if (k < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return n
}

const owedOf = (m: Mate) => Math.max(0, m.covered - m.repaid)

function Big({ value, suffix }: { value: number; suffix?: string }) {
  const n = useCountUp(value)
  return (
    <span className="wrap-pop num block text-[132px] leading-none font-black tracking-[-0.06em]" style={{ animationDelay: "0.25s" }}>
      {n}
      {suffix && <span className="text-[56px] tracking-tight">{suffix}</span>}
    </span>
  )
}

const Kicker = ({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) => (
  <p className="wrap-rise text-[19px] font-semibold opacity-90" style={{ animationDelay: `${delay}s` }}>
    {children}
  </p>
)

const Line = ({ children, delay = 0.9 }: { children: React.ReactNode; delay?: number }) => (
  <p className="wrap-rise mt-5 text-[19px] font-semibold leading-snug max-w-[18rem] opacity-90" style={{ animationDelay: `${delay}s` }}>
    {children}
  </p>
)

type SlideDef = { id: string; last?: boolean; node: (d: WrappedData, mates: Mate[], onRepay: (id: string) => void, onClose: () => void) => React.ReactNode }

function buildSlides(d: WrappedData): SlideDef[] {
  const slides: SlideDef[] = [
    {
      id: "intro",
      node: (data) => (
        <>
          <Kicker>{data.isCurrent ? "This week so far" : "Last week"} · {data.rangeLabel}</Kicker>
          <h2 className="wrap-pop text-[76px] leading-[0.95] font-black tracking-[-0.03em] mt-2" style={{ animationDelay: "0.2s" }}>
            wrapped.
          </h2>
          <Line delay={0.8}>{data.attended + data.missed === 0 ? "A quiet one. Nothing was marked." : "Here's how you showed up."}</Line>
        </>
      ),
    },
  ]
  if (d.attended > 0)
    slides.push({
      id: "attended",
      node: (data) => (
        <>
          <Kicker>You showed up</Kicker>
          <Big value={data.attended} />
          <Kicker delay={0.6}>{data.attended === 1 ? "time" : "times"} this week</Kicker>
          {data.pct !== null && <Line>That&rsquo;s {data.pct}% of the classes you marked.</Line>}
        </>
      ),
    })
  if (d.best)
    slides.push({
      id: "best",
      node: (data) => (
        <>
          <Kicker>Your best subject</Kicker>
          <h2 className="wrap-pop text-[52px] leading-[1.02] font-black tracking-[-0.04em] mt-3 break-words" style={{ animationDelay: "0.25s" }}>
            {data.best!.name}
          </h2>
          <Line>
            {data.best!.pct}% across {data.best!.classes} classes.
          </Line>
          {data.weakest && (
            <Line delay={1.3}>
              Keep an eye on {data.weakest.name}: {data.weakest.pct}%.
            </Line>
          )}
        </>
      ),
    })
  if (d.streak >= 2)
    slides.push({
      id: "streak",
      node: (data) => (
        <>
          <Fire weight="fill" className="wrap-pop w-14 h-14 mb-2" />
          <Kicker>Longest streak</Kicker>
          <Big value={data.streak} />
          <Line delay={0.7}>classes in a row without missing one.</Line>
        </>
      ),
    })
  if (d.attended > 0 && d.missed === 0)
    slides.push({
      id: "perfect",
      node: () => (
        <>
          <Kicker>Zero absences</Kicker>
          <h2 className="wrap-pop text-[64px] leading-[0.98] font-black tracking-[-0.05em] mt-3" style={{ animationDelay: "0.25s" }}>
            Perfect week.
          </h2>
          <Line>Not a single class missed.</Line>
        </>
      ),
    })
  else if (d.missed > 0)
    slides.push({
      id: "missed",
      node: (data) => (
        <>
          <Kicker>You skipped</Kicker>
          <Big value={data.missed} />
          <Kicker delay={0.6}>{data.missed === 1 ? "class" : "classes"}</Kicker>
          <Line>{data.pct !== null && data.pct >= 75 ? "Still comfortably in the safe zone." : "Worth turning around next week."}</Line>
        </>
      ),
    })
  if (d.coverHero)
    slides.push({
      id: "hero",
      node: (data) => (
        <>
          <Kicker>Proxy-mate of the week</Kicker>
          <span
            className="wrap-pop mt-5 grid place-items-center w-36 h-36 rounded-full bg-[#ffffff] text-[#000000] text-[68px] font-black"
            style={{ animationDelay: "0.25s" }}
          >
            {(data.coverHero!.name.trim()[0] ?? "?").toUpperCase()}
          </span>
          <h2 className="wrap-rise text-[44px] leading-none font-black tracking-[-0.04em] mt-5 break-words" style={{ animationDelay: "0.6s" }}>
            {data.coverHero!.name}
          </h2>
          <Line delay={0.9}>
            covered you {data.coverHero!.count} {data.coverHero!.count === 1 ? "time" : "times"}.
          </Line>
        </>
      ),
    })
  slides.push({
    id: "settle",
    last: true,
    node: (_d, mates, onRepay, onClose) => {
      const owing = mates.filter((m) => owedOf(m) > 0)
      const total = owing.reduce((n, m) => n + owedOf(m), 0)
      return (
        <>
          <Kicker>Time to settle up</Kicker>
          {total === 0 ? (
            <>
              <h2 className="wrap-pop text-[64px] leading-[0.98] font-black tracking-[-0.05em] mt-3" style={{ animationDelay: "0.25s" }}>
                All square.
              </h2>
              <Line>Nobody is waiting on a favour from you.</Line>
            </>
          ) : (
            <>
              <h2 className="wrap-pop text-[48px] leading-[1] font-black tracking-[-0.045em] mt-3" style={{ animationDelay: "0.25s" }}>
                You owe {total} {total === 1 ? "favour" : "favours"}.
              </h2>
              <ul className="w-full max-w-xs mt-6 space-y-2.5">
                {owing.map((m, i) => (
                  <li
                    key={m.id}
                    className="wrap-rise flex items-center gap-3 rounded-2xl bg-[#ffffff]/15 backdrop-blur px-3.5 py-2.5 text-left"
                    style={{ animationDelay: `${0.6 + i * 0.12}s` }}
                  >
                    <span className="w-9 h-9 rounded-full bg-[#ffffff] text-[#000000] grid place-items-center font-black flex-shrink-0">
                      {(m.name.trim()[0] ?? "?").toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[16px] font-bold truncate">{m.name}</span>
                      <span className="block text-[13px] opacity-75">
                        {owedOf(m)} to repay
                      </span>
                    </span>
                    <button
                      onClick={() => onRepay(m.id)}
                      className="h-9 px-3.5 rounded-full bg-[#ffffff] text-[#000000] text-[13px] font-bold"
                    >
                      Repaid
                    </button>
                  </li>
                ))}
              </ul>
              <Line delay={1}>A treat, a party, notes. Then tap Repaid.</Line>
            </>
          )}
          <button
            onClick={onClose}
            className="wrap-rise mt-7 h-12 px-8 rounded-full bg-[#ffffff] text-[#000000] text-[16px] font-bold"
            style={{ animationDelay: "1.1s" }}
          >
            Done
          </button>
        </>
      )
    },
  })
  return slides
}

export default function WrappedStory({ open, onClose, subjects, mates, onRepay }: Props) {
  const data = useMemo(() => (open ? computeWrapped(subjects, mates) : null), [open, subjects, mates])
  const slides = useMemo(() => (data ? buildSlides(data) : []), [data])
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const down = useRef<{ t: number; x: number } | null>(null)
  useScrollLock(open)
  const [sharing, setSharing] = useState<"idle" | "working" | "saved">("idle")

  useEffect(() => {
    if (open) {
      setIndex(0)
      setPaused(false)
      setSharing("idle")
    }
  }, [open])

  const go = useCallback(
    (to: number) => {
      if (to < 0) return setIndex(0)
      // The last slide only closes through Done, X or Escape. Closing from a tap would let the same
      // tap land on whatever is under the story once it disappears.
      if (to >= slides.length) return
      setIndex(to)
    },
    [slides.length],
  )

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
      if (e.key === "ArrowRight") go(index + 1)
      if (e.key === "ArrowLeft") go(index - 1)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open, index, go, onClose])

  const share = async () => {
    if (!data || sharing === "working") return
    setPaused(true)
    setSharing("working")
    try {
      const blob = await renderWrappedImage(data)
      const result = await shareImage(blob, `week-wrapped-${data.rangeLabel.replace(/[^0-9A-Za-z]+/g, "-")}.png`)
      setSharing(result === "saved" ? "saved" : "idle")
    } catch {
      setSharing("idle")
    } finally {
      setPaused(false)
    }
  }

  if (!open || !data || slides.length === 0) return null
  const slide = slides[Math.min(index, slides.length - 1)]

  return (
    // Phones: the story fills the screen. Bigger screens: a story-shaped frame in the middle, dimmed page around it.
    <div
      className="fixed inset-0 z-[70] sm:grid sm:place-items-center sm:bg-black/85 sm:backdrop-blur-sm"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Your week wrapped, ${data.rangeLabel}`}
      className="relative h-full w-full overflow-hidden text-[#ffffff] select-none sm:h-[min(calc(100dvh-2rem),900px)] sm:max-w-[460px] sm:rounded-[36px] sm:shadow-2xl"
      style={{ background: GRADIENTS[index % GRADIENTS.length], transition: "background 0.4s" }}
    >
      {/* drifting colour blobs */}
      <span className="wrap-blob absolute -top-24 -left-20 w-72 h-72 rounded-full bg-[#ffffff]/15 blur-2xl" />
      <span className="wrap-blob absolute bottom-10 -right-24 w-80 h-80 rounded-full bg-black/15 blur-2xl" style={{ animationDelay: "-4s" }} />

      {/* progress bars */}
      <div className="absolute top-0 inset-x-0 z-10 flex gap-1.5 px-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
        {slides.map((s, i) => (
          <span key={s.id} className="h-1 flex-1 rounded-full bg-[#ffffff]/30 overflow-hidden">
            <span
              key={i === index ? `run-${index}` : `idle-${i}`}
              className="block h-full bg-[#ffffff]"
              style={
                i < index || (i === index && slide.last)
                  ? { width: "100%" }
                  : i === index
                    ? { animation: `wrap-bar ${SLIDE_MS}ms linear forwards`, animationPlayState: paused ? "paused" : "running" }
                    : { width: 0 }
              }
              onAnimationEnd={() => i === index && go(index + 1)}
            />
          </span>
        ))}
      </div>

      <div className="absolute z-20 right-3 top-[calc(1.6rem+env(safe-area-inset-top))] flex items-center gap-2">
        <button
          onClick={share}
          disabled={sharing === "working"}
          aria-label="Share as an image"
          className="h-9 px-3.5 rounded-full bg-black/25 flex items-center gap-1.5 text-[13px] font-semibold disabled:opacity-60"
        >
          <ShareNetwork weight="bold" className="w-4 h-4" />
          {sharing === "working" ? "Making…" : sharing === "saved" ? "Saved" : "Share"}
        </button>
        <button onClick={onClose} aria-label="Close" className="w-9 h-9 rounded-full bg-black/25 grid place-items-center">
          <X weight="bold" className="w-4 h-4" />
        </button>
      </div>

      {/* tap left = back, tap right = next, hold = pause */}
      <div
        className="absolute inset-0"
        onPointerDown={(e) => {
          down.current = { t: Date.now(), x: e.clientX }
          setPaused(true)
        }}
        onPointerUp={(e) => {
          setPaused(false)
          const d = down.current
          down.current = null
          if (!d || Date.now() - d.t > 250) return
          // the left third of the story goes back, the rest goes on (measured on the story, not the whole window)
          const box = e.currentTarget.getBoundingClientRect()
          go(e.clientX - box.left < box.width / 3 ? index - 1 : index + 1)
        }}
        onPointerCancel={() => setPaused(false)}
        onPointerLeave={() => setPaused(false)}
      />

      <div
        key={slide.id}
        className="relative z-10 h-full flex flex-col items-center justify-center text-center px-8 pointer-events-none [&_button]:pointer-events-auto [&_li]:pointer-events-auto"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {slide.node(data, mates, onRepay, onClose)}
      </div>
    </div>
    </div>
  )
}
