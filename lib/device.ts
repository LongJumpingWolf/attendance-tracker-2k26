import { newId } from "./ids"

let memory: string | null = null

/**
 * A random id for this browser, made once and kept. It names who holds the lease on an answer, so two devices of the
 * same person can tell themselves apart. It is not an identity, only a way to avoid both applying the same answer.
 */
export function deviceId(): string {
  try {
    const saved = localStorage.getItem("deviceId")
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved
    const fresh = newId()
    localStorage.setItem("deviceId", fresh)
    return fresh
  } catch {
    return (memory ??= newId()) // storage blocked: stable for this visit
  }
}
