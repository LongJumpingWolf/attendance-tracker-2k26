/**
 * Replacing or wiping everything on this device (restoring a backup or a restore point, resetting) with one rule, in this order:
 *
 *   0. REFUSE if the demo is on screen (what is "current" would then be sample data) or another replacement is running (one lock,
 *      lib/operation-lock.ts, shared with the demo and with sign-in choices);
 *   1. SAVE a safety copy of what is here now, and read it back (saveRestorePoint does both and throws if it cannot);
 *   2. look again: if the data or the reminders changed while the copy was being saved, the copy is stale, so it is made again
 *      (a few tries) or the whole thing is abandoned. Nothing is replaced on the strength of an out-of-date copy;
 *   3. check the demo once more, immediately before the first change;
 *   4. only then CHANGE anything, and read the result back from where it is kept (the data in storage, the reminders);
 *   5. report what really happened. A success message exists only on the path where the change was made AND found in storage.
 *
 * If step 0-3 fail, nothing is touched: not the subjects, deadlines, tags or mates, and not the reminders (which live in their own
 * storage). If a later step fails, the safety copy stays where it is, the previous data is put back where possible, and the message
 * says what is and is not true. It is the one backup mechanism of the app (lib/restore-points.ts); this file adds no storage.
 */
import type { FullBackupData } from "./backup"
import type { BackupData } from "./backup-import"
import { same } from "./merge"
import { BUSY_MESSAGE, tryAcquire } from "./operation-lock"
import { holdsSomething, RestorePointError } from "./restore-points"

export type ReplaceResult = { ok: true } | { ok: false; message: string }

const SPACE_ADVICE = " If storage is full, delete older restore points under Settings > Backup & restore, then try again."

export const MESSAGES = {
  restoreNotSaved: "Couldn’t save a safety copy first, so your data was not replaced." + SPACE_ADVICE,
  resetNotSaved: "Couldn’t save a safety copy first, so nothing was reset." + SPACE_ADVICE,
  restoreUnexpected: "Something went wrong before anything was replaced, so your data is unchanged.",
  resetUnexpected: "Something went wrong before anything was reset, so your data is unchanged.",
  restoreHalfDone: "Couldn’t finish restoring. Your previous data is saved under Restore points.",
  resetHalfDone: "Couldn’t finish the reset. Your previous data is saved under Restore points.",
  restoreHalfDoneNoCopy: "Couldn’t finish restoring.",
  resetHalfDoneNoCopy: "Couldn’t finish the reset.",
  restoreNotKept: "The restored data couldn’t be saved on this device, so it was not kept. Your previous data was put back and is also saved under Restore points.",
  restoreNotKeptNoCopy: "The restored data couldn’t be saved on this device, so it was not kept. Your previous data was put back.",
  resetNotKept: "The reset didn’t fully finish: some data is still stored on this device. Your previous data is saved under Restore points.",
  resetNotKeptNoCopy: "The reset didn’t fully finish: some data is still stored on this device.",
  restoreFailed: "Couldn’t restore the backup. Nothing was changed.",
  resetFailed: "Couldn’t reset. Nothing was changed.",
  demo: "The demo is on screen, so nothing was changed. End the demo first.",
  busy: BUSY_MESSAGE,
  changedWhileSaving: "Your data changed while the safety copy was being saved, so nothing was replaced. Try again.",
  signOutFailed: "Couldn’t sign out first, so nothing was reset. Your data is unchanged. Syncing on this device stays off until you reload the page.",
  signOutTimedOut: "Signing out is taking too long, so nothing was reset. Your data is unchanged. Syncing on this device stays off until you reload the page.",
  restoreUnconfirmed:
    "The restore was applied, but it couldn’t be confirmed as saved because your data changed at the same time. Nothing was undone. Your previous data is saved under Restore points.",
  restoreUnconfirmedNoCopy: "The restore was applied, but it couldn’t be confirmed as saved because your data changed at the same time. Nothing was undone.",
  restorePutBackUnverified:
    "The restored data couldn’t be saved on this device, and putting your previous data back couldn’t be confirmed. Your previous data is saved under Restore points: restore it from there.",
  restorePutBackUnverifiedNoCopy: "The restored data couldn’t be saved on this device, and putting your previous data back couldn’t be confirmed. Check your subjects, deadlines and reminders.",
} as const

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls `check` (React applies a state change a moment after it is asked for) until it holds or `ms` has passed */
async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  for (;;) {
    if (check()) return true
    if (Date.now() >= end) return false
    await sleep(25)
  }
}

/** The part of a copy that lives in the app's data storage (reminders have their own) */
const dataPart = (d: BackupData) => ({ subjects: d.subjects, tasks: d.tasks, tags: d.tags, mates: d.mates ?? [], holidays: d.holidays ?? [], scheduleOverrides: d.scheduleOverrides ?? [] })

/** How long reset waits for the account to sign out before giving up (nothing has been wiped at that point) */
export const SIGN_OUT_TIMEOUT_MS = 8000

/** A restore request. `unrecorded` names lists an older restore point never recorded: those are left as they are, not emptied. */
export interface RestoreRequest extends BackupData {
  unrecorded?: ("tags" | "mates" | "holidays" | "scheduleOverrides")[]
}

export interface ReplaceDeps {
  /** this device's data and reminders exactly as they are NOW (read fresh every time it is called) */
  current: () => FullBackupData
  /** the one backup mechanism; must throw if the copy cannot be saved and read back */
  saveRestorePoint: (reason: string, data: FullBackupData) => Promise<void>
  /** true while demo data is on screen. Must read the live value, not a render-time copy. */
  demoActive: () => boolean
}

/** How many times a safety copy is remade when the data changes under it */
const COPY_TRIES = 3

type Msg = { notSaved: string; unexpected: string; halfDone: string; halfDoneNoCopy: string }

async function protectThenChange(
  who: string,
  reason: string,
  msg: Msg,
  deps: ReplaceDeps,
  change: (before: FullBackupData) => Promise<ReplaceResult> | ReplaceResult,
): Promise<ReplaceResult> {
  if (deps.demoActive()) return { ok: false, message: MESSAGES.demo }
  const release = tryAcquire(who)
  if (!release) return { ok: false, message: MESSAGES.busy }
  try {
    let before: FullBackupData | null = null
    for (let i = 0; i < COPY_TRIES && !before; i++) {
      const candidate = deps.current()
      try {
        await deps.saveRestorePoint(reason, candidate)
      } catch (e) {
        // Not protected: nothing is changed, whatever the reason the copy failed
        return { ok: false, message: e instanceof RestorePointError ? msg.notSaved : msg.unexpected }
      }
      if (deps.demoActive()) return { ok: false, message: MESSAGES.demo }
      if (same(candidate, deps.current())) before = candidate // still what the copy holds
    }
    if (!before) return { ok: false, message: MESSAGES.changedWhileSaving }
    if (deps.demoActive()) return { ok: false, message: MESSAGES.demo } // immediately before the first change
    try {
      return await change(before)
    } catch {
      return { ok: false, message: holdsSomething(before) ? msg.halfDone : msg.halfDoneNoCopy }
    }
  } finally {
    release()
  }
}

export interface RestoreDeps extends ReplaceDeps {
  /** replace subjects, deadlines, tags and mates */
  applyData: (d: BackupData) => void
  /** replace the reminders (their own storage). Called only after the safety copy has been saved. */
  applyReminders: (reminders: NonNullable<BackupData["reminders"]>) => void
  /** the reminders as they are STORED now (read back, not the value that was just written) */
  readReminders: () => NonNullable<BackupData["reminders"]>
  /** true once this device's storage holds exactly `d`'s subjects, deadlines, tags and mates (the app persists them asynchronously) */
  dataPersisted: (d: BackupData) => Promise<boolean>
}

/** Restoring a backup file or a restore point */
export function restoreFrom(request: RestoreRequest, deps: RestoreDeps): Promise<ReplaceResult> {
  return protectThenChange(
    "restore",
    "Before restoring a backup",
    { notSaved: MESSAGES.restoreNotSaved, unexpected: MESSAGES.restoreUnexpected, halfDone: MESSAGES.restoreHalfDone, halfDoneNoCopy: MESSAGES.restoreHalfDoneNoCopy },
    deps,
    async (before) => {
      // What an older point never recorded is not "none": this device's own tags/mates stay
      const incoming: BackupData = {
        ...request,
        tags: request.unrecorded?.includes("tags") ? before.tags : request.tags,
        mates: request.unrecorded?.includes("mates") ? before.mates : request.mates,
        holidays: request.unrecorded?.includes("holidays") || request.holidays === undefined ? before.holidays ?? [] : request.holidays,
        scheduleOverrides: request.unrecorded?.includes("scheduleOverrides") || request.scheduleOverrides === undefined ? before.scheduleOverrides ?? [] : request.scheduleOverrides,
      }
      const withReminders = Boolean(incoming.full && incoming.reminders)
      const kept = holdsSomething(before)
      deps.applyData(incoming)
      // A full backup brings the reminders back exactly as saved; one without them leaves the reminders alone
      if (withReminders) deps.applyReminders(incoming.reminders!)
      const remindersOk = !withReminders || same(deps.readReminders(), incoming.reminders)
      const dataOk = await deps.dataPersisted(incoming)
      if (remindersOk && dataOk) return { ok: true }

      // Not confirmed. Undo ONLY if nothing else has changed the data since we applied it: an old snapshot must never be put over
      // a legitimate concurrent update (the person editing, a sync merge) just because the expected state was not observed.
      const untouched = await waitFor(() => same(dataPart(deps.current()), dataPart(incoming)), 1500)
      if (!untouched) return { ok: false, message: kept ? MESSAGES.restoreUnconfirmed : MESSAGES.restoreUnconfirmedNoCopy }
      try {
        deps.applyData(before)
        if (withReminders && remindersOk) deps.applyReminders(before.reminders) // the reminders were written: write the old ones back
      } catch {
        /* judged by the read-back below */
      }
      // The put-back is a claim like any other: it is only made once it is found in storage and on screen
      const back =
        (await waitFor(() => same(dataPart(deps.current()), dataPart(before)), 1500)) &&
        (await deps.dataPersisted(before)) &&
        (!withReminders || same(deps.readReminders(), before.reminders))
      if (back) return { ok: false, message: kept ? MESSAGES.restoreNotKept : MESSAGES.restoreNotKeptNoCopy }
      return { ok: false, message: kept ? MESSAGES.restorePutBackUnverified : MESSAGES.restorePutBackUnverifiedNoCopy }
    },
  )
}

export interface ResetDeps extends ReplaceDeps {
  /** Ends the account link first, so a reset can never push an empty copy to the account. Throws if it cannot. */
  signOut: () => Promise<void>
  /** Overrides SIGN_OUT_TIMEOUT_MS (tests) */
  signOutTimeoutMs?: number
  /** wipe the data, the reminders and everything else this device keeps */
  clear: () => void | Promise<void>
  /** true once nothing the reset removes is still stored */
  isCleared: () => Promise<boolean>
}

/** "Start fresh" */
export function resetEverything(deps: ResetDeps): Promise<ReplaceResult> {
  return protectThenChange(
    "reset",
    "Before reset",
    { notSaved: MESSAGES.resetNotSaved, unexpected: MESSAGES.resetUnexpected, halfDone: MESSAGES.resetHalfDone, halfDoneNoCopy: MESSAGES.resetHalfDoneNoCopy },
    deps,
    async (before) => {
      // Keep the authenticated account signed in. Clearing the account's local state allows the normal
      // authenticated sync pipeline to publish an empty state for this UID; signing out here previously
      // prevented that and made Reset merely look like a logout.
      if (deps.demoActive()) return { ok: false, message: MESSAGES.demo }
      // The sign-out took time: if the data moved meanwhile, the copy taken earlier is stale, so another is taken first
      const now = deps.current()
      if (!same(now, before)) {
        try {
          await deps.saveRestorePoint("Before reset", now)
        } catch {
          return { ok: false, message: MESSAGES.resetNotSaved }
        }
        if (!same(now, deps.current())) return { ok: false, message: MESSAGES.changedWhileSaving }
        if (deps.demoActive()) return { ok: false, message: MESSAGES.demo }
      }
      await deps.clear()
      if (!(await deps.isCleared())) return { ok: false, message: holdsSomething(before) ? MESSAGES.resetNotKept : MESSAGES.resetNotKeptNoCopy }
      return { ok: true }
    },
  )
}

/**
 * Runs an action that answers whether it really happened, and calls `onDone` ONLY if it did. A refusal or an exception
 * never reaches `onDone`, so a success message placed there cannot appear for something that did not happen.
 * (The action reports its own reason for a refusal; `onThrown` covers an exception it did not catch.)
 */
export async function runGuarded(action: () => Promise<boolean> | boolean, onDone: () => void, onThrown: () => void): Promise<boolean> {
  let ok = false
  try {
    ok = await action()
  } catch {
    onThrown()
    return false
  }
  if (ok) onDone()
  return ok
}
