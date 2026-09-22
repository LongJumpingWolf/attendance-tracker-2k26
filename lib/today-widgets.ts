/**
 * The widgets shown on the Today tab once every class is marked. The person chooses which ones, and the order
 * they pick them in is the order of the swipeable stack. The choice is kept in localStorage under "todayWidgets".
 */
export type WidgetId = "skip" | "stand" | "deadline"

export const WIDGETS: { id: WidgetId; title: string; description: string }[] = [
  { id: "skip", title: "Can I skip tomorrow?", description: "A verdict for each of tomorrow's classes, and what skipping would do to your percentage." },
  { id: "stand", title: "Where you stand", description: "One ring per subject: your percentage, skips left, or how many classes to attend to recover." },
  { id: "deadline", title: "Deadline", description: "Your next deadline as a big countdown, with the one after it." },
]

const KEY = "todayWidgets"
const known = new Set<string>(WIDGETS.map((w) => w.id))

/** null = never chosen (show the invitation). An empty list = chose none on purpose. */
export function loadWidgets(): WidgetId[] | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return Array.from(new Set(parsed.filter((x): x is WidgetId => typeof x === "string" && known.has(x))))
  } catch {
    return null
  }
}

export function saveWidgets(list: WidgetId[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* not remembered, still works this session */
  }
}
