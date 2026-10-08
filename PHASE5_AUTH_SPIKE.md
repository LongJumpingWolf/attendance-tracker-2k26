# Phase 5A: Firebase Auth → Supabase Auth Bridge Spike

Status: **CLOSED. GO WITH CONDITIONS. The "ADDENDUM: S13 expiry enforcement and Phase 5 closure" at the bottom is the final word and supersedes earlier interim statements.**

Nothing in production was touched. No application code, Firebase config, Supabase config, secrets, or users were changed.

## 1. Environment

| Item | Value |
|---|---|
| Repo commit at start | `bc8fcd3` (Phase 4A, 64/64 rules tests pass) |
| Docs read | 2026-10-07, fetched live (see sources) |
| Throwaway Firebase Spark project | provided: project ID `attendance-auth-sp` (web config kept out of the repo) |
| Throwaway Supabase Free project | **not yet provided** |

Doc-reading caveat: the Firebase pages (custom claims, blocking functions, verify-ID-tokens) came back through a summarizing fetcher, not verbatim, so claims drawn only from them are marked *(secondhand)*. The Supabase pages and the Firebase pricing page were read directly. Anything not stated by a page is marked **UNVERIFIED** and must be proven in the spike.

## 2. Documented path (official)

Sources:
- https://supabase.com/docs/guides/auth/third-party/firebase-auth
- https://supabase.com/docs/guides/auth/third-party/overview
- https://firebase.google.com/docs/auth/admin/custom-claims
- https://firebase.google.com/docs/auth/extend-with-blocking-functions
- https://firebase.google.com/docs/auth/admin/verify-id-tokens
- https://firebase.google.com/pricing
- https://supabase.com/docs/guides/functions (+ `/secrets`, `/limits`, `/auth`, `/dependencies`, `/auth-headers`)

### Required JWT claims
- `role: 'authenticated'` must be present as a Firebase custom claim. Supabase "inspects the `role` claim present in all JWTs ... to assign the correct Postgres role when using the Data API, Storage or Realtime authorization."
- Without it: "By default, Firebase JWTs do not contain a `role` claim", so the request runs as `anon`.
- `iss` / `aud` are not required by the hosted platform; they are only used in the optional RLS guard (`iss = https://securetoken.google.com/<project-id>`, `aud = <project-id>`).
- The provider must sign asymmetrically with a `kid` header and expose an OIDC discovery URL. Key rotation can take up to 30 minutes to be picked up.

### Supabase configuration
- Dashboard: Authentication → Third-Party Auth → add Firebase with the Firebase Project ID.
- CLI: `[auth.third_party.firebase] enabled = true, project_id = "<id>"` in `config.toml`.
- Hosted behaviour: JWTs from unregistered Firebase project IDs are rejected before reaching the database.
- Client: `createClient(url, key, { accessToken: async () => (await currentUser?.getIdToken(false)) ?? null })`.

### UID extraction
- The Supabase pages do **not** document `sub` extraction or text-vs-uuid typing. Firebase UIDs are not UUIDs, so UID columns must be `text` and policies must use `auth.jwt()->>'sub'`. **Must be proven (S3, S6).**
- `auth.uid()` returns `uuid` and is expected to fail or be useless for Firebase UIDs. **UNVERIFIED.**

### Documented ways to assign `role: authenticated`
1. **Blocking functions** (`beforeUserCreated` / `beforeUserSignedIn`), described as the easiest. Requires Firebase Auth **with Identity Platform**, and they are Cloud Functions (Cloud Functions are "Not applicable" on Spark per the pricing page, which makes this a Blaze dependency, an inference). Synchronous, so no forced refresh is needed. The Firebase page says anonymous and custom auth **do not trigger blocking functions** *(secondhand)*.
2. **`onCreate` Auth Cloud Function** calling `setCustomUserClaims`. Also a Cloud Function. Asynchronous, so the client must call `getIdToken(true)` after sign-up.
3. **Admin SDK backfill script** for existing users ("Existing users will not have these claims in their ID tokens"). The sample on the Supabase page has two bugs (`userRecord.id` should be `uid`, and unbalanced parentheses). Fix before any use.

### Documented mechanism without Blaze / Identity Platform
**None documented.** Neither Supabase page says "Blaze". The Admin SDK `setCustomUserClaims` is not documented as Blaze-gated, and the pricing page shows no per-feature Auth restriction on Spark (verified by absence only). But every documented *automatic* path for new users uses a Cloud Function.

### Limitations and warnings
- **Cross-project risk (security-critical):** "Firebase Auth uses a single set of JWT signing keys for all projects." A token from an unrelated Firebase project could pass signature checks. Supabase says to add **`as restrictive`** RLS policies on all `public` tables, Storage and Realtime that check `iss` and `aud`, and "make sure you don't omit the `as restrictive` clause." Example helper: `public.is_supabase_or_firebase_project_jwt()`.
- Works with Data API (REST/GraphQL), Storage, Realtime, Functions. No product-specific caveats beyond the above.
- "It is not possible to disable Supabase Auth at this time."
- Pricing: $0.00325 per third-party MAU above plan quota (not fetched in detail).
- `setCustomUserClaims` overwrites all existing custom claims, so claims must be merged; 1000-byte payload limit; new claims reach the client only on a newly issued ID token (`getIdToken(true)`) *(secondhand)*.
- Whether `role` is a reserved Firebase claim name: **UNVERIFIED** (the page says OIDC and Firebase reserved names are rejected but the fetch did not return the list). Must be tested directly.
- Whether claims set via Admin SDK stick to anonymous users: **UNVERIFIED.**

## 3. Experimental no-Blaze path

Hypothesis: a server-side component outside Firebase holds the service account, verifies the caller's Firebase ID token, and sets exactly `{ role: 'authenticated' }`; the browser then calls `getIdToken(true)`.

### Candidate host: Supabase Edge Function (throwaway project)
Facts from the Edge Functions docs:
- Deno runtime; `npm:` specifiers and Node built-ins supported. **`firebase-admin` is not mentioned and is UNVERIFIED** (heavy package, 2s CPU / 256MB limits, no multithreaded Node libs).
- Fallback that avoids `firebase-admin`: `npm:jose` + `fetch` to the Google Identity Toolkit REST API (`accounts:update` with `customAttributes`), authenticating with a service-account OAuth JWT. Also UNVERIFIED.
- `verify_jwt` defaults to on and will 401 any Firebase token before the handler runs, because the token is not signed by Supabase. The function must set `verify_jwt = false` in `config.toml` and verify the Firebase token itself (RS256 against Google's x509 keys, `iss = https://securetoken.google.com/<project>`, `aud = <project>`, `exp`, non-empty `sub`).
- Secrets: set via dashboard or `supabase secrets set`, read with `Deno.env.get`, server-side only, max 48 KiB each (a service-account JSON fits). Names cannot start with `SUPABASE_`. The user sets them manually; I never see them.
- Free plan: 2s CPU, 256MB memory, 150s wall clock.

### Required safety properties of the bootstrap function
- Accept only an `Authorization: Bearer <Firebase ID token>`; no request body fields influence claims.
- Verify signature, `iss`, `aud`, `exp` against the throwaway project ID; derive UID only from the verified `sub`.
- Write the constant `{ role: 'authenticated' }` only. Read existing claims first and merge, never accept caller-supplied claims.
- Reject all other roles (`admin`, `service_role`, `anon`, etc.) by construction (nothing reads them from input).
- Idempotent: skip the write if the claim is already present.

### Known structural risks (to be tested, not assumed)
1. **New-user problem.** There is no Firebase trigger on Spark. The bootstrap would have to be called by the client after sign-in/sign-up, then a forced refresh. Between sign-up and bootstrap the user's first token has no role (runs as `anon`). That is acceptable only if the app handles it, and it makes the client responsible for calling it. This is the likeliest NO-GO point (Task 7).
2. **Anonymous users** are not covered by blocking functions; the client-called bootstrap must handle them, and claim persistence is unverified.
3. **Auth for the bootstrap itself** relies on the client being honest only about *which token it holds*, which is safe because the token is verified server-side.
4. **Self-service role grant.** Any Firebase user of the project can obtain `role=authenticated` by design. This is fine only if RLS (not the role) is the real access boundary. Policies must also be `as restrictive` per project.

## 4. Exact configuration
Not yet applicable (no throwaway resources). To be filled after provisioning.

## 5. Tests S1–S12
Not run. Blocked on throwaway resources.

## 6. Security tests
Not run.

## 7. New-user results
Not run.

## 8. Anonymous-user results
Not run.

## 9. Google-user results
Not run.

## 10. Realtime results
Not run.

## 11. Token-refresh results
Not run.

## 12. Multi-device results
Not run.

## 13. Failure tests
Not run.

## 14. GO / NO-GO
**Undetermined.**

## 15. Exact reason for result
Not applicable yet. Documentation review alone shows that every *documented* automatic path for new users needs a Cloud Function (Blaze) and that anonymous users are not covered by blocking functions. Whether the client-triggered bootstrap can substitute safely is what the spike must prove.

## 16. What would be required for production
Not determined. Pending spike result.

## Required from the user to proceed
1. A throwaway **Firebase Spark** project (Auth enabled: Anonymous + Google). Give me only the project ID and web app config (public values).
2. A throwaway **Supabase Free** project. Give me only the project ref/URL and publishable key.
3. The user configures, manually and never in chat or git: the Firebase service-account key as an Edge Function secret in the throwaway Supabase project, and registers the throwaway Firebase project under Supabase → Authentication → Third-Party Auth.
4. Two or three test Google accounts for S10 and the multi-user and multi-device tests.

## Phase 5B progress (2026-10-08)
Spike lab: `C:/Users/Aditya/Downloads/attendance-auth-spike-lab` (outside this repo, no git). No S1-S12 test has run. Verdict still **undetermined**.

Blockers (VERIFIED in spike attempt):
1. The Firebase Web API key is rejected by Identity Toolkit (`accounts:signUp` returns 400 `API_KEY_INVALID`, also with a localhost Referer). No Firebase user can be created, so no token exists to test.
2. No Supabase CLI install or access token, and no DB credentials, so the agent cannot deploy the Edge Function or apply SQL.
3. Google sign-in (S10, multi-device) needs a human in a browser.

## Phase 5B-1: S1–S3 results (2026-10-08)
Labels: **[DOC]** documented by Supabase, **[VERIFIED]** observed in this spike, **[UNVERIFIED]** not yet tested.

Setup (VERIFIED): lab `C:/Users/Aditya/Downloads/attendance-auth-spike-lab` (outside repo). Linked and targeted project ref `gfnblqnsdubsxfoywfgr` (name `attendance-auth-spike`, ap-south-1, empty at start: 0 public tables, 0 auth users). Firebase project `attendance-auth-sp`. Every CLI call used an explicit `--project-ref`. The Supabase account also lists other projects (all INACTIVE, none touched). Probe SQL: `sql/s1_s3_probes.sql` in the lab (two tables, `spike_public` readable by anon+authenticated, `spike_protected` granted to `authenticated` only, and `public.spike_whoami()`). No role bridge, no custom claims, no Edge Function, no restrictive policies yet. Test was via PostgREST with `apikey: sb_publishable_…` and `Authorization: Bearer <Firebase ID token>`.

### S1: Supabase accepts the configured Firebase project: **PASS** (VERIFIED)
- A fresh anonymous Firebase ID token (`iss=https://securetoken.google.com/attendance-auth-sp`, `aud=attendance-auth-sp`) was accepted: `rpc/spike_whoami` returned HTTP 200 and `jwt_iss`/`jwt_aud` were visible in SQL.
- A malformed token was rejected before the DB: HTTP 401 `PGRST301 JWT cryptographic operation failed`.
- NOT tested here: a validly signed token from an unregistered Firebase project (needs a second Firebase project; planned for the security tests). **[UNVERIFIED]** that unregistered projects are rejected.

### S2: token without `role`: **PASS** (VERIFIED)
- The Firebase token has no `role` claim (claim keys: provider_id, iss, aud, auth_time, user_id, sub, iat, exp, firebase).
- Effective Postgres role: **`anon`** (`current_user = anon`, `auth.role() = anon`). Inside SQL, `auth.jwt()->>'role'` also reads `anon`, so the platform fills in a default `anon` role claim when the Firebase token has none (the original token is unchanged).
- `spike_public` (anon allowed): HTTP 200, row returned.
- `spike_protected` (`authenticated` only): HTTP 401, `42501 permission denied for table spike_protected`. Denied as expected.
- Same results as a request with the publishable key and no token, which is the same as `anon`.
- DOCUMENTED claim "without a role claim the request runs as anon" is now VERIFIED.

### S3: UID extraction: **PASS** (VERIFIED)
- JWT `sub` equals the Firebase UID (e.g. 28-character mixed-case alphanumeric, not a UUID); `sub === localId` confirmed.
- `auth.jwt()->>'sub'` returns the exact Firebase UID, `pg_typeof` = `text`.
- `auth.uid()` **fails** with `invalid input syntax for type uuid: "<firebase uid>"`. So `auth.uid()` must never be used; all policies and UID columns must use `text` with `auth.jwt()->>'sub'`. (Observed while the role was `anon`; behaviour is the same function so not expected to change with a role claim, but re-check at S6.)
- Without a token (publishable key only), `jwt_sub` is null and `auth.uid()` is null.

### Notes
- Only an anonymous user was used. Google users are not yet tested.
- S4 onward (role bootstrap) is NOT started.

## Phase 5C: S4–S6 results (2026-10-08)
Labels: **[DOC]** documented by Supabase, **[EXPERIMENTAL]** the no-Blaze bridge, **[VERIFIED]** observed in this spike, **[UNVERIFIED]** not tested.

Pre-flight (VERIFIED): lab outside repo; Supabase ref `gfnblqnsdubsxfoywfgr`; Firebase `attendance-auth-sp`; secret name `FIREBASE_SERVICE_ACCOUNT_JSON` exists in the throwaway project (value never read or printed; the key from the earlier exposure was rotated by the user). No service-account JSON or key marker in this repo.

### Edge Function runtime: **PASS** (VERIFIED, EXPERIMENTAL)
- `auth-role-bootstrap-spike`, deployed only to the throwaway project with `verify_jwt = false` (confirmed in function list). Lab source: `supabase/functions/auth-role-bootstrap-spike/index.ts`.
- `npm:firebase-admin@13` (`/app`, `/auth`) **runs in the Supabase Edge runtime** and completed `verifyIdToken`, `getUser` and `setCustomUserClaims` with the free plan. This resolves the earlier UNVERIFIED item. No REST/jose fallback was needed.
- Function logic: Bearer token only; `verifyIdToken` (Google signature, exp), then explicit `iss`, `aud`, `sub == uid` checks; UID taken only from the verified token; request body is never read; existing claims merged and only `role: "authenticated"` added; idempotent (no write if already set). Response: success, redacted UID (first 4 chars), `roleSet`, `changed`. Only error codes are logged, never tokens or secrets.
- `role` is NOT a reserved Firebase claim name: `setCustomUserClaims` accepted it. (VERIFIED, resolves earlier UNVERIFIED.)

### S4: claim bootstrap: **PASS** (VERIFIED)
New anonymous user (the S1–S3 users were not saved), token had no `role`. Bootstrap call returned `200 {success:true, roleSet:true, changed:true}`. After a forced refresh the token had `role=authenticated`, same `sub`/UID, correct `iss` and `aud`.
Not tested: preserving unrelated pre-existing custom claims (code merges, but no test set another claim first). **[UNVERIFIED]**.

### S5: token refresh: **PASS** (VERIFIED)
Two further forced refreshes both carried `role=authenticated`; `sub`, `aud`, `iss` unchanged; lifetime 3600 s; `accounts:lookup` with the refreshed token returned the same UID. The two back-to-back refreshes returned the same `iat` (issued in the same second), so independent re-minting was not distinguishable. Full sign-out/sign-in is S11, not run.

### S6: Supabase authorization and UID: **PASS** (VERIFIED)
- With the refreshed token: `current_user = authenticated`, `auth.role() = authenticated`, `auth.jwt()->>'role' = authenticated`, `auth.jwt()->>'sub' =` exact Firebase UID (`text`).
- `auth.uid()` still **fails** (`invalid input syntax for type uuid`) even as `authenticated`. Never use it.
- `spike_protected` (authenticated-only) now readable (it was denied at `anon` in S2).
- `spike_items` has a permissive policy `owner = auth.jwt()->>'sub'` plus a `restrictive` iss/aud policy. The user sees only their own row; a forged `?owner=eq.<other>` filter returns `[]`; an RPC taking a `p_uid` of another user returns `[]` (RLS, not the parameter, decides).
- Not tested here: a token from a different Firebase project against the restrictive policy (needs a second project). **[UNVERIFIED]**

### Bootstrap security negatives (VERIFIED, all denied)
| Case | Result |
|---|---|
| no Authorization | 401 |
| malformed bearer / garbage JWT | 401 |
| forged token, `alg: none`, past `exp` | 401 |
| forged wrong issuer / wrong audience / other project (fake signature) | 401 |
| real token with payload `sub` tampered to another user | 401 |
| valid token + body `{uid: victim, role: "admin", claims: {admin: true}}` | 200 for the caller (role=authenticated only); caller has no `admin`; victim's role stays null |

Not tested: a genuinely expired Firebase token (needs to wait ≥1 h; one fresh token is saved in the lab as `.state2.json` for this), and a real, validly signed token from another Firebase project. Both **[UNVERIFIED]**. Forged tokens cover the same code path (all fail in `verifyIdToken`), but they are not the same test.

### Secret handling (VERIFIED)
Secret exists only as a Supabase Edge Function secret; no key marker in function source, lab files or this repo; function reads it via `Deno.env.get`, never returns or logs it; the browser/client never receives it. Function logs were not read from the platform. Note: `supabase secrets list` returned a digest string for the value, not the secret.

### Interim assessment (not a verdict)
Role assignment without Blaze works for an existing/new anonymous user **when the client calls the bootstrap itself and then force-refreshes**. The new-user race (first token runs as `anon`) is the remaining hard gate (S9, S10) along with Realtime (S12) and Google (S10).

## Phase 5D: S7–S12, cross-project, closeout (2026-10-08)
Labels: **DOCUMENTED** (by Supabase/Firebase), **EXPERIMENTAL** (the no-Blaze bridge), **VERIFIED** (observed in this spike), **UNVERIFIED**.
Lab: `C:/Users/Aditya/Downloads/attendance-auth-spike-lab` (outside this repo). Throwaway resources only: Firebase `attendance-auth-sp`, Firebase `attendance-cross-project-test` (cross-project token only), Supabase `gfnblqnsdubsxfoywfgr`.

### Architecture (EXPERIMENTAL, VERIFIED)
Browser → Firebase Auth (anonymous or Google) → Firebase ID token (no `role`, so Supabase treats it as `anon`) → POST to Edge Function `auth-role-bootstrap-spike` (`verify_jwt=false`, because the token is Firebase-signed; CORS limited to one fixed origin) → the function verifies the token with `firebase-admin` (`verifyIdToken`) plus explicit `iss`/`aud`/`sub` checks, takes the UID only from the verified token, never reads the body, and merges `role: "authenticated"` into existing custom claims (idempotent) → the client calls `getIdToken(true)` → Supabase third-party Firebase Auth accepts the token as role `authenticated`. All RLS uses `auth.jwt()->>'sub'` (text) with `as restrictive` checks on `iss` and `aud`. Never `auth.uid()`.

### S7: correct user authorization: **PASS** (VERIFIED)
Own rows only. Another user's UID passed as a function argument, a forced `owner=eq.` filter, and spoofed `x-uid` headers all returned nothing; identity comes only from the JWT `sub`.

### S8 same-project: **PASS** (VERIFIED)
Two users each read only their own rows. Tampered real tokens (`role=service_role`, `role=admin`, `sub`, `aud`, `iss` changed, original signature kept) were rejected with 401. Forged body `{role: admin, uid: other, claims…}` was ignored (no admin claim, victim unchanged). Missing or garbage `Authorization` on the data API: 401.

### S8 cross-project: **PASS**, one variant UNVERIFIED (VERIFIED)
- The token from `attendance-cross-project-test` (anonymous user) was genuinely signed by Google for that project and unmodified (`iss=https://securetoken.google.com/attendance-cross-project-test`, `aud=attendance-cross-project-test`).
- Edge Function: **401 `invalid-token`**.
- Supabase data API and `spike_whoami`: **401 "Unregistered Firebase Auth JWT issuer"** (rejected by the platform before the database, so the restrictive `iss`/`aud` RLS never ran).
- **UNVERIFIED:** a cross-project token that also carries `role=authenticated` and a `sub` copied from a real spike user. Setting claims in the other project needs its service account, which was not used.

### S9: brand-new anonymous user: **PASS** (VERIFIED)
The first token had no `role` (`anon`, protected data denied). Bootstrap returned 200, then refresh gave `role=authenticated` with the same UID; Supabase role `authenticated`; RLS returned the user's row. A second bootstrap returned `changed:false`. Claim preservation: a user seeded with `some_test_flag=true` kept it after bootstrap (a temporary test-only function seeded the flag). 12 parallel bootstraps for one user: all 200, final claims correct, no corruption.

### S10: brand-new Google user: **PASS with a caveat** (VERIFIED from recorded events and Supabase-side checks)
- Evidence: the local helper log `.events.jsonl`, plus a re-check against Supabase using each session's refresh token.
- Google sign-in succeeded; the first token of the Google user had `role=null`; bootstrap returned 200 `changed:true`; after the forced refresh `role=authenticated`; sign-out then sign-in again succeeded; bootstrap returned 200 `changed:false` (idempotent); provider `google.com`; same UID throughout; Supabase sees `authenticated`, `sub` equals the UID, and RLS returns only that user's row, never the other owner's.
- **Caveat:** the Firebase user was actually created at 01:22:22 UTC by an earlier sign-in attempt whose bootstrap call failed on CORS, so the recorded successful sign-in reports `isNewUser:false`. The recorded flow is still "role-less first token → bootstrap → refresh" on an account with no claims, but a fresh Google account with `isNewUser:true` was not captured. See condition 2.

### S11: refresh / sign-out / sign-in / multi-device: **PASS with gaps** (VERIFIED, plus user-attested)
- Sessions A and B produced three distinct refresh tokens (A original, A after re-sign-in, B), all resolving to the same Firebase UID with provider `google.com`. All three currently refresh to `role=authenticated` and see only that user's rows on Supabase.
- Sign-out then sign-in in session A returned to the same UID with the role claim intact (no identity split).
- That A and B were separate browser profiles is **user-attested**, not independently verifiable.
- Client-side sign-out does not revoke the server-side refresh token: A's pre-sign-out refresh token still refreshes. Server-enforced logout needs Firebase `revokeRefreshTokens`, and access tokens stay valid until they expire (up to 1 h). A production design must account for this.
- **UNVERIFIED:** the recorded order was A in, A out, A in, then B in. "Session B keeps working after A signs out while B is active" was not tested in that order.
- **UNVERIFIED:** automatic client-side token refresh before expiry (only forced refresh was tested).

### S12: Realtime: **PASS** (VERIFIED)
Postgres Changes with Firebase JWT and `sub`-based RLS: each user got only their own events; no cross-user leak; delivery continued after a token refresh; a signed-out client got no data events; signing in again restored delivery; after disconnect and reconnect, a change made while offline was NOT replayed, and an explicit refetch converged to the database state; live events resumed after reconnect; no unauthorized event leaked.
- **Critical gotcha:** with the Supabase client's `accessToken` option alone and no explicit `realtime.setAuth(token)`, every event arrived as `Error 401: Unauthorized` with no data (reproduced; fail-closed, not a leak). The app must call `realtime.setAuth(token)` before subscribing and after every Firebase token refresh.
- **Required pattern:** after every reconnect, refetch. Missed Postgres Changes events are not replayed.
- **UNVERIFIED:** in-place sign-out on an already-subscribed socket; a subscription surviving natural token expiry.

### Security-negative summary (VERIFIED, all denied)
Missing Authorization; malformed or garbage token; forged `alg:none` token; forged wrong issuer, audience and other-project tokens (fake signature); tampered `sub`/`role`/`aud`/`iss` on a real token; body-supplied `uid`/`role`/`claims`; spoofed uid headers and parameters; a genuine token from an unregistered project; a signed-out (no token) client. No negative produced elevated access, another user's data or a changed claim. Nothing in production was written.
- **Genuine expired token:** UNVERIFIED at the time of writing (a saved genuine token expires about 22 minutes after the Phase 5D tests; a background test was started). See the addendum if present.

### Secret handling (VERIFIED)
The service-account key exists only as the Edge Function secret `FIREBASE_SERVICE_ACCOUNT_JSON`. The old exposed key id no longer appears in Google's public key list for the service account. No key marker exists in the lab source, the function source or this repo. The function reads the secret with `Deno.env.get`, never returns or logs it (it logs only an error code), and the browser helper receives no secret.
- Caveats: the exposed key was visible to the assistant once (via the IDE selection) before rotation. Two key ids are active and I cannot tell which is the replacement. The publishable key and Firebase web API keys sit in lab config files (public values). Refresh tokens of throwaway test users were stored in lab files and were scrubbed at cleanup.

### Documented vs experimental
- DOCUMENTED: third-party Firebase Auth in Supabase; the `role` claim is required for `authenticated`; `as restrictive` iss/aud policies; blocking functions (Blaze/Identity Platform) as the documented way to set the role.
- EXPERIMENTAL and VERIFIED here: the client-called bootstrap via Edge Function and `firebase-admin` on Spark (no Blaze); Firebase accepts the claim name `role`; `firebase-admin@13` runs in the Supabase Edge runtime on the Free plan.
- Not needed by this spike: no Firebase billing upgrade; no user identity migration (Firebase UIDs stay).

### Phase 5 final matrix
| Test | Result |
|---|---|
| S1 | PASS |
| S2 | PASS |
| S3 | PASS |
| S4 | PASS |
| S5 | PASS |
| S6 | PASS |
| S7 | PASS |
| S8 same-project | PASS |
| S8 cross-project | PASS (copied-`sub` + `role` variant UNVERIFIED) |
| S9 | PASS |
| S10 | PASS with caveat (the "new" account was created by an earlier failed attempt) |
| S11 | PASS with gaps (see above) |
| S12 | PASS |
| Genuine expired token | UNVERIFIED (see addendum) |

### FINAL VERDICT: **GO WITH CONDITIONS**
Evidence: every hard gate passed. Direct integration works; `role=authenticated` is established without Blaze; existing, new anonymous and new Google users all work with a client-called bootstrap; refresh, sign-out/sign-in, same-account multi-session, restrictive RLS, cross-project rejection and Realtime all behaved correctly; no secret reached the browser; no production system was touched; no Firebase upgrade or identity migration was needed.

Conditions before migrating the application:
1. **New-user window:** every new user's first token runs as `anon` until the client has called the bootstrap and force-refreshed. The app must block authenticated work until that completes, with retry, and treat the bootstrap as a required part of sign-in.
2. Re-run S10 once with a fresh Google account to capture `isNewUser:true` end to end.
3. Test (a) the cross-project variant with `role=authenticated` and a copied `sub` (needs the other project's admin access), and (b) a genuine expired token if the addendum does not cover it.
4. Realtime: always call `realtime.setAuth(token)` before subscribing and after each refresh; always refetch after reconnect.
5. Server-side logout needs `revokeRefreshTokens` and leaves up to 1 h of access-token validity; decide whether that is acceptable.
6. Keep the bootstrap function's checks as they are (token verification, fixed claim, ignored body); add rate limiting and a production CORS allow-list; keep `as restrictive` iss/aud policies on every table, Storage and Realtime.
7. Re-run these checks against the real production Firebase project during the migration, without weakening any of the above.

### Cleanup performed (2026-10-08, throwaway resources only)
- Deleted Edge Function `claim-seed-spike` (test-only) in `gfnblqnsdubsxfoywfgr`. `auth-role-bootstrap-spike` is kept for evidence.
- Truncated all rows in `spike_public`, `spike_protected`, `spike_items`, `spike_rt` (schema kept).
- Deleted three anonymous Firebase users in `attendance-auth-sp` (S4 user, A, B). The Google test user and other anonymous users whose tokens were not retained (C, D, S5/S6 users, cross-project users) were NOT deleted: no admin access was used. Delete them in Firebase console (Authentication → Users), or delete the throwaway projects.
- Stopped the local helper on port 5179; deleted lab token files, temp SQL, logs and `config.other.json`; scrubbed refresh tokens from `.events.jsonl`.
- Not deleted: the Supabase spike project, both throwaway Firebase projects, the `FIREBASE_SERVICE_ACCOUNT_JSON` secret (delete it when the spike project is retired).


---
# AUTHORITATIVE FINAL RESULTS (supersede the interim matrices and verdicts above)

## Genuine expired-token test (2026-10-08, VERIFIED as run; result is mixed)
A genuine Firebase ID token for `attendance-auth-sp`, saved during S6 and unmodified, was tested 20 seconds after its natural expiry (`exp`). It was the token of an anonymous user taken **before** that user's bootstrap, so it carried **no `role` claim**.
- Edge Function `auth-role-bootstrap-spike`: **401 `invalid-token`**. Expired token rejected. **PASS** for the bootstrap function.
- Supabase data API (`spike_items`, `authenticated`-only): **401 `42501` permission denied**, with the hint naming role `anon`. Access denied, but the request ran as `anon`; it was not rejected as an expired JWT.
- Supabase `spike_whoami`: **HTTP 200**, with `jwt_iss`, `jwt_aud` and `jwt_sub` populated from the expired token. The stored result was truncated at 160 characters, so the effective role in that response was not captured. The data-API result above implies `anon`.
- **Conclusion: UNVERIFIED for Supabase-side expiry enforcement.** What is proven: the bootstrap function rejects an expired token, and an expired role-less token does not give access to protected data. What is NOT proven: that Supabase refuses an expired token that carries `role=authenticated`. The `whoami` 200 suggests Supabase may still read an expired Firebase token's claims instead of rejecting it, which must be ruled out before production (condition 1 below). This does not change any S1–S12 result.
- The test token and its user were not retained, so the test cannot be repeated with the same token. A repeat needs a new user, a bootstrap, a refresh, then a wait of just over one hour.

## Final status matrix (one status per test)
| Test | Status | Note |
|---|---|---|
| S1 third-party Firebase integration accepts the project | PASS | |
| S2 token without role runs as `anon` | PASS | |
| S3 Firebase UID as `sub`, kept as TEXT | PASS | `auth.uid()` fails; never use it |
| S4 claim bootstrap sets `role=authenticated` | PASS | |
| S5 token refresh keeps the claim | PASS | |
| S6 Supabase role, `sub` extraction and RLS | PASS | |
| S7 correct-user authorization | PASS | |
| S8 cross-user and cross-project security | PASS | same-project PASS; a genuinely signed token from another Firebase project was rejected (Edge Function 401, Supabase "Unregistered Firebase Auth JWT issuer"); variant listed in limitations |
| S9 brand-new anonymous user | PASS | plus claim preservation and 12-way concurrency |
| S10 brand-new Google user | PASS | limitation 2 below |
| S11 refresh, sign-out/sign-in, multi-device | PASS | limitations 3 and 4 below |
| S12 Realtime | PASS | two required patterns in Production Requirements |

## Documented limitations (not tested, or not verifiable here)
1. A cross-project token carrying `role=authenticated` and a `sub` copied from a real spike user was **not tested** (it needs the other project's service account). The platform rejected a genuine other-project token on issuer alone.
2. A fresh Google account reporting `isNewUser=true` at the moment of bootstrap was **not tested**. The Google account used was created by an earlier sign-in attempt whose bootstrap call failed on CORS; its recorded successful sign-in reports `isNewUser=false`, with no claims present until the bootstrap.
3. That sessions A and B were **separate browser profiles** cannot be independently verified from the lab. The lab shows three distinct refresh tokens resolving to one UID.
4. "Session B keeps working after A signs out while B is already active" and **automatic client-side refresh before expiry** were **not tested**. The recorded order was A in, A out, A in, then B in; only forced refresh was exercised.
5. Supabase-side rejection of an expired token that carries `role=authenticated` was **not verified** (see the expiry test).
6. In-place sign-out on an already-subscribed Realtime socket, and a subscription surviving natural token expiry, were **not tested**.

## Production Requirements (discovered by the spike)
1. **Bootstrap before authenticated cloud work.** A new user's first Firebase token has no `role` and runs as `anon`. After sign-in or sign-up the client must call the bootstrap function and must not start authenticated cloud work (reads, writes, Realtime) until it succeeds. Retry with backoff on failure.
2. **Force-refresh after bootstrap.** Call `getIdToken(true)` after the bootstrap so the token carries `role=authenticated`; the claim only appears on a newly issued token.
3. **Explicit `realtime.setAuth(token)`** before subscribing and after every Firebase token change. Without it, every Realtime event arrived as `Error 401: Unauthorized`.
4. **Refetch after every Realtime reconnect or resubscribe.** Postgres Changes events missed while disconnected are not replayed.
5. **Production CORS allow-list.** The spike allows one fixed origin and never echoes `Origin`. Production needs an explicit list of real origins, and `OPTIONS` handling on the bootstrap function.
6. **Rate limiting on the bootstrap function.** It is callable by any holder of a valid Firebase token and performs Admin SDK writes.
7. **Explicit sign-out and revocation strategy.** Client sign-out does not revoke the refresh token (verified). Use `revokeRefreshTokens` where server-enforced logout is needed, and accept up to one hour of access-token validity.
8. **Issuer and audience validation everywhere.** The bootstrap function checks `iss` and `aud` itself. Every table, Storage and Realtime policy needs `as restrictive` checks on `iss` and `aud`, because Firebase signs all projects with the same keys.
9. **Firebase UID is TEXT.** Use `text` columns and `auth.jwt()->>'sub'` in RLS. Never use `auth.uid()` (it fails with a uuid error).
10. **Keep the bootstrap function's guarantees:** verify the token with the Admin SDK, take the UID only from the verified token, never read the request body, set only `role: "authenticated"`, and merge existing claims.
11. **Secrets:** the service-account JSON lives only as an Edge Function secret; never in the repo, the browser or logs.

## FINAL VERDICT: **GO WITH CONDITIONS**
All twelve tests passed on evidence. Direct integration works; `role=authenticated` is set without Blaze; new anonymous users, new-state Google users, existing users, refresh, sign-out/sign-in, same-account multi-session, restrictive RLS, cross-project rejection and Realtime all behaved as required; no secret reached the browser; no production system was touched; no Firebase upgrade and no identity migration were needed.

Remaining conditions (must be closed before or during the production migration):
1. **Expired authenticated token:** prove that an expired token carrying `role=authenticated` is refused by Supabase, or else add compensating controls. The expiry test showed an expired role-less token still being read by `spike_whoami`.
2. Re-run S10 once with a fresh Google account to capture `isNewUser=true`.
3. Test the cross-project variant with `role=authenticated` and a copied `sub` if the second project's admin access is available.
4. Test "A signs out while B is active" and automatic pre-expiry refresh.
5. Implement every item in Production Requirements and repeat these checks against the real production Firebase project without weakening any of them.


---
# ADDENDUM (2026-10-08): S13 expiry enforcement and Phase 5 closure

This addendum records the expired-token tests that the sections above left open. It does not change any earlier result. Where it differs from an earlier line (the "UNVERIFIED" expiry entries and condition 1 of the verdict), this addendum is the later and authoritative record.

## S13: expired Firebase ID token carrying `role=authenticated`: **PASS WITH DOCUMENTED CLOCK-SKEW GRACE** (VERIFIED)

Test: fresh anonymous Firebase user in `attendance-auth-sp`; bootstrap (200, `changed:true`); one forced refresh after the bootstrap; that token saved unmodified; never refreshed again; the same exact string sent after its natural expiry.

| Item | Value |
|---|---|
| Firebase UID (`sub`) | `pQsIi0mal0OJhEKAfRJ6ND2r8mz1` (throwaway project) |
| Role before expiry | `authenticated` (confirmed in the saved token; a pre-expiry control returned `current_user=authenticated` and the user's protected row) |
| `exp` | 1791430636 = 2026-10-08T03:37:16Z |
| Token sent | the exact saved string (`same_token_as_saved: true`), not refreshed, not decoded and reassembled |

| Time after `exp` | Edge Function `auth-role-bootstrap-spike` | Supabase Data API (`spike_items`) | `spike_whoami` |
|---|---|---|---|
| +25 s (03:37:41Z) | **401** `invalid-token` | **200**, returned the user's protected row | **200**, `current_user=authenticated` |
| +45 s (03:38:01Z) | **401** | **401** `PGRST303` "JWT expired" | **401** `PGRST303` "JWT expired" |

Interpretation:
- The Edge Function (Firebase Admin SDK `verifyIdToken`) has no grace and rejected the token at +25 s.
- The Supabase Data API accepted the token at +25 s and rejected it at +45 s with an explicit "JWT expired" error. This shows **bounded expiry grace, not missing expiry enforcement.** The observed acceptance window after `exp` is bracketed between +25 s and +45 s. The exact length was not measured (the test was not repeated at +30 s) and is not documented in the sources read for this spike. A grace of about 30 s is the likely explanation (a clock-skew allowance in PostgREST's JWT check), but that is an inference and is labelled UNVERIFIED.
- This does **not** mean expired tokens are accepted indefinitely: at +45 s the same token was refused by the Data API and by `spike_whoami`.
- **Production requirement:** token-refresh logic must not assume a hard zero-second boundary at `exp`. The client must refresh before expiry (with a safety margin), and server-side logic must not treat "the database accepted it" as proof a token is still inside its lifetime. A stolen or stale token can stay usable for up to a short window after expiry; this adds to the one-hour access-token validity after sign-out already recorded above.

An earlier, separate expiry test (role-less anonymous token, +20 s past `exp`, 2026-10-08, token not retained) showed the same pattern: Edge Function 401 `invalid-token`; Data API 401 `42501` run as `anon`; `spike_whoami` 200. That is consistent with the same grace window; its `spike_whoami` body was truncated at 160 characters in the stored result, so the role in that response was not captured. It is superseded by S13 as the evidence for the question.

## `spike_whoami`: why a 200 is not proof of authenticated access (VERIFIED, database inspection)
`spike_whoami` is a plain diagnostic function: `SECURITY INVOKER`, owned by `postgres`, executable by `anon`, `authenticated`, `service_role` and PUBLIC (granted that way for the S1–S3 probes), reading only `current_user`, `auth.role()` and `auth.jwt()`. It touches no table. A 200 from it shows only that a request reached Postgres; the protected-table read (`spike_items`, `SELECT` granted to `authenticated` only, RLS on) is the real authorization test and is what S13 relies on.

## Final status matrix (authoritative)
| Test | Status |
|---|---|
| S1 | PASS |
| S2 | PASS |
| S3 | PASS |
| S4 | PASS |
| S5 | PASS |
| S6 | PASS |
| S7 | PASS |
| S8 (same-project and cross-project) | PASS |
| S9 | PASS |
| S10 | PASS (limitation 2 in the list above) |
| S11 | PASS (limitations 3 and 4) |
| S12 | PASS |
| S13 expiry enforcement | PASS WITH DOCUMENTED CLOCK-SKEW GRACE |

Limitations that remain recorded and are NOT resolved by this addendum: the cross-project token with `role=authenticated` and a copied `sub` was not tested; a fresh Google account reporting `isNewUser=true` was not tested; that sessions A and B were separate browser profiles cannot be verified from the lab; "sign-out while B is active" and automatic pre-expiry refresh were not tested; in-place sign-out on a live Realtime socket and a subscription surviving natural expiry were not tested.

## Phase 5 gate conclusion
Phase 5 is closed with the verdict **GO WITH CONDITIONS**. What the spike established, all VERIFIED in the throwaway environment:
- **Firebase Auth remains the identity provider.** Supabase accepts the Firebase ID token through its third-party Firebase integration; no Supabase Auth user is created and no identity is migrated.
- **The Firebase UID remains the JWT `sub`**, kept as `text`; `auth.jwt()->>'sub'` returns it exactly; `auth.uid()` fails and must never be used.
- **Supabase RLS authorization works with `role=authenticated`**, set by the experimental client-called bootstrap (Edge Function + Admin SDK, no Blaze). Without the claim a token runs as `anon`.
- **Anonymous and Google identities were both exercised** (anonymous: S4, S5, S7 to S9, S12, S13; Google: S10, S11).
- **Account separation and cross-user isolation worked**: users read only their own rows; forged parameters, filters, headers and tampered tokens were denied; a genuinely signed token from another Firebase project was rejected.
- **Realtime auth requires an explicit `realtime.setAuth(firebaseToken)`** before subscribing and after every token change; without it every event arrives as `401 Unauthorized` (fail-closed, no leak).
- **Reconnect requires an explicit refetch**: Postgres Changes events missed while disconnected are not replayed.
- **Expiry is enforced, with bounded clock-skew behaviour** (S13).

Conditions carried into the migration (updated): condition 1 of the earlier verdict (the expired authenticated-token question) is now answered by S13 and replaced by the clock-skew requirement above. Conditions 2 to 5 stand: capture `isNewUser=true` with a fresh Google account; test the cross-project variant with a role claim and copied `sub` if possible; test "sign-out while the other session is active" and automatic pre-expiry refresh; implement every item under "Production Requirements" (plus the expiry-margin requirement) and repeat these checks against the production Firebase project without weakening any of them.
