"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { signInDev, signInWithGoogle, signOutAccount, watchAccount, type Account } from "@/lib/account"
import { buildBackup, parseFullBackup, type FullBackupData } from "@/lib/backup"
import { cloudGet, cloudKind, cloudPut } from "@/lib/cloud-sync"
import { loadSchedule, saveSchedule } from "@/lib/reminders"

const OWNER_KEY = "syncOwner"
const REV_KEY = "syncRev"
const AT_KEY = "syncAt"
const PUSH_DELAY = 1200
const PULL_TIMEOUT = 6000

export type SyncStatus = "off" | "syncing" | "synced" | "offline"

type Data = Omit<FullBackupData, "reminders">

/** A first sign-in in a browser that already has data: the stored copy and this browser's copy can't be merged */
export interface Choice {
  owner: string
  rev: number
  cloud: FullBackupData
}

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
 * foreground. If two browsers changed things at once, the newer stored copy wins.
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
  const [account, setAccount] = useState<Account | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [ready, setReady] = useState(false)
  const [status, setStatus] = useState<SyncStatus>("off")
  const [lastAt, setLastAt] = useState<number | null>(null)
  const [choice, setChoice] = useState<Choice | null>(null)

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

  const stamp = () => {
    const now = Date.now()
    setLastAt(now)
    write(AT_KEY, String(now))
  }

  const payload = () => buildBackup({ ...dataRef.current, reminders: loadSchedule() })

  const takeCloud = useCallback((cloud: FullBackupData, rev: number) => {
    applyRef.current(cloud)
    saveSchedule(cloud.reminders)
    revRef.current = rev
    write(REV_KEY, String(rev))
    lastJson.current = fingerprint(cloud)
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

  /** Fetches the stored copy and adopts it if it is newer than what this browser last saw */
  const pull = useCallback(async (): Promise<"updated" | "same" | "none" | "failed"> => {
    const owner = ownerRef.current
    if (!owner) return "none"
    try {
      const doc = await withTimeout(cloudGet(owner), PULL_TIMEOUT)
      if (!doc) return "none"
      const parsed = parseFullBackup(doc.data)
      if (!parsed.ok) return "failed"
      if (doc.rev > (revRef.current ?? 0)) {
        takeCloud(parsed.data, doc.rev)
        setStatus("synced")
        stamp()
        return "updated"
      }
      if (lastJson.current === null) lastJson.current = fingerprint(parsed.data)
      setStatus("synced")
      return "same"
    } catch {
      setStatus("offline")
      return "failed"
    }
  }, [takeCloud])

  const push = useCallback(async () => {
    const owner = ownerRef.current
    if (!owner || busy.current) return
    const now = fingerprint(dataRef.current)
    if (now === lastJson.current) return
    busy.current = true
    setStatus("syncing")
    const r = await cloudPut(owner, payload(), revRef.current)
    busy.current = false
    if (r.ok) {
      revRef.current = r.rev
      write(REV_KEY, String(r.rev))
      lastJson.current = now
      setStatus("synced")
      stamp()
    } else if (r.reason === "conflict") {
      // Another browser saved first. Take its copy rather than overwrite it.
      if ((await pull()) === "updated") notifyRef.current("Updated from your other browser")
    } else {
      setStatus("offline")
    }
  }, [pull])

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
      setChoice(null)
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

    // First time this account is used in this browser
    setStatus("syncing")
    void (async () => {
      try {
        const doc = await withTimeout(cloudGet(accountId), PULL_TIMEOUT)
        if (cancelled) return
        const d = dataRef.current
        const hasLocal = d.subjects.length + d.tasks.length > 0 // the demo mates shown on a fresh install are not real data
        if (!doc) {
          const r = await cloudPut(accountId, payload(), null)
          if (!cancelled) r.ok ? adopt(accountId, r.rev, fingerprint(d)) : setStatus("offline")
        } else {
          const parsed = parseFullBackup(doc.data)
          if (!parsed.ok) setStatus("offline")
          else if (!hasLocal) {
            takeCloud(parsed.data, doc.rev)
            adopt(accountId, doc.rev, fingerprint(parsed.data))
          } else {
            setChoice({ owner: accountId, rev: doc.rev, cloud: parsed.data })
            setStatus("off")
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
    if (!ready || !accountId || choice || paused || ownerRef.current !== accountId) return
    const t = setTimeout(() => void push(), PUSH_DELAY)
    return () => clearTimeout(t)
  }, [changed, ready, accountId, choice, paused, status, push])

  // Catch up when the app comes back to the front
  useEffect(() => {
    if (!ready || !accountId) return
    const onVisible = async () => {
      if (document.visibilityState !== "visible" || paused || ownerRef.current !== accountId) return
      if ((await pull()) === "updated") notifyRef.current("Updated from your other browser")
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => document.removeEventListener("visibilitychange", onVisible)
  }, [ready, accountId, paused, pull])

  /** Returns an error message, or null. In development without Firebase keys, pass an email for the test account. */
  const signIn = async (devEmail?: string): Promise<string | null> => {
    if (cloudKind() === "dev") {
      if (!devEmail || !/^\S+@\S+$/.test(devEmail.trim())) return "Enter an email address."
      signInDev(devEmail)
      return null
    }
    return signInWithGoogle()
  }

  /** After a first sign-in on a browser that already has data: keep the stored copy here, or replace it with this browser's data */
  const resolve = async (use: "cloud" | "here"): Promise<boolean> => {
    if (!choice) return true
    if (use === "cloud") {
      takeCloud(choice.cloud, choice.rev)
      adopt(choice.owner, choice.rev, fingerprint(choice.cloud))
    } else {
      const r = await cloudPut(choice.owner, payload(), choice.rev)
      if (!r.ok) return false
      adopt(choice.owner, r.rev, fingerprint(dataRef.current))
    }
    setChoice(null)
    return true
  }

  /** Signs out of this browser. Nothing is deleted: the stored copy and this browser's data both stay. */
  const signOut = async () => {
    for (const k of [OWNER_KEY, REV_KEY, AT_KEY]) write(k, null)
    ownerRef.current = null
    revRef.current = null
    lastJson.current = null
    setChoice(null)
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

  return { kind: cloudKind(), account, ready, status, lastAt, choice, signIn, resolve, signOut, syncNow }
}

export type CloudSync = ReturnType<typeof useCloudSync>
