# MIGRATION_CHECKPOINT.md

Phase 1 (safety harness) checkpoint for the Firebase to Supabase migration. The plan is `MIGRATION_PLAN.md`. This file records where the migration **started**, how to prove at any time that nothing has regressed, and how to get back.

## 1. Starting point

| | |
|---|---|
| Starting commit | `3644948` ("Ping Phase 2: identity, server-side rules, exactly-once processing, rules tests") on `main` |
| Migration branch | `migration/supabase` (created from `3644948`) |
| Working tree at start | clean, apart from the untracked `MIGRATION_PLAN.md` |
| Firebase project | `attendance-tracker-2k26` (`.firebaserc`) |
| Authoritative backend | **Firebase** (production). Supabase is **not connected** and has no project, tables or migrations |
| Firestore rules | already **deployed** to production (the version at `3644948`, including the two receiver-answer conditions) |
| Cloud Functions | **NOT deployed** (the project is on the Spark plan; functions need Blaze). The code exists in `functions/` |
| Hosting | Vercel (no Firebase hosting) |
| Billing constraint | no Blaze upgrade, no payment method; destination is Supabase Free |

## 2. What Phase 1 changed

Only test and tooling files. No application source, Firebase config, rules, functions or environment variables were touched.

| File | Purpose |
|---|---|
| `MIGRATION_CHECKPOINT.md` | this document |
| `scripts/migration-health.mjs` | the health command (`npm run migration:health`) |
| `scripts/migration-baseline.json` | the numbers the health command compares against |
| `tests/migration-invariants.test.ts` | 55 tests pinning the things that must not change |
| `tests/migration-protected.json` | SHA-256 of every protected source file |
| `package.json` / `package-lock.json` | `puppeteer-core` as a **dev** dependency; `migration:health` script |

## 3. The health command

```
npm run migration:health                       # everything
npm run migration:health -- --only unit,lint   # a subset (reported as PARTIAL, exit code 2)
npm run migration:health -- --json report.json
```

Runs, in order: unit tests, Firestore rules tests (emulator), typecheck, lint, the seven Chrome e2e suites, `next build`. It never stops at the first failure and never omits a suite silently:

- a suite that cannot run (no Java, no `firebase` CLI, no Chrome, port 3458 busy) is reported **BLOCKED** and counts as a failure;
- fewer passing tests than `scripts/migration-baseline.json` is a failure (a test was deleted or is not running); a skipped test is a failure;
- lint errors above 0, or warnings above 75, are failures;
- exit code `0` healthy, `1` something failed or is blocked, `2` partial run (`--only`).

Requirements on the machine: Node, **Java** (for the Firestore emulator, `JAVA_HOME` honoured), the **`firebase` CLI** on the PATH, **Google Chrome** (`CHROME` env var if not at the default Windows path), and port **3458** free (`E2E_PORT` / `BASE` to change). The e2e step starts its own `next dev` with every `NEXT_PUBLIC_FIREBASE_*` key blanked (the app's local mode, as the suites were written) and **refuses to reuse** a server that is already running, because that one might have real keys. It deletes `.next` (git-ignored build output) before starting.

## 4. Baseline (Phase 0, measured at `3644948`) versus now

| Check | Baseline at `3644948` | Phase 1 (this branch) |
|---|---|---|
| Unit | 15 files, 177 tests | **16 files, 232 tests** (+55 migration invariants), all pass |
| Firestore rules (emulator) | 4 files, 64 tests | **4 files, 64 tests**, all pass (see flaky test below) |
| Typecheck | clean | **clean** |
| Lint | 0 errors, 75 warnings | **0 errors, 75 warnings** |
| Build | passes | **passes** |
| E2E ping / ping-reliability / nav / value / today / cleanup / sync | 40 / 20 / 35 / 32 / 38 / 27 / 11 = 203 | **203/203** (same per-suite numbers) |

No existing test was edited, skipped or removed.

## 5. Known flaky test (documented, NOT fixed)

`tests/rules/identity.test.ts` > "1. anonymous -> Google sign-in keeps who you are" > "keeps the same id, the same mates and the same listeners, and Pings still work both ways".

**What was measured** (identity file alone, fresh Auth and Firestore state before each run):

| Condition | Runs | Failures |
|---|---|---|
| Idle machine | 45 | 3 |
| All CPU cores saturated | 15 | 1 |
| Full `npm run test:rules` (separate sample) | 6 | 1 |
| Earlier full runs during Phases 0 to 1 | 5+ | 1 |

Roughly 5 to 7 percent. It is **always this one test**, and always at the same point: after `linkWithCredential` upgrades the anonymous account, a Listen stream that has been open since before the link stops delivering the next write, and the test's 8 second `waitFor` ("an incoming Ping after sign-in") times out. Other tests that attach listeners after sign-in did not fail in any of the runs. CPU load did not raise the rate, so this is not a timing-pressure problem.

In some failing runs the Firestore client also logs `RESOURCE_EXHAUSTED: Received message larger than max (N vs 4194304)` with a different, huge `N` each time (4172205160, 2483292814), i.e. not a real message size: the gRPC client read a **corrupt frame header** from the emulator on that long-lived stream, after which the SDK backs off at its maximum delay. Other failing runs show no such log, only the stall.

**Conclusion.** This looks like a transport-level glitch between the Node gRPC client and the Java Firestore emulator on a listener that survives an auth-token change. The assertion is correct, the 8 second wait is not too short (the SDK's own backoff outlasts any reasonable wait), and the production code under test is exercised normally in the other 94 percent of runs. There is **no narrowly justified harness setting** that addresses it (the frame size is garbage, so raising the gRPC message limit would not help), so the test is unchanged: no assertion weakened, no timeout raised, no test deleted, no production code touched.

**How the health command treats it.** If the rules suite fails and the *only* failing test is this one (listed in `knownFlaky` in `scripts/migration-baseline.json`), it re-runs the rules suite once and reports `PASSED ON RETRY` with the test named, so it is visible. Any other failure, or a second failure, is a plain FAIL.

**Open question for Phase 8 (realtime).** The real browser flow is the same shape (live listeners, anonymous to Google link). Nothing here shows it happens against production Firestore, but it should be re-checked against real Firestore (and then real Supabase Realtime) when listeners are migrated. The existing `resilient()` wrapper and pull-on-open/visible/online recovery are what protect users either way.

**Other limitation found.** This file cannot be re-run twice against the *same* emulator instance: the Auth emulator keeps the fake Google accounts between runs and the "account already exists elsewhere" tests then behave differently. `npm run test:rules` starts a fresh emulator every time, so it is not affected.

## 6. End-to-end reproducibility gap: closed

The seven `scripts/e2e-*.mjs` files import `puppeteer-core`, which was not a dependency; they only ran from a scratch folder. It is now a `devDependency` (`^25.12.0`), and `migration:health` runs them from a clean checkout. The e2e **semantics are unchanged** (the scripts are byte-identical to `3644948`). The Chrome path is still the Windows default unless `CHROME` is set.

What e2e does and does not cover (unchanged from Phase 0): local/mock social mode only. **Real Firestore delivery, real FCM and real two-device sync have no automated coverage.**

## 7. Migration invariants (`tests/migration-invariants.test.ts`)

These pin current behaviour and must stay green through every phase. If one fails, the migration changed behaviour.

- **Protected files unchanged** (SHA-256, line-ending-normalised): attendance and scan logic; `db.ts`, `merge.ts`, `backup*.ts`, `restore-points.ts`; Ping processing, apply, id, constants; `identity.ts`, `social-session.ts`, `account.ts`, `realtime.ts`; the sync hook; `firestore.rules`, `firestore.indexes.json`, `functions/*`; `public/sw.js`.
- **Firebase is still the backend:** no source mentions Supabase, no Supabase package, no `supabase/` directory, `.firebaserc` unchanged.
- **Attendance:** a 10-row golden table for `getAttendance` / `skipVerdict` (including the rounding boundary 74.6 percent counted as 75), double tap is a no-op, changing a mark moves the count, exact undo, the 400-entry log cap with counters still counting.
- **Three-way merge:** offline marks from two devices both survive, the same mark on both counts once, a local-only change survives, a true clash keeps the local value, merging a merged copy is a no-op.
- **Storage:** the IndexedDB layer's round trip (its localStorage fallback in Node; the real IndexedDB is covered by the e2e suites), restore points never trimmed, empty and duplicate copies skipped, only deleted on request.
- **Offline:** an unreachable backend returns `unavailable` and never throws.
- **Ping:** constants (8 classes, 3 days, 2 minute lease, 30 days history); order lease, apply, finalize exactly once; never finalized unless saved, never applied without the lease; applying twice credits one favour.
- **Identity is the uid:** an answer is credited by uid even if the name differs, and a different person who shares the name is not credited.

Mutation-checked: temporarily changing the rounding in `getAttendance`, and temporarily finalizing before applying in `processAnswered`, each made both the matching behavioural test and the protected-file test fail. Both files were restored.

**Changing a protected file on purpose** requires saying why behaviour is unchanged in the commit message, then regenerating the hashes with `UPDATE_PROTECTED=1 npx vitest run tests/migration-invariants.test.ts` and having that diff reviewed. The "no Supabase in sources" test must be updated deliberately in the commit that first adds Supabase code.

## 8. Rollback starting point

Nothing in production has changed, so rollback is simply not using this branch.

- Return to the starting state: `git checkout main` (commit `3644948`), or `git branch -D migration/supabase` to discard the branch.
- Firebase: untouched. Rules deployed, project `attendance-tracker-2k26`, Auth and Firestore data unchanged, no functions deployed.
- Before any later phase moves authority (Phase 6 onward), take a full Firebase export and a Supabase `pg_dump` (Supabase Free has no point-in-time recovery), as set out in `MIGRATION_PLAN.md` sections 14 and 20.

## 9. Not done in Phase 1 (by instruction)

No Supabase project, tables or migrations; no Supabase dependency; no connection from the app; no change to Firebase Auth, Firestore, rules or functions; no deletion of Firebase code or data; no environment variable change; no refactor; no UI change. Phase 2 has not started.

CURRENT MIGRATION STATUS:
PHASE 1 — SAFETY HARNESS COMPLETE
APPLICATION BACKEND — STILL FIREBASE
SUPABASE — NOT CONNECTED
PRODUCTION DATA — UNCHANGED
FIREBASE — NOT RETIRED
ROLLBACK — FULLY AVAILABLE

## 10. Status update after Phase 6C (initial import tooling)

Phases 2 to 5 (local schema, security, repository boundary, Auth spike) and 6A to 6C are done and committed on `migration/supabase`. Phase 6C added the export / transform / validate / import / verify tooling (`PHASE6C_INITIAL_IMPORT.md`).

```
CURRENT MIGRATION STATUS:
PHASE 6C — INITIAL IMPORT TOOLING COMPLETE (NOT RUN AGAINST PRODUCTION)
APPLICATION BACKEND — STILL FIREBASE (authoritative)
SUPABASE — A COPY ONLY; production project not touched; no import performed
SHADOW / BRIDGE FLAGS — ALL OFF
PRODUCTION DATA — UNCHANGED
FIREBASE — NOT RETIRED
ROLLBACK — FULLY AVAILABLE
NEXT — owner steps in PHASE6C_INITIAL_IMPORT.md section 12 (read-only key, schema check, dry run, import, verify)
```

## 11. Status update after Phase 6D (production bridge readiness)

Phase 6D audited the production authentication bridge and prepared (but did not deploy) the production Edge Function and a proposed issuer/audience SQL guard. See `PHASE6D_PRODUCTION_BRIDGE_READINESS.md`.

```
CURRENT MIGRATION STATUS:
PHASE 6D — PRODUCTION BRIDGE READINESS PREPARED (NOTHING DEPLOYED, NOTHING APPLIED REMOTELY)
APPLICATION BACKEND — STILL FIREBASE (authoritative)
AUTH BRIDGE FUNCTION — NOT DEPLOYED; SHADOW / BRIDGE FLAGS — ALL OFF
PRODUCTION DATA — UNCHANGED BY 6D
NEXT — owner-supplied origin, secrets and decisions listed in section 8 of the 6D document
```

## 12. Status update after Phase 6D hardening

Guard migration 20261009000100 exists locally only (remote still has the original 10). Client retry, refresh margin, cooldown and the Realtime session controller exist behind the OFF bridge flag. Bridge function not deployed; all flags off. See `PHASE6D_AUTH_HARDENING.md`. Linked checkouts run unit tests with `npm run test:unlinked`.

## 13. Status update after Phase 7 preparation (supersedes the statuses in sections 10 to 12)

```
CURRENT MIGRATION STATUS:
PRODUCTION SUPABASE — 12 migrations applied (incl. issuer/audience guard and bootstrap rate limit); auth-role-bootstrap DEPLOYED (version 1)
BRIDGE HAPPY PATH — VERIFIED IN PRODUCTION with a dedicated Google test account (rate limit, expiry, revocation: not yet)
SUPABASE READ/RPC TRANSPORT — BUILT AND TESTED LOCALLY (unit + real local stack); NOT used by the app
APPLICATION BACKEND — STILL FIREBASE; ALL BRIDGE / SHADOW / BACKEND FLAGS OFF
NEXT — read-only shadow reads + reconciliation (local first); see PHASE7_SUPABASE_TRANSPORT.md
```

## 14. Status update after the Phase 7 shadow reader (local only, uncommitted)

```
CURRENT MIGRATION STATUS:
SUPABASE TRANSPORT — BUILT AND TESTED (unit + real local stack); NOT used by the app
READ-ONLY SHADOW READER + RECONCILIATION REPORT — BUILT AND TESTED LOCALLY (unit 27, Firestore emulator + local Supabase 14); NOT used by the app, NOT run against production
SHADOW-READ FLAG — NEXT_PUBLIC_SUPABASE_SHADOW_READ, OFF by default and unset everywhere
APPLICATION BACKEND — STILL FIREBASE; ALL BRIDGE / SHADOW / BACKEND FLAGS OFF
FULL HEALTH — HEALTHY (unit 28 files / 586 tests, rules 64, e2e 203, build ok)
NEXT — see PHASE7_SUPABASE_TRANSPORT.md section 9.7
```

## 15. Status update after the bootstrap limiter fix (local only, uncommitted)

```
CURRENT MIGRATION STATUS:
BOOTSTRAP LIMITER FIX — IMPLEMENTED AND TESTED LOCALLY (24 new tests; Deno type-check ok); DEPLOYED FUNCTION IS STILL VERSION 1 (old behaviour)
PRODUCTION / FLAGS / FIREBASE / VERCEL — UNCHANGED; APPLICATION BACKEND — STILL FIREBASE; ALL FLAGS OFF
NEXT — owner review, then (with approval) commit and redeploy, then the production smoke tests in PHASE6E_LIMITER_FIX.md section 6
```

## 16. Status update after the limiter fix was deployed and smoke-tested (supersedes section 15)

```
CURRENT MIGRATION STATUS:
BOOTSTRAP FUNCTION — DEPLOYED, VERSION 2 (limiter fix, commit f08c412); ACTIVE; verify_jwt off
PRODUCTION SMOKE (v2) — ESTABLISHED ACCOUNT: 150 PACED REQUESTS ALL 200 (162 s, no 429); GARBAGE BEARER 401; ACCOUNT STILL SERVED; FORGED ROLE CLAIMS 401
STILL NOT RUN IN PRODUCTION — FIRST-TIME PER-ACCOUNT RATE LIMIT (needs a second account and separate authorization), EXPIRY, REVOCATION/DISABLED ERRORS, FUNCTION LOGS
APPLICATION BACKEND — STILL FIREBASE; ALL BRIDGE / SHADOW / BACKEND FLAGS OFF; NO CUTOVER
NEXT — see the Phase 7 audit recommendation (Realtime and mirroring are not built)
```

Section 15's statements "local only, uncommitted" and "deployed function is still version 1" are historical. Details: `PHASE6E_LIMITER_FIX.md` section 8.

## 17. Status update: sign-in reconciliation and safe-replacement work (local only, uncommitted)

```
CURRENT STATE:
SIGN-IN RECONCILIATION + SAFE REPLACEMENT (restore / restore point / reset / demo / uncertain writes) — IMPLEMENTED AND TESTED LOCALLY; NOT COMMITTED, NOT PUSHED, NOT DEPLOYED
NOT PART OF THE MIGRATION: no backend, schema, rules, function, environment, flag, Firebase or Vercel change; stored document format unchanged
APPLICATION BACKEND — STILL FIREBASE; ALL BRIDGE / SHADOW / BACKEND FLAGS OFF; PRODUCTION UNTOUCHED
```

Full description: `SIGNIN_RECONCILIATION.md`. HEAD is `f08c412`; the working tree also holds the uncommitted evidence edits to `PHASE6E_*` and `PHASE7_*` documents.

**Protected files changed on purpose (hash pins updated by hand, key order kept):**
* `hooks/use-cloud-sync.ts`: first-sign-in choice instead of a silent merge; write-ahead markers and revision-based settlement of uncertain writes; base and revision stored together (`syncBaseV2`); prompt identity; paused status. A product-behaviour change, not a migration change.
* `lib/restore-points.ts`: **behaviour change.** (1) Tags-only and reminders-only copies are now saved (they used to count as empty and were silently not saved); one rule `holdsSomething`. (2) Points written before reminders/tags/mates were kept are read with empty lists and flagged `remindersKnown: false` instead of crashing the screen, and writes start from the stored list, never the normalised view, so an older point is never rewritten as something it was not. (3) Saves are serialized and read back, failing with `RestorePointError` (earlier, same file); the error message now tells the person to delete older restore points when storage is full. (4) `contents()` labels a point with tags, mates and reminders. `lib/merge.ts` and `lib/db.ts` are untouched.

**Validation actually run on this tree:**
* Full unit suite in a clean unlinked copy (`node scripts/test-unlinked.mjs`): **36 files, 848 / 848**. Baseline updated to these numbers only after that run was green.
* `tsc --noEmit` clean; `eslint .` 0 errors, 75 warnings (baseline).
* `migration-invariants` on the linked checkout: 55 pass, 1 environmental failure ("no remote link": `supabase/.temp/project-ref` exists because the checkout is linked to production). It passes in the clean copy. The link file was not touched.
* **Not run:** browser E2E, the rules suite, `npm run build`, `npm run migration:health`. The e2e baseline entry `reconcile: 44` is inherited from an earlier run on an earlier design and has not been re-verified.

NEXT — owner review of the diff; then (with approval) browser E2E, commit, and deploy. Open decision: the ambiguous-revision counter under-count needs a document-schema change to remove (see `SIGNIN_RECONCILIATION.md` section 4); nothing was done about it.

## 18. Status update: background sync tied to the safety lock, bounded network waits (local only, uncommitted; supersedes the validation lines of section 17)

```
CURRENT STATE:
SIGN-IN RECONCILIATION + SAFE REPLACEMENT — LOCAL ONLY, NOT COMMITTED, NOT PUSHED, NOT DEPLOYED
THIS ROUND — background sync (pull / live listener / push / reconcile) now respects the operation lock, the demo and an epoch; sign-in reads and writes and reset's sign-out are time-bounded; restore verification no longer undoes a legitimate concurrent update; write-in-doubt markers keep a digest instead of the sent text; older restore points that never recorded tags or mates no longer wipe them
APPLICATION BACKEND — STILL FIREBASE; ALL BRIDGE / SHADOW / BACKEND FLAGS OFF; PRODUCTION UNTOUCHED; STORED DOCUMENT FORMAT UNCHANGED
FULL HEALTH (npm run migration:health, run on this tree) — HEALTHY: unit 37 files / 892 (clean unlinked copy), rules 64, typecheck ok, lint 0 errors / 75 warnings, e2e 8 suites / 247 (local mode, Firebase keys blanked), build ok
```

Details and reasoning: `SIGNIN_RECONCILIATION.md` sections 4, 5, 5b, 5c. The confirmed risks and their fixes:
* **Background sync could write during a restore, reset or demo.** Fixed: every apply path checks owner, pause (prop or `isDemoLive()`), epoch and `lockHolder()` before and after its awaits and again immediately before applying; deferred data is retried on lock release and when a pause ends (no loop, nothing discarded). Markers are kept on deferral.
* **Hung network calls.** Fixed: `cloudGet` 6 s and `cloudPut` 12 s bounds; reset's sign-out bounded at 8 s (refused before any wipe); the lock is released by `finally`, never expired while an operation is running. Without Firebase keys a local-only reset is possible; real sign-out failures still propagate.
* **False revert.** Fixed: a restore is undone only if the data is still exactly what it applied, and the undo is verified before it is claimed.
* **Marker storage.** Fixed: digest markers (compatible with old text markers).
* **Legacy restore points** missing tags/mates are distinguishable from empty ones and no longer wipe current tags/mates.

**Protected files changed (hashes hand-edited, key order kept):** `hooks/use-cloud-sync.ts` (now 14e054b0…) and `lib/restore-points.ts` (now 5cf7147f…; adds `tagsKnown`/`matesKnown`, still read-only normalisation). `lib/account.ts`, `lib/merge.ts` and `lib/db.ts` are untouched. Baseline raised to unit 37 files / 892 tests only after the clean-copy run was green.

**Environmental:** `migration-invariants` run directly on this linked checkout fails one test ("no remote link", because `supabase/.temp/project-ref` exists); `migration:health` runs the unit suite on a clean unlinked copy, where it passes. The link file was not touched.

**Still open:** the `N >= R+2` counter under-count needs a document-schema change and approval (section 4 of `SIGNIN_RECONCILIATION.md`). Nothing has been committed, pushed or deployed.

## 19. Status update: first-connection upload race fixed (local only, uncommitted; supersedes the test counts and the hook hash in section 18)

The first upload recorded the data as it was after the request (not the uploaded snapshot) as synced, so an edit made during the upload was never sent. Fixed in `hooks/use-cloud-sync.ts` via `settleFirstConnection` (`lib/signin-reconcile.ts`); 6 new tests in `tests/first-connection.test.ts`. Hook hash is now 74fab375…; baseline unit 38 files / 898 (clean unlinked copy, green). Typecheck clean, lint 0 errors / 75 warnings. After this change only the unit suite, typecheck and lint were re-run: rules, browser E2E and build were last run before it (section 18) and have not been repeated. Offline reset waiting 8 s with Firebase configured was assessed and left unchanged (`SIGNIN_RECONCILIATION.md` 5d). Nothing committed, pushed or deployed.

## 20. Status update: sign-in choice edit-while-waiting fixed (local only, uncommitted; supersedes the counts and hook hash in section 19)

`finalize` now records the verified snapshot through `connected()` and raises a push if the data changed while the choice waited on the network. Hook hash 4e5b09a1…; unit baseline 38 files / 904 (clean unlinked copy, green); typecheck clean; lint 0 errors / 75 warnings. Rules, browser E2E and build were last run before sections 19 and 20 and have not been repeated. Offline-reset shortcut assessed and not implemented (`SIGNIN_RECONCILIATION.md` 5e). Nothing committed, pushed or deployed.

## 21. Status update: edits during a sign-in safety copy (local only, uncommitted) — and which validation record is current

**Current validation record: `SIGNIN_RECONCILIATION.md` section 7.** Sections 17 to 20 above contain superseded figures (unit 36 / 848, 37 / 892, 38 / 898, 38 / 904 and earlier hook hashes). Current: unit baseline **38 files / 910 tests**; clean unlinked copy 910 / 910; linked checkout 909 passed + 1 known environmental failure (`migration-invariants` "no remote link", `supabase/.temp/project-ref` present, file untouched). `npm run migration:health` was re-run on this tree after the last code change: HEALTHY (rules 64, typecheck, lint 0 errors / 75 warnings, E2E 247 in local mode, build ok). The hook hash is the one in `tests/migration-protected.json` (4e5b09a1…; the hook was not changed this round).

This round: `doMerge` and `doCloud` in `lib/signin-reconcile.ts` now retake the safety copy if the device's data changed while it was being saved (up to three tries, then `device-changed`), and `doMerge` verifies the applied merge on the device before uploading. 6 tests added. Nothing committed, pushed or deployed.

## 22. Status update: Phase 8 Realtime, local only (uncommitted)

```
CURRENT MIGRATION STATUS:
PHASE 8 REALTIME (sync document only) — BUILT AND TESTED LOCALLY; behind NEXT_PUBLIC_SUPABASE_REALTIME (off, unset everywhere); NOT used by the app; NOT applied to production
LOCAL STACK EVIDENCE (this tree) — test:local-supabase 21/21 (16 earlier + 5 new Realtime), test:shadow-integration 14/14; both ran against the real local stack and the Firestore emulator
FULL HEALTH (npm run migration:health, this tree) — HEALTHY: unit 39 files / 940 (clean unlinked copy), rules 64, typecheck ok, lint 0 errors / 75 warnings, e2e 8 suites / 247 (local mode), build ok
APPLICATION BACKEND — STILL FIREBASE; ALL FLAGS OFF; PRODUCTION UNTOUCHED
NEW MIGRATION FILE — supabase/migrations/20261011000100_realtime_syncs.sql: applied to the LOCAL database only; production needs explicit approval
```

Details: `PHASE8_REALTIME.md`. Protected files: none changed (hash pins verified). `lib/db.ts`, `lib/merge.ts`, `supabase/.temp/project-ref` untouched. Not started: Ping promotion, push-sender deployment, production shadow testing, any production flag.

## 23. Status update: overnight run 1 (local only, uncommitted; supersedes the counts in section 22)

```
CURRENT MIGRATION STATUS:
PHASE 8 REALTIME (sync document) — retry defect FIXED; owner isolation ENFORCED in sync.get; real local-stack proof for the sync core (not for the React hook itself)
PHASE 9 SLICE — Ping/connection live lists by polling in the Supabase adapter (flagged, local); Ping state machine verified against the real local stack incl. authorization, expiry, lease takeover and concurrency; the app still uses Firebase Pings
PHASE 10 SLICE — push dispatch decision logic + messages (pure, fake-tested, NOT deployed, not imported by the app)
APPLICATION BACKEND — STILL FIREBASE; ALL FLAGS OFF; NO HOSTED / PRODUCTION CHANGE
UNIT (clean unlinked copy) — 41 files / 980; LOCAL STACK — local-supabase 41/41, shadow-integration 14/14; rules 64 (on retry); typecheck ok; lint 0 errors / 74 warnings; build ok
E2E — 6 of 8 suites pass; nav and value fail because the run was on a Monday (the week-wrapped bubble covers the percentage toast): date-dependent, not caused by this run, not control-verified. migration:health therefore reports UNHEALTHY.
```

Details: `PHASE8_REALTIME.md` section 6. Protected files: none changed (pins verified). No schema or migration added this run (the Realtime publication migration is from the previous run, local only).

## 24. Status update: the real hook against local Supabase (test-only; local, uncommitted; supersedes the counts in section 23)

```
CURRENT MIGRATION STATUS:
REAL useCloudSync HOOK vs LOCAL SUPABASE — PROVEN END TO END in a real browser (node scripts/run-hook-supabase.mjs: 48/48, three consecutive runs): Firebase Auth emulator sign-in, the real bootstrap handler, adapter, Realtime and RLS; cross-device convergence, conflict merge, Realtime recovery, failed-read recovery, sign-out and account-switch isolation
TEST-ONLY WIRING — lib/firebase.ts (emulators only when both hosts are set to loopback in a non-production build); scripts/local-supabase-gateway.mjs (verifies emulator tokens and swaps in local-stack tokens; refuses to start unless everything is loopback); NOT enabled anywhere; lib/cloud-sync.ts unchanged
APPLICATION BACKEND — STILL FIREBASE; ALL PRODUCTION FLAGS OFF; NO HOSTED / PRODUCTION CHANGE
FULL HEALTH (npm run migration:health, this tree) — HEALTHY: unit 42 files / 998 (clean unlinked copy), rules 64, typecheck ok, lint 0 errors / 74 warnings, e2e 8 suites / 247, build ok
LOCAL STACK — test:local-supabase 41/41, test:shadow-integration 14/14; hook suite 48/48
DATE-DEPENDENT E2E (nav, value) — reproduced on a Monday with an unchanged control, cause = designed "week wrapped" bubble covering the toast, fixed in the two suites' seeding; both now pass
```

Details: `PHASE8_REALTIME.md` section 7. Protected files: none changed beyond the previously documented ones (pins verified); `lib/account.ts`, `lib/identity.ts`, `lib/db.ts`, `lib/merge.ts`, `firestore.rules`, `functions/`, `package.json` untouched. Two guard tests were updated on purpose: `phase6d-bootstrap-function` (the local gateway is the one script allowed to import the real handler).

## 25. Status update: hosted-readiness assessment (local only, uncommitted; nothing hosted was touched)

```
HOSTED-READINESS — assessed in HOSTED_READINESS_PLAN.md: milestones M0-M10 with prerequisites, exact changes, local validation, approvals, rollback and measurable acceptance; separate decisions D1-D9 (the N>=R+2 counter semantics and the offline-reset behaviour are D1 and D2, UNCHANGED)
LOCAL CHECKS DONE THIS ROUND — 13 migrations replay cleanly; the 13th = exactly one statement and idempotent; ~850 kB sync document still notifies through Realtime; the PROPOSED push outbox (proposals/push_outbox.sql, outside supabase/migrations) behaves as designed (tests/local-supabase/hosted-readiness.test.ts, 18 tests); a default production build has the emulator wiring compiled out and the Realtime code dormant
LOCAL STACK — test:local-supabase 59/59 (5 files); unit baseline unchanged (42 files / 998)
GAPS FOUND — G1 backend choice is global (no one-domain-at-a-time cutover yet); G2 flags are build-time (rollback = redeploy); G3 no reverse mirroring; G4 no persisted shadow report; G5 everything is uncommitted; G6 push needs a hosted secret + schema change (held behind a gate)
APPLICATION BACKEND — STILL FIREBASE; NO HOSTED / PRODUCTION CONTACT; NO FLAG, SECRET, MIGRATION OR DEPLOYMENT
NEXT — per-domain backend routing (local), then ask for the commit approval (M0)
```

## 26. Status update: M3a per-domain backend routing (local only, uncommitted)

Firebase is still the default for every domain. `getDomainBackend(domain)` (sync, social, ping, push) with `NEXT_PUBLIC_BACKEND_SYNC/_SOCIAL/_PING/_PUSH` overriding the global value; unknown values throw; Supabase without configuration fails closed. Files: `lib/backend/index.ts`, `lib/cloud-sync.ts`, `lib/use-social.ts`, `tests/domain-routing.test.ts` (new, 17), `tests/hook-integration-guards.test.ts`, `scripts/e2e-hook-supabase.mjs` (only sync routed; asserts only sync tables reached Supabase), `scripts/local-supabase-gateway.mjs` (per-target counters), `scripts/migration-baseline.json` (43 files / 1015). Results: tsc clean; eslint 0 errors / 74 warnings; unit 43 files / 1015 (clean unlinked copy); test:local-supabase 59/59; test:shadow-integration 14/14; hook suite 49/49 with only sync on local Supabase; next build ok; migration:health HEALTHY (rules 64, e2e 247). Not verified: a social action in the browser while sync is routed (Mates tab froze the page in the emulator setup, not investigated). Nothing staged, committed, pushed or deployed; no hosted contact.

## 27. Status update: M3a domain isolation proven in the browser (local only, uncommitted)

**Mates-tab "freeze" diagnosis: not an app problem and not caused by M3a.** A CPU profile after opening Mates shows the page idle (about 3.7 s of 5 s) with a short QR-code render (about 300 ms in dev mode); the input appeared and the page answered every probe. The earlier hang was in the test: device A was a background tab (device B opened after it), and Puppeteer's `page.click` on an element in a tab that never paints waits forever (`Runtime.callFunctionOn timed out`). The fix is `bringToFront()` before the step and focusing the input directly. The first diagnostic attempt also hit one dev-server 404 that cleared on retry (not investigated further).

**Change:** `scripts/e2e-hook-supabase.mjs` step 3b: on device A, open Mates, type a display name and press Enter (a real social-domain write). Checks: the name is stored in Firebase (Firestore emulator `users/<uid>`), and the gateway saw no request other than `syncs` / `rpc:sync_put`. `tests/hook-integration-guards.test.ts` gained 2 guards (the runner routes only `NEXT_PUBLIC_BACKEND_SYNC`, never the global value or another domain, and keeps the social checks).

**Evidence.** Sync-only: `node scripts/run-hook-supabase.mjs` exit 0, 52/52; gateway targets `{"syncs":45,"rpc:sync_put":13}` and the profile name read back from the Firestore emulator. Negative control (runner temporarily set to global `NEXT_PUBLIC_BACKEND=supabase`, then restored): exit 1, 49/52; the three social checks failed, the name was absent from Firestore and the gateway saw `{"syncs":14,"rpc:sync_put":3,"rpc:upsert_profile":1}`. The static guard also fails on that mutated runner (1 failed / 19 passed) and passes on the restored one (20/20).

**Validation:** tsc exit 0; eslint 0 errors / 74 warnings; unit (clean unlinked copy) 43 files / 1017; test:local-supabase 59/59; test:shadow-integration 14/14. `next build` and `migration:health` were not re-run after this change (only test code and the baseline changed; the previous run is in section 26). Nothing staged, committed, pushed or deployed; no hosted contact.
