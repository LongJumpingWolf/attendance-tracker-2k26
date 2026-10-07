"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { confirmSwitch as confirmAccountSwitch, signInDev, signInWithGoogle, signOutAccount, watchAccount, type Account, type SwitchPlan } from "@/lib/account"
import { buildBackup, parseFullBackup, type FullBackupData } from "@/lib/backup"
import { cloudGet, cloudKind, cloudPut, watchCloud, type CloudDoc } from "@/lib/cloud-sync"
import { loadSchedule, saveSchedule } from "@/lib/reminders"
import { dbDel, dbGet, dbSet } from "@/lib/db"
import { mergeData, same } from "@/lib/merge"
import { saveRestorePoint } from "@/lib/restore-points"

const OWNER_KEY = "syncOwner"
const REV_KEY = "syncRev"
const AT_KEY = "syncAt"
const PUSH_DELAY = 1200
const PULL_TIMEOUT = 6000
/** After an upload fails while online, try again after this long, doubling each time up to the cap */
const RETRY_FIRST = 15_000
const RETRY_MAX = 300_000
/** The copy this device and the stored copy last agreed on: the common starting point for merging later changes */
const BASE_KEY = "syncBase"

export type SyncStatus = "off" | "syncing" | "synced" | "offline" | "too-large"

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false

type Data = Omit<FullBackupData, "reminders">

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const write = (key: string, value: string | null) => {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* private mode */
  }
}

/** Reminders are not React state, so they are left out when deciding whether anything changed */
const fingerprint = (d: Data) => JSON.stringify({ s: d.subjects, t: d.tasks, g: d.tags, m: d.mates })

const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))])

/**
 * Keeps this browser's data in step with the copy stored for the signed-in account, so the same timetable and marks
 * show up in Safari, the home-screen app or any other browser signed in to the same account. Changes are pushed a
 * moment after they happen; other browsers' changes are pulled when the app opens and when it comes back to the
 * foreground. If two browsers changed things at once, the two copies are merged (see lib/merge.ts): nothing either one
 * added is lost, and a copy of this device's data is saved as a restore point before anything is replaced.
 */
export function useCloudSync(opts: {
  loaded: boolean
  data: Data
  apply: (d: FullBackupData) => void
  notify: (message: string) => void
  /** While true, nothing is pushed or pulled — used while demo data is on screen, so it never reaches the real account */
  paused?: boolean
}) {
  const { loaded, data, apply, notify, paused = false } = opts
  const pausedRef = useRef(paused)
  pausedRef.current = paused
  const [account, setAccount] = useState<Account | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<SyncStatus>("off")
  const [realtime, setRealtime] = useState(false)
  // Bumped when something must be sent although the data didn't change (a merge that kept this device's edits)
  const [kick, setKick] = useState(0)
  const [lastAt, setLastAt] = useState<number | null>(null)
  // Google already has an account from another device and switching would leave mates made here behind: wait for a yes
  const [switchPlan, setSwitchPlan] = useState<SwitchPlan | null>(null)

  const dataRef = useRef(data)
  dataRef.current = data
  const applyRef = useRef(apply)
  applyRef.current = apply
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  const ownerRef = useRef<string | null>(null)
  const revRef = useRef<number | null>(null)
  const lastJson = useRef<string | null>(null) // what the stored copy holds, so unchanged data is never re-sent
  const busy = useRef(false)
  const baseRef = useRef<FullBackupData | null>(null)
  const conflictsRef = useRef(0)
  const missedRef = useRef(false) // a live update arrived while we were sending; fetch it once we are done
  const pendingAfterMerge = useRef(false) // the merge kept changes the stored copy doesn't have yet
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retryWait = useRef(RETRY_FIRST)
  const warnedLarge = useRef(false)
  const realtimeRef = useRef(false)

  const stamp = () => {
    const now = Date.now()
    setLastAt(now)
    write(AT_KEY, String(now))
  }

  const current = (): FullBackupData => ({ ...dataRef.current, reminders: loadSchedule() })

  const setBase = (d: FullBackupData | null) => {
    baseRef.current = d
    if (d) void dbSet(BASE_KEY, d)
    else void dbDel(BASE_KEY)
  }
  const loadBase = async (): Promise<FullBackupData | null> => {
    if (baseRef.current) return baseRef.current
    const b = await dbGet<FullBackupData>(BASE_KEY)
    baseRef.current = b && Array.isArray(b.subjects) && Array.isArray(b.tasks) && Array.isArray(b.mates) ? b : null
    return baseRef.current
  }

  /** This device has nothing worth keeping, so the stored copy simply becomes this device's data */
  const takeCloud = useCallback((cloud: FullBackupData, rev: number) => {
    applyRef.current(cloud)
    saveSchedule(cloud.reminders)
    revRef.current = rev
    write(REV_KEY, String(rev))
    lastJson.current = fingerprint(cloud)
    setBase(cloud)
  }, [])

  /**
   * Brings the stored copy in without losing anything done here since the last sync: merges the two, applies the
   * result, and saves restore points whenever this device's data is about to change. Returns whether the data here changed.
   */
  const reconcile = useCallback(async (cloud: FullBackupData, rev: number, base: FullBackupData | null): Promise<boolean> => {
    // Save the restore points first, before anything on this device is replaced. A point is only worth making when
    // this device holds changes the stored copy never saw (a plain catch-up replaces nothing of value).
    const before = current()
    const trial = mergeData(base, before, cloud)
    const unsynced = !base || !same(before, base)
    if (trial.conflicts > 0 || (unsynced && !same(trial.data, before))) {
      await saveRestorePoint(trial.conflicts > 0 ? "Before merging with your other browser" : "Before a sync update", before)
      if (trial.conflicts > 0) await saveRestorePoint("Your other browser's copy", cloud)
    }
    // Merge again on whatever is here now, so anything done while the points were being saved is kept
    const local = current()
    const { data: merged, conflicts } = mergeData(base, local, cloud)
    const changed = !same(merged, local)
    conflictsRef.current = conflicts
    if (changed) {
      applyRef.current(merged)
      saveSchedule(merged.reminders)
    }
    revRef.current = rev
    write(REV_KEY, String(rev))
    lastJson.current = fingerprint(cloud) // anything the merge kept that the stored copy lacks is pushed next
    pendingAfterMerge.current = fingerprint(merged) !== fingerprint(cloud)
    setBase(cloud)
    if (conflicts > 0) {
      notifyRef.current(
        `Merged with your other browser. ${conflicts} ${conflicts === 1 ? "item was" : "items were"} changed in both places, so yours was kept. The other copy is saved under Restore points.`,
      )
    }
    return changed
  }, [])

  const adopt = (owner: string, rev: number, json: string | null) => {
    ownerRef.current = owner
    revRef.current = rev
    lastJson.current = json
    write(OWNER_KEY, owner)
    write(REV_KEY, String(rev))
    setStatus("synced")
    stamp()
  }

  /** Takes in a stored copy (fetched, or pushed to us live): merged in if it is newer than what this browser last saw */
  const ingest = useCallback(
    async (doc: CloudDoc): Promise<"updated" | "same" | "failed"> => {
      const parsed = parseFullBackup(doc.data)
      if (!parsed.ok) return "failed"
      if (doc.rev > (revRef.current ?? 0)) {
        const changed = await reconcile(parsed.data, doc.rev, await loadBase())
        // Only "synced" when nothing is still waiting to be sent
        setStatus(pendingAfterMerge.current ? "syncing" : "synced")
        if (pendingAfterMerge.current) setKick((k) => k + 1)
        if (!pendingAfterMerge.current) stamp()
        return changed ? "updated" : "same"
      }
      if (lastJson.current === null) lastJson.current = fingerprint(parsed.data)
      if (fingerprint(dataRef.current) !== lastJson.current) {
        setStatus("syncing") // this device has changes the stored copy lacks; they are sent next
        setKick((k) => k + 1)
        return "same"
      }
      setStatus("synced")
      return "same"
    },
    [reconcile],
  )

  /** Fetches the stored copy and adopts it if it is newer than what this browser last saw */
  const pull = useCallback(async (): Promise<"updated" | "same" | "none" | "failed"> => {
    const owner = ownerRef.current
    if (!owner || pausedRef.current) return "none"
    if (isOffline()) {
      setStatus("offline") // no waiting on a network that is known to be down
      return "failed"
    }
    try {
      const doc = await withTimeout(cloudGet(owner), PULL_TIMEOUT)
      if (!doc) return "none"
      return await ingest(doc)
    } catch {
      setStatus("offline")
      return "failed"
    }
  }, [ingest])

  const push = useCallback(async () => {
    const owner = ownerRef.current
    if (!owner || busy.current || pausedRef.current) return // never while demo data is on screen, even from a timer set earlier
    // After a restart nothing is known about what the stored copy holds. The copy last confirmed by a successful write
    // (the sync base) says what has been sent, so changes that were still waiting when the app closed are sent now,
    // and nothing is re-sent when there are none.
    if (lastJson.current === null) {
      const b = await loadBase()
      if (b) lastJson.current = fingerprint(b)
    }
    const now = fingerprint(dataRef.current)
    if (now === lastJson.current) return
    if (isOffline()) {
      setStatus("offline") // the change is already saved on this device; it is sent when the connection returns
      return
    }
    busy.current = true
    setStatus("syncing")
    const sent = current()
    const r = await cloudPut(owner, buildBackup(sent, false), revRef.current)
    busy.current = false
    if (r.ok) {
      // Only now, after the store confirmed the write, is anything called synced
      revRef.current = r.rev
      write(REV_KEY, String(r.rev))
      lastJson.current = now
      setBase(sent)
      warnedLarge.current = false
      retryWait.current = RETRY_FIRST
      if (retryTimer.current) clearTimeout(retryTimer.current)
      setStatus("synced")
      stamp()
    } else if (r.reason === "too-large") {
      // Nothing was sent and nothing here was touched. It is tried again whenever the data changes.
      setStatus("too-large")
      if (!warnedLarge.current) {
        warnedLarge.current = true
        notifyRef.current("Cloud backup is too large. Your data is safe on this device.")
      }
    } else if (r.reason === "conflict") {
      // Another browser saved first. Merge its copy with ours instead of overwriting either; the merged result is pushed next.
      if ((await pull()) === "updated" && conflictsRef.current === 0) notifyRef.current("Updated from your other browser")
    } else {
      // The write did not go through (it may or may not have reached the store). Changes stay here as unsent and are retried.
      setStatus("offline")
      if (retryTimer.current) clearTimeout(retryTimer.current)
      retryTimer.current = setTimeout(() => void pushRef.current(), retryWait.current)
      retryWait.current = Math.min(retryWait.current * 2, RETRY_MAX)
    }
    if (missedRef.current) {
      missedRef.current = false
      void pull()
    }
  }, [pull])
  const pushRef = useRef(push)
  pushRef.current = push

  useEffect(() => () => clearTimeout(retryTimer.current), [])

  // Who is signed in (Firebase restores the session on its own; the first answer may take a moment)
  useEffect(() => {
    return watchAccount((a) => {
      setAccount(a)
      setAuthReady(true)
    })
  }, [])

  // Once data and the account are known: catch up, or connect a newly signed-in account
  const accountId = account?.id ?? null
  useEffect(() => {
    if (!loaded || !authReady) return
    let cancelled = false
    const done = () => !cancelled && setReady(true)

    if (!accountId) {
      ownerRef.current = null
      revRef.current = null
      lastJson.current = null
      setStatus("off")
      done()
      return
    }

    // Demo data must never be read as "what's really in this browser" or pushed anywhere; wait it out and catch up
    // for real once it ends (paused re-running this effect is what makes that happen)
    if (paused) {
      done()
      return
    }

    const at = read(AT_KEY)
    setLastAt(at ? Number(at) : null)

    if (read(OWNER_KEY) === accountId) {
      // Already connected in this browser: pick up where it left off
      ownerRef.current = accountId
      const rev = read(REV_KEY)
      revRef.current = rev ? Number(rev) : null
      setStatus("syncing")
      void pull().then(done)
      return () => {
        cancelled = true
      }
    }

    // First time this account is used in this browser. An empty browser takes the stored copy; a browser with data
    // is merged with it (matching subjects by name), never replaced by it and never replacing it.
    setStatus("syncing")
    setBase(null)
    void (async () => {
      try {
        const doc = await withTimeout(cloudGet(accountId), PULL_TIMEOUT)
        if (cancelled) return
        const d = dataRef.current
        const hasLocal = d.subjects.length + d.tasks.length > 0 // the demo mates shown on a fresh install are not real data
        if (!doc) {
          const sent = current()
          const r = await cloudPut(accountId, buildBackup(sent, false), null)
          if (!cancelled) {
            if (r.ok) {
              adopt(accountId, r.rev, fingerprint(d))
              setBase(sent)
            } else setStatus("offline")
          }
        } else {
          const parsed = parseFullBackup(doc.data)
          if (!parsed.ok) setStatus("offline")
          else if (!hasLocal) {
            takeCloud(parsed.data, doc.rev)
            adopt(accountId, doc.rev, fingerprint(parsed.data))
          } else {
            await reconcile(parsed.data, doc.rev, null)
            notifyRef.current(
              conflictsRef.current === 0
                ? "Signed in. This browser's data was combined with your account's."
                : "Signed in and combined your data. Where both differed, this browser's version was kept.",
            )
            const merged = current()
            const r = await cloudPut(accountId, buildBackup(merged, false), doc.rev)
            if (!cancelled) {
              if (r.ok) {
                adopt(accountId, r.rev, fingerprint(merged))
                setBase(merged)
              } else setStatus("offline") // safe to retry: merging again changes nothing
            }
          }
        }
      } catch {
        if (!cancelled) setStatus("offline")
      }
      done()
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, authReady, accountId, paused])

  // Push shortly after a change
  const changed = fingerprint(data)
  useEffect(() => {
    if (!ready || !accountId || paused || ownerRef.current !== accountId) return
    const t = setTimeout(() => void push(), PUSH_DELAY)
    return () => clearTimeout(t)
  }, [changed, ready, accountId, paused, kick, push]) // not `status`: a failed send flips it, which would re-send every second

  // Catch up when the app comes back to the front
  useEffect(() => {
    if (!ready || !accountId) return
    const onVisible = async () => {
      if (document.visibilityState !== "visible" || paused || ownerRef.current !== accountId) return
      if ((await pull()) === "updated" && conflictsRef.current === 0) notifyRef.current("Updated from your other browser")
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [ready, accountId, paused, pull])

  // Realtime: another device's change shows up here by itself. One listener on this account's one document. If it can't
  // run (offline, blocked, rules), nothing else changes: the app keeps working from its own copy and the normal
  // catch-ups (opening, returning to the app, reconnecting) carry on. lib/realtime.ts restarts it when it can.
  useEffect(() => {
    if (!ready || !accountId || paused) return
    const stop = watchCloud(
      accountId,
      (doc) => {
        if (ownerRef.current !== accountId || doc.rev <= (revRef.current ?? 0)) return // our own write coming back, or nothing new
        if (busy.current) {
          missedRef.current = true
          return
        }
        void ingest(doc).then((r) => {
          if (r === "updated" && conflictsRef.current === 0) notifyRef.current("Updated from your other browser")
        })
      },
      (live) => {
        realtimeRef.current = live
        setRealtime(live)
      },
    )
    return () => {
      stop()
      realtimeRef.current = false
      setRealtime(false)
    }
  }, [ready, accountId, paused, ingest])

  // The moment the connection comes back, catch up: fetch what changed elsewhere, merge it, and send what was done offline
  const syncRef = useRef<() => Promise<boolean>>(async () => false)
  useEffect(() => {
    if (!ready || !accountId) return
    const onOnline = () => {
      if (paused || ownerRef.current !== accountId) return
      // With the live listener running it delivers anything new by itself, so only what was done offline is sent (no extra read)
      if (realtimeRef.current) {
        if (fingerprint(dataRef.current) === lastJson.current) setStatus((s) => (s === "offline" ? "synced" : s))
        void pushRef.current()
      } else void syncRef.current()
    }
    window.addEventListener("online", onOnline)
    return () => window.removeEventListener("online", onOnline)
  }, [ready, accountId, paused])

  // Changes saved on this device that the stored copy doesn't have yet
  const [pending, setPending] = useState(false)
  useEffect(() => {
    setPending(Boolean(ownerRef.current) && fingerprint(dataRef.current) !== lastJson.current)
  }, [changed, status])

  /** Returns an error message, or null. In development without Firebase keys, pass an email for the test account. */
  const signIn = async (devEmail?: string): Promise<string | null> => {
    if (cloudKind() === "dev") {
      if (!devEmail || !/^\S+@\S+$/.test(devEmail.trim())) return "Enter an email address."
      signInDev(devEmail)
      return null
    }
    const r = await signInWithGoogle()
    if (r.kind === "confirm") setSwitchPlan(r.plan)
    return r.kind === "error" ? r.message : null
  }

  /** The person agreed to switch to the Google account's own profile and reconnect the mates made here */
  const confirmSwitch = async (): Promise<string | null> => {
    if (!switchPlan) return null
    const problem = await confirmAccountSwitch(switchPlan)
    if (!problem) setSwitchPlan(null)
    return problem
  }
  const cancelSwitch = () => setSwitchPlan(null)

  /** Signs out of this browser. Nothing is deleted: the stored copy and this browser's data both stay. */
  const signOut = async () => {
    clearTimeout(retryTimer.current)
    for (const k of [OWNER_KEY, REV_KEY, AT_KEY]) write(k, null)
    ownerRef.current = null
    revRef.current = null
    lastJson.current = null
    setBase(null)
    setStatus("off")
    setLastAt(null)
    await signOutAccount()
  }

  const syncNow = async () => {
    if (!ownerRef.current) return false
    setStatus("syncing")
    const before = revRef.current
    await pull()
    await push()
    return revRef.current !== before
  }
  syncRef.current = syncNow

  return { kind: cloudKind(), account, ready, status, pending, realtime, lastAt, switchPlan, confirmSwitch, cancelSwitch, signIn, signOut, syncNow }
}

export type CloudSync = ReturnType<typeof useCloudSync>
