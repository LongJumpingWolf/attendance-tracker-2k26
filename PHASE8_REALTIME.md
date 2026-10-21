# PHASE8_REALTIME.md

Phase 8 of `MIGRATION_PLAN.md`: Supabase Realtime for the single stored sync document. **Local only. Not committed, not deployed.** Firebase is still the backend; `NEXT_PUBLIC_SUPABASE_REALTIME` is off by default and is not set anywhere; no production flag, configuration or database was touched, and the new migration was applied to the LOCAL database only.

## 1. Fresh evidence gathered first (before any change)
Docker and the local Supabase stack were already running (`docker ps`: db, rest, auth, realtime, kong, storage... up; only the optional `vector` log shipper was restarting, irrelevant here). Nothing was installed or reconfigured.

| Suite | Command | Result |
|---|---|---|
| Real transport + adapter against real PostgREST (incl. the Ping RPCs, profiles, invites, connections, sync, push tokens) | `npm run test:local-supabase` | **16 / 16 passed** |
| Read-only shadow reader against the Firestore emulator AND the local Supabase stack | `npm run test:shadow-integration` | **14 / 14 passed** (needed Java and the firebase CLI: present) |

Nothing was blocked.

## 2. What was built
| Piece | File | Notes |
|---|---|---|
| Wire transport | `lib/backend/supabase/realtime-transport.ts` | Phoenix-channels over WebSocket, written by hand because no client package may be added. Joins Postgres Changes for ONE table and ONE owner (`uid=eq.<owner>`) with the token; heartbeat; any close/error/phx_error/missed heartbeat reconnects with capped backoff and re-joins with the LATEST token; refuses non-https (or non-loopback http) URLs and unsafe table/filter names; unsubscribe leaves the channel, closes the socket and clears every timer |
| Sync watcher | `lib/backend/supabase/sync-watch.ts` | One session per owner (shared by every watcher); every delivery goes through a normal RLS-checked read (`sync.get`), never the event payload; coalesced reads; one delivery per revision (older/equal dropped); **polling fallback** (15 s) whenever the channel is not live; cleanup when the last watcher leaves |
| Existing session controller | `lib/backend/supabase/realtime-session.ts` (unchanged) | `setAuth` before every subscribe, refetch on every `subscribed`, sign-out drops the channel |
| Adapter | `lib/backend/supabase/index.ts` | `sync.watch` uses the watcher only if the caller passes `realtime`; otherwise "not live" exactly as before. Connections/Pings/other `watch` calls are unchanged (still "not live") |
| Flag | `lib/backend/flags.ts`, `lib/backend/index.ts` | `NEXT_PUBLIC_SUPABASE_REALTIME`, exact `"true"` only; read only inside the `supabase` branch of `getBackend()` (never while Firebase is selected, the default) and only with the Supabase configuration present; part of the backend cache key |
| Migration | `supabase/migrations/20261011000100_realtime_syncs.sql` | Idempotently adds `public.syncs` to the `supabase_realtime` publication (it was empty). No policy, grant or schema change: existing select policies decide who receives an event. Applied to the local DB with `npx supabase migration up --local`. **Not applied to production**; a production push needs the owner's explicit approval |

### A defect found by the real stack, and fixed
The first local run missed an update: the server accepts the channel join (`phx_reply ok`) BEFORE the database change stream is running (a later system message, "Subscribed to PostgreSQL", confirms it). Reporting "subscribed" at the join made the session's refetch happen too early, so a change made in between was neither delivered nor refetched. The transport now reports `subscribed` only after that confirmation (and starts over if it never comes within 10 s). With that, the refetch-after-subscribe rule is sound. Stand-in tests could not have found this.

## 3. Behaviour
* Socket dropped → `closed` (watcher reports not-live, polling resumes) → reconnect → re-join with the latest token → `subscribed` → refetch → convergence on anything missed (Realtime does not replay).
* Several watchers of one account → one channel/socket; a late watcher starts from the current copy; each revision reaches each watcher once.
* Sign-out (null token) → token cleared, channel dropped, not-live, polling continues (and fails closed without a token). Account switch → the app's `watch` cleanup removes the old account's session; the new account gets its own channel filtered to itself; RLS means neither sees the other's rows.
* The consumer (`hooks/use-cloud-sync.ts`) is unchanged: it still applies a document only through `ingest` (revision, markers, merge, locks, epoch). Realtime is not selected for the app today anyway.

## 4. Tests
| Test | What | Result (this tree) |
|---|---|---|
| `tests/phase8-realtime.test.ts` (30) | wire transport against a scripted WebSocket; watcher against a fake store/bridge: join frame, confirmation-before-subscribed, token handling, reconnect/backoff, heartbeat, leave/cleanup (no timers left), refetch after every subscribe, kill-mutate-restore convergence, dedupe, coalescing, shared channel, polling fallback and hand-over, sign-out, token refresh, account switch, flag default, wiring | pass |
| `tests/local-supabase/realtime-e2e.test.ts` (5) | the REAL adapter + fetch transport + Realtime transport against the LOCAL stack: live delivery by revision; socket killed, document changed while down, socket restored → converges; two watchers → one socket, one delivery each; Realtime unreachable → polling delivers, then hands over; sign-out and account switch → channels closed, no cross-delivery | **5 / 5, run twice** |
| Mutation checks | 10 safeguards removed one at a time (subscribed-on-join, heartbeat, timer cleanup, reconnect, revision dedupe, sharing, poll stop, refetch-on-subscribed, session stop, coalescing) | all 10 caught by `phase8-realtime` |

Two existing guard tests were updated on purpose, with the reason in their names: "no application file imports the Realtime session" (now: only `sync-watch.ts` and the wire transport inside `lib/backend/supabase` may), and the single-line shape of the supabase branch of `getBackend`.

## 5. Not done in this phase
* Realtime for connections and Pings (their `watch` stays "not live"); Ping promotion, push sender, production shadow testing: separate validation and approval.
* The hook does not use the Supabase adapter (Firebase is selected); nothing exercises Realtime from the browser app. Only the adapter-level behaviour is proven.
* Production: the migration is unapplied; Realtime must be enabled for the table in the hosted project and its limits (concurrent connections, messages) checked against the Free plan before any use.
* A stored revision that goes BACKWARDS is not delivered by the watcher (monotonic); a rebaseline still happens only through an explicit pull in the hook.

## 6. Overnight run 1 (supersedes statements above where they differ)

### 6.1 Retry defect (fixed)
A read that failed right after `subscribed` was swallowed, and because the channel was then "live" the poll was off: a change made around the subscription (never announced by an event) left the watcher stale for ever. `sync-watch.ts` now retries a failed read **while live**, with backoff (1 s doubling up to the poll interval) until one succeeds; the retry stops on success, when the channel drops (the poll covers it) and when the last watcher leaves (no timer left). Reproduced first (2 new unit tests failed against the old code) and also over the real path (`sync-core-e2e`: with the retry disabled the test times out; with it, B recovers).

### 6.2 Owner isolation (fixed)
`sync.get(owner)` ignored `owner`. It now refuses (`BackendError` unauthorized, code `sync-owner-mismatch`, not retryable) any row whose `uid` is not the requested owner, or has none, instead of returning it or saying "nothing stored". The watcher therefore never delivers another account's row. No RLS, policy, grant or schema change.

### 6.3 Real-hook integration (partly possible; the gap is documented)
`tests/local-supabase/sync-core-e2e.test.ts` (5 tests) runs the app's real sync core (write-ahead markers, revision settlement, ingestor, three-way merge) for two devices of one account over the real local path: real fetch transport, real adapter (compare-and-set, owner check), real Realtime, real RLS. Covered: A writes and B receives live; B writes and A converges; simultaneous edits conflict, merge and the counter adds both; B's socket killed and refused while A writes twice, then B converges; the failed post-subscribe read recovers; sign-out and account switch deliver nothing across accounts.

**What is NOT done: `hooks/use-cloud-sync.ts` itself has not run against Supabase.** It reaches the backend only through `lib/cloud-sync.ts`, which uses `getBackend()` only when Firebase is configured, and it signs in through Firebase Auth plus the deployed `auth-role-bootstrap` function. Missing locally: Firebase Auth emulator wiring in `lib/firebase.ts`, a locally served bootstrap function, and a Supabase kind in `cloud-sync.ts`. A token shortcut inside the app would be an authentication bypass, so none was added. The hook is covered by the browser E2E in dev-store mode and by its unit tests. To close the gap with a real hook run: (1) wire `connectAuthEmulator` behind a test-only flag, (2) `supabase functions serve auth-role-bootstrap` with a test Firebase project id, (3) add a Supabase branch to `cloud-sync.ts`. Each touches protected or production-facing code and needs a decision.

One of the first runs of the "simultaneous edits" test failed once (timeout waiting for both counters to read 2) and could not be reproduced in 10 further runs of the file; it is kept, with diagnostic output on failure, and listed as an open observation.

### 6.4 Phase 9 slice: Ping and connection live lists (local only)
`pings.watch` / `connections.watch` were "not live". With `watchPollMs` (set only behind `NEXT_PUBLIC_SUPABASE_REALTIME`, inside the supabase branch) they now poll the normal RLS-checked read (`poll-watch.ts`): one poller per account, delivery only on change, rows that do not involve the account dropped, failed reads keep the last list and report not-live, full cleanup. Realtime was deliberately not used here: Postgres Changes cannot express "from me OR to me" in one filter and the tables are not in the publication (a second configuration migration). No schema change. Unit tests: `phase9-ping-watch` (10). Local stack: `ping-e2e` (15): strangers, wrong roles (answer/lease/finalize/remove), server-derived sender, idempotent create and id reuse, validation, class-day window, state machine (no lease/finalize before answer, no double answer, unapplied answer not removable), expiry on the database clock, lease takeover after 2 minutes, and genuinely concurrent creates, leases, finalizes and answers; watchers see asking -> answered -> processed, a stranger's watcher sees nothing, and a watcher under a switched identity never delivers the other account's Pings. **Ping is not "fully integrated": the app still uses Firebase Pings; this is the adapter and database behaviour only.**

### 6.5 Phase 10 slice: push dispatch logic (local, pure)
`lib/backend/supabase/push-dispatch.ts` and `ping-push-messages.ts`: the decision and send logic for a Ping event with everything external injected. Recipient from the freshly read Ping (never the event); one handling per event (claim); stale/expired/missing Pings dropped; dead tokens removed per device and not retried; transient failures retried with bounded backoff (5 attempts, 1 s to 60 s); generic lock-screen text identical to `functions/ping-messages.js` (parity test). Tested with fakes (`phase10-push-dispatch`, 25 tests). Nothing is deployed, no secret exists, nothing real can be sent, and nothing in the app imports it. The client still stores one token per account (`device_id = 'legacy'`); this does not make multi-device real. Still required before it can run: an Edge Function (needs approval), a hosted FCM secret, a database-backed outbox table (schema change) and a trigger or webhook.

### 6.6 Validation for this run (actually run, this tree)
| Check | Result |
|---|---|
| Unit, clean unlinked copy | **41 files, 980 / 980** |
| `npm run test:local-supabase` | **41 / 41** in 4 files (16 earlier + 5 Realtime + 5 sync-core + 15 Ping) |
| `npm run test:shadow-integration` | **14 / 14** |
| `tsc --noEmit`, `eslint .` | no type errors; 0 errors, 74 warnings (baseline 75) |
| rules (`migration:health`) | 64 / 64, **passed on retry** (the first attempt failed only in the documented flaky `identity.test.ts`) |
| `next build` | succeeded |
| browser E2E (`migration:health`) | **6 of 8 suites passed; `nav` (34/35) and `value` (28/32) FAILED**, every failure showing the toast "Your week wrapped is ready" in place of the percentage toast. Cause: the date. The run happened on a Monday (2026-10-12, 00:41 IST); the app shows the "week wrapped" bubble when last week has marks, and these suites mark "yesterday" (a Sunday = last week). Earlier green runs were on a Sunday. No UI file was touched by this run, but this is NOT proven by a control run on an untouched tree. Not fixed: making the suites date-independent needs a decision |
| `migration:health` overall | **UNHEALTHY solely because of those two date-dependent E2E suites** |

## 7. The real `useCloudSync` hook against the local Supabase stack (test-only; supersedes 6.3)

**Run it:** `node scripts/run-hook-supabase.mjs` (needs the local stack running, Java + firebase CLI for the emulators, Chrome + puppeteer-core as the other browser suites). It reads the local stack's development keys from `supabase status`, refuses anything non-loopback, starts the Firebase Auth + Firestore emulators for the demo project `demo-hook`, starts the gateway and a `next dev` on port 3459 built with test-only settings, drives two browser "devices", prints PASS/FAIL per check, cleans up the rows of the accounts it created and stops everything it started.

**What is real in that run:** the Next app and `hooks/use-cloud-sync.ts` unchanged; the Firebase Auth SDK and the app's own sign-in UI (`signInWithPopup` / `linkWithPopup` against the emulator's Google popup); the auth bridge (`lib/backend/supabase-auth.ts`) and the **real bootstrap handler** (`supabase/functions/auth-role-bootstrap/handler.ts`), whose Admin-SDK calls go to the Auth emulator (verify, read user, set the `role` claim); the Supabase adapter, the fetch transport and the Realtime wire transport; the local PostgREST + Realtime services, the database, its RLS and its issuer/audience guard policy. `lib/cloud-sync.ts` needed **no change**: with `NEXT_PUBLIC_BACKEND=supabase` it already reaches Supabase through `getBackend()`.

**What stands in for production, and why:** a local Supabase stack cannot verify tokens issued by the Auth emulator (they are unsigned), where production verifies Firebase tokens against Google's published keys. `scripts/local-supabase-gateway.mjs` stands where that acceptance stands: it asks the **emulator** to confirm each ID token (so a forged, expired, unknown-user, wrong-project or role-less token gets 401), requires the `role` claim the bootstrap put there, and only then mints a token for the same subject signed with the local stack's own development secret. There is no fixed or shortcut token and nothing is trusted from a request body. It also proxies the Realtime WebSocket, verifying and swapping the token inside the join / access_token frames. Test controls (`/__test/*`: stats, kill sockets, fail the next N sync reads) answer only loopback requests that carry no Origin header.

**Test-only wiring in the app:** `lib/firebase.ts` connects Auth and Firestore to the emulators only when BOTH `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` and `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` are set to loopback `host:port` in a **non-production** build (a production build ignores them; one half alone, or a non-loopback host, does nothing); it also turns FCM off in that mode. No file in the repository sets them; only the runner's child dev server receives them, together with the Supabase flags (`NEXT_PUBLIC_BACKEND`, `..._AUTH_BRIDGE`, `..._REALTIME`) and a loopback gateway URL. Two devices are two app origins in one browser profile (`localhost` and `device-b.localhost`, separate IndexedDB / localStorage) so the emulator's Google account list can be reused to sign the SAME account in on both.

**Results (48 checks, 3 consecutive passes after the last edit):** (1) real popup sign-in; the hook records the owner; the real bootstrap ran and a verified token was exchanged; the device's data is uploaded as revision 1 through RLS; the Realtime channel opens. (2) a second device signs in as the same Google account, gets the same user id, and takes the account's data. (3) A's change reaches the database and B live; B's change reaches A live; both end with the same tags; no extra sockets. (4) both edit while apart (B offline): reconnecting merges, both changes are stored, A converges, the revision moves on. (5) sockets killed from the server while a change is made: B re-subscribes and converges on what it missed. (6) the sync reads B makes on coming back fail three times (injected 503s): B still converges with no further change by A (the bounded retry); with that retry disabled the same check **fails**, so the check discriminates. (7) sign-out deletes nothing; a signed-out device receives nothing; signing in as a different account asks (data belongs to the previous account), uploads nothing until the explicit confirmed choice, then each account only ever sees its own changes in both directions.

**Not covered / honest limits:** production Google (popup UI, real keys), Supabase's own third-party-auth verification (replaced by the gateway as described), the hosted Realtime service and its limits, Firestore-backed social/Ping features under this build (the app runs with the Supabase backend selected; only sync is exercised), mobile browsers. The emulator's popup page loads its own CSS/JS from public CDNs inside the browser (not the app's traffic). The earlier one-off timeout of the "simultaneous edits" test in `sync-core-e2e` did not reproduce here (the equivalent scenario, check 4, passed in every run); it remains an unexplained single observation.

### 7.1 `nav` and `value` browser suites (date dependence, fixed in the suites)
Both failed on Monday 2026-10-12 with the toast "Your week wrapped is ready" where a percentage toast was expected; they had passed on the Sunday before. **Control:** re-run unchanged on that Monday (same code, separate dev server with Firebase keys blanked): `nav` 34/35 and `value` 28/32 failed again, each failure showing the wrapped-story bubble. **Cause:** `app/page.tsx` shows the story when last week (the Monday-to-Sunday week before today's, `lib/wrapped.ts`) has marks and has not been seen; the suites mark "yesterday", which on a Monday is last week. This is designed app behaviour, not a bug. **Fix (suites only, no app change):** the seeding of those suites now marks last week's story as already seen (`wrappedSeenWeek` = last week's Monday, computed in the page by the same rule). After it: `nav` 35/35 and `value` 32/32 on the same Monday, and `migration:health` HEALTHY.
