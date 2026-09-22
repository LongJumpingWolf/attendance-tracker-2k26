"use client"

import { Check, X } from "@phosphor-icons/react"
import { DAY_LETTERS, localDate } from "@/lib/attendance"
import type { Mate, Subject } from "@/lib/types"

/** The last seven days, ending today: a green tick for a day you showed up, a red cross for a day you missed, a dot when nothing was marked */
export function WeekStrip({ subjects, now }: { subjects: Subject[]; now: Date }) {
  const days = Array.from({ length: 7 }, (_, k) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - k))
    const key = localDate(d)
    let p = 0
    let a = 0
    for (const s of subjects) for (const e of s.log ?? []) if (e.d === key) e.s === "P" ? p++ : a++
    // A day counts as attended or missed by whichever happened more (a tie counts as attended)
    return { letter: DAY_LETTERS[d.getDay()], state: p === 0 && a === 0 ? "none" : p >= a ? "p" : "a", today: k === 6 }
  })
  const label = (d: (typeof days)[number]) => (d.state === "p" ? "attended" : d.state === "a" ? "missed" : "nothing marked")

  return (
    <section aria-label="Last 7 days">
      <h2 className="text-[12px] font-medium uppercase tracking-wider text-mute mb-2.5">Last 7 days</h2>
      <ul className="flex justify-between rounded-2xl bg-card px-4 py-3.5">
        {days.map((d, i) => (
          <li key={i} className="grid justify-items-center gap-1.5 text-[12px] font-semibold text-mute" aria-label={`${d.today ? "Today" : d.letter}: ${label(d)}`}>
            <span
              className={`w-[30px] h-[30px] rounded-full grid place-items-center ${
                d.state === "p" ? "bg-good text-paper" : d.state === "a" ? "bg-bad text-paper" : "bg-secondary text-mute"
              } ${d.today ? "ring-2 ring-ink ring-offset-2 ring-offset-card" : ""}`}
            >
              {d.state === "p" ? <Check weight="bold" className="w-3.5 h-3.5" /> : d.state === "a" ? <X weight="bold" className="w-3.5 h-3.5" /> : <span className="w-1 h-1 rounded-full bg-mute" />}
            </span>
            {d.letter}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** "Zoe covered you 2 times this week", when a mate has. Tapping it opens Mates. */
export function MateNote({ mates, now, onOpen }: { mates: Mate[]; now: Date; onOpen: () => void }) {
  const since = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6))
  const counts = mates
    .map((m) => ({ m, n: (m.coveredLog ?? []).filter((d) => d >= since).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
  if (counts.length === 0) return null
  const top = counts[0]
  const owe = Math.max(0, top.m.covered - top.m.repaid)
  const total = counts.reduce((n, x) => n + x.n, 0)
  return (
    <button onClick={onOpen} className="w-full flex items-center gap-3.5 rounded-2xl bg-card p-4 text-left">
      <span className="w-11 h-11 rounded-full bg-secondary grid place-items-center text-[17px] font-bold flex-shrink-0">{(top.m.name.trim()[0] ?? "?").toUpperCase()}</span>
      <span className="min-w-0 text-[14px] text-mute leading-snug">
        <span className="block text-[15px] font-semibold text-ink">
          {counts.length === 1 ? `${top.m.name} covered you ${top.n} ${top.n === 1 ? "time" : "times"} this week.` : `${total} covers from ${counts.length} mates this week.`}
        </span>
        {owe > 0 ? `You owe ${top.m.name} ${owe} ${owe === 1 ? "favour" : "favours"}. A treat, maybe?` : "All squared up. Nice."}
      </span>
    </button>
  )
}
