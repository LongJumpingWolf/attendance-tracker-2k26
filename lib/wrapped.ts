import type { Mate, Subject } from "./types"
import { localDate } from "./attendance"

/** Everything the weekly "wrapped" story shows. A field is null/0 when there isn't enough data for it. */
export interface WrappedData {
  /** e.g. "Sep 8 – 14" */
  rangeLabel: string
  /** true when showing the week in progress because last week has no marks */
  isCurrent: boolean
  attended: number
  missed: number
  /** Share of this week's marked classes you attended, 0-100 */
  pct: number | null
  best: { name: string; pct: number; classes: number } | null
  /** Only set when it differs from `best` and is clearly lower */
  weakest: { name: string; pct: number } | null
  /** Longest run of attended classes with no absence in between */
  streak: number
  coverHero: { name: string; count: number } | null
  coversTotal: number
}

const MIN_CLASSES = 3

/** Monday-to-Sunday week that is `back` weeks before the one containing `now` */
function weekRange(now: Date, back: number) {
  const offset = (now.getDay() + 6) % 7 // days since Monday
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset - 7 * back)
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 6)
  return { start: localDate(start), end: localDate(end), startDate: start, endDate: end }
}

const inRange = (d: string, r: { start: string; end: string }) => d >= r.start && d <= r.end

const marksIn = (subjects: Subject[], r: { start: string; end: string }) =>
  subjects.reduce((n, s) => n + (s.log ?? []).filter((e) => inRange(e.d, r)).length, 0)

/** The last finished week: its id (the Monday it started) and whether you marked anything in it */
export function lastWeekInfo(subjects: Subject[], now: Date = new Date()) {
  const r = weekRange(now, 1)
  return { key: r.start, hasData: marksIn(subjects, r) > 0 }
}

const short = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" })

export function computeWrapped(subjects: Subject[], mates: Mate[], now: Date = new Date()): WrappedData {
  // Last week, unless it's empty and this week already has marks
  const last = weekRange(now, 1)
  const cur = weekRange(now, 0)
  const isCurrent = marksIn(subjects, last) === 0 && marksIn(subjects, cur) > 0
  const range = isCurrent ? cur : last

  let attended = 0
  let missed = 0
  const perSubject: { name: string; p: number; a: number }[] = []
  const timeline: { d: string; t: string; s: "P" | "A" }[] = []

  for (const s of subjects) {
    let p = 0
    let a = 0
    for (const e of s.log ?? []) {
      if (!inRange(e.d, range)) continue
      if (e.s === "P") p++
      else a++
      timeline.push({ d: e.d, t: e.t ?? "", s: e.s })
    }
    attended += p
    missed += a
    if (p + a > 0) perSubject.push({ name: s.name, p, a })
  }

  timeline.sort((x, y) => (x.d + x.t).localeCompare(y.d + y.t))
  let streak = 0
  let run = 0
  for (const e of timeline) {
    run = e.s === "P" ? run + 1 : 0
    streak = Math.max(streak, run)
  }

  const ranked = perSubject
    .filter((x) => x.p + x.a >= MIN_CLASSES)
    .map((x) => ({ name: x.name, pct: Math.round((x.p / (x.p + x.a)) * 100), classes: x.p + x.a }))
    .sort((x, y) => y.pct - x.pct || y.classes - x.classes)
  const best = ranked[0] ?? null
  const low = ranked.length > 1 ? ranked[ranked.length - 1] : null

  const counts = mates
    .map((mt) => ({ name: mt.name, count: (mt.coveredLog ?? []).filter((d) => inRange(d, range)).length }))
    .filter((x) => x.count > 0)
    .sort((x, y) => y.count - x.count)

  const sameMonth = range.startDate.getMonth() === range.endDate.getMonth()
  return {
    rangeLabel: `${short(range.startDate)} – ${sameMonth ? range.endDate.getDate() : short(range.endDate)}`,
    isCurrent,
    attended,
    missed,
    pct: attended + missed > 0 ? Math.round((attended / (attended + missed)) * 100) : null,
    best,
    weakest: best && low && low.pct + 10 <= best.pct ? { name: low.name, pct: low.pct } : null,
    streak,
    coverHero: counts[0] ?? null,
    coversTotal: counts.reduce((n, x) => n + x.count, 0),
  }
}
