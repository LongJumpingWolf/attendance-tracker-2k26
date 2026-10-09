# PHASE6D_AUTH_HARDENING.md

Hardening and deployment preparation after `PHASE6D_PRODUCTION_BRIDGE_READINESS.md` (commit `3cfefea`). That report is a historical record and is not rewritten; where this document differs (the guard migration is no longer "proposed"), this document is later.

```
STATE AFTER THIS STEP
  Firebase authoritative; bridge Edge Function NOT deployed; no production secret set
  Guard migration 20261009000100: exists LOCALLY only. NOT applied to ajfyyknqdqaptuuzbwnv (remote still has 10 migrations)
  Every NEXT_PUBLIC_SUPABASE_* / BACKEND flag: unset (OFF); no production read or write goes to Supabase
  No production import rerun, no shadow write, no cutover
```

## A. The migration-invariants blocker: cause and resolution

**Cause.** `tests/migration-invariants.test.ts` asserts `supabase/.temp/project-ref` does not exist ("no remote link"). This checkout was linked to `ajfyyknqdqaptuuzbwnv` (needed for the schema check and import), which creates that git-ignored file. The invariant describes a clean clone and is correct; the checkout is not clean. Reproduced with all 6D files stashed.

**Resolution (invariant untouched, production link untouched).** `scripts/test-unlinked.mjs` (also `npm run test:unlinked`) copies the working tree to a temp folder using `git ls-files --cached --others --exclude-standard` (so `supabase/.temp`, `.env*`, `migration-output`, `.next` are never copied), links `node_modules` by junction, runs vitest there, and deletes the copy. It refuses to run if the copy contains `supabase/.temp` or an `.env*` file. `npm run migration:health` now uses it automatically when the checkout is linked and says so in its output; otherwise it runs plain vitest as before. A fresh clone and CI run the unmodified suite.

Result: plain `npx vitest run` in this linked checkout still fails that one test by design; `npm run test:unlinked`: see section E.

## B. Issuer/audience guard: reviewed and promoted locally

Review of the Phase 6D proposal: correct and compatible with the approved design (Firebase stays the identity provider; `sub` stays text; `auth.uid()` is never used; `current_uid()` stays SECURITY INVOKER with `search_path=''`; no new function and no grant change, so the Phase 3 catalog assertions still hold). One design point worth recording: the check lives in `current_uid()`, so every SECURITY DEFINER RPC (which bypasses RLS) is covered through `require_uid()`, not only the tables. The four restrictive policies are belt and braces against a future permissive policy.

* Migration: `supabase/migrations/20261009000100_firebase_issuer_audience_guard.sql` (moved from `supabase/proposed/`; header states it is not applied to production). Applied **only to the local database** (`supabase migration up --local`, then `supabase db reset --local` to prove the full 11-migration history builds from nothing).
* Test helpers now supply the production-shaped claims: `tests.act_as` and `tests.act_claims` in `security.test.sql`, `tests6d.claims` in `phase6d_bridge_gaps.test.sql`, and the claim JSON in `concurrency.sh` add `iss=https://securetoken.google.com/attendance-tracker-2k26` and `aud=attendance-tracker-2k26`. This makes the old tests stricter (they now fail unless the guard accepts the identity); no assertion was removed or relaxed.
* Guard tests: `supabase/tests/database/issuer_audience_guard.test.sql` (38 checks): correct token works; missing, wrong-audience, wrong-issuer, Google-issuer, case-different, array-audience, null-issuer and empty-sub tokens give no identity, read nothing and are refused by every RPC; `user_id`/`uid`/`email`/`name` are ignored; strangers and anon read nothing; direct INSERT/UPDATE/DELETE/TRUNCATE denied; catalog (PUBLIC grants, helper grants, pinned search_path, 16 public functions, SECURITY INVOKER) unchanged.
* **Not applied to production.** Before it ever is: `npx supabase db push --dry-run --project-ref ajfyyknqdqaptuuzbwnv`, owner approval, and the Firebase project id inside the SQL confirmed.
* **Ordering caution for the owner:** applying the guard before the bridge is live is safe (nothing in production presents a Supabase token). Applying it with a wrong project id would make every Supabase call fail closed.

## C. Client authentication gaps closed (code-owned)

All changes sit behind the bridge flag, which is OFF; nothing in the normal app path imports them (test-scanned).

| Gap | What was done | Where |
|---|---|---|
| Retry for bootstrap failures | Optional `RetryPolicy`: production wiring uses 3 attempts, 500 ms base, 8 s cap, up to +25 % jitter. Only `unavailable`, `rate-limited`, `server-error` are retried; 401/403 are not. Identity is re-checked before and after each backoff, so a sign-out or account switch during backoff drops the attempt. Without a policy there is one attempt (6A tests unchanged) | `lib/backend/supabase-auth.ts`, `lib/backend/index.ts` |
| Pre-expiry refresh margin | `refreshMarginMs` (production: 120 s): a token with less life left is force-refreshed before it is handed out (using `getIdTokenResult().expirationTime`; the bridge still never decodes a JWT). If the refresh fails, a still-valid token is used and an expired one is not. Applies to `getToken()` and to the token passed to Realtime on Firebase's refresh event | same |
| Hammering a down bootstrap | `failureCooldownMs` (production: 30 s): after a failure for an account, the failed state is returned without calling the endpoint; other accounts are not held back; cleared on success/reset/sign-out | same |
| App usable when the bridge is unavailable | `ensureAuthenticated()` never throws (unreadable identity = signed out). A selected Supabase backend refuses with a typed `unavailable` BackendError and sends nothing; the Firebase default is unchanged | same, tests |
| Identity changes | Sign-out emits one null token; switching accounts never reuses the old token and bootstraps again; mid-flight and mid-backoff changes are covered by tests | tests |
| Realtime `setAuth` and refetch | `createRealtimeSession`: `setAuth(token)` before every subscribe, on every token change, and with a fresh token before a dropped channel re-joins; sign-out clears the token (`setAuth(null)`) and drops the channel; refetch on **every** `subscribed` (first and after reconnect); idempotent `start`; never throws into the app. Not wired into the adapter (Supabase Realtime is still "not live") | `lib/backend/supabase/realtime-session.ts` |

A defect found and fixed during this work: the token the bridge emits while authenticating started a second concurrent `open` in the Realtime controller (double `setAuth`, possible double subscribe); an in-progress guard now prevents it (the test that exposed it is kept).

**Still not proven live:** Firebase's own proactive refresh timer (relied on, documented by Firebase, not exercised against a real SDK here); a real Supabase Realtime socket; the S10/S11 spike conditions. These need the live environment and are in the checklist.

## D. Remaining production decisions: what the repository can and cannot establish

| Item | Established? |
|---|---|
| Production web origin for `ALLOWED_ORIGINS` | **No.** No tracked file names a domain (`manifest.json` start_url is `/`; `.vercel/project.json` gives only the Vercel project name `attendance-tracker-2k26`; the Vercel domain list was not queried). Not guessed. **Owner supplies.** |
| Firebase registered under Third-Party Auth in Supabase prod | **No.** Not recorded in the repo; not readable without dashboard or a management token. **Owner verifies.** |
| Existing Firebase users' `role` custom claims | **No.** Needs an Admin SDK read with the service account (not available here by design). The function refuses to overwrite a different `role` (403) so an unexpected role fails safe, but the census is advisable. **Owner-run or later-approved read-only script.** |
| Rate-limit strategy | Recommendation below; owner decides. |
| Token-revocation policy | Recommendation below; owner decides. |

### Rate limiting: recommendation

The exposure: the bootstrap is callable by any holder of a valid Firebase token, and anyone can mint anonymous Firebase accounts with the public API key. A per-account limit therefore does not bound a flood of fresh accounts; only a per-client (IP) limit does, and an IP is only as trustworthy as the header the platform sets. The per-instance memory limiter in the function is a speed bump for one warm instance, not protection against distributed abuse. Firebase's own throttling of anonymous sign-ups (not verified in detail here) and the "token already has the role = no Admin call" fast path reduce but do not remove the cost.

| Option | Cost | Operational trade-offs |
|---|---|---|
| A. In-memory (what exists) | free | per instance only; resets on cold start |
| **B. Postgres counter (recommended)** | free (existing project); one RPC round-trip (a few tens of ms) on non-fast-path requests only | needs one new migration (a small counter table with hashed client keys and a `service_role`-only SECURITY DEFINER check function, plus periodic cleanup) = a **production schema change**, so it needs your approval and its own tests; keep layer A in front so a flood does not reach the database; the Edge Function gains a `service_role` key dependency (a second secret) |
| C. External store (for example Upstash Redis) | new vendor and account, free tier exists (check current limits) | extra secret and dependency; lowest latency; one more thing to operate |
| D. WAF/CDN in front of the function | needs a custom domain on the Supabase function, a paid add-on (check) | strongest; not available on the free plan as far as known |
| E. Firebase App Check | unknown for Auth on the Spark plan | enforcement coverage for Firebase Auth endpoints must be verified before relying on it |

Recommendation: **B on top of A**, as its own small step after you approve the migration, and re-check your Supabase plan's Edge Function invocation quota (a flood that exhausts it is the realistic denial-of-service). Nothing requiring another service or schema change was implemented.

### Token-revocation policy: recommendation

1. Ordinary sign-out: client sign-out only. Accept that a stolen access token works for up to one hour plus a short unmeasured grace (S13), and that the refresh token is not revoked.
2. Security events (suspected compromise, account removal, admin action): owner-run `revokeRefreshTokens(uid)` (and disable if needed). The bootstrap already refuses a token issued before `tokensValidAfterTime` on its write path, so a revoked account cannot re-bootstrap; already-issued access tokens expire within the hour.
3. Do not revoke on every sign-out: it is an Admin API call per sign-out and signs the user out on all their devices.

## E. Verification (what actually ran)

Only checks that ran successfully are listed.

| Check | Result (ran on this checkout) |
|---|---|
| `npm run migration:health` (full) | **HEALTHY**: unit 25 files / 496 tests (clean unlinked copy), Firestore rules 4 files / 64 tests, typecheck clean, lint 0 errors / 75 warnings (unchanged), e2e 7 suites 203/203, `next build` succeeded |
| `npm run test:unlinked` | 25 files, 496 / 496 pass (same run as the health unit step) |
| Plain `npx vitest run` in this linked checkout | 495 pass, 1 fail: the unchanged "no remote link" invariant, by design (section A) |
| Local pgTAP, `npx supabase test db` after `db reset --local` (11 migrations) | **290 / 290** (security 228 with strengthened helpers, 24 gap checks, 38 guard checks) |
| `supabase/tests/concurrency.sh` (local, with iss/aud claims) | all checks pass |
| New unit tests | 35 handler (6D readiness) and 29 client-hardening / Realtime-session, all pass |
| Remote | not touched: no `db push`, no function deploy, no secret, no import, no flag |

## F. Checklist

**1. Claude can complete autonomously (after you answer section 2)**
- Implement and test the Postgres rate limiter (option B) once you approve the migration; keep it local until you approve applying it.
- Add a smoke-test script for the 14 checks in the readiness document (reads tokens from the environment, prints no secrets); not run until deployment is approved.
- Wire the Realtime session into the Supabase adapter, and the shadow-read/Realtime phases after deployment.
- Prepare the exact `supabase/functions/` copy and `config.toml` change as a reviewed commit (still undeployed).
- Draft the owner-run, read-only script that lists custom `role` claims, for your review before you run it.

**2. Decisions only you can make**
- The exact production origin(s) for `ALLOWED_ORIGINS`, and whether any preview alias may call production Supabase (recommended: no).
- Confirm the Firebase project id is `attendance-tracker-2k26` for the production web app.
- Rate-limit option (A only, B, C, D) and acceptance of the free-plan invocation risk.
- Revocation policy (section D recommendation or another).
- Approval to apply the guard migration to production, and when (dry run first).
- Scope of the service account (recommended: a dedicated one with Firebase Authentication Admin only).

**3. Manual dashboard actions before deployment**
- Supabase (`ajfyyknqdqaptuuzbwnv`) > Authentication > Third-Party Auth: confirm or add Firebase with project id `attendance-tracker-2k26`.
- Google Cloud / Firebase console: create the dedicated service account and key; set `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_PROJECT_ID`, `ALLOWED_ORIGINS` as Edge Function secrets yourself (never in chat or git).
- Firebase > Authentication > Settings > Authorized domains: confirm the production origin is listed.
- Supabase plan: review Edge Function invocation limits and set any usage alert.
- Vercel: nothing now. At the later activation step only: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, then the flags, each under separate approval.

## G. Next exact milestone

**Phase 6E: guarded production bridge deployment.** Entry criteria: the section F.2 decisions and the F.3 dashboard actions are done. Then, with your go for each stage: (1) dry-run and apply the guard migration; (2) copy the function into `supabase/functions/`, commit, deploy with `--no-verify-jwt`; (3) run the 14 smoke tests with a throwaway Firebase user; (4) stop. Flags stay OFF until a separate shadow-activation phase.
