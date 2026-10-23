import { getProfileName, listRequests } from "./social"

/**
 * The label given to an account that has never been named. It comes from the account id, so it is stable for one id,
 * but a browser that starts from nothing gets a brand-new anonymous id, so it is different on every fresh browser.
 * That is why it is only ever a label to show: never a name to save on the device or publish over a real one.
 */
export const placeholderName = (uid: string) => `Mate-${uid.slice(-8).toUpperCase()}`

/** Any generated label, whichever account id it came from */
export const isPlaceholderName = (name: string | null | undefined) => /^Mate-[A-Za-z0-9_-]{8}$/.test((name ?? "").trim())

/** A name a person chose, or "" */
export const realName = (name: string | null | undefined) => {
  const t = (name ?? "").trim()
  return t && !isPlaceholderName(t) ? t : ""
}

/**
 * The name this account goes by when a device doesn't have it saved (a new browser, cleared data).
 *
 * Signed in with Google (a real account that follows the person across devices), the account's own record wins:
 * the name on its cloud profile, then what this device has, then the name on the Google/Firebase account, then a name
 * recovered from the connections it has made. An anonymous account has no other device, so this device's name leads.
 * Only if none of these exists is the account unnamed and the placeholder is shown.
 *
 * `publish` is false when the placeholder is all there is and the profile could not be read: announcing it then
 * could overwrite a real name that is merely out of reach right now.
 */
export async function resolveProfileName(
  uid: string,
  opts: {
    local: string
    authName?: string | null
    anonymous?: boolean
    lookup?: (uid: string) => Promise<string | null>
    recover?: (uid: string) => Promise<string>
  },
): Promise<{ name: string; publish: boolean }> {
  const { local, authName, anonymous = false, lookup = getProfileName, recover = nameFromConnections } = opts
  let cloud = ""
  let readable = true
  try {
    cloud = realName(await lookup(uid))
  } catch {
    readable = false
  }
  const order = anonymous ? [realName(local), cloud, realName(authName)] : [cloud, realName(local), realName(authName)]
  const found = order.find(Boolean)
  if (found) return { name: found, publish: true }
  if (readable && !anonymous) {
    // The profile exists but only holds a placeholder (an earlier overwrite): the name may survive on the requests this account made
    const recovered = realName(await recover(uid).catch(() => ""))
    if (recovered) return { name: recovered, publish: true }
  }
  return { name: placeholderName(uid), publish: readable }
}

/** The most common real name this account is called in its own connection requests ("" if none) */
export async function nameFromConnections(uid: string): Promise<string> {
  const counts = new Map<string, number>()
  for (const r of await listRequests(uid)) {
    const n = realName(r.from === uid ? r.fromName : r.to === uid ? r.toName : "")
    if (n) counts.set(n, (counts.get(n) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ""
}

const LIVE_MS = 5 * 60_000
const liveCache = new Map<string, { name: string; at: number }>()

/**
 * What each account is called right now. The name inside a request or Ping is a copy from when it was created, so it
 * can be a placeholder or out of date; the profile is the source. Missing or unreadable ones are left out.
 */
export async function liveNames(uids: string[], lookup: (uid: string) => Promise<string | null> = getProfileName, now = Date.now()) {
  const out: Record<string, string> = {}
  await Promise.all(
    [...new Set(uids)].map(async (uid) => {
      const hit = liveCache.get(uid)
      if (hit && now - hit.at < LIVE_MS) {
        if (hit.name) out[uid] = hit.name
        return
      }
      try {
        const name = realName(await lookup(uid))
        liveCache.set(uid, { name, at: now })
        if (name) out[uid] = name
      } catch {
        /* offline or not allowed: keep the copy already shown */
      }
    }),
  )
  return out
}

/** Forget what was looked up (a test, or sign-out) */
export const clearLiveNames = () => liveCache.clear()
