"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { confirmSwitch as confirmAccountSwitch, signInDev, signInWithGoogle, signOutAccount, watchAccount, type Account, type SwitchPlan } from "@/lib/account"
import { buildBackup, parseFullBackup, type FullBackupData } from "@/lib/backup"
import { cloudGet, cloudKind, cloudPut, watchCloud, type CloudDoc } from "@/lib/cloud-sync"
import { isDemoLive, lockHolder, onRelease } from "@/lib/operation-lock"
import { loadSchedule, saveSchedule } from "@/lib/reminders"
import { dbDel, dbGet, dbSet } from "@/lib/db"
import { mergeData, same } from "@/lib/merge"
import { listRestorePoints, saveRestorePoint } from "@/lib/restore-points"
import {
  createIngestor,
  DeferredError,
  fingerprint,
  isRev,
  normalizeRev,
  planFirstSignIn,
  PromptController,
  putTracked,
  runChoice,
  settleFirstConnection,
  signOutIfConfigured,
  WriteLedger,
  withPutTimeout,
  withReadTimeout,
  type BaseRecord,
  type Choice,
  type CloudRead,
  type MarkerStore,
  type MergeWhy,
  type PromptState,
} from "@/lib/signin-reconcile"

const OWNER_KEY = "syncOwner"
const REV_KEY = "syncRev"
const AT_KEY = "syncAt"
const PUSH_DELAY = 1200
const PULL_TIMEOUT = 6000
/** A write that gets no answer in this time is treated as "unavailable": it may still have landed, so its marker stays */
const PUT_TIMEOUT = 12_000
/** After an upload fails while online, try again after this long, doubling each time up to the cap */
const RETRY_FIRST = 15_000
const RETRY_MAX = 300_000
/** The copy this device and the stored copy last agreed on: the common starting point for merging later changes */
const BASE_KEY = "syncBase"
/**
 * The account this device's data was last synced with. Unlike the keys above it is NOT cleared on sign-out, so a different
 * account signing in later can tell that the data here belongs to someone else and is never combined into its copy unasked.
 */
const DATA_OWNER_KEY = "syncDataOwner"
/** The base together with the revision it is at, in ONE stored value (BASE_KEY above is the older format, without the revision) */
const BASE2_KEY = "syncBaseV2"
/**
 * Writes whose result is not known: each is recorded (exact text sent, revision it was conditional on) BEFORE the request is made,
 * and settled only by reading the stored copy (see decideIngest in lib/signin-reconcile.ts). Kept across restarts.
 */
const UNCERTAIN_KEY = "syncUncertain"

const markerStore: MarkerStore = {
  load: () => dbGet<unknown>(UNCERTAIN_KEY),
  save: async (list) => {
    if (!list.length) return dbDel(UNCERTAIN_KEY)
    await dbSet(UNCERTAIN_KEY, list)
    const back = await dbGet<unknown>(UNCERTAIN_KEY) // dbSet reports nothing when storage refuses: read it back
    if (JSON.stringify(back) !== JSON.stringify(list)) throw new Error("the record of a write in flight could not be stored")
  },
}

/** What the person is told when the stored copy had to be combined without a shared starting point */
const CAUTIOUS_NOTICE: Record<MergeWhy, string> = {
  "ambiguous-write":
    "Your last change may or may not have reached your account before another browser saved. Both copies were combined without counting anything twice, but something you deleted may have come back. Your earlier data is saved under Restore points.",
  "unproven-base":
    "This device couldn’t be sure what it last agreed on with your account, so both copies were combined cautiously. Something you deleted may have come back. Your earlier data is saved under Restore points.",
  "remote-behind":
    "Your account’s copy is older than this device remembered (it may have been restored or reset). The two were combined and this device’s data was kept. A copy of both is saved under Restore points.",
  "corrupt-rev":
    "This device’s sync record was damaged, so it was rebuilt by combining both copies cautiously. Something you deleted may have come back. Your earlier data is saved under Restore points.",
}

export type SyncStatus = "off" | "syncing" | "synced" | "offline" | "too-large" | "needs-choice" | "paused"

/** First sign-in with data on both sides: what to show, and where the person's decision stands (see PromptState) */
export type ReconcilePrompt = PromptState

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


const withTimeout = <T,>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))])

/** cloudPut that cannot hang: no answer in time = "unavailable" (the write may or may not have landed; callers keep their markers) */
const boundedPut = withPutTimeout(cloudPut, PUT_TIMEOUT)
const boundedGet = withReadTimeout(cloudGet, PULL_TIMEOUT)

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
  // Bumped whenever what incoming data would be applied to changes (account, pause, sign-out): older work then must not apply it
  const epochRef = useRef(0)
  // Incoming data or a push was set aside because a replacement was running; retried when the lock is released
  const deferredRef = useRef(false)

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
  // Both this device and the account hold different data: wait for the person to choose how to combine them
  const [prompt, setPrompt] = useState<ReconcilePrompt | null>(null)
  // The controller owns which comparison is current and updates synchronously; `prompt` is only what is drawn
  const [prompts] = useState(() => new PromptController(setPrompt))
  // Writes in doubt, kept in storage
  const [ledger] = useState(() => new WriteLedger(markerStore))
  const accountIdRef = useRef<string | null>(null)
  const connectRef = useRef<(notice?: string) => Promise<void>>(async () => {})
  const connectGen = useRef(0) // each attempt to build the comparison gets a number; only the newest may show it
  const revCorruptRef = useRef(false) // the recorded revision was unreadable and has been discarded

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
  const baseRef = useRef<BaseRecord | null>(null)
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

  /**
   * Records the copy this device and the store agree on, WITH the revision that agreement is at, in one stored value (they used to be
   * two separate, unawaited writes, so after a crash the base could belong to a different revision than the one recorded).
   */
  const setBase = async (d: FullBackupData | null, rev: number | null = null) => {
    baseRef.current = d ? { rev, data: d } : null
    if (!d) {
      await dbDel(BASE_KEY)
      await dbDel(BASE2_KEY)
      return
    }
    await dbDel(BASE_KEY) // the old record carries no revision: it must never be read in place of this one
    await dbSet(BASE2_KEY, { rev, data: d })
  }
  const loadBase = async (): Promise<BaseRecord | null> => {
    if (baseRef.current) return baseRef.current
    const valid = (b: FullBackupData | undefined): b is FullBackupData => Boolean(b && Array.isArray(b.subjects) && Array.isArray(b.tasks) && Array.isArray(b.mates))
    const v2 = await dbGet<{ rev: unknown; data: FullBackupData }>(BASE2_KEY)
    if (v2 && valid(v2.data)) {
      // a revision that is not a valid one is stored as -1: it can never equal the revision a base is needed for
      baseRef.current = { rev: v2.rev === null ? null : isRev(v2.rev) ? v2.rev : -1, data: v2.data }
      return baseRef.current
    }
    const legacy = await dbGet<FullBackupData>(BASE_KEY) // from before revisions were recorded with it
    baseRef.current = valid(legacy) ? { rev: null, data: legacy } : null
    return baseRef.current
  }

  /** This device has nothing worth keeping, so the stored copy simply becomes this device's data */
  const takeCloud = useCallback(async (cloud: FullBackupData, rev: number) => {
    applyRef.current(cloud)
    saveSchedule(cloud.reminders)
    await setBase(cloud, rev) // the base first, then the revision it is at
    revRef.current = rev
    write(REV_KEY, String(rev))
    lastJson.current = fingerprint(cloud)
  }, [])

  /**
   * Brings the stored copy in without losing anything done here since the last sync: merges the two, applies the
   * result, and saves restore points whenever this device's data is about to change. Returns whether the data here changed.
   * `base` is null when no shared starting point may be used; `why` is set when that is because something was in doubt (see
   * decideIngest): both sides are then ALWAYS saved as restore points first, and the person is told.
   */
  const reconcile = useCallback(async (cloud: FullBackupData, rev: number, base: FullBackupData | null, why?: MergeWhy, canProceed?: () => boolean): Promise<boolean> => {
    // Save the restore points first, before anything on this device is replaced. A point is only worth making when
    // this device holds changes the stored copy never saw (a plain catch-up replaces nothing of value).
    const before = current()
    const trial = mergeData(base, before, cloud)
    const unsynced = !base || !same(before, base)
    if (why || trial.conflicts > 0 || (unsynced && !same(trial.data, before))) {
      try {
        await saveRestorePoint(why ? "Before reconciling after an uncertain sync" : trial.conflicts > 0 ? "Before merging with your other browser" : "Before a sync update", before)
        if (why || trial.conflicts > 0) await saveRestorePoint("Your other browser's copy", cloud)
      } catch (e) {
        // Not protected, so nothing is replaced: the update waits and is tried again
        notifyRef.current("Couldn’t save a safety copy, so an update from your other browser was not applied yet. Your data here is unchanged. If storage is full, delete older restore points under Settings > Backup & restore.")
        throw e
      }
    }
    // Saving took time. If a restore, reset or demo began, the account changed or sync was paused meanwhile, nothing is applied now:
    // the incoming copy is kept aside and tried again (it is not discarded). Nothing below awaits before the data is applied.
    if (canProceed && !canProceed()) throw new DeferredError()
    // Merge again on whatever is here now, so anything done while the points were being saved is kept
    const local = current()
    const { data: merged, conflicts } = mergeData(base, local, cloud)
    const changed = !same(merged, local)
    conflictsRef.current = conflicts
    if (changed) {
      applyRef.current(merged)
      saveSchedule(merged.reminders)
    }
    await setBase(cloud, rev) // the base first, then the revision it is at
    revRef.current = rev
    write(REV_KEY, String(rev))
    lastJson.current = fingerprint(cloud) // anything the merge kept that the stored copy lacks is pushed next
    pendingAfterMerge.current = fingerprint(merged) !== fingerprint(cloud)
    if (why) {
      notifyRef.current(CAUTIOUS_NOTICE[why])
      conflictsRef.current = Math.max(conflicts, 1) // the "Updated from your other browser" message must not replace the warning
    } else if (conflicts > 0) {
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
    write(DATA_OWNER_KEY, owner)
    write(REV_KEY, String(rev))
    prompts.clear()
    setStatus((pausedRef.current || isDemoLive()) ? "paused" : "synced")
    stamp()
  }

  // Everything that reads a stored copy goes through this one ingestor: one at a time, and decided by lib/signin-reconcile.ts
  const ingestorRef = useRef<ReturnType<typeof createIngestor> | null>(null)
  useEffect(() => {
    ingestorRef.current = createIngestor({
      ledger,
      getRev: () => revRef.current,
      revCorrupt: () => revCorruptRef.current,
      loadBase,
      merge: (cloud, rev, base, why, canProceed) => reconcile(cloud, rev, base, why, canProceed),
      adoptLanded: async (cloud, rev) => {
        await setBase(cloud, rev)
        revRef.current = rev
        write(REV_KEY, String(rev))
        lastJson.current = fingerprint(cloud)
        pendingAfterMerge.current = fingerprint(dataRef.current) !== fingerprint(cloud)
      },
      revRecovered: () => {
        revCorruptRef.current = false
      },
    })
    // The closures read only refs and module functions, so the first ones stay valid for the life of the hook
  }, [ledger, reconcile])

  /** adopt(), recording exactly `snapshot` as synced; edits made since are sent next */
  const connected = (owner: string, rev: number, snapshot: FullBackupData) => {
    const s = settleFirstConnection(snapshot, dataRef.current)
    adopt(owner, rev, s.lastJson)
    if (s.needsPush) {
      setStatus("syncing")
      setKick((k) => k + 1)
    }
  }

  /** Takes in a stored copy (fetched, or pushed to us live): merged in if it is newer than what this browser last saw */
  const ingest = useCallback(
    async (doc: CloudDoc, source: "pull" | "live", canProceed: () => boolean): Promise<"updated" | "same" | "failed"> => {
      const ing = ingestorRef.current
      if (!ing) return "failed" // not yet created: only possible before the first effect has run
      const out = await ing.ingest(doc, source, canProceed)
      if (out.kind === "failed") {
        if (out.reason === "unprotected") setStatus("offline")
        // Set aside, not dropped: the lock's release (or the end of the pause) fetches and applies it again
        if (out.reason === "deferred") deferredRef.current = true
        return "failed"
      }
      if (out.kind === "merged" || out.kind === "landed") {
        // Only "synced" when nothing is still waiting to be sent
        setStatus(pendingAfterMerge.current ? "syncing" : "synced")
        if (pendingAfterMerge.current) setKick((k) => k + 1)
        if (!pendingAfterMerge.current) stamp()
        return out.kind === "merged" && out.changed ? "updated" : "same"
      }
      const parsed = parseFullBackup(doc.data)
      if (!parsed.ok) return "failed"
      if (lastJson.current === null) lastJson.current = fingerprint(parsed.data)
      if (fingerprint(dataRef.current) !== lastJson.current) {
        setStatus("syncing") // this device has changes the stored copy lacks; they are sent next
        setKick((k) => k + 1)
        return "same"
      }
      setStatus("synced")
      return "same"
    },
    [],
  )

  /** Fetches the stored copy and adopts it if it is newer than what this browser last saw */
  const pull = useCallback(async (): Promise<"updated" | "same" | "none" | "failed"> => {
    const owner = ownerRef.current
    if (!owner || (pausedRef.current || isDemoLive())) return "none"
    if (lockHolder() !== null) {
      deferredRef.current = true // a restore or reset is replacing the data: fetched again when it is over
      return "none"
    }
    // True while it is still right to apply incoming data for this owner: same account and epoch, not paused, nothing replacing the data
    const epoch = epochRef.current
    const can = () => ownerRef.current === owner && !(pausedRef.current || isDemoLive()) && epochRef.current === epoch && lockHolder() === null
    if (isOffline()) {
      setStatus("offline") // no waiting on a network that is known to be down
      return "failed"
    }
    try {
      const doc = await withTimeout(cloudGet(owner), PULL_TIMEOUT)
      if (!doc) return "none"
      return await ingest(doc, "pull", can)
    } catch {
      setStatus("offline")
      return "failed"
    }
  }, [ingest])

  const push = useCallback(async () => {
    const owner = ownerRef.current
    if (!owner || busy.current || (pausedRef.current || isDemoLive())) return // never while demo data is on screen, even from a timer set earlier
    if (lockHolder() !== null) {
      deferredRef.current = true // not while data is being replaced: sent when the lock is released
      return
    }
    // After a restart nothing is known about what the stored copy holds. The copy last confirmed by a successful write
    // (the sync base) says what has been sent, so changes that were still waiting when the app closed are sent now,
    // and nothing is re-sent when there are none.
    if (lastJson.current === null) {
      const b = await loadBase()
      if (b) lastJson.current = fingerprint(b.data)
      if (busy.current || ownerRef.current !== owner) return
    }
    const now = fingerprint(dataRef.current)
    if (now === lastJson.current) {
      setStatus((st) => (st === "syncing" ? "synced" : st)) // a send that turned out to be unnecessary must not leave "Syncing…" showing
      return
    }
    if (isOffline()) {
      setStatus("offline") // the change is already saved on this device; it is sent when the connection returns
      return
    }
    if (!normalizeRev(revRef.current).ok) {
      // The recorded revision cannot be used for a write. Forget it and rebuild from the stored copy instead of sending against NaN.
      revCorruptRef.current = true
      revRef.current = null
      write(REV_KEY, null)
      await pull()
      return
    }
    busy.current = true
    setStatus("syncing")
    const sent = current()
    // The marker is written down before the request and removed only by a definite answer (see putTracked)
    let r: Awaited<ReturnType<typeof putTracked>>
    try {
      r = await putTracked(ledger, boundedPut, owner, buildBackup(sent, false), revRef.current, async (rev) => {
        if (ownerRef.current !== owner) return // signed out meanwhile: this account's revision must not be recorded for another
        await setBase(sent, rev) // the base first, then the revision it is at
        revRef.current = rev
        write(REV_KEY, String(rev))
        lastJson.current = now
      })
    } catch {
      r = { ok: false, reason: "unavailable" } // never leave the sync marked busy, or nothing is sent until the page is reloaded
    }
    busy.current = false
    if (r.ok && ownerRef.current === owner) {
      // Only now, after the store confirmed the write, is anything called synced
      warnedLarge.current = false
      retryWait.current = RETRY_FIRST
      if (retryTimer.current) clearTimeout(retryTimer.current)
      setStatus("synced")
      stamp()
    } else if (r.ok) {
      /* the account changed while this was being sent: nothing here belongs to the new account */
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
      // Its marker stays too, so the next read of the stored copy can tell whether it landed (see decideIngest).
      setStatus("offline")
      if (retryTimer.current) clearTimeout(retryTimer.current)
      retryTimer.current = setTimeout(() => void pushRef.current(), retryWait.current)
      retryWait.current = Math.min(retryWait.current * 2, RETRY_MAX)
    }
    if (missedRef.current) {
      missedRef.current = false
      void pull()
    }
  }, [pull, ledger])
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
    epochRef.current++ // the account, the pause state or the loaded data changed: work started under the old ones must not apply anything
    let cancelled = false
    const done = () => !cancelled && setReady(true)

    accountIdRef.current = accountId
    if (!accountId) {
      ownerRef.current = null
      revRef.current = null
      lastJson.current = null
      prompts.clear() // signed out or the sign-in failed: no half-finished choice follows the next account
      connectGen.current++
      setStatus("off")
      done()
      return
    }

    // Demo data must never be read as "what's really in this browser" or pushed anywhere; wait it out and catch up
    // for real once it ends (paused re-running this effect is what makes that happen)
    if (paused) {
      prompts.clear() // a comparison made from the real data must not be answered while other data is on screen; it is rebuilt when this ends
      connectGen.current++ // and a comparison still being built must not appear while it is paused
      setStatus("paused")
      done()
      return
    }

    const at = read(AT_KEY)
    setLastAt(at ? Number(at) : null)

    if (read(OWNER_KEY) === accountId) {
      // Already connected in this browser: pick up where it left off
      ownerRef.current = accountId
      if (read(DATA_OWNER_KEY) === null) write(DATA_OWNER_KEY, accountId)
      const rev = normalizeRev(read(REV_KEY))
      if (rev.ok) revRef.current = rev.rev
      else {
        // Never let a damaged revision (NaN, negative, fractional) into arithmetic: forget it; the next read rebuilds from the stored copy
        revCorruptRef.current = true
        revRef.current = null
        write(REV_KEY, null)
      }
      setStatus("syncing")
      void pull().then(done)
      return () => {
        cancelled = true
      }
    }

    // First time this account is used in this browser. lib/signin-reconcile.ts decides what to do. A failure to READ the account's
    // copy is never taken for an empty account; nothing here is replaced, merged or sent without the safeguards that file
    // describes, and when both sides hold different data (or the data here belongs to another account) the person chooses.
    setStatus("syncing")
    void setBase(null)
    void ledger.clearAll() // anything uncertain belonged to a previous account
    revCorruptRef.current = false
    prompts.clear()
    let retryAt: ReturnType<typeof setTimeout> | undefined
    let wait = RETRY_FIRST
    const later = () => {
      clearTimeout(retryAt)
      retryAt = setTimeout(() => void connect(), wait)
      wait = Math.min(wait * 2, RETRY_MAX)
    }
    const connect = async (notice?: string) => {
      if (cancelled || ownerRef.current === accountId || prompts.current) return
      const gen = ++connectGen.current
      setStatus("syncing")
      let cloud: CloudRead
      try {
        const doc = await withTimeout(cloudGet(accountId), PULL_TIMEOUT)
        cloud = doc ? { kind: "doc", doc } : { kind: "none" }
      } catch {
        cloud = { kind: "unavailable" }
      }
      if (cancelled || gen !== connectGen.current) return // closed, paused, or a newer attempt took over while this was reading
      if (pausedRef.current || isDemoLive() || lockHolder() !== null) {
        // a restore, reset or demo is replacing the data: decide nothing now, look again shortly
        setStatus("syncing")
        later()
        return
      }
      try {
        const device = current()
        const plan = planFirstSignIn({ device, cloud, accountId, dataOwner: read(DATA_OWNER_KEY) })
        if (plan.kind === "unavailable" || plan.kind === "unreadable") {
          setStatus("offline") // this device's data is untouched; the sign-in is retried by itself
          later()
        } else if (plan.kind === "nothing" || plan.kind === "upload") {
          if (plan.kind === "nothing" && plan.rev !== null) {
            await setBase(device, plan.rev)
            connected(accountId, plan.rev, device) // an empty copy already exists: nothing to send
          } else {
            const r = await boundedPut(accountId, buildBackup(device, false), plan.rev)
            if (cancelled) return
            if (r.ok) {
              await setBase(device, r.rev)
              connected(accountId, r.rev, device) // synced = the snapshot that was uploaded, not whatever the data is by now
            } else {
              setStatus("offline")
              later()
            }
          }
        } else if (plan.kind === "take-account") {
          await takeCloud(plan.data, plan.rev) // this device holds nothing, so there is nothing to replace
          adopt(accountId, plan.rev, fingerprint(plan.data))
        } else if (plan.kind === "adopt") {
          await setBase(plan.data, plan.rev) // both sides already say the same thing
          connected(accountId, plan.rev, plan.data)
        } else {
          prompts.show(plan.offer, notice ?? null)
          setStatus("needs-choice")
        }
      } catch {
        if (!cancelled) {
          setStatus("offline")
          later()
        }
      }
    }
    connectRef.current = connect
    const onOnline = () => void connect()
    window.addEventListener("online", onOnline)
    void connect().then(done)
    return () => {
      cancelled = true
      clearTimeout(retryAt)
      window.removeEventListener("online", onOnline)
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
        if (pausedRef.current || isDemoLive() || lockHolder() !== null) {
          deferredRef.current = true // kept for later: retried when the lock is released, or when the pause ends
          return
        }
        const epoch = epochRef.current
        const can = () => ownerRef.current === accountId && !(pausedRef.current || isDemoLive()) && epochRef.current === epoch && lockHolder() === null
        void ingest(doc, "live", can).then((r) => {
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

  /** Explicit full-page Google flow when a browser closes popup sign-in prematurely. */
  const signInRedirect = async (): Promise<string | null> => {
    if (cloudKind() === "dev") return "Full-page Google sign-in is available only with real Google Authentication."
    if (cloudKind() === "none") return "Google sign-in is not configured for this deployment."
    const r = await signInWithGoogle(true)
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

  /** True once this device's own storage (not just the screen) holds exactly `d` */
  const verifyDevice = async (d: FullBackupData): Promise<boolean> => {
    const end = Date.now() + 5000
    while (Date.now() < end) {
      const cur = current()
      const [subjects, tasks, tags, mates, holidays, scheduleOverrides] = await Promise.all([
        dbGet("subjects"), dbGet("tasks"), dbGet("tags"), dbGet("mates"), dbGet("holidays"), dbGet("scheduleOverrides"),
      ])
      if (
        same(cur.subjects, d.subjects) && same(cur.tasks, d.tasks) && same(cur.tags, d.tags) && same(cur.mates, d.mates) && same(cur.reminders, d.reminders) &&
        same(cur.holidays, d.holidays) && same(cur.scheduleOverrides, d.scheduleOverrides) &&
        same(subjects, d.subjects) && same(tasks, d.tasks) && same(tags, d.tags) && same(mates, d.mates) &&
        same(holidays, d.holidays) && same(scheduleOverrides, d.scheduleOverrides)
      )
        return true
      await new Promise((r) => setTimeout(r, 150))
    }
    return false
  }

  /**
   * Carries out the option the person chose. Returns an error message, or null when it finished and was verified.
   * `confirmed` must be true for the options that replace data. Nothing is marked as synced unless the result checks out.
   * (The rules - one run at a time, only for the comparison and account it was made for - are runChoice in lib/signin-reconcile.ts.)
   */
  const chooseReconcile = (choice: Choice, confirmed: boolean): Promise<string | null> =>
    runChoice(
      {
        prompts,
        accountId: () => accountIdRef.current,
        paused: () => pausedRef.current || isDemoLive(),
        deps: {
          getDevice: current,
          applyDevice: (d) => {
            applyRef.current(d)
            saveSchedule(d.reminders)
          },
          verifyDevice,
          saveRestorePoint,
          listRestorePoints,
          cloudGet: boundedGet, // a read that never answers must not hold the lock
          cloudPut: boundedPut,
        },
        // The device holds this account's choice from the moment its data is replaced, so the next account is not told it is the previous owner's
        deviceReplaced: (owner) => write(DATA_OWNER_KEY, owner),
        finalize: async (owner, res, picked) => {
          await setBase(res.data, res.rev)
          pendingAfterMerge.current = false
          // Synced = the snapshot the choice produced and verified. Edits made while it waited on the network are not in it: they are sent next.
          connected(owner, res.rev, res.data)
          notifyRef.current(
            picked === "merge"
              ? "Signed in. Your data and your account’s data were combined."
              : picked === "device"
                ? "Signed in. This device’s data is now your account’s copy."
                : "Signed in. This device now shows your account’s data.",
          )
        },
        rebuild: (notice) => connectRef.current(notice),
      },
      choice,
      confirmed,
    )
  const declineReconcile = () => {
    const p = prompts.current
    if (p) prompts.patch(p.id, { declined: true, error: null })
  }
  const reopenReconcile = () => {
    const p = prompts.current
    if (p) prompts.patch(p.id, { declined: false })
  }

  /** Signs out of this browser. Nothing is deleted: the stored copy and this browser's data both stay. */
  const signOut = async () => {
    clearTimeout(retryTimer.current)
    epochRef.current++ // anything fetched for this account must not be applied now
    deferredRef.current = false
    for (const k of [OWNER_KEY, REV_KEY, AT_KEY]) write(k, null) // DATA_OWNER_KEY stays: it says whose data this device still holds
    prompts.clear()
    connectGen.current++
    ownerRef.current = null
    revRef.current = null
    revCorruptRef.current = false
    lastJson.current = null
    await ledger.clearAll() // belongs to the account being left
    await setBase(null)
    setStatus("off")
    setLastAt(null)
    // Everything on this device that could push or pull for the account is detached above, before any network wait. Without Firebase
    // keys there is no account to sign out of, so a local-only device can still be reset; a real sign-out failure is NOT swallowed.
    await signOutIfConfigured(cloudKind(), signOutAccount)
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

  // Incoming data (or a push) that was set aside while a restore, reset or demo transition held the lock is handled when it ends
  useEffect(
    () =>
      onRelease(() => {
        if (!deferredRef.current) return
        deferredRef.current = false
        void syncRef.current()
      }),
    [],
  )

  return {
    kind: cloudKind(), account, ready, status, pending, realtime, lastAt, switchPlan, confirmSwitch, cancelSwitch, signIn, signInRedirect, signOut, syncNow,
    reconcile: paused ? null : prompt, chooseReconcile, declineReconcile, reopenReconcile,
  }
}

export type CloudSync = ReturnType<typeof useCloudSync>
