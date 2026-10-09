# PHASE6D_PRODUCTION_BRIDGE_READINESS.md

Phase 6D is a **readiness audit and preparation**. It deploys nothing and activates nothing.

```
CURRENT PRODUCTION STATE (unchanged by 6D)
  Firebase authoritative
  Auth bridge Edge Function: NOT DEPLOYED (no supabase/functions directory, no [functions.*] in config.toml)
  Supabase Third-Party Auth registration: NOT CHECKED, NOT CHANGED by this phase
  NEXT_PUBLIC_BACKEND                      unset (Firebase)
  NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE         unset (OFF)
  NEXT_PUBLIC_SUPABASE_SHADOW_SYNC/SOCIAL/PUSH   unset (OFF)
  NEXT_PUBLIC_SUPABASE_URL / PUBLISHABLE_KEY     unset
  No production secret created, rotated, printed or committed. No production import rerun. No remote SQL applied.
```

## 1. What was inspected

Repository: `MIGRATION_PLAN.md`, `MIGRATION_DECISIONS.md`, `MIGRATION_CHECKPOINT.md`, `PHASE5_AUTH_SPIKE.md` (including the S13 addendum), `PHASE6A/6B/6C` documents, `PHASE3_SECURITY_MATRIX.md`, all 10 SQL migrations, `supabase/config.toml`, `supabase/tests/`, `lib/backend/supabase-auth.ts` (the client), `lib/backend/flags.ts`, `.firebaserc`, `.env.local.example`.

Outside the repository, read only: the **actual spike Edge Function** `auth-role-bootstrap-spike/index.ts` and the spike SQL in `C:/Users/Aditya/Downloads/attendance-auth-spike-lab` (present on this machine; it is not part of the repository and is not copied into it). No lab config, token or secret file was read.

Read-only Vercel check: `vercel env ls` (names, environments and encrypted placeholders only). The Vercel project `attendance-tracker-2k26` holds **only the six `NEXT_PUBLIC_FIREBASE_*` variables**, for Development, Preview and Production. There is no Supabase, backend, bridge or shadow variable in any environment. The Vercel domain list was **not** queried (see section 5).

## 2. Tested spike behaviour versus untested production behaviour

| Behaviour | Spike (throwaway `attendance-auth-sp` / `gfnblqnsdubsxfoywfgr`) | Production |
|---|---|---|
| Firebase token accepted through third-party auth; unregistered issuer rejected | VERIFIED (S1, S8) | **UNTESTED.** Whether Firebase is registered under Authentication > Third-Party Auth on `ajfyyknqdqaptuuzbwnv` is **not known**; nothing in the repo records it |
| `sub` = Firebase UID as text; `auth.uid()` fails | VERIFIED (S3, S6) | Schema uses text everywhere; local pgTAP proves the SQL side. Real token **UNTESTED** |
| No `role` claim => `anon`; `role=authenticated` => `authenticated` | VERIFIED (S2, S4, S6) | UNTESTED |
| Bootstrap via Edge Function + `firebase-admin@13` on a free plan | VERIFIED (S4, S9, 12-way concurrency) | **UNTESTED.** The production function is new code (section 4); its Deno wiring has never run |
| Forged / tampered / wrong-issuer / other-project / `alg:none` / expired token rejected by the function | VERIFIED | The same checks are unit-tested here against fakes. Real-token behaviour **UNTESTED** |
| Refresh keeps the claim; sign-out/sign-in keeps UID | VERIFIED (S5, S11) | UNTESTED |
| Realtime needs explicit `setAuth`, refetch after reconnect | VERIFIED (S12) | Realtime is **not implemented** in the app and **no table is published** (pinned by a test) |
| Expired token | Function: 401 at +25 s. Data API: accepted at +25 s, 401 `PGRST303` at +45 s (S13). The grace length is **not documented and not measured** | UNTESTED. Treat as "bounded grace of roughly 30 s, unconfirmed" |
| CORS, rate limit | spike: one fixed localhost origin, no rate limit | new in 6D, fake-tested only |
| Cross-project token carrying `role=authenticated` and a copied `sub` | **NOT TESTED** (spike limitation 1) | the database-side guard in section 7 exists to cover it |
| Fresh Google account with `isNewUser=true`; sign-out while another session is active; automatic pre-expiry refresh | **NOT TESTED** (spike limitations 2 and 4) | UNTESTED |

## 3. Audit of the production bridge requirements

| # | Requirement | Finding |
|---|---|---|
| 1 | Issuer and audience validation | The spike function checked `iss`, `aud`, `sub == uid`. **The database did not**: no `iss`/`aud` check exists in any migration or policy (`grep restrictive supabase/migrations` is empty), although `PHASE5_AUTH_SPIKE.md` Production Requirement 8 and the Supabase docs ask for `as restrictive` checks on every table. In the spike this was only ever reached through the platform's "Unregistered Firebase Auth JWT issuer" rejection. **GAP. Closed in a proposed migration (section 7), not applied.** The proposed function validates `iss`/`aud` against `FIREBASE_PROJECT_ID` |
| 2 | UID is `sub`, as text | Sound. `app_private.current_uid()` reads only `auth.jwt()->>'sub'`; no policy or function uses `auth.uid()` (new test); the type is `text`; user_id/uid/email/name/`firebase` claims are ignored (new tests) |
| 3 | `role=authenticated` only by trusted server-side verification | Only the function writes it; the constant is the only claim ever written; the body is never read; a different existing `role` is never overwritten. **Inherent property to accept:** any Firebase user of the project (including anonymous accounts, which anyone can create with the public API key) can obtain `authenticated`. RLS and the RPCs, not the role, are the access boundary. Abuse of anonymous-reachable RPCs is bounded only by the RPC validation limits already in the schema |
| 4 | Account isolation and denial of cross-user access | Phase 3 suite (228 tests) plus new checks; stranger, other-uid-in-other-claims and wrong-project tokens read nothing |
| 5 | Direct mutation of protected tables denied | New catalog test: neither `anon` nor `authenticated` holds INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any public table; `anon` cannot SELECT any; no views; also re-asserted for a `role: service_role` claim string inside the token body (it does not change the Postgres role) |
| 6 | SECURITY DEFINER hygiene | The Phase 3 catalog test covered only `public`. **New:** every function in `public` **and `app_private`** pins `search_path=""`; every SECURITY DEFINER function derives identity from `current_uid()`/`require_uid()`; none is owned by a Data API role; no function is granted to PUBLIC |
| 7 | Token refresh, sign-in/out | Client (`createAuthBridge`) re-bootstraps per account, force-refreshes after bootstrap, drops state on account switch (6A tests). **Not present in the client:** retry with backoff after a failed bootstrap (Phase 5 requirement 1) and any automatic pre-expiry refresh margin; a later phase must add them. Client sign-out does not revoke the refresh token (spike); a server-side `revokeRefreshTokens` decision is still open |
| 8 | Realtime | `setAuth` seam exists in the adapter; Realtime itself is not implemented. Both required patterns (explicit `setAuth`, refetch after reconnect) remain obligations of the Realtime phase |
| 9 | Expired tokens | The function (Admin SDK) has no grace; the database path has an unmeasured grace (S13). The client must refresh with a safety margin and must not treat a database acceptance as proof of validity |

## 4. The production Edge Function (prepared, not deployed)

Location: `supabase/proposed/functions/auth-role-bootstrap/` (deliberately **not** `supabase/functions/`, so `supabase functions deploy` with no name cannot pick it up).

* `handler.ts`: pure request logic with injected dependencies; typechecked and unit-tested under Node.
* `index.ts`: Deno glue (`npm:firebase-admin@13`, `Deno.env`); the only file that reads the secret.

Differences from the tested spike function (each is new and untested against real Firebase):

| Area | Spike | Proposed |
|---|---|---|
| CORS | one hard-coded localhost origin | `ALLOWED_ORIGINS` exact `https` origins; `*`, `http`, paths, wildcards and localhost are rejected at startup; unset/invalid = fail closed (503 to all); foreign `Origin` = 403 before any work; never echoed |
| Rate limiting | none | per-client (30/min) before verification and per-account (6/min) before Admin calls, `429` + `Retry-After`. **Per-instance memory only** |
| Project id | hard-coded | `FIREBASE_PROJECT_ID`, must equal the service account's `project_id` |
| Existing `role` claim | overwritten | a different existing role is refused (403); the same role = no write |
| Token already has the role | one Admin read | no Admin call at all |
| Disabled user / revoked token | not checked | disabled = 403; token issued before `tokensValidAfterTime` = 401 (write path) |
| Response | redacted uid, `changed` flag | `{success:true}` or `{success:false,error:<fixed word>}`; no uid, no flag; `Cache-Control: no-store` |
| Errors | `e.code`/message logged up to 80 chars | only fixed codes logged (`verify-failed`, `claims-mismatch`, `role-conflict` ...); library messages never logged or returned |

**What rate limiting does and does not protect.** Supabase Edge Functions have no built-in per-user or per-IP rate limit that I could verify, and I did not check the dashboard. The limiter above bounds bursts against one warm instance only; instances are short lived and may run side by side, so it is **not** protection against a distributed or patient attacker. Residual cost of abuse is bounded by (a) token verification being local cryptography with cached Google keys, (b) a request whose token already has the role causing no Admin call, (c) one Admin write per account ever (idempotent). If stronger protection is required before launch the owner must choose one: a database counter table behind a SECURITY DEFINER function (new migration), an external limiter, or a Cloudflare/WAF rule in front of the function URL. This is an owner decision; nothing is assumed.

## 5. Production origin: OWNER MUST SUPPLY

The deployed web origin **cannot be established from repository configuration** (no `NEXT_PUBLIC_SITE_URL`, no domain in any tracked file; `firebase.json` has no hosting block; Hosting is Vercel per the plan). It is not guessed here. Owner supplies:

* `ALLOWED_ORIGINS` = the exact production origin(s), for example `https://<your-production-domain>` (scheme + host [+ port], no trailing slash, no path). One entry per origin that must call the bootstrap. Vercel preview URLs change per deployment and must **not** be wildcarded; list a stable preview alias only if previews must reach production Supabase (recommended: no).
* Verify the same origin is listed under Firebase Authentication > Settings > Authorized domains (already required for Google sign-in).

Other values stated by the owner or the repo, to be confirmed: Supabase production ref `ajfyyknqdqaptuuzbwnv` (given); Firebase project id `attendance-tracker-2k26` (`.firebaserc`, `MIGRATION_CHECKPOINT.md`; owner confirms it is the project the production web app signs in with).

## 6. Secrets the owner provisions privately (never in chat, git or logs)

| Secret / config | Where | Notes |
|---|---|---|
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Supabase Edge Function secret, project `ajfyyknqdqaptuuzbwnv` | A **new, dedicated** key. Do not reuse the read-only export key from Phase 6C. Needs only the permissions to read users and set custom claims (for example the "Firebase Authentication Admin" role on a dedicated service account), not Owner/Editor. Set it from the dashboard, or with `supabase secrets set --env-file <file outside the repo>` (not an inline value, which lands in shell history); delete the file afterwards |
| `FIREBASE_PROJECT_ID` | Edge Function secret/config | `attendance-tracker-2k26` after confirmation |
| `ALLOWED_ORIGINS` | Edge Function secret/config | section 5 |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Vercel, **only at the later flag-activation step** | public values; not set now |

Secret names must not start with `SUPABASE_`. The key is read only by `index.ts`; a test scans the proposed source and this document for key material and token shapes.

## 7. Proposed SQL (NOT applied anywhere)

`supabase/proposed/20261009000100_firebase_issuer_audience_guard.sql`, outside `supabase/migrations/` so `db push` ignores it.

* `app_private.current_uid()` returns the `sub` **only when** `iss = https://securetoken.google.com/attendance-tracker-2k26` and `aud = attendance-tracker-2k26`; otherwise NULL. Every RLS policy and every RPC (through `require_uid()`) inherits this, so they fail closed (`42501` / no rows).
* Four `AS RESTRICTIVE` select policies (connections, pings, push_tokens, syncs) require a non-null `current_uid()`, so a future permissive policy cannot bypass it.
* No new function, no grant change (the catalog assertions of the existing suite still hold).

**Promotion requirements (later, approved phase):** the Phase 3 and 6D helpers `tests.act_as` build claims with only `sub` and `role`; once promoted they must add the production `iss` and `aud` (a mechanical change, strengthening not loosening), and the existing suite must stay at 228 passes. Run the dry run first: `npx supabase db push --dry-run --project-ref ajfyyknqdqaptuuzbwnv`. The owner must confirm the Firebase project id inside the SQL.

**Down script** (if ever needed): `drop policy connections_firebase_project on public.connections;` (and the same for `pings_`, `push_tokens_`, `syncs_`), then `create or replace function app_private.current_uid() returns text language sql stable security invoker set search_path = '' as $$ select nullif(auth.jwt() ->> 'sub', '') $$;`.

Not covered by this migration: Storage (unused) and Realtime authorization (no table is published). Whoever enables Realtime must add and test the same restriction there.

## 8. Production-specific blockers (all open)

1. **Production origin not supplied** (section 5).
2. **Third-Party Auth registration of Firebase on the production Supabase project: state unknown.** Without it every Firebase token is rejected; with the wrong project id the guard is meaningless. Owner checks Authentication > Third-Party Auth.
3. **Service-account key does not exist / not provisioned** (section 6).
4. **Issuer/audience guard not applied** and needs an explicit decision plus the test-helper change (section 7).
5. **Rate-limit strategy is best-effort only**; owner decision required (section 4).
6. **Existing `role` custom claims on production Firebase users are unknown.** The function refuses to overwrite a different role (403 for that user). An owner-run, read-only Admin check (list users, look for `customClaims.role`) is advisable before launch; it needs the service account and was not run here.
7. **The production function has never run.** Handler logic is covered by 35 fake-based tests; the Deno + `firebase-admin` wiring is the same SDK calls as the spike but must be proven by the smoke tests in section 9.
8. **Spike conditions still open:** fresh Google account with `isNewUser=true`, cross-project token with `role=authenticated` and copied `sub`, sign-out while another session is active, automatic pre-expiry refresh, in-place sign-out on a live Realtime socket.
9. **Client gaps for the activation phase:** retry with backoff after a failed bootstrap, token-refresh margin before expiry, Realtime `setAuth` and refetch (Realtime not implemented), an explicit revocation (`revokeRefreshTokens`) decision.
10. **Environment inconsistency (pre-existing, not caused by 6D):** `tests/migration-invariants.test.ts` ("no remote link") fails on this machine because `supabase/.temp/project-ref` exists (the checkout is linked to the production project, which Phases 6A-6C required). The file is git-ignored, so a fresh clone passes. It was left as is (see section 10).

## 9. Deployment and smoke-test steps for a LATER, approved deployment

Do **not** run any of this in Phase 6D. Each numbered stage needs the owner's explicit go.

**A. Preconditions:** blockers 1-6 closed; the proposed SQL promoted, tested and applied (dry run first); all production flags still OFF.

**B. Deploy the function (one commit, reviewed):**
1. Copy `supabase/proposed/functions/auth-role-bootstrap/` to `supabase/functions/auth-role-bootstrap/`; add to `supabase/config.toml`: `[functions.auth-role-bootstrap]` / `verify_jwt = false` (the bearer token is signed by Firebase, so the platform check would reject it; the function verifies the token itself).
2. Owner sets the three secrets (section 6).
3. Owner (or approved agent): `npx supabase functions deploy auth-role-bootstrap --project-ref ajfyyknqdqaptuuzbwnv --no-verify-jwt`.

**C. Smoke tests** (use a throwaway anonymous user in the production Firebase project and delete it afterwards; tokens are held in environment variables only, never echoed; `FN=https://ajfyyknqdqaptuuzbwnv.supabase.co/functions/v1/auth-role-bootstrap`):

| # | Request | Expect |
|---|---|---|
| 1 | `POST` with no `Authorization` | 401 |
| 2 | `POST` with `Authorization: Bearer garbage.garbage.garbage-garbage` | 401 |
| 3 | `OPTIONS` with `Origin: https://evil.example` | 403, no `Access-Control-Allow-Origin` |
| 4 | `OPTIONS` with the production origin | 204, `Access-Control-Allow-Origin` = that origin exactly |
| 5 | `GET` | 405 |
| 6 | `POST` with the new user's token and a JSON body `{"uid":"x","role":"admin"}` | 200; user's claims contain only `role=authenticated`; nobody else changed |
| 7 | repeat 6 three times | 200 each; no further Admin write (check the user's claims unchanged) |
| 8 | force-refresh the token; decode locally | `role=authenticated`, same `sub`, `iss`/`aud` = production project |
| 9 | Data API `rpc/get_profile_name` etc. with the refreshed token and publishable key | succeeds as `authenticated`; with the **pre-bootstrap** token: 401/`42501` |
| 10 | a second throwaway user cannot read the first user's `syncs` row | empty |
| 11 | token for a different Firebase project (if available) | 401 |
| 12 | more than 30 requests/minute from one client | `429` with `Retry-After` |
| 13 | the same exact token after expiry plus 60 s | function 401; Data API 401 `PGRST303` |
| 14 | function logs | fixed codes only; no token, uid or key |

Any failure => stop and roll back (section 11). Activation of the client flags (`NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE`, shadow flags) is a **separate** approval with its own phase.

## 10. Security tests and results (this phase, run on this checkout)

| Check | Result |
|---|---|
| `npx supabase test db` (local) | **252 / 252 pass**: Phase 3 + legacy suites 228 unchanged, plus **24 new** in `phase6d_bridge_gaps.test.sql` |
| Proposed guard, `supabase/proposed/run-proposed-tests.sh` (applied in a transaction, rolled back; local DB verified unchanged afterwards) | **38 / 38 pass**: wrong/missing/array/null/case-different `iss` and `aud`, empty `sub`, ignored `user_id`/`uid`/`email`, stranger reads nothing, anon denied, direct mutation and TRUNCATE denied, catalog (PUBLIC grants, private helper grants, search_path, 16 functions) unchanged |
| `tests/phase6d-bootstrap-function.test.ts` | **35 / 35 pass** (config fail-closed, CORS, request shape, verification, claim bootstrap, idempotency, disabled/revoked, rate limits, response hygiene, source scans, "not deployable", client contract, production inactive). Mutation-checked: removing the audience check, and removing the existing-role refusal, each made tests fail (reverted) |
| `supabase/tests/concurrency.sh` (local) | all checks pass |
| Local migration list | 10 migrations, matching; the proposed file is not among them |
| Full unit suite | **466 pass, 1 fail** of 467. The failure is the pre-existing environment issue in blocker 10 (reproduced with all 6D files stashed) |
| Typecheck | clean |
| Lint | 0 errors, 75 warnings (baseline unchanged) |
| `npm run migration:health -- --only unit,typecheck,lint` | typecheck PASS, lint PASS, unit FAIL on the one test above (`UNHEALTHY`, reported honestly) |
| Not re-run | Firestore rules emulator, e2e, `next build`: no application, Firebase or rules file changed in 6D |

Unit baseline in `scripts/migration-baseline.json` raised from 23/432 to 24/467 (tests were added; nothing lowered). No existing test was edited, weakened, skipped or removed.

## 11. Rollback

* **Phase 6D itself:** nothing is deployed; revert the 6D commit.
* **If the function is deployed later:** `npx supabase functions delete auth-role-bootstrap --project-ref ajfyyknqdqaptuuzbwnv`; `npx supabase secrets unset FIREBASE_SERVICE_ACCOUNT_JSON FIREBASE_PROJECT_ID ALLOWED_ORIGINS --project-ref ...`; disable and delete the service-account key in Google Cloud Console (IAM > Service Accounts > Keys).
* **Claims already written** (`role=authenticated`) are harmless without the function but remain on those Firebase users. To make the database refuse them entirely, remove the Firebase entry from Authentication > Third-Party Auth. To strip them, an owner-run Admin script may call `setCustomUserClaims(uid, <claims without role>)`; this is optional.
* **If the SQL guard is applied later:** the down script in section 7.
* **Client:** nothing to roll back while the flags are unset; if later enabled, unset `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE` (and the shadow flags) in Vercel and redeploy. Firebase is never modified by the bridge, so no data needs restoring.

## 12. Confirmation

* The bridge is **NOT deployed.** No Edge Function exists in the production Supabase project from this phase; none was deployed anywhere.
* **Every production shadow and bridge flag remains OFF** (unset) in `.env.local` / `.env.local.example` (test-pinned) and in the Vercel project (names listed read-only: Firebase variables only). `NEXT_PUBLIC_BACKEND` is unset, so the application uses Firebase. No production read or write is routed to Supabase.
* Not done, by instruction: no deploy, no secret created/rotated/printed/committed, no flag enabled, no production import rerun, no shadow reads, no Realtime/Ping/notification promotion, no backend authority switch, no Firebase deletion, no cutover, no remote SQL.
* Not verified (no access, by design): the production Supabase dashboard (Third-Party Auth, function list, secrets), Firebase production user claims, the Vercel domain list.

## 13. What changed in this phase

| File | Change |
|---|---|
| `PHASE6D_PRODUCTION_BRIDGE_READINESS.md` | new (this document) |
| `supabase/proposed/functions/auth-role-bootstrap/{handler,index}.ts` | new, proposed, not deployable by accident |
| `supabase/proposed/20261009000100_firebase_issuer_audience_guard.sql`, `firebase_issuer_audience_guard.test.sql`, `run-proposed-tests.sh` | new, proposed, local-only tests |
| `supabase/tests/database/phase6d_bridge_gaps.test.sql` | new, 24 pgTAP tests |
| `tests/phase6d-bootstrap-function.test.ts` | new, 35 tests |
| `scripts/migration-baseline.json` | unit baseline raised |
| `MIGRATION_CHECKPOINT.md` | status note |

Not changed: application code, Firebase adapter/rules/functions, the 10 migrations, `config.toml`, `tsconfig.json`, package files, environment variables.
