"use client"

const storageKey = (ownerUid: string) => `mateAliases:${ownerUid}`

/** Read a local alias entered before a connection is accepted. The confirmed Mate row becomes the durable copy. */
export function readMateAlias(ownerUid: string, mateUid: string): string | undefined {
  if (!ownerUid || !mateUid || typeof localStorage === "undefined") return undefined
  try {
    const raw = localStorage.getItem(storageKey(ownerUid))
    if (!raw) return undefined
    const data: unknown = JSON.parse(raw)
    if (!data || typeof data !== "object" || Array.isArray(data)) return undefined
    const value = (data as Record<string, unknown>)[mateUid]
    return typeof value === "string" && value.trim() ? value.trim().slice(0, 48) : undefined
  } catch {
    return undefined
  }
}

/** Save a provisional alias locally while the account connection request is pending. */
export function writeMateAlias(ownerUid: string, mateUid: string, alias: string): boolean {
  const clean = alias.trim().replace(/\s+/g, " ").slice(0, 48)
  if (!ownerUid || !mateUid || !clean || typeof localStorage === "undefined") return false
  try {
    const raw = localStorage.getItem(storageKey(ownerUid))
    let data: Record<string, unknown> = {}
    if (raw) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          data = { ...(parsed as Record<string, unknown>) }
        }
      } catch {
        // Recover from corrupt local state without preventing the user from saving a new alias.
      }
    }
    data[mateUid] = clean
    localStorage.setItem(storageKey(ownerUid), JSON.stringify(data))
    return true
  } catch {
    return false
  }
}
