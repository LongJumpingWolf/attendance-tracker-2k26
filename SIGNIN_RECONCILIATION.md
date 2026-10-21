# SIGNIN_RECONCILIATION.md

User-controlled reconciliation of the data on a device with the data in the account, at the first Google sign-in in a browser, plus the safeguards around every other place that replaces this device's data wholesale (restoring a backup or a restore point, resetting, the demo).

**Status: implemented and tested locally; NOT committed, NOT deployed.** No backend, schema, rules, function, environment, flag or Firebase/Vercel setting changed, and the stored document format is unchanged (older clients are unaffected). Firebase remains the authoritative backend; the code reads and writes the stored copy only through `lib/cloud-sync.ts` and `getBackend()`, as before.

## 1. Audit: what existed

| Area | Finding |
|---|---|
| Local data | IndexedDB (`lib/db.ts`, localStorage fallback): `subjects` (with attendance `log`), `tasks`, `tags`, `mates` (favour ledger), plus reminders (`lib/reminders.ts`, localStorage) |
| Cloud copy | One whole-backup document per account (`syncs/{uid}`, gzip, compare-and-set revision), through `lib/cloud-sync.ts` -> `getBackend()` |
| Merge | One three-way engine, `lib/merge.ts`, incl. a no-base mode (match by id, then by name; counts take the larger side) |
| Safety copies | `lib/restore-points.ts` (never auto-trimmed) and a restore UI |
| Sign-in | `lib/account.ts`: Google upgrades the anonymous Firebase account or switches to the Google account's existing id after confirmation. Anonymous users never sync |

Gaps found (each verified in the code): no choice and no comparison at first sign-in (both sides with data were merged silently); "empty device" ignored tags/reminders/mates; the previous account's data leaked into the next account's copy; no retry after a failed first read; no read-back verification. Later reviews added: uncertain writes double-counted counters; prompt/account races; "Backup restored" reported before the safety copy existed; reminders replaced before the safety copy; tags-only/reminders-only data was not protected.

## 2. Design (reuse, not replace)

* `lib/signin-reconcile.ts` holds the decisions and the injected steps. **No second merge engine and no second backup system:** combining is `mergeData`; safety copies are `saveRestorePoint`; the stored copy is read and written through the injected `cloudGet`/`cloudPut`.
* `hooks/use-cloud-sync.ts` wires them to React. `components/reconcile-sheet.tsx` is the screen; `components/settings-sync.tsx` shows "Waiting for you" / "Paused while the demo shows"; `app/page.tsx` mounts the sheet at page level so a redirect sign-in still shows it.
* `lib/safe-replace.ts`, `lib/operation-lock.ts`, `lib/replace-verify.ts` (new) hold the rules for restore/reset/demo.

### First sign-in in this browser
| Situation | Behaviour |
|---|---|
| The account's copy cannot be read, or cannot be parsed | **Never treated as empty.** Nothing uploaded or replaced; status "Offline"; retried with backoff and when the connection returns |
| Both empty / account empty and device has data | Connect quietly; this device's data becomes the account's copy |
| Device empty, account has data | The account's data is used |
| Identical | Connect, no question |
| Both have different data | **Comparison + choice**; "Combine both" recommended |
| This device's data last belonged to a different account (`syncDataOwner`, kept across sign-out) | Always a choice; merging is not offered into an empty account |
| Decide later | Nothing changes on either side; sync stays off until a choice is made |

Options: **Combine both** (`mergeData(null, device, account)`, other copy saved as a restore point, up to 3 re-merges on a write conflict), **Use this device's data** (needs confirmation; refuses if the account changed after the comparison; the replaced copy is saved on this device first), **Use my account's data** (needs confirmation; this device's data saved and read back first). Record-by-record choice is not provided (it would need a second merge engine). Success is declared only after read-back (stored copy, or this device's own storage). A mate row without ledger history is not "user data" for these decisions (`hasHistory`).

## 3. Prompt identity, stale results, account changes, pause (D3)

* `PromptController` owns the current comparison. Each comparison has an `id`; `current` is updated **synchronously** (the old effect-synced ref lagged a render). Async results go through `patch(id, …)`/`isCurrent(id)`, so a late failure cannot revive a prompt that was cleared (pause, sign-out, success) or replaced.
* `runChoice` sets `working` before its first await (a second click returns immediately), and passes `blocked()` to every read/replace of device data: `paused`, `account` (a different account is signed in), or `stale` (the comparison was replaced/closed). Failure reasons `account-changed` and `stale` have their own messages.
* `changed-elsewhere` drops the stale prompt first, then `connect(notice)` builds a new comparison from the account as it is now (new id, the reason shown). Every connect attempt is numbered (`connectGen`); only the newest may show a comparison.
* `onDeviceReplaced` records `syncDataOwner` the moment a choice replaces device data, even if a later step fails, so the next account is not told it is the previous owner's.
* While paused (demo on screen): the hook returns `reconcile: null` immediately, clears the prompt, numbers away any attempt still reading, and reports status `"paused"` ("Paused while the demo shows").

## 4. Uncertain writes and revision-based settlement (D1)

Compare-and-set contract (checked in `firestore.rules`, `app/api/dev-sync`, Supabase `sync_put`): nothing stored = revision 0 in arithmetic (sent as `null`); a write conditional on R makes exactly R+1 or does not land. Revisions are validated (`normalizeRev`): NaN/negative/fractional are discarded and the next read rebuilds cautiously.

* **Write-ahead marker:** before every request, `{digest, expectedRev}` is stored and read back (`WriteLedger`, `putTracked`). A write that cannot be recorded is not sent. A conflict or too-large answer clears its marker; a confirmed success clears older markers only after the new base+revision are recorded; "unavailable" (including a timeout) keeps it. Markers survive restarts; an unreadable or old-format marker, or overflow beyond 6, becomes an "ambiguous" marker.
* **Digest, not text (fix 4):** a marker used to hold the whole sent text (up to hundreds of kilobytes each, on a device that may be short of storage). It now holds `sha256:<length>:<hex>` (or `fnv:<length>:<hex>` where `crypto.subtle` does not exist), about 100 bytes. The stored copy is digested with the marker's own algorithm and compared, so our exact payload is still told apart from any other text at R+1 (one character, whitespace or key order different = not ours). Markers written before this change (which hold `sentText`) are still read and still compared exactly; they are never written by this version. A digest marker that cannot be compared on this device (algorithm unavailable) is treated as **in doubt** (cautious merge), never as "not ours". No marker is cleared by a deferral, a failed safety copy or "unchanged". The document stored in the account is unchanged.
* **Settlement (`decideIngest`)**, `N=R` nothing new; `N=R+1` + exact sent text = landed (adopted, nothing merged); `N=R+1` + other text = ours cannot have landed, normal three-way merge **only if the base is proven to be the copy at revision R**; `N>=R+2` = undecidable from content → cautious merge. Stored revision behind the local one → rebaseline from a fresh read only (a listener snapshot may be merely older than our own write).
* **Base + revision are one stored record** (`syncBaseV2`, base written first, then the revision). An old base without a revision is trusted only when no write is in doubt.
* **Cautious merge:** no shared base (counters take the larger side, nothing counted twice), restore points of both sides first (verified), the person is told; deleted items may reappear.
* **Ingest is serialized** (one at a time), so a pull and a listener event cannot settle the same marker.

### Remaining risk: ambiguous revision (N >= R+2)
If our write landed at R+1 and another device then built on it, or if ours never landed and others wrote twice, the stored text cannot tell which. The cautious merge takes the **larger** counter, so a favour count that BOTH devices raised concurrently can be under-counted by the smaller side's increments (both full copies are in restore points; nothing else is lost). **Exact resolution is not possible without a schema change**: the store keeps only the latest document (intermediate revisions are gone), and a write ID inside the document would be dropped by any older client that rewrites it. Options that would fix it, none implemented (each needs approval): (a) per-device counter deltas in the document (schema + migration + old-client compatibility), (b) a write ID plus history of recent IDs (same), (c) a revision-history collection (rules + migration). Left as is.

## 5. Safe replacement: restore, restore point, reset, demo

Order (`lib/safe-replace.ts`): refuse if the demo is on screen or another replacement holds the lock → save a safety copy of the **current** data and reminders and read it back (`saveRestorePoint`; throws `RestorePointError` if it cannot) → look again: if data or reminders changed meanwhile the copy is remade (3 tries) or the operation is abandoned → demo check once more immediately before the first change → change → read the result back from storage → report. Reset signs out **before** wiping (so an empty copy can never reach the account) and, if the data moved while signing out, saves a fresh copy first. Success messages exist only on the path where the change was made and found stored.

* **Demo protection:** restore, restore-point restore and reset are refused while the demo is active. The page sets its demo flag in the same step that starts/ends the demo (no render lag), both on its own ref and on `lib/operation-lock` (`setDemoLive`) which background sync reads; the guard is read live at three points.
* **Shared lock** (`lib/operation-lock.ts`): restore, reset, demo start/end and sign-in choices cannot overlap; released on success and failure through `finally`; never expired by a clock while an operation runs. Releasing notifies listeners (`onRelease`).
* **Persistence verification** (`lib/replace-verify.ts`): reminders are read back after writing (`saveSchedule` swallows failures); data is read back from IndexedDB/localStorage; reset checks nothing it removes is still stored.
* **A failed check does not blindly undo (fix 3).** If the expected state is not seen in storage, the restore is undone **only if the data on screen is still exactly what the restore applied**. If it changed (the person edited, a sync merged) nothing is put back and the message says the restore was applied but could not be confirmed (`restoreUnconfirmed`). The undo itself is a claim: it is reported as done only after it is found on screen and in storage; otherwise the error says so and sends the person to the safety copy (`restorePutBackUnverified`: "restore it from there"). The safety copy is never removed.
* **Reset sign-out is bounded (fix 1):** 8 s (`SIGN_OUT_TIMEOUT_MS`). A timeout or a failure refuses the reset before anything is wiped, with a message that says syncing stays off until reload (the hook has already detached ownership, revision and markers locally before waiting on the network, so nothing can push an emptied copy). Without Firebase keys (`cloudKind() === "none"`) there is nothing to sign out of and a local-only reset works (`signOutIfConfigured`); real sign-out failures are not swallowed.
* **Tags-only / reminders-only data:** `holdsSomething` (subjects, deadlines, tags, mates or reminders) is the single rule for restore points, `restorable` (sign-in) and the messages.
* **Older restore points** are read with empty lists and flagged `remindersKnown` / `tagsKnown` / `matesKnown` = false (a missing list is not the same as an explicitly empty one). Restoring one leaves this device's reminders, tags and mates alone (`unrecorded`), the screen says which; stored points are never rewritten in a normalised form.
* **Storage full:** failure messages say to delete older restore points under Settings > Backup & restore. Nothing is deleted automatically.
* Restore-point list labels include tags, mates and reminders.

## 5b. Background sync and the lock (fix 2)

The lock used to protect only user actions; a pull or live snapshot could still apply data during a restore, reset or demo. Now (`hooks/use-cloud-sync.ts`):
* Every way incoming data can be applied (`pull`, the live listener, `push`, the first-connection decision, `reconcile`) checks, before and after its awaits, that the owner is the same, **sync is not paused (the prop, or `isDemoLive()`)**, the **epoch** is unchanged (bumped when the account/pause/loaded state changes and on sign-out) and `lockHolder()` is null. `reconcile` re-checks immediately before applying, after its awaited restore-point saves, and throws `DeferredError`; the ingestor returns `deferred` and keeps every marker.
* Skipped data is **set aside, not dropped**: a flag is raised and `onRelease` fetches and applies it once the lock is released (once, no loop); a pause ending re-runs the connection effect, which pulls. After a reset the account is detached first, so an in-flight pull cannot repopulate the device; during a demo it cannot overwrite it.

## 5c. Network timeouts (fix 1)
`cloudGet` (sign-in choices) is bounded at 6 s and `cloudPut` (pushes and sign-in choices) at 12 s (`withReadTimeout`, `withPutTimeout`). A read timeout fails the choice with a retryable message; a write timeout is "unavailable" (it may still have landed, so its marker stays and the next read settles it). The shared lock is released by `finally` when the timeout lets the operation finish; it is not expired while an operation is genuinely running. `ReconcileSheet` now shows the busy/paused answer (`reconcile-notice`) instead of dropping it.

## 5d. First-connection upload race, and offline reset (later audit)
* **Fixed:** after the first upload the hook recorded `fingerprint(dataRef.current)` (the data as it was AFTER the await) as synced, so an edit made while the request was in flight was marked as already sent and was never pushed. It now records the exact snapshot that was uploaded (`settleFirstConnection`, shared by the hook and its tests) and, when the data moved meanwhile, raises a push. Same fix in the "empty copy already exists" and "identical" first-connection paths. Revision/CAS and marker behaviour are unchanged. Tests: `tests/first-connection.test.ts` (the pure function plus the real planner, ledger and push helper against a CAS store; the hook wiring is additionally pinned by source checks, because the hook itself needs a DOM).
* **Offline reset, assessed, NOT changed:** with Firebase configured, `signOutOfAccount` (`lib/identity.ts`) awaits `deletePushToken` (a Firestore write) before `signOut(auth)`. Firestore here uses the default in-memory cache, so a write issued offline does not settle until the server answers; the wait therefore runs to the 8 s reset limit and the reset is refused, even though the local detach is already done. Being "never signed in" does not avoid it, because the app keeps an anonymous Firebase account for friend connections. A safe fix exists in principle (give the token clean-up a short bound, e.g. 1.5 s, and still await `signOut(auth)`, which is local and whose failures would still propagate), but it changes a hash-pinned file and makes the clean-up best-effort: offline, this device could keep receiving alerts for the account until the token is removed some other way. That trade-off needs a decision, so nothing was changed. Until then: an offline reset waits 8 s, then refuses with "Signing out is taking too long... Syncing on this device stays off until you reload"; going online and retrying works.

## 5e. Sign-in choice that waits on the network (later audit)
* **Fixed:** `finalize` (after "Combine both" / "Use this device's data" / "Use my account's data") recorded `fingerprint(res.data)` as synced and cleared the pending flag, but never sent edits made while the choice was waiting on the network. It now goes through the same `connected()` helper as the first upload (`settleFirstConnection`): the verified snapshot is recorded and a push is raised only if the current data differs. Revision/CAS logic, markers, restore points, pause/demo guards and the lock are untouched. Because the "use my account's data" choice replaces the screen's data a render later, the comparison can briefly differ for it; a push that finds nothing to send now clears "Syncing…" instead of leaving it showing. Tests: `tests/first-connection.test.ts` (a real `runChoice` held open on the network, an edit made meanwhile, then the push reaches the stored copy; no edit = no push).
* **Offline reset: skipping the network sign-out when `navigator.onLine === false` — assessed, NOT implemented.** What stays safe: no empty copy could be pushed, because ownership, revision, base and markers are detached locally before any network wait. Why it is not demonstrably safe as a product behaviour: (1) the Firebase session would remain, so after a reload the connection flow finds an empty device and an account with data and silently downloads the account's data back (`take-account`), undoing the reset the person asked for; (2) the device's push token is not removed, so it keeps being alerted for the account; (3) `navigator.onLine` is only a hint (true behind a captive portal, so the wait would remain; false-negative would sign nobody out). It becomes acceptable only with a persisted "sign-out pending" flag that completes the sign-out on the next online start before any connection is made. That is a new mechanism and needs approval; until then offline reset waits 8 s and is refused with a retryable message.

## 5f. Edits made while a sign-in choice saves its safety copy (later audit)
* **`doMerge`:** the device snapshot is captured before the safety copy and compared (`same`) with the device after the awaited save and read-back. If the person edited meanwhile, the attempt is abandoned and redone from a fresh snapshot (shared three-attempt loop); previously the stale merge would have overwritten the edit and the saved copy would not have held it. After applying the merge, `verifyDevice(merged)` must succeed before anything is uploaded or finalized (`apply-failed` otherwise, nothing uploaded).
* **`doCloud`:** the same snapshot check around the safety copy, up to three tries; if the device keeps changing the result is the new `device-changed` ("Your data changed while the safety copy was being saved, so nothing was replaced. Try again."). It keeps the prompt open with the reason shown and is not treated as `changed-elsewhere` (a remote account change).
* Shared lock, owner/pause/demo guards, revision/CAS, markers and restore-point guarantees unchanged. Tests: section 16 of `tests/signin-reconcile.test.ts` (6 tests, which fail against the earlier code).

## 6. Files
New: `lib/signin-reconcile.ts`, `lib/safe-replace.ts`, `lib/operation-lock.ts`, `lib/replace-verify.ts`, `components/reconcile-sheet.tsx`, `scripts/e2e-reconcile.mjs`, tests listed below. Changed: `hooks/use-cloud-sync.ts` and `lib/restore-points.ts` (both hash-pinned in `tests/migration-protected.json`; deliberate product-behaviour changes, not migration artefacts), `app/page.tsx`, `components/settings-sheet.tsx`, `settings-panels.tsx`, `restore-points.tsx`, `settings-sync.tsx`. `lib/merge.ts`, `lib/db.ts` and `lib/account.ts` are untouched.

## 7. Validation (what was actually run, and what was not)

Current unit baseline in `scripts/migration-baseline.json`: **38 files / 910 tests** (this section's earlier 37 / 892 and 38 / 904 figures, and the earlier hook hashes, are superseded).

### Run on the current tree, after the last code change (sections 5f and this edit)
| Check | Result |
|---|---|
| Unit suite, **clean unlinked copy** (`node scripts/test-unlinked.mjs`, and again inside `migration:health`) | **38 files, 910 / 910 passed** |
| Unit suite, **this linked checkout** (plain `npx vitest run`) | **909 passed + 1 known environmental failure**: `migration-invariants` "no remote link", because `supabase/.temp/project-ref` exists (the checkout is linked to a Supabase project). The file was not touched; the same test passes in the clean copy |
| `npm run migration:health` | **HEALTHY** — rules 4 files / 64; typecheck no errors; lint 0 errors / 75 warnings; browser E2E 8 suites / 247 checks (Chrome, local `next dev` with every Firebase key blanked, i.e. local mode, no production access; includes `reconcile` 44 / 44); `next build` succeeded |
| Mutation checks for the 5f change (3 safeguards removed one at a time: stale-snapshot detection in merge, in cloud, and the apply check) | all 3 caught by the new tests (2, 3 and 1 failing tests respectively) |

### Earlier reports, not re-run in full
* Mutation-check totals given in earlier rounds ("25 of 25", "12 of 12 after two tests were added") were reported at the time and are **not independently verified or re-run** on the current tree; do not treat them as current evidence. (The "this round 12 of 12" wording is dated: it referred to the background-sync round.)
* Chat 1's audit counts (903 passing + 1 environmental in the linked checkout, before the latest tests) are the same shape as the current linked-checkout result above, which now reads 909 + 1.

### Test files for this work (unit, current counts)
`signin-reconcile` (52), `signin-safety` (21), `uncertain-writes` (65), `reconcile-prompt` (29), `safe-replace` (17), `safe-replace-guards` (64), `background-sync-safety` (14), `first-connection` (12), `db-indexeddb` (20, in-memory IndexedDB stand-in, no dependency).

Limits of what these show: the hook itself needs a DOM and is not rendered in unit tests; the behaviour tests drive the same library code through stand-ins that mirror its wiring, plus source-pattern checks of that wiring. The browser E2E exercises the real hook, but in local (dev-store) mode, not against real Firebase or the Google pop-up.

## 8. Remaining risks
* Ambiguous-revision under-count (section 4).
* After a refused reset (sign-out failed or timed out) syncing stays off on this device until the page is reloaded: the local detach is deliberately done first. The message says so.
* The first-sign-in upload is not marker-tracked; a lost answer is re-derived from content on the next attempt.
* Restore/reset verification polls storage for a few seconds; on a failing store the person waits that long before the error.
* A restore whose persistence cannot be confirmed while the data also changed gets "applied but not confirmed" and is not undone: the person must check. The safety copy is there.
* A background merge that has already applied (synchronously, with no await left) just before a restore takes the lock is simply part of the data the restore then copies; there is no further window.
* Devices that signed out before this version have no recorded data owner (cross-account protection starts from their next sign-in).
