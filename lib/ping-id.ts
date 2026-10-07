import { newId } from "./ids"

/**
 * One id per logical Ping, kept until the send is confirmed. Retrying a send (after a timeout, a reload, a double tap, a
 * dropped connection) therefore reuses the SAME id, so the server can only ever end up with one Ping: if the first
 * attempt did arrive, the retry finds it instead of making another.
 */
const KEY = "pingSendKeys"
const KEEP_MS = 24 * 3_600_000

type Store = Record<string, { id: string; at: number }>

const read = (): Store => {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || "{}")
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {}
  } catch {
    return {}
  }
}
const write = (s: Store) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* not remembered: a retry in this visit still reuses the id held in memory */
  }
}
const held = new Map<string, string>()

/** The same request (who, to whom, which day, which classes) is the same Ping, however many times it is sent */
export const logicalKey = (from: string, to: string, date: string, itemKeys: string[]) => [from, to, date, [...itemKeys].sort().join(",")].join("|")

/** The id for this request: the one already chosen if there is one (and it isn't stale), otherwise a new one, remembered */
export function idFor(key: string, now = Date.now()): string {
  const store = read()
  const entry = store[key]
  if (entry && now - entry.at < KEEP_MS) return entry.id
  const id = held.get(key) ?? newId()
  held.set(key, id)
  for (const [k, v] of Object.entries(store)) if (now - v.at >= KEEP_MS) delete store[k]
  store[key] = { id, at: now }
  write(store)
  return id
}

/** The send is confirmed: the next identical request is a new Ping */
export function forget(key: string) {
  held.delete(key)
  const store = read()
  if (store[key]) {
    delete store[key]
    write(store)
  }
}
