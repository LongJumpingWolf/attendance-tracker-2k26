/**
 * What happens to the data on this device and the data in the account when someone signs in with Google for the first time
 * in this browser. Pure decisions and injected steps, so every case is testable without React, Firebase or a browser.
 *
 * It adds NO second merge engine and NO second backup system: combining is `mergeData` (lib/merge.ts), safety copies are
 * restore points (lib/restore-points.ts), and the stored copy is read and written through lib/cloud-sync.ts exactly as the
 * rest of the sync does. This file only decides WHEN to ask, shows the comparison, and carries out the chosen option with
 * the safeguards in a fixed order: protect first (and verify the protection), change second, verify the result last.
 *
 * Rules it enforces (each is a test in tests/signin-reconcile.test.ts):
 *  - failing to read the account's copy is NEVER read as "the account is empty";
 *  - data that belonged to a different account is never combined into this one without an explicit, confirmed choice;
 *  - replacing anything needs an explicit confirmation AND a restore point that has been read back and checked;
 *  - nothing is called complete until the result has been read back (stored copy, or the device's own storage);
 *  - every step can be repeated: the merge is idempotent and writes are compare-and-set on the revision.
 */
import { buildBackup, parseFullBackup, type FullBackupData } from "./backup"
import { mergeData, same } from "./merge"
import type { CloudDoc, PutResult } from "./cloud-sync"
import { holdsSomething, type RestorePoint } from "./restore-points"
import { BUSY_MESSAGE, tryAcquire } from "./operation-lock"
import type { Holiday, Mate, ScheduleOverride, Subject, Task } from "./types"
import type { ScheduleEntry } from "./reminders"

export type Choice = "merge" | "device" | "cloud"

// ---- what is in a copy -----------------------------------------------------------------------------------------------

export interface Counts {
  subjects: number
  marks: number
  tasks: number
  tags: number
  mates: number
  reminders: number
  holidays: number
  scheduleChanges: number
}

export const marksOf = (s: Subject) => s.log?.length ?? 0

export const countsOf = (d: FullBackupData): Counts => ({
  subjects: d.subjects.length,
  marks: d.subjects.reduce((n, s) => n + marksOf(s), 0),
  tasks: d.tasks.length,
  tags: d.tags.length,
  mates: d.mates.length,
  reminders: d.reminders.length,
  holidays: d.holidays?.length ?? 0,
  scheduleChanges: d.scheduleOverrides?.length ?? 0,
})

/**
 * A mate worth protecting: one that carries ledger history (favours covered or repaid, with their dates and Ping ids). That
 * history exists only on the devices that recorded it. A mate row WITHOUT history is just an accepted connection, which the
 * app re-creates by itself from the connection list (see "Accepted connections appear in the favour ledger" in app/page.tsx),
 * so a fresh device can already hold some. They are not user data, but they still travel with the merge like everything else.
 */
export const hasHistory = (m: Mate): boolean =>
  m.covered > 0 || m.repaid > 0 || (m.coveredLog?.length ?? 0) > 0 || (m.repaidLog?.length ?? 0) > 0 || (m.coveredPings?.length ?? 0) > 0

/** The copy as the decisions below see it: bare connections left out */
export const meaningful = (d: FullBackupData): FullBackupData => ({ ...d, mates: d.mates.filter(hasHistory) })

/** Anything the person created. (A fresh install holds none of it: the demo data only lives in memory.) */
export const hasUserData = (d: FullBackupData): boolean => {
  const m = meaningful(d)
  return m.subjects.length + m.tasks.length + m.tags.length + m.mates.length + m.reminders.length + (m.holidays?.length ?? 0) + (m.scheduleOverrides?.length ?? 0) > 0
}

/**
 * Whether a restore point can hold this copy: anything with subjects, deadlines, tags, mates or reminders. (It used to leave out
 * tags and reminders, so a copy that was only those could not be protected and replacing it was not offered. Restore points now
 * keep them, and this is the same rule as theirs.)
 */
export const restorable = (d: FullBackupData): boolean => holdsSomething(d)

export const emptyData = (): FullBackupData => ({ subjects: [], tasks: [], tags: [], mates: [], reminders: [], holidays: [], scheduleOverrides: [] })

// ---- the comparison --------------------------------------------------------------------------------------------------

export interface ConflictItem {
  kind: "subject" | "deadline" | "mate" | "reminder" | "holiday" | "class-change"
  name: string
}

export interface Comparison {
  device: Counts
  account: Counts
  /** present on both sides, as the merge engine itself pairs them (same id, or same name for subjects and mates) */
  both: Counts
  onlyDevice: Counts
  onlyAccount: Counts
  /** fields that differ and have no shared starting point; the merge keeps this device's value and saves the other copy */
  conflicts: number
  conflictItems: ConflictItem[]
  /** the two copies say the same thing */
  identical: boolean
}

const KEYS: (keyof Counts)[] = ["subjects", "marks", "tasks", "tags", "mates", "reminders", "holidays", "scheduleChanges"]
const zero = (): Counts => ({ subjects: 0, marks: 0, tasks: 0, tags: 0, mates: 0, reminders: 0, holidays: 0, scheduleChanges: 0 })
const norm = (s: string) => s.trim().toLowerCase()

/**
 * The counts come from the merge engine itself: an item present on both sides collapses into one in the merged copy, so
 * "on both" is local + account - merged. The comparison therefore can never disagree with what a merge would do.
 */
export function compareData(device: FullBackupData, account: FullBackupData): Comparison {
  const { data: merged, conflicts } = mergeData(null, device, account)
  const d = countsOf(device)
  const a = countsOf(account)
  const m = countsOf(merged)
  const both = zero()
  const onlyDevice = zero()
  const onlyAccount = zero()
  for (const k of KEYS) {
    both[k] = Math.max(0, d[k] + a[k] - m[k])
    onlyDevice[k] = Math.max(0, d[k] - both[k])
    onlyAccount[k] = Math.max(0, a[k] - both[k])
  }

  const items: ConflictItem[] = []
  const one = <T,>(l: T, r: T, wrap: (x: T) => FullBackupData) => mergeData(null, wrap(l), wrap(r)).conflicts > 0
  for (const l of device.subjects) {
    const r = account.subjects.find((x) => x.id === l.id) ?? account.subjects.find((x) => norm(x.name) === norm(l.name))
    if (r && one<Subject>(l, r, (s) => ({ ...emptyData(), subjects: [s] }))) items.push({ kind: "subject", name: l.name })
  }
  for (const l of device.tasks) {
    const r = account.tasks.find((x) => x.id === l.id)
    if (r && one<Task>(l, r, (t) => ({ ...emptyData(), tasks: [t] }))) items.push({ kind: "deadline", name: l.title })
  }
  for (const l of device.mates) {
    const r = account.mates.find((x) => x.id === l.id) ?? (l.uid ? account.mates.find((x) => x.uid === l.uid) : undefined)
    if (r && one<Mate>(l, r, (x) => ({ ...emptyData(), mates: [x] }))) items.push({ kind: "mate", name: l.name })
  }
  for (const l of device.reminders) {
    const r = account.reminders.find((x) => x.id === l.id)
    if (r && one<ScheduleEntry>(l, r, (x) => ({ ...emptyData(), reminders: [x] }))) items.push({ kind: "reminder", name: l.subjectName })
  }
  for (const l of device.holidays ?? []) {
    const r = (account.holidays ?? []).find((x) => x.id === l.id)
    if (r && one(l, r, (x) => ({ ...emptyData(), holidays: [x] }))) items.push({ kind: "holiday", name: l.name })
  }
  for (const l of device.scheduleOverrides ?? []) {
    const r = (account.scheduleOverrides ?? []).find((x) => x.originalSubjectId === l.originalSubjectId && x.date === l.date && x.start === l.start)
    if (r && one(l, r, (x) => ({ ...emptyData(), scheduleOverrides: [x] }))) items.push({ kind: "class-change", name: `${l.kind === "cancelled" ? "Cancelled" : "Substituted"} class · ${l.date} ${l.start}` })
  }

  const identical = conflicts === 0 && KEYS.every((k) => onlyDevice[k] === 0 && onlyAccount[k] === 0)
  return { device: d, account: a, both, onlyDevice, onlyAccount, conflicts, conflictItems: items, identical }
}

// ---- deciding what to do ---------------------------------------------------------------------------------------------

/** What reading the account's stored copy produced. A failed read is its own case and is never "empty". */
export type CloudRead =
  | { kind: "doc"; doc: CloudDoc }
  | { kind: "none" }
  | { kind: "unavailable" }

export interface OptionState {
  choice: Choice
  enabled: boolean
  /** shown when the option is disabled, or to say what it does */
  note: string
  /** needs the person's explicit confirmation before it runs */
  destructive: boolean
}

export interface Offer {
  comparison: Comparison
  /** this device's data was last tied to a different account */
  foreign: boolean
  accountHasData: boolean
  recommended: Choice | null
  options: OptionState[]
  rev: number | null
}

export type Plan =
  | { kind: "unavailable" }
  | { kind: "unreadable" }
  /** nothing on either side: connect with nothing to combine */
  | { kind: "nothing"; rev: number | null }
  /** the account has nothing; this device's data becomes the account's copy (non-destructive: there is nothing to replace) */
  | { kind: "upload"; rev: number | null }
  /** this device has nothing; the account's copy becomes this device's data (non-destructive: there is nothing to replace) */
  | { kind: "take-account"; data: FullBackupData; rev: number }
  /** both say the same thing */
  | { kind: "adopt"; data: FullBackupData; rev: number }
  | { kind: "choose"; offer: Offer; account: FullBackupData }

export interface PlanInput {
  device: FullBackupData
  cloud: CloudRead
  accountId: string
  /** the account this device's data was last synced with (kept across sign-out), or null when it never was */
  dataOwner: string | null
}

export function planFirstSignIn(input: PlanInput): Plan {
  const { device, cloud, accountId, dataOwner } = input
  if (cloud.kind === "unavailable") return { kind: "unavailable" }
  const foreign = dataOwner !== null && dataOwner !== accountId && hasUserData(device)

  let account: FullBackupData | null = null
  let rev: number | null = null
  if (cloud.kind === "doc") {
    const parsed = parseFullBackup(cloud.doc.data)
    if (!parsed.ok) return { kind: "unreadable" } // a copy we cannot read is not an empty one: touch nothing
    account = parsed.data
    rev = cloud.doc.rev
  }
  const accountHasData = account !== null && hasUserData(account)
  const deviceHasData = hasUserData(device)

  if (!foreign) {
    if (!deviceHasData && !accountHasData) return { kind: "nothing", rev }
    if (deviceHasData && !accountHasData) return { kind: "upload", rev }
    if (!deviceHasData && accountHasData && account) return { kind: "take-account", data: account, rev: rev as number }
    if (account && compareData(meaningful(device), meaningful(account)).identical) return { kind: "adopt", data: account, rev: rev as number }
  }

  // Both have data and differ, or this device's data belongs to another account: a real choice
  const comparison = compareData(meaningful(device), meaningful(account ?? emptyData()))
  const canReplaceDevice = !deviceHasData || restorable(device)
  const options: OptionState[] = [
    {
      choice: "merge",
      enabled: accountHasData,
      destructive: false,
      note: accountHasData
        ? "Keeps everything from both. Nothing is removed on either side."
        : "There is nothing in this account yet, so there is nothing to combine.",
    },
    {
      choice: "device",
      enabled: true,
      destructive: accountHasData || foreign,
      note: accountHasData
        ? "Makes this device's data your account's copy. Records that are only in the account are removed from the account's copy (a copy is kept on this device under Restore points)."
        : "Saves this device's data to this account.",
    },
    {
      choice: "cloud",
      enabled: accountHasData && canReplaceDevice,
      destructive: deviceHasData,
      note: !accountHasData
        ? "There is nothing in this account to use."
        : !canReplaceDevice
          ? "Not offered: this device's data cannot be saved as a restore point first, so it would not be recoverable."
          : "Replaces this device's data with your account's. This device's data is saved under Restore points first.",
    },
  ]
  const recommended: Choice | null = foreign ? (accountHasData && canReplaceDevice ? "cloud" : null) : accountHasData ? "merge" : "device"
  return { kind: "choose", offer: { comparison, foreign, accountHasData, recommended, options, rev }, account: account ?? emptyData() }
}

// ---- carrying out a choice -------------------------------------------------------------------------------------------

export interface ApplyDeps {
  /** this device's data right now */
  getDevice: () => FullBackupData
  /** replace this device's data (state and reminders) */
  applyDevice: (d: FullBackupData) => void
  /** true once this device's own storage holds exactly `d` (the app persists it asynchronously) */
  verifyDevice: (d: FullBackupData) => Promise<boolean>
  saveRestorePoint: (reason: string, d: FullBackupData) => Promise<void>
  listRestorePoints: () => Promise<RestorePoint[]>
  cloudGet: (owner: string) => Promise<CloudDoc | null>
  cloudPut: (owner: string, text: string, expectedRev: number | null) => Promise<PutResult>
  /**
   * Says why the choice must not touch this device's data right now, or false: "paused" (demo data on screen), "account" (a
   * different account is signed in than the one this choice belongs to) or "stale" (the comparison it was made from has been
   * replaced or closed). `true` means paused. Checked before the choice starts and again every time it reads or replaces this
   * device's data, so a choice can never run on, or change, data that isn't real or that belongs to someone else.
   */
  blocked?: () => boolean | BlockReason
  /**
   * Called right after this device's data was replaced, even if a later step fails. The device then holds what this choice
   * put there, so whose data it is must be recorded now, not only when everything has finished.
   */
  onDeviceReplaced?: () => void
}

export type BlockReason = "paused" | "account" | "stale"

export type FailReason =
  | "needs-confirmation"
  | "restore-point-failed"
  | "not-offered"
  | "unavailable"
  | "paused"
  | "account-changed"
  | "stale"
  | "device-changed"
  | "changed-elsewhere"
  | "too-large"
  | "apply-failed"
  | "verify-failed"

export type ApplyResult =
  | { ok: true; rev: number; data: FullBackupData; restorePoints: string[] }
  | { ok: false; reason: FailReason; message: string }

const fail = (reason: FailReason, message: string): ApplyResult => ({ ok: false, reason, message })

const MESSAGES: Record<FailReason, string> = {
  "needs-confirmation": "This replaces data, so it needs your confirmation first.",
  "restore-point-failed": "Couldn’t save a safety copy first, so nothing was changed. If storage is full, delete older restore points under Settings > Backup & restore, then try again.",
  "not-offered": "That option isn’t available for this data.",
  unavailable: "Couldn’t reach your account just now. Nothing was lost. You can try again.",
  paused: "Sync is paused (for example while the demo is showing), so nothing was changed. Try again once your own data is on screen.",
  "account-changed": "You signed in with a different account while this was happening, so nothing more was changed.",
  stale: "This comparison was closed or replaced while this was happening, so nothing more was changed. Look at the current comparison and choose again.",
  "device-changed": "Your data changed while the safety copy was being saved, so nothing was replaced. Try again.",
  "changed-elsewhere": "Your account’s copy changed while this was happening, so nothing was replaced. Look at the new comparison and choose again.",
  "too-large": "Your data is too large for cloud backup. Nothing was changed.",
  "apply-failed": "Couldn’t finish saving on this device. Your previous data is under Restore points.",
  "verify-failed": "Couldn’t confirm the result, so it isn’t marked as done. Try again; nothing is duplicated by trying again.",
}

class Unprotected extends Error {}
class Blocked extends Error {
  constructor(readonly why: BlockReason) {
    super(why)
  }
}

const blockReason = (deps: ApplyDeps): BlockReason | null => {
  const b = deps.blocked?.()
  return !b ? null : b === true ? "paused" : b
}
const blockedFailure = (why: BlockReason): ApplyResult => fail(why === "paused" ? "paused" : why === "account" ? "account-changed" : "stale", MESSAGES[why === "paused" ? "paused" : why === "account" ? "account-changed" : "stale"])

/** The same dependencies, except that reading or replacing this device's data throws once `blocked()` says so */
function guarded(deps: ApplyDeps): ApplyDeps {
  const check = () => {
    const why = blockReason(deps)
    if (why) throw new Blocked(why)
  }
  return {
    ...deps,
    getDevice: () => (check(), deps.getDevice()),
    applyDevice: (d) => {
      check()
      deps.applyDevice(d)
      deps.onDeviceReplaced?.() // from here on the device holds what this choice put there, whatever happens next
    },
  }
}

/**
 * Saves a restore point and READS IT BACK. Throws if the copy is not really in the list afterwards. A copy a restore point
 * cannot hold (no subjects, deadlines or mates) is skipped: callers never rely on a point for such a copy.
 */
async function protect(deps: ApplyDeps, reason: string, data: FullBackupData, made: string[]): Promise<void> {
  if (!restorable(data)) return
  try {
    await deps.saveRestorePoint(reason, data)
  } catch {
    throw new Unprotected() // the save itself reported that it could not be written or read back
  }
  const found = (await deps.listRestorePoints()).find((p) => same(p.data, data))
  if (!found) throw new Unprotected()
  made.push(reason)
}

async function readAccount(deps: ApplyDeps, owner: string): Promise<{ doc: CloudDoc | null; data: FullBackupData } | null> {
  const doc = await deps.cloudGet(owner)
  if (!doc) return { doc: null, data: emptyData() }
  const parsed = parseFullBackup(doc.data)
  return parsed.ok ? { doc, data: parsed.data } : null
}

/** The stored copy equals what was just written, read back from the store (not from the write's own answer) */
async function verifyStored(deps: ApplyDeps, owner: string, expected: FullBackupData, rev: number): Promise<boolean> {
  // The store holds JSON, so optional properties whose value is `undefined` disappear on the round trip. Compare against
  // that exact JSON representation (without filtering malformed records) rather than the live object reference. This avoids
  // falsely reporting a failed write for legacy copies with omitted optional arrays while still detecting any dropped item.
  const serializedExpected = JSON.parse(buildBackup(expected, false)).data as FullBackupData
  // A successful transaction can be followed by one stale/failed read in an interrupted or just-reconnected browser. Retry
  // read-back briefly; never treat the write response itself as proof, and never accept a different revision or payload.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const back = await readAccount(deps, owner)
      if (back !== null && back.doc !== null && back.doc.rev >= rev && same(back.data, serializedExpected)) return true
    } catch {
      // Retry the verification, not the write. The write is compare-and-set and remains safe to repeat manually.
    }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 180 * (attempt + 1)))
  }
  return false
}

export async function applyChoice(choice: Choice, offer: Offer, owner: string, confirmed: boolean, rawDeps: ApplyDeps): Promise<ApplyResult> {
  const first = blockReason(rawDeps)
  if (first) return blockedFailure(first)
  const deps = guarded(rawDeps)
  const option = offer.options.find((o) => o.choice === choice)
  if (!option || !option.enabled) return fail("not-offered", MESSAGES["not-offered"])
  if (option.destructive && !confirmed) return fail("needs-confirmation", MESSAGES["needs-confirmation"])
  const made: string[] = []
  try {
    if (choice === "merge") return await doMerge(owner, deps, made)
    if (choice === "device") return await doDevice(owner, offer, deps, made)
    return await doCloud(owner, deps, made)
  } catch (e) {
    if (e instanceof Blocked) return blockedFailure(e.why)
    if (e instanceof Unprotected) return fail("restore-point-failed", MESSAGES["restore-point-failed"])
    return fail("unavailable", MESSAGES.unavailable)
  }
}

/** Both kept. Safe to repeat: merging an already merged copy changes nothing, and the write is compare-and-set. */
async function doMerge(owner: string, deps: ApplyDeps, made: string[]): Promise<ApplyResult> {
  let moved = false // the last attempt ended because the device's data changed under the safety copy
  for (let attempt = 0; attempt < 3; attempt++) {
    moved = false
    const read = await readAccount(deps, owner)
    if (!read) return fail("verify-failed", MESSAGES["verify-failed"]) // the stored copy is not one we can read: change nothing
    const before = deps.getDevice()
    const { data: merged, conflicts } = mergeData(null, before, read.data)
    if (conflicts > 0 || (!same(merged, before) && restorable(before))) {
      await protect(deps, "Before signing in: this device’s data", before, made)
      if (conflicts > 0) await protect(deps, "Your account’s copy", read.data, made)
      // Saving took time. If the person edited meanwhile, `merged` was built from a stale snapshot: applying it would overwrite that
      // edit and the copy just saved would not hold it. Start again from the data as it is now.
      if (!same(before, deps.getDevice())) {
        moved = true
        continue
      }
    }
    if (!same(merged, before)) {
      deps.applyDevice(merged)
      // Nothing is uploaded or finalized on the strength of data that did not stick on this device
      if (!(await deps.verifyDevice(merged))) return fail("apply-failed", MESSAGES["apply-failed"])
    }

    let rev = read.doc?.rev ?? 0
    if (!read.doc || !same(merged, read.data)) {
      const put = await deps.cloudPut(owner, buildBackup(merged, false), read.doc?.rev ?? null)
      if (!put.ok) {
        if (put.reason === "conflict") continue // someone saved first: merge again on top of what is there now
        return fail(put.reason === "too-large" ? "too-large" : "unavailable", MESSAGES[put.reason === "too-large" ? "too-large" : "unavailable"])
      }
      rev = put.rev
    }
    if (!(await verifyStored(deps, owner, merged, rev))) return fail("verify-failed", MESSAGES["verify-failed"])
    return { ok: true, rev, data: merged, restorePoints: made }
  }
  return moved ? fail("device-changed", MESSAGES["device-changed"]) : fail("changed-elsewhere", MESSAGES["changed-elsewhere"])
}

/** This device becomes the account's copy. The replaced account copy is kept on this device first. */
async function doDevice(owner: string, offer: Offer, deps: ApplyDeps, made: string[]): Promise<ApplyResult> {
  const read = await readAccount(deps, owner)
  if (!read) return fail("verify-failed", MESSAGES["verify-failed"])
  // Only replace what was shown. If the account changed since the comparison, stop and let the person look again.
  if ((read.doc?.rev ?? null) !== offer.rev) return fail("changed-elsewhere", MESSAGES["changed-elsewhere"])
  const device = deps.getDevice()
  if (read.doc && hasUserData(read.data)) {
    if (!restorable(read.data)) return fail("restore-point-failed", MESSAGES["restore-point-failed"]) // would be unrecoverable
    await protect(deps, "Your account’s copy before this device’s data replaced it", read.data, made)
  }
  const put = await deps.cloudPut(owner, buildBackup(device, false), read.doc?.rev ?? null)
  if (!put.ok) {
    if (put.reason === "conflict") return fail("changed-elsewhere", MESSAGES["changed-elsewhere"])
    return fail(put.reason === "too-large" ? "too-large" : "unavailable", MESSAGES[put.reason === "too-large" ? "too-large" : "unavailable"])
  }
  if (!(await verifyStored(deps, owner, device, put.rev))) return fail("verify-failed", MESSAGES["verify-failed"])
  return { ok: true, rev: put.rev, data: device, restorePoints: made }
}

/** The account's copy becomes this device's data. This device's data is kept first. */
async function doCloud(owner: string, deps: ApplyDeps, made: string[]): Promise<ApplyResult> {
  const read = await readAccount(deps, owner)
  if (!read || !read.doc) return fail("not-offered", MESSAGES["not-offered"])
  // The safety copy is taken from a snapshot; if the data changed while it was being saved, that copy is stale (it would not hold
  // the edit that is about to be replaced), so it is taken again from the data as it is now, up to three times.
  let protectedNow = false
  for (let attempt = 0; attempt < 3 && !protectedNow; attempt++) {
    const before = deps.getDevice()
    if (!hasUserData(before)) {
      protectedNow = true
      break
    }
    if (!restorable(before)) return fail("restore-point-failed", MESSAGES["restore-point-failed"])
    await protect(deps, "Before using your account’s data on this device", before, made)
    protectedNow = same(before, deps.getDevice())
  }
  if (!protectedNow) return fail("device-changed", MESSAGES["device-changed"]) // nothing was replaced
  deps.applyDevice(read.data)
  if (!(await deps.verifyDevice(read.data))) return fail("apply-failed", MESSAGES["apply-failed"])
  return { ok: true, rev: read.doc.rev, data: read.data, restorePoints: made }
}

// ---- revisions -------------------------------------------------------------------------------------------------------------

/**
 * The compare-and-set contract of the stored copy, as enforced by firestore.rules (create needs rev == 1, update needs
 * rev == old + 1), app/api/dev-sync (the same) and the SQL backend's sync_put (expected 0 = nothing stored, otherwise n -> n + 1):
 *
 *  - nothing stored: a write says "expected: nothing" (null here; the SQL backend spells it 0) and creates revision 1;
 *  - revision R:     a write says "expected: R" and makes revision R + 1; anything else is a conflict and changes nothing.
 *
 * So a write sent with expectedRev R lands as exactly R + 1 or not at all, and "no revision yet" counts as 0 in arithmetic
 * (but is still SENT as null: Firestore compares it with the missing document, which is not 0).
 */
export const isRev = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0

/** A revision read back from storage: nothing recorded (null), a valid revision, or garbage that must never reach arithmetic */
export function normalizeRev(raw: unknown): { ok: true; rev: number | null } | { ok: false } {
  if (raw === null || raw === undefined || raw === "") return { ok: true, rev: null }
  if (typeof raw === "string") {
    if (!/^\d{1,15}$/.test(raw)) return { ok: false }
    return { ok: true, rev: Number(raw) }
  }
  return isRev(raw) ? { ok: true, rev: raw } : { ok: false }
}

// ---- writes whose result is not known --------------------------------------------------------------------------------------

/**
 * A write that was sent (or was about to be) and whose outcome this device has not confirmed. It is written down BEFORE the
 * request is made, so a tab that dies with the request in flight still knows afterwards that something may have landed.
 * `sentText` is the exact text handed to the store, and `expectedRev` the revision it was conditional on.
 */
export interface WriteMarker {
  id: string
  /**
   * A digest of the exact text sent ("sha256:<length>:<hex>", or "fnv:<length>:<hex>" where SHA-256 is unavailable). Markers used to
   * keep the whole text, which can be hundreds of kilobytes each on a device that is already short of storage; the digest tells our
   * exact payload from any other text at revision R+1 and costs ~100 bytes.
   */
  digest?: string
  /** The whole text: only on markers written before digests existed. Still compared exactly, and never written by this version. */
  sentText?: string
  expectedRev: number
  at: number
  /** Nothing is known about what this marker stood for (an old format, or the oldest ones when too many pile up) */
  ambiguous?: boolean
}

export type DigestAlg = "sha256" | "fnv"
export const algOf = (digest: string): string => digest.split(":", 1)[0]

/** FNV-1a over UTF-16 code units, twice with different seeds: a stand-in only where crypto.subtle does not exist */
function fnv(text: string): string {
  let a = 0x811c9dc5
  let b = 0x9747b28c
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    a = Math.imul(a ^ c, 0x01000193) >>> 0
    b = Math.imul(b ^ (c + i), 0x01000193) >>> 0
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")
}

/** Digest of `text` with the named algorithm (default: the best available), or null if that algorithm is not available here */
export async function digestText(text: string, alg?: DigestAlg): Promise<string | null> {
  const subtle = typeof globalThis.crypto !== "undefined" ? globalThis.crypto.subtle : undefined
  const use: DigestAlg = alg ?? (subtle ? "sha256" : "fnv")
  if (use === "fnv") return `fnv:${text.length}:${fnv(text)}`
  if (!subtle) return null
  try {
    const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)))
    return `sha256:${text.length}:${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`
  } catch {
    return null
  }
}

export const MAX_MARKERS = 6

/** Reads markers back, never trusting them: anything unreadable becomes one marker that makes the next read cautious */
export function parseMarkers(raw: unknown): WriteMarker[] {
  if (raw === undefined || raw === null) return []
  const unknown = (): WriteMarker => ({ id: "unreadable", expectedRev: 0, at: 0, ambiguous: true })
  if (!Array.isArray(raw)) return [unknown()]
  const out: WriteMarker[] = []
  let bad = false
  for (const m of raw) {
    const w = m as WriteMarker
    if (m && typeof m === "object" && typeof w.id === "string" && isRev(w.expectedRev) && (typeof w.digest === "string" || typeof w.sentText === "string")) {
      out.push({
        id: w.id,
        ...(typeof w.digest === "string" ? { digest: w.digest } : {}),
        ...(typeof w.sentText === "string" ? { sentText: w.sentText } : {}),
        expectedRev: w.expectedRev,
        at: typeof w.at === "number" ? w.at : 0,
        ...(w.ambiguous ? { ambiguous: true } : {}),
      })
    } else bad = true // including the earlier format, which kept whole copies without the revision they were sent against
  }
  return bad ? [...out, unknown()] : out
}

export interface MarkerStore {
  load(): Promise<unknown>
  /** Must not return before the list is really stored; throws if it cannot be */
  save(list: WriteMarker[]): Promise<void>
}

let markerSeq = 0
const markerId = () => `w${Date.now().toString(36)}-${(markerSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`

/** The markers, kept in storage, changed one operation at a time */
export class WriteLedger {
  private cache: WriteMarker[] | null = null
  private chain: Promise<unknown> = Promise.resolve()
  constructor(private store: MarkerStore, private newId: () => string = markerId) {}

  private exclusive<T>(job: () => Promise<T>): Promise<T> {
    const run = this.chain.then(job, job)
    this.chain = run.catch(() => {})
    return run
  }
  private async load(): Promise<WriteMarker[]> {
    if (!this.cache) this.cache = parseMarkers(await this.store.load())
    return this.cache
  }
  private async persist(next: WriteMarker[]): Promise<void> {
    await this.store.save(next) // only after it is stored does the in-memory list change
    this.cache = next
  }

  list(): Promise<WriteMarker[]> {
    return this.exclusive(async () => [...(await this.load())])
  }

  /** Writes the marker down. Resolves only once it is stored; if it cannot be stored the caller must not send. */
  begin(sentText: string, expectedRev: number): Promise<WriteMarker> {
    return this.exclusive(async () => {
      const digest = await digestText(sentText)
      if (digest === null) throw new Error("the sent text could not be recorded") // an unrecorded write is not made
      const marker: WriteMarker = { id: this.newId(), digest, expectedRev, at: Date.now() }
      let next = [...(await this.load()), marker]
      if (next.length > MAX_MARKERS) {
        // Too many unresolved writes: the oldest are folded into one marker that stays cautious about everything before it
        const drop = next.length - (MAX_MARKERS - 1)
        const dropped = next.slice(0, drop)
        const folded: WriteMarker = { id: this.newId(), expectedRev: Math.min(...dropped.map((m) => m.expectedRev)), at: Date.now(), ambiguous: true }
        next = [folded, ...next.slice(drop)]
      }
      await this.persist(next)
      return marker
    })
  }

  clear(ids: readonly string[]): Promise<void> {
    return this.exclusive(async () => {
      if (!ids.length) return
      const cur = await this.load()
      const next = cur.filter((m) => !ids.includes(m.id))
      if (next.length !== cur.length) await this.persist(next)
    })
  }

  /** Markers whose write was conditional on a revision below `rev`: the confirmed revision `rev` is past all of them */
  clearBelow(rev: number): Promise<void> {
    return this.exclusive(async () => {
      const cur = await this.load()
      const next = cur.filter((m) => m.expectedRev >= rev)
      if (next.length !== cur.length) await this.persist(next)
    })
  }

  clearAll(): Promise<void> {
    return this.exclusive(async () => {
      this.cache = []
      await this.store.save([])
    })
  }
}

/**
 * Sends a copy and keeps the books: the marker is stored before the request; a definite answer ("conflict": the compare failed,
 * so it cannot have landed; "too-large": never sent) removes it; a confirmed success removes it and everything older, but only
 * after `onConfirmed` has recorded the new revision; "unavailable" leaves it, because the request may still have been applied.
 * A success whose revision is not exactly expectedRev + 1 breaks the contract above, so it is not believed: it stays a marker
 * and is settled by reading the stored copy.
 */
export async function putTracked(
  ledger: WriteLedger,
  put: (owner: string, text: string, expectedRev: number | null) => Promise<PutResult>,
  owner: string,
  sentText: string,
  expectedRev: number | null,
  onConfirmed?: (rev: number) => Promise<void> | void,
): Promise<PutResult> {
  const sentWith = normalizeRev(expectedRev)
  if (!sentWith.ok) return { ok: false, reason: "unavailable" } // nothing is sent against a revision that cannot be trusted
  const expected = sentWith.rev ?? 0
  let marker: WriteMarker
  try {
    marker = await ledger.begin(sentText, expected)
  } catch {
    return { ok: false, reason: "unavailable" } // a write that could not be tracked is not made
  }
  let r: PutResult
  try {
    r = await put(owner, sentText, sentWith.rev)
  } catch {
    return { ok: false, reason: "unavailable" }
  }
  if (r.ok) {
    if (!isRev(r.rev) || r.rev !== expected + 1) return { ok: false, reason: "unavailable" } // keep the marker
    try {
      await onConfirmed?.(r.rev)
      await ledger.clearBelow(r.rev)
    } catch {
      // The write landed but this device could not record it (storage full or failing). Never throw out of here: the
      // marker stays, and the next read of the stored copy settles whether it landed (see decideIngest).
      return { ok: false, reason: "unavailable" }
    }
    return r
  }
  if (r.reason === "conflict" || r.reason === "too-large") {
    try {
      await ledger.clear([marker.id])
    } catch {
      /* a leftover marker is settled by the next read; the answer itself is still definite */
    }
  }
  return r
}

/** What the sync compares to decide whether anything still has to be sent. Reminders are not React state, so they are left out. */
export const fingerprint = (d: Pick<FullBackupData, "subjects" | "tasks" | "tags" | "mates" | "holidays" | "scheduleOverrides">): string =>
  JSON.stringify({ s: d.subjects, t: d.tasks, g: d.tags, m: d.mates, h: d.holidays ?? [], o: d.scheduleOverrides ?? [] })

/**
 * The first connection has just been made on the strength of `uploaded` (the exact snapshot that was written, or agreed with the
 * account). "Synced" means exactly that snapshot: edits made while the request was in flight were NOT part of it, so recording
 * the CURRENT data instead would mark them as already sent and they would sit unsent until something else changed.
 * `needsPush` says they still have to be sent.
 */
export function settleFirstConnection(
  uploaded: Pick<FullBackupData, "subjects" | "tasks" | "tags" | "mates" | "holidays" | "scheduleOverrides">,
  current: Pick<FullBackupData, "subjects" | "tasks" | "tags" | "mates" | "holidays" | "scheduleOverrides">,
): { lastJson: string; needsPush: boolean } {
  const lastJson = fingerprint(uploaded)
  return { lastJson, needsPush: fingerprint(current) !== lastJson }
}

/** cloudPut that cannot hang: no answer in `ms` = "unavailable" (it may still have landed, so callers keep their markers) */
export function withPutTimeout(put: (owner: string, text: string, expectedRev: number | null) => Promise<PutResult>, ms: number) {
  return (owner: string, text: string, expectedRev: number | null): Promise<PutResult> =>
    new Promise<PutResult>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, reason: "unavailable" }), ms)
      put(owner, text, expectedRev).then(
        (r) => (clearTimeout(timer), resolve(r)),
        () => (clearTimeout(timer), resolve({ ok: false, reason: "unavailable" })),
      )
    })
}

/** A read that cannot hang: no answer in `ms` rejects (callers already treat a failed read as "unavailable") */
export function withReadTimeout<T>(get: (owner: string) => Promise<T>, ms: number) {
  return (owner: string): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms)
      get(owner).then(
        (r) => (clearTimeout(timer), resolve(r)),
        (e) => (clearTimeout(timer), reject(e)),
      )
    })
}

/** Signing out of an account only means something when there is one: without Firebase keys ("none") there is nothing to sign out of. Real failures propagate. */
export async function signOutIfConfigured(kind: string, signOut: () => Promise<void>): Promise<void> {
  if (kind === "none") return
  await signOut()
}

// ---- reading the stored copy after such writes -----------------------------------------------------------------------------

/** What this device last agreed on with the store, and the revision that agreement was at (null: recorded before revisions were) */
export interface BaseRecord {
  rev: number | null
  data: FullBackupData
}

export type MergeWhy = "ambiguous-write" | "unproven-base" | "remote-behind" | "corrupt-rev"

export interface IngestInput {
  stored: {
    rev: number
    text: string
    /** the stored text's digest by algorithm ("sha256" / "fnv"), for markers that hold a digest instead of the text */
    digests?: Record<string, string>
  }
  /** the revision this device believes the store is at (null: none recorded) */
  localRev: number | null
  /** the recorded revision was not a valid revision and has been discarded */
  revCorrupt?: boolean
  base: { rev: number | null } | null
  markers: readonly WriteMarker[]
  /** "live": pushed by the listener (may be older than what we just wrote); "pull": freshly read */
  source: "pull" | "live"
}

export type IngestDecision =
  | { kind: "invalid" }
  | { kind: "ignore" }
  | { kind: "unchanged"; clear: string[] }
  | { kind: "landed"; clear: string[] }
  | { kind: "merge"; useBase: boolean; why?: MergeWhy; clear: string[] }

/**
 * Decides what a stored copy at revision N means for this device. R is the revision a pending write was conditional on, so it
 * landed as R + 1 or not at all (see "revisions"). Comparing TEXT, not parsed data: parsing would hide differences (key order,
 * unknown fields, normalisation) that are exactly what tells our write from someone else's.
 *
 *   N == R          the write did not land (and nothing later did): nothing new
 *   N == R + 1, same exact text     it landed: adopt it, merge nothing
 *   N == R + 1, other text          someone else took R + 1 first, so ours can never land: the normal three-way merge, but only
 *                                   if the sync base is PROVEN to be the copy at revision R; otherwise the cautious merge
 *   N >= R + 2      content alone cannot say whether ours landed and was then built on: the cautious merge
 *
 * "Cautious merge" = no shared starting point (counters take the larger side, so nothing is counted twice), restore points of
 * both sides first (the caller's job), and the person is told. Deletions made on one side may come back: the safe direction.
 */
export function decideIngest(i: IngestInput): IngestDecision {
  const N = i.stored.rev
  if (!isRev(N)) return { kind: "invalid" }
  const R = i.localRev ?? 0
  const allIds = i.markers.map((m) => m.id)
  if (i.revCorrupt) return { kind: "merge", useBase: false, why: "corrupt-rev", clear: allIds }
  if (N < R) {
    // The store is BEHIND what this device recorded (restored, reset, or the recorded revision is wrong). A listener event can
    // simply be older than our own latest write, so only a fresh read may rebuild from this.
    return i.source === "live" ? { kind: "ignore" } : { kind: "merge", useBase: false, why: "remote-behind", clear: allIds }
  }
  const relevant = i.markers.filter((m) => m.ambiguous || m.expectedRev <= N - 1)
  const relevantIds = relevant.map((m) => m.id)
  // Exact: the stored TEXT is the text we sent (compared as text, or as the digest of the text), at the revision it would have made
  const ours = (m: WriteMarker) =>
    !m.ambiguous &&
    N === m.expectedRev + 1 &&
    ((typeof m.sentText === "string" && m.sentText !== "" && i.stored.text === m.sentText) || (typeof m.digest === "string" && i.stored.digests?.[algOf(m.digest)] === m.digest))
  if (relevant.some(ours)) {
    return { kind: "landed", clear: relevantIds }
  }
  if (N === R) return { kind: "unchanged", clear: relevant.filter((m) => !m.ambiguous).map((m) => m.id) } // a marker nothing is known about stays until a later read or write settles it
  // A marker that holds only a digest cannot be compared if this device cannot compute that kind of digest now: it is in doubt, not "not ours"
  const unverifiable = (m: WriteMarker) => typeof m.digest === "string" && !m.sentText && i.stored.digests?.[algOf(m.digest)] === undefined
  if (relevant.some((m) => m.ambiguous || N >= m.expectedRev + 2 || unverifiable(m))) return { kind: "merge", useBase: false, why: "ambiguous-write", clear: relevantIds }

  // Here every relevant marker was conditional on N - 1 and the store holds someone else's text: ours did not land.
  if (!i.base) return { kind: "merge", useBase: false, clear: relevantIds } // no shared starting point exists: nothing to prove
  const proven =
    relevant.length > 0
      ? R === N - 1 && i.base.rev === N - 1
      : i.localRev !== null && (i.base.rev === R || (i.base.rev === null && i.markers.length === 0)) // an old base without a revision is trusted only as before: when no write is in doubt
  return proven ? { kind: "merge", useBase: true, clear: relevantIds } : { kind: "merge", useBase: false, why: "unproven-base", clear: relevantIds }
}

export interface IngestEnv {
  ledger: WriteLedger
  getRev(): number | null
  revCorrupt(): boolean
  loadBase(): Promise<BaseRecord | null>
  /**
   * Brings `cloud` (revision `rev`) into this device. `base` is null when no shared starting point may be used; `why` is set for
   * the cautious cases (the caller then saves restore points of both sides first and tells the person). Throws if the safety copy
   * could not be saved: nothing has then changed. Returns whether this device's data changed.
   */
  merge(cloud: FullBackupData, rev: number, base: FullBackupData | null, why: MergeWhy | undefined, canProceed?: () => boolean): Promise<boolean>
  /** The stored copy is exactly what this device sent: it becomes the base, at `rev` */
  adoptLanded(cloud: FullBackupData, rev: number): Promise<void>
  /** Called once the recorded revision was replaced by a valid one */
  revRecovered?(): void
}

/**
 * Thrown by `merge` when `canProceed()` turned false after it had started waiting (a restore, reset or demo began, the account
 * changed, sync was paused). Nothing has been changed; the incoming copy is NOT discarded: the caller retries it later.
 */
export class DeferredError extends Error {
  constructor() {
    super("deferred")
    this.name = "DeferredError"
  }
}

export type IngestOutcome =
  | { kind: "failed"; reason: "unreadable" | "invalid-rev" | "unprotected" | "deferred" }
  | { kind: "ignored" }
  | { kind: "unchanged" }
  | { kind: "landed" }
  | { kind: "merged"; changed: boolean; why?: MergeWhy }

/**
 * Takes in stored copies ONE AT A TIME: a pull and a listener event arriving together cannot both read, and both settle, the
 * same marker. Markers are cleared only after the new revision and base are recorded, so a crash in between leaves them in
 * place (the next read is then merely more cautious), never gone while the write they stood for is still in doubt.
 */
export function createIngestor(env: IngestEnv) {
  let chain: Promise<unknown> = Promise.resolve()
  const run = async (doc: { data: string; rev: number }, source: "pull" | "live", canProceed?: () => boolean): Promise<IngestOutcome> => {
    const deferred: IngestOutcome = { kind: "failed", reason: "deferred" }
    // Checked when this job's turn comes (it may have waited behind others), after every wait, and by `merge` itself right before it applies
    if (canProceed && !canProceed()) return deferred
    const parsed = parseFullBackup(doc.data)
    if (!parsed.ok) return { kind: "failed", reason: "unreadable" }
    if (!isRev(doc.rev)) return { kind: "failed", reason: "invalid-rev" }
    const [markers, base] = await Promise.all([env.ledger.list(), env.loadBase()])
    const algs = new Set(markers.filter((m) => typeof m.digest === "string").map((m) => algOf(m.digest as string)))
    const digests: Record<string, string> = {}
    for (const a of algs) {
      const d = await digestText(doc.data, a as DigestAlg)
      if (d) digests[a] = d
    }
    if (canProceed && !canProceed()) return deferred
    const decision = decideIngest({
      stored: { rev: doc.rev, text: doc.data, digests },
      localRev: env.getRev(),
      revCorrupt: env.revCorrupt(),
      base: base ? { rev: base.rev } : null,
      markers,
      source,
    })
    switch (decision.kind) {
      case "invalid":
        return { kind: "failed", reason: "invalid-rev" }
      case "ignore":
        return { kind: "ignored" }
      case "unchanged":
        await env.ledger.clear(decision.clear)
        return { kind: "unchanged" }
      case "landed":
        if (canProceed && !canProceed()) return deferred
        await env.adoptLanded(parsed.data, doc.rev)
        await env.ledger.clear(decision.clear)
        return { kind: "landed" }
      case "merge": {
        let changed: boolean
        try {
          changed = await env.merge(parsed.data, doc.rev, decision.useBase && base ? base.data : null, decision.why, canProceed)
        } catch (e) {
          if (e instanceof DeferredError) return deferred // nothing was replaced; the markers stay and the copy is retried
          return { kind: "failed", reason: "unprotected" } // nothing was replaced; the markers stay
        }
        await env.ledger.clear(decision.clear)
        env.revRecovered?.()
        return { kind: "merged", changed, why: decision.why }
      }
    }
  }
  return {
    ingest(doc: { data: string; rev: number }, source: "pull" | "live" = "pull", canProceed?: () => boolean): Promise<IngestOutcome> {
      const job = chain.then(() => run(doc, source, canProceed), () => run(doc, source, canProceed))
      chain = job.catch(() => {})
      return job
    },
  }
}

// ---- the comparison on screen, and the choice made from it --------------------------------------------------------------------

/** A comparison being shown. `id` is its identity: it changes whenever a new comparison replaces the old one. */
export interface PromptState {
  id: number
  offer: Offer
  /** a chosen option is being carried out */
  working: boolean
  /** why the last attempt did not finish (nothing was lost; the person can try again) */
  error: string | null
  /** the person closed the comparison without choosing; sync stays paused until they reopen it */
  declined: boolean
}

/**
 * The one place that knows which comparison is current. `current` is updated SYNCHRONOUSLY on every change (a ref refreshed in an
 * effect lags a render behind, which let a second click and a late answer act on a prompt that was already gone).
 * Any async result must go through `patch(id, …)` / `isCurrent(id)`: it only counts while its own comparison is still the one shown.
 */
export class PromptController {
  private cur: PromptState | null = null
  private seq = 0
  constructor(private onChange: (p: PromptState | null) => void) {}

  get current(): PromptState | null {
    return this.cur
  }
  isCurrent(id: number): boolean {
    return this.cur !== null && this.cur.id === id
  }
  private set(p: PromptState | null) {
    this.cur = p
    this.onChange(p)
  }
  show(offer: Offer, error: string | null = null): PromptState {
    const p: PromptState = { id: ++this.seq, offer, working: false, error, declined: false }
    this.set(p)
    return p
  }
  clear(): void {
    if (this.cur) this.set(null)
  }
  /** Changes the prompt `id` stood for. Returns false (and changes nothing) if that prompt is no longer the current one. */
  patch(id: number, change: Partial<Pick<PromptState, "working" | "error" | "declined">>): boolean {
    if (!this.cur || this.cur.id !== id) return false
    this.set({ ...this.cur, ...change })
    return true
  }
}

export interface ChoiceEnv {
  prompts: PromptController
  accountId(): string | null
  paused(): boolean
  /** The steps of the choice; `blocked` and `onDeviceReplaced` are supplied here */
  deps: Omit<ApplyDeps, "blocked" | "onDeviceReplaced">
  /** this choice replaced this device's data on behalf of `owner` */
  deviceReplaced(owner: string): void
  /** The choice finished and was verified */
  finalize(owner: string, result: Extract<ApplyResult, { ok: true }>, choice: Choice): void | Promise<void>
  /** The account's copy changed after the comparison was made: build the comparison again from what is there now */
  rebuild(notice: string): Promise<void>
}

/**
 * Carries out the person's choice for the CURRENT comparison. Returns an error message, or null when it finished (or was dropped
 * because it no longer belongs to anything). It never starts twice, never acts for a comparison or account that is gone, and a
 * late failure cannot bring a closed comparison back.
 */
export async function runChoice(env: ChoiceEnv, choice: Choice, confirmed: boolean): Promise<string | null> {
  const st = env.prompts.current
  const owner = env.accountId()
  if (!st || !owner || st.working) return null // a second click while the first is running does nothing
  if (env.paused()) return MESSAGES.paused
  const release = tryAcquire("sign-in") // one replacement of this device's data at a time (a restore, a reset or the demo may be running)
  if (!release) return BUSY_MESSAGE
  try {
    return await runLocked(env, st, owner, choice, confirmed)
  } finally {
    release()
  }
}

async function runLocked(env: ChoiceEnv, st: PromptState, owner: string, choice: Choice, confirmed: boolean): Promise<string | null> {
  const id = st.id
  env.prompts.patch(id, { working: true, error: null }) // before any await: the next click already sees it
  const blocked = (): false | BlockReason => (env.paused() ? "paused" : env.accountId() !== owner ? "account" : !env.prompts.isCurrent(id) ? "stale" : false)
  const res = await applyChoice(choice, st.offer, owner, confirmed, { ...env.deps, blocked, onDeviceReplaced: () => env.deviceReplaced(owner) })
  if (env.accountId() !== owner) return null // signed out or switched while this ran: nothing of it may stick to the next account
  if (!res.ok) {
    if (res.reason === "changed-elsewhere") {
      // The comparison is out of date. It is dropped (not patched), and a new one is built from the account as it is now.
      if (env.prompts.isCurrent(id)) {
        env.prompts.clear()
        void env.rebuild(res.message)
      }
      return res.message
    }
    env.prompts.patch(id, { working: false, error: res.message }) // does nothing if that prompt was closed meanwhile
    return res.message
  }
  await env.finalize(owner, res, choice)
  return null
}
