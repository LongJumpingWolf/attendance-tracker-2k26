# HOSTED_READINESS_PLAN.md

Hosted-readiness assessment and the controlled deployment plan for Phases 9–12 (Realtime and push, production identity, soak, cutover).
Written 2026-10-12 against the working tree on branch `migration/supabase` (HEAD `f08c412` plus a large amount of **uncommitted** local work).

**Nothing in this document was executed against production.** No hosted service was contacted, no production flag, secret, migration or deployment was touched. Firebase is, and stays, the production authority throughout. Every step below that touches a hosted system is marked **GATE** and needs the owner's explicit approval first; each states its rollback.

---

## 1. Where things stand

### 1.1 What is verified locally (this tree, actually run)
| Area | Evidence |
|---|---|
| App + hook behaviour | `migration:health` HEALTHY: unit 42 files / 998 (clean unlinked copy), rules 64, typecheck, lint 0 errors / 74 warnings, build, browser E2E 8 suites / 247 (the two date-dependent suites fixed and re-verified) |
| Real `useCloudSync` hook on Supabase (local) | `node scripts/run-hook-supabase.mjs`: 48/48, three consecutive runs. Real Auth-emulator sign-in, **real bootstrap handler**, adapter, Realtime and RLS; cross-device convergence, conflict merge, Realtime recovery, failed-read recovery, sign-out and account-switch isolation |
| Backend adapter + Ping state machine (local stack) | `npm run test:local-supabase` 59/59 (incl. 15 Ping authorization / idempotency / expiry / lease / concurrency tests and the checks added in 1.3); `test:shadow-integration` 14/14 |
| Migrations | all 13 replay cleanly, in order, on an empty database; the 13th (Realtime publication) adds exactly one statement and is idempotent (new, 1.3) |
| Push decision logic | `push-dispatch` 25 fake-tested tests; message parity with the Firebase functions |

### 1.2 What is NOT verified, and cannot be without production (or a production-equivalent)
1. **Supabase third-party auth with real Firebase tokens at scale**: the bridge's happy path was smoke-tested in production earlier (established account, function v2: 150 paced requests all 200; garbage bearer 401; forged role claims 401), but these are **still untested in production**: the first-time per-account rate limit (needs a second never-used account), token expiry, revoked / disabled users, function logs, and the anonymous sign-up question (`PHASE6E_LIMITER_FIX.md` §8).
2. **Hosted Realtime**: the publication, tenant limits, message size limits, connection limits and behaviour behind the hosted proxy. Locally the whole path works; the hosted service has its own limits (to be read from the dashboard at the time; do not trust remembered numbers).
3. **Real push delivery**: FCM credentials, a hosted sender, device delivery. Only logic with fakes exists.
4. **Real Google sign-in and real browsers/phones** (the local test uses the Auth emulator's popup and desktop Chrome).
5. **Behaviour under real load, real latency, real quota**: only the budget analysis in `PHASE6E_RATE_LIMIT_AND_QUOTA.md` exists.

The local gateway used by the hook test replaces Supabase's own token acceptance; the tokens it mints are not what production sees. That is the single biggest reason milestone 3 (a production-equivalent preview) exists.

### 1.3 Local checks made for this assessment (no production contact)
| Check | Result |
|---|---|
| Replay of the 13 migrations on an empty throwaway database in the local Postgres container | clean |
| The 13th migration on a database holding the first 12 (= production's state) | schema diff = exactly `ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.syncs;`; running it twice changes nothing; on a database without the publication it does nothing |
| A ~850 kB sync document (the limit is just under 900 kB) through the real Realtime path | still produces a change notification; the normal read returns all of it. (Hosted message-size limits remain to be read from the dashboard.) |
| The proposed push outbox (`proposals/push_outbox.sql`, **not** a migration) after all 13 migrations | 12 behaviour tests pass (legacy import enqueues nothing, exactly-once enqueue even on a replay, clients have no access of any kind, recipient derived from the Ping row, clients cannot forge a transition, concurrent claims disjoint, lease takeover, retry / finish, bad arguments, draft kept out of migrations). Of 8 mutations of its safeguards 6 are caught; the other 2 (`ON CONFLICT` without a target, and omitting `SKIP LOCKED`) are behaviour-equivalent here (the unique constraint and the READ COMMITTED re-check still hold) and are listed so nobody mistakes them for coverage |
| A default production build (`next build`, no test variables) inspected | the emulator wiring is compiled out (no `usingFirebaseEmulators`, no emulator hosts in any client chunk); the Realtime wire code ships but is dormant behind `NEXT_PUBLIC_SUPABASE_REALTIME`; no `/__test/`, no local hostnames, no Supabase project reference in client chunks |
| Hosted-state inventory from the repository's own records (not by contacting production) | 12 migrations applied (through `20261009000200`), `auth-role-bootstrap` deployed as version 2, all migration flags off, Vercel production on Firebase |

### 1.4 Gaps found while planning (these shape the plan)
* **G1. The backend choice is global. CLOSED by M3a (see section 2, M3).** (Original finding:) `getBackend()` returns one backend for sync, social, Ping, invites and push tokens (`lib/cloud-sync.ts`, `lib/use-social.ts`). A cutover "one domain at a time" (sync → social → Ping → push) is **not possible yet**. Milestone 3 builds per-domain selection.
* **G2. Flags are build-time (`NEXT_PUBLIC_*`).** Turning one off is a redeploy, not a switch. Rollback speed is therefore the speed of Vercel's "promote the previous deployment", which must be rehearsed; a runtime kill switch is a separate decision (D6).
* **G3. No reverse mirroring.** Supabase→Firebase mirroring is required by the plan before any domain's writes move (so rollback finds Firebase current). It does not exist. Shadow writes are Firebase→Supabase only.
* **G4. No persisted shadow report.** `shadow_mismatch` is unused; no schedule, no history.
* **G5. Uncommitted work.** The reconciliation, safe-replacement, Realtime, Ping-watch, push-logic and hook-integration work is only in the working tree. Nothing can be reviewed, deployed or rolled back by commit until it is committed (**GATE**).
* **G6. Push needs a hosted secret and a schema change** (outbox), an Edge Function and a trigger or poller: all gated.

---

## 2. Ordered milestones

Each milestone: prerequisites → exact changes → local validation → approval → rollback → acceptance. M0–M1 and M3's code are local-only; hosted steps are marked **GATE**.

### M0. Land the local work (GATE: commit/push approval)
* **Prerequisites:** this tree green (it is). Owner reviews the diff.
* **Changes:** commit the working tree on `migration/supabase` in reviewable commits (suggested order: reconciliation + safe-replacement + docs; Realtime + sync watch + migration file; Ping watch + push logic; hook integration scaffolding + test fixes). No push to `main`, no deploy.
* **Local validation:** `migration:health` HEALTHY on the committed tree; `node scripts/run-hook-supabase.mjs` 48/48; `test:local-supabase` and `test:shadow-integration` green.
* **Approval:** commit; push of the branch (separate); any merge to `main` (separate).
* **Rollback:** `git revert` per commit; nothing deployed.
* **Acceptance:** clean `git status`; health HEALTHY on a clean clone of the branch.

### M1. Close the production bridge test gaps (GATE: production access, dedicated test account)
* **Prerequisites:** M0 not required (the function is already deployed, v2). A **second** dedicated Google test account; the owner present; Supabase function logs readable.
* **Changes (none to code):** run the remaining tests listed in 1.2(1) with the dedicated accounts only: first-time per-account limit (6 / 10 min per verified account), a token past expiry, a disabled user, a revoked session; read the function logs; decide the anonymous sign-up question (D5).
* **Local validation first:** `tests/phase6d-bootstrap-function.test.ts`, `phase6e-*` (all green now).
* **Rollback:** none needed (read/test only); if a rate-limit lock-out occurs it clears with the window.
* **Acceptance:** each case returns the documented status (200 / 401 / 403 / 429 / 503) and nothing but the fixed error word; logs contain no token, uid or key; the 429 clears after the window.

### M2. Hosted Realtime publication (GATE: production database migration)
* **Prerequisites:** M1 done or consciously deferred (the migration is independent of auth). Read the hosted Realtime limits on the dashboard (concurrent connections, messages per second, message size, tenant settings) and confirm Realtime is enabled for the project.
* **Exact change:** apply `supabase/migrations/20261011000100_realtime_syncs.sql` only (adds `public.syncs` to `supabase_realtime`). Sequence: `supabase migration list --linked` (read-only) → `supabase db push --dry-run --linked` must list **exactly** that one file → owner approves → apply → verify.
* **Local validation (done):** replay, schema-diff-equals-one-line, idempotency, no-publication no-op, large-document notification (1.3).
* **Why it is safe before any flag:** with no subscribers nothing is sent; clients that do not enable `NEXT_PUBLIC_SUPABASE_REALTIME` never open a socket. Cost: logical-decoding of `syncs` writes (a sync write is 1 row; up to ~900 kB).
* **Rollback:** `alter publication supabase_realtime drop table public.syncs;` (reversible, instant, no data effect).
* **Acceptance:** dry-run lists one migration; `select tablename from pg_publication_tables where pubname='supabase_realtime'` returns `syncs`; no change in any table, policy or grant (compare `pg_dump -s` before/after, as the local test does); Firebase production traffic unchanged.

### M3. Per-domain backend routing, then a production-equivalent preview of sync-only Supabase (code local; deploy GATE)
* **3a. Code (local, no approval):** replace the single global choice with a per-domain choice (`sync`, `social`, `ping`, `push`) selected by separate build-time values, **Firebase for every domain by default**; `getBackend()` keeps working. Local validation: extend `backend-selection` / `phase6a` tests (default Firebase; each domain independently selectable; an invalid value fails closed), re-run `run-hook-supabase.mjs` with only `sync` on Supabase (social stays on Firebase emulators): this also proves G1 is fixed.
* **3b. Preview (GATE):** a Vercel **preview** deployment (not production) built with sync→Supabase, bridge, Realtime flag, pointed at the **hosted** Supabase, signed in as the dedicated test accounts only. This is the first time the real path runs without the gateway stand-in.
* **Approval:** creating a preview build with hosted values; use of the hosted project by test accounts.
* **Rollback:** delete the preview; production is untouched (it still serves the Firebase build).
* **Acceptance:** the 7 groups of checks of `e2e-hook-supabase.mjs` re-run by hand (or by a headed version of the script) against the preview with two real devices: sign-in, first sync, bidirectional change within 5 s p95, conflict merge, reconnect convergence, sign-out isolation; zero uncaught errors; function and Realtime logs clean; no write to Firebase `syncs/{uid}` by the Supabase path.

**3a status: DONE locally (verified).** `lib/backend/index.ts` now has `getDomainBackend("sync"|"social"|"ping"|"push")`; build-time `NEXT_PUBLIC_BACKEND_SYNC/_SOCIAL/_PING/_PUSH` each override the global `NEXT_PUBLIC_BACKEND`; a blank value inherits the global one, which defaults to Firebase; an unknown value throws; a Supabase domain without its configuration or auth bridge fails closed (`supabase-not-configured`), it never falls back to Firebase. One backend instance per kind is shared by the domains that use it. `lib/cloud-sync.ts` uses the sync domain; `lib/use-social.ts` uses push, ping and social. Verified: `tests/domain-routing.test.ts` (17 tests; 2 of 3 mutations of the routing code were caught by it, the third did not apply to the file and was not run); the real-hook browser suite passes 49/49 with only `NEXT_PUBLIC_BACKEND_SYNC=supabase`, and the gateway saw only `syncs` and `rpc:sync_put` traffic. The browser run now also performs a real social action (saving the profile name in Mates): it lands in the Firestore emulator and the gateway sees no profile request; with the runner temporarily switched to the global setting the same checks fail (checkpoint section 27). A global `NEXT_PUBLIC_BACKEND` is still inherited by any domain without its own value, and `getShadowReader()` is still keyed to the global value.

### M4. Shadow writes and soak (GATE: production flags on for allow-listed accounts only)
* **Prerequisites:** M0; G4 closed (a persisted, comparable report: either the unused `shadow_mismatch` table or a stored report artifact; local code + tests, no hosted effect until used); the initial import dry-run → apply path from `PHASE6C_INITIAL_IMPORT.md` rehearsed on a copy.
* **Changes:** (local) persisted shadow report + a runner that produces it on demand; (GATE) a production build with `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE`, `…_SHADOW_SYNC` (and, for reports, `…_SHADOW_READ`) on for a small allow-list (new code: an account allow-list read at runtime from a harmless source, or a separate preview URL used by those accounts only; decision D7).
* **Soak criteria (measurable):** over ≥ 14 days and ≥ 20 accounts (or all active accounts if fewer): **0** `different` outcomes after the initial import is complete; `missing-in-supabase` = 0 for any account that wrote after its import; bootstrap 5xx < 0.1 %; shadow write failures never visible to the user (0 UI errors); no increase in Firebase write latency p95 > 50 ms; Supabase usage under 60 % of every Free-plan limit (database size, egress, function invocations, Realtime messages).
* **Rollback:** turn the flags off (redeploy previous build, G2); shadow data is disposable.
* **Acceptance:** the report series meets the criteria for the whole window with no manual repairs.

### M5. Ping and connection Realtime (GATE: second publication migration)
* **Prerequisites:** M2 done and observed ≥ 7 days; local polling watchers exist (Phase 9 slice).
* **Changes:** (local) transport filter support for "from me OR to me" (two postgres_changes entries in one join, or two channels): extend `realtime-transport.ts` + tests; use Realtime for `pings` / `connections` with the existing polling as the floor. (GATE) a migration adding `public.pings` and `public.connections` to the publication.
* **Local validation:** extend `ping-e2e` / `hosted-readiness` with the new migration replay and event delivery to both participants; the hook-level test with Ping flows (a Ping created by A reaches B within the bounded time; strangers receive nothing).
* **Rollback:** `alter publication … drop table` for each; polling continues to work.
* **Acceptance:** event delivery p95 < 3 s locally and in preview; no cross-account event ever (RLS test); duplicate-event rate 0 in the client (dedupe by id + status).

### M6. Push: outbox, sender, secrets, delivery (GATE on every item; schema + hosted secret)
* **Prerequisites:** M4 criteria met for sync; **D3** (multi-device tokens) decided; M5 not required.
* **Exact changes (all gated):**
  1. migration from `proposals/push_outbox.sql` (table `push_outbox`, trigger `pings_enqueue_push`, functions `push_outbox_claim` / `push_outbox_finish`; service-role only);
  2. an Edge Function `ping-push-sender` that calls `dispatchPingEvent` (`lib/backend/supabase/push-dispatch.ts`) with a database-backed outbox adapter, reads tokens with the service role, and sends through FCM HTTP v1;
  3. **secrets**: an FCM-capable service-account credential set **only** in the hosted secret store (`supabase secrets set`), never in git, chat or logs; plus the sender trigger mechanism (database webhook, or a scheduled poller if `pg_cron` / `pg_net` are available on the plan: to be checked on the dashboard);
  4. client: token adapter flag (`push` domain) so tokens are saved to Supabase only when that domain is on.
* **Local validation (done / to do):** done: dispatch logic (25), outbox SQL behaviour (11 + mutations); to do before the gate: an Edge Function wrapper tested under Node with fakes, a DB-backed outbox adapter tested against the local stack, a poller loop test (lease, retry, give up), the 3-day expiry on the database clock.
* **Delivery validation (needs real devices, preview or production test accounts):** a Ping created → incoming push on the recipient's phone within 10 s; an answer → result push to the asker; the locked-screen text is generic (no class, subject, date); tapping opens `/?ping=<id>`; a repeated trigger shows one notification (tag dedupe + outbox); a dead token is removed and not retried; a revoked permission is handled; token refresh works; no push for imported legacy Pings.
* **Rollback:** disable the trigger (`alter table public.pings disable trigger pings_enqueue_push`), stop the sender (undeploy), flip the `push` domain back to Firebase tokens; the outbox is retained or dropped later. Firebase Functions stay deployed until M9.
* **Acceptance:** 0 duplicate notifications and 0 missed notifications in a 100-Ping synthetic run on test accounts; every outbox row ends in a final status ≤ 5 attempts; sender error rate < 1 %; no secret in any log or repository file (scan).

### M7. Production identity bridge hardening (partly GATE)
* **Prerequisites:** M1.
* **Changes:** only if M1 finds problems (e.g. IP mode decision D5 for `CLIENT_IP_MODE`, rate numbers, error shapes); function re-deploy is a GATE; the rate-limit table cleanup job (delete expired windows) if M1 shows growth.
* **Local validation:** the existing `phase6d` / `phase6e` suites plus whatever M1 shows.
* **Rollback:** redeploy v2 (kept), revert migration only through its documented down SQL.
* **Acceptance:** M1 criteria hold at the expected account count with no 429 for legitimate use.

### M8. Observability (local code + dashboard setup GATE)
* **Needed before M9:** a single place to answer "is it healthy?":
  * client: sync status distribution (offline / synced / needs-choice / paused) counted anonymously and only when the Supabase path is on (decision D8 on any telemetry);
  * server: bootstrap function logs (fixed codes only), Supabase API/Realtime/database dashboards, usage vs Free-plan limits, sender outcome counts from `push_outbox` (group by status);
  * the persisted shadow report series (M4);
  * an on-call checklist with the exact rollback commands.
* **Acceptance:** each alarm in M9 can be answered from these sources in < 5 minutes.

### M9. Controlled cutover (GATE per domain; each domain has its own soak)
Order: **sync → social (profiles, invites, connections) → Ping → push**. For each domain:
1. **Entry criteria:** its previous milestone accepted; reverse mirroring for that domain built and tested (G3) so Firebase stays current; a final delta import done and verified; the rollback rehearsed once on preview (promote previous deployment; time it).
2. **Change:** set that one domain to Supabase in the production build for an allow-list first (D7), then for everyone; announce a short window for Ping/push.
3. **Soak:** ≥ 7 days per domain with the criteria of M4 re-applied (plus domain-specific: Ping exactly-once rate, push delivery rate).
4. **Rollback triggers (any one):** data mismatch > 0 for an account that did not edit on two devices; sync failure rate > 2 % over an hour; any cross-account exposure (immediate); push duplicate rate > 0.5 %; Free-plan limit > 80 % with growth. **Action:** promote the previous Vercel deployment (Firebase for that domain); reverse mirror has kept Firebase current; verify with the shadow report; write the incident note.
5. **Exit:** criteria met for the whole soak; then the next domain.

### M10. Cleanup (after all domains soaked)
Remove dead Firebase paths only after a further soak with Firebase in read-only fallback (plan Phase 11); delete `shadow_mismatch` if unused; no Firebase deletion in this plan.

---

## 3. Separate decisions (not part of any milestone; none is made here)
| # | Decision | Why it matters | State |
|---|---|---|---|
| D1 | The `N >= R+2` counter under-count (two devices raising the same counter while a write is in doubt) | exact resolution needs a document-schema change (per-device deltas / write ids / history); cautious merge currently takes the larger counter and keeps both copies in restore points | **unchanged**, needs approval |
| D2 | Offline reset waits ~8 s then refuses (Firebase configured; the push-token delete never settles offline) | a skip-when-offline shortcut would let the account's data silently return on reload and leave the push token; the safe version needs a persisted "sign-out pending" flag | **unchanged**, needs approval |
| D3 | Multi-device push tokens (the client stores one token per account, `device_id = 'legacy'`) | schema supports per-device; the client does not | open |
| D4 | Hosted Realtime limits vs expected connections (every open tab = one socket) | may force polling-only for Ping/connections or a plan upgrade | decide after reading the dashboard limits (M2) |
| D5 | Anonymous sign-up on hosted Supabase and `CLIENT_IP_MODE` | abuse/rate behaviour of the bootstrap function | decide with M1 results |
| D6 | A runtime kill switch (flag read at runtime) instead of build-time flags | faster rollback than a redeploy; new surface to secure | optional |
| D7 | How to expose the Supabase path to an allow-list on production | preview URL for testers vs runtime allow-list | open |
| D8 | Any client telemetry | privacy | open |
| D9 | Paid plan / quotas | cost | owner |

---

## 4. Approvals needed (nothing below has been requested or taken)
1. Commit (and later push) the working tree (M0).
2. Production read-only commands for M1/M2 (`migration list --linked`, `db push --dry-run --linked`) and the dedicated test-account runs.
3. Applying migration `20261011000100` to production (M2).
4. A hosted preview build and use of the hosted project by test accounts (M3b).
5. Production flags for an allow-list; the initial import apply (M4).
6. The outbox migration, the sender Edge Function, the FCM secret, the trigger/poller (M6): **explicitly held behind this gate**.
7. Each domain's cutover (M9).
8. Decisions D1–D9 as they come up.

## 5. Readiness (judgment, not a measured metric)
About **60 %** of the whole migration, up from about 58 %: the sync path, the sign-in/restore safety layer, the adapter, Realtime and the Ping state machine are proven locally, including with the real hook; what remains is mostly hosted verification, per-domain routing, reverse mirroring, the push pipeline, observability, the soak and the cutover itself. The weight of the remaining work is in the gated, production-facing milestones.

## 6. The single best next step
**M0 + M3a together as the next local milestone, then ask for M0's commit approval:** build per-domain backend routing (G1) with Firebase as the default for every domain and re-run the hook suite with only `sync` on Supabase. It is entirely local, it removes the largest structural blocker to a one-domain-at-a-time cutover, and it makes the first hosted step (M2) a pure configuration change on a tree that is already committed and reviewable.
