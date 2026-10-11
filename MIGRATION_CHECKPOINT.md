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
