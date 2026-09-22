"use client"

import { useEffect, useState } from "react"
import { House, SquaresFour, CalendarBlank, UsersThree } from "@phosphor-icons/react"

/** A mate covered for you while you were away. `key` changes each time a new cover arrives. */
export interface CoverNotice {
  key: string
  initial: string
  text: string
}

interface BottomNavProps {
  currentPage: string
  onPageChange: (page: string) => void
  /** Small red counts on a tab, e.g. pending mate requests */
  badges?: Record<string, number>
  /** When set, a short speech bubble pops up above the Mates tab */
  cover?: CoverNotice | null
}

const ITEMS = [
  { id: "today", label: "Today", Icon: House },
  { id: "subjects", label: "Subjects", Icon: SquaresFour },
  { id: "calendar", label: "Calendar", Icon: CalendarBlank },
  { id: "mates", label: "Mates", Icon: UsersThree },
]

/** iOS-style tab bar: same icon size everywhere, filled icon + white label for the active tab. */
export default function BottomNav({ currentPage, onPageChange, badges = {}, cover = null }: BottomNavProps) {
  const active = currentPage

  // The bubble plays once per cover, then goes; the red badge on the tab is what stays.
  const [bubble, setBubble] = useState<CoverNotice | null>(null)
  const coverKey = cover?.key
  const coverText = cover?.text
  const coverInitial = cover?.initial
  useEffect(() => {
    if (coverKey === undefined || coverText === undefined || coverInitial === undefined) {
      setBubble(null)
      return
    }
    setBubble({ key: coverKey, text: coverText, initial: coverInitial })
    const timer = setTimeout(() => setBubble(null), 4600)
    return () => clearTimeout(timer)
  }, [coverKey, coverText, coverInitial])

  return (
    <nav
      aria-label="Main"
      className="fixed bottom-0 inset-x-0 z-40 bg-paper/90 backdrop-blur-xl border-t border-ink/[0.08] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] lg:inset-x-auto lg:inset-y-0 lg:left-0 lg:w-[88px] lg:border-t-0 lg:border-r lg:pb-0 lg:pr-0"
    >
      <div className="w-full max-w-3xl mx-auto grid grid-cols-4 pt-2 pb-2 px-4 sm:px-6 lg:max-w-none lg:grid-cols-1 lg:content-start lg:gap-1.5 lg:px-3 lg:pt-8 lg:pb-0">
        {ITEMS.map(({ id, label, Icon }) => {
          const on = active === id
          const badge = badges[id] ?? 0
          const showBubble = id === "mates" && bubble !== null
          return (
            <button
              key={id}
              onClick={() => onPageChange(id)}
              aria-current={on ? "page" : undefined}
              className={`nav-item relative flex flex-col items-center justify-center gap-1 h-[54px] transition lg:h-[68px] lg:rounded-2xl lg:hover:bg-ink/[0.06] ${on ? "text-ink lg:bg-ink/[0.07]" : "text-mute"}`}
            >
              <span className={`relative ${showBubble ? "cover-wiggle" : ""}`}>
                <Icon weight={on ? "fill" : "regular"} className="w-6 h-6" />
                {badge > 0 && (
                  <span
                    aria-label={`${badge} new`}
                    className="absolute -top-1.5 -right-2.5 min-w-[17px] h-[17px] px-1 rounded-full bg-bad text-paper text-[11px] font-bold grid place-items-center leading-none"
                  >
                    {badge}
                  </span>
                )}
              </span>
              <span className="text-[11px] font-medium">{label}</span>
              {showBubble && bubble && (
                <span
                  key={bubble.key}
                  role="status"
                  className="cover-bubble pointer-events-none absolute inset-x-0 bottom-full h-0 lg:inset-x-auto lg:bottom-auto lg:left-full lg:top-1/2 lg:w-0"
                >
                  <span className="absolute right-0 bottom-3.5 flex items-center gap-2 whitespace-nowrap rounded-2xl bg-ink py-1.5 pl-1.5 pr-3 text-[12px] font-semibold text-paper shadow-lg lg:right-auto lg:left-3 lg:bottom-auto lg:top-0 lg:-translate-y-1/2">
                    <span className="grid h-6 w-6 place-items-center rounded-full bg-paper text-[12px] font-bold text-ink">
                      {bubble.initial}
                    </span>
                    {bubble.text}
                  </span>
                  <span className="absolute bottom-[9px] left-1/2 -ml-1.5 h-3 w-3 rotate-45 rounded-[2px] bg-ink lg:bottom-auto lg:left-[6px] lg:top-0 lg:ml-0 lg:-mt-1.5" />
                </span>
              )}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
