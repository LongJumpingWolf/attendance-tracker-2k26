# PHASE6E_LIMITER_FIX.md

Local fix for the earlier audit finding A (the bootstrap function's shared per-instance limiter could throttle established users). **Local only: not committed, not deployed.** The function deployed in production is still **version 1 with the old behaviour**. Nothing was pushed or enabled; no flag, Firebase, Vercel, schema or production data change.

## 1. The problem (verified in the source and reproduced by a test)

In the deployed v1, `handler.ts` called `ipLimiter.take(ip)` for **every** request, before the token was looked at. With `CLIENT_IP_MODE=off` (the default, because the platform's client-IP header is not known to be trustworthy) `clientKey()` returns the constant `"instance"`, so every user on a function instance shared one bucket of **30 requests per minute**. A busy minute, or anybody sending junk, made established users get 429. The bridge client retries 429 a few times and then pauses, so the symptom would be a sign-in delay or a spurious "bridge unavailable", not data loss. It had no effect while the flags are off.

The deeper reason it was wrong: **before verification nothing can be told apart**, and what the cap seemed to protect it did not protect:
* A garbage token is rejected after a regex and a local signature check (no network, microseconds). The invocation is already spent, so rejecting it cheaply costs the Free-plan invocation quota the same whether or not a limiter said no. A limiter in front of it saves nothing.
* The expensive resources are later: the Firebase revocation look-up (network), the Firebase Admin read and write, and the database counters.

## 2. The design: limit the expensive step, per verified identity

```
request
  CORS / method / bearer format                          (cheap, unchanged)
  [only if the owner enabled CLIENT_IP_MODE] per-address memory + database counter   (unchanged; OFF by default)
  PHASE 1  local verification: signature, expiry, issuer, audience   (no network, NO limiter)
           bad token -> cheap 401; touches no counter, no Admin API, no budget
  claims checks: iss/aud == production project, sub == uid, length   (unchanged)
  token carries role=authenticated  (ESTABLISHED USER)
           per-account fast limit (memory, default 120/min)
           instance-wide revocation valve (memory, 600/min)
           revocation / disabled-user check (network)   -> 401 revoked / 403 disabled / 503 Firebase trouble
           200 {success:true}.  Never touches the first-time counters. Nothing is written.
  no role yet (FIRST-TIME BOOTSTRAP)
           per-account memory limit (default 6/min)
           database counters, keyed by the VERIFIED uid: per account (6 / 10 min) and project-wide (120 / min)
           instance valve + revocation / disabled-user check (network)
           Admin read, conflict checks, the one write  (unchanged)
```

| Concern | How it is met |
|---|---|
| Unauthenticated / invalid tokens still protected | They never reach a network call, a counter or a budget. A flood of 2000 bad tokens followed by a real request in the tests leaves every budget intact. The remaining cost of a flood (invocation quota, log volume) cannot be limited by function code; see section 5 |
| Established users not throttled by the shared limiter | They use their own per-account limit and a very high instance valve; the first-time counters and the shared per-instance bucket are not on their path (regression test: 300 requests in a minute all succeed; the v1 cap would have refused 270) |
| No trust in unverified input | Every limiter key after phase 1 is the verified `sub`; the IP key (only in IP mode) is a hash of a header the owner has chosen to trust; a source test asserts no `take()` argument comes from the request |
| Token verification, issuer/audience, origin, account limits, authorization, no-overwrite of a foreign `role` | All unchanged and re-tested (the 60 earlier handler tests pass with only their harnesses adapted) |
| Revocation / disabled users | Checked on **both** paths (first-time and established) via the SDK's revocation check, as in v1. Order changed: on the first-time path the check now runs after the counters (so a revoked token spends its own account's budget and one project slot, but no Admin read or write happens). Firebase trouble during the check is now **503 (retry)**, not 401 (a verdict on the token) |
| Concurrency | Database counters are atomic (the 24-way parallel test against the real database from Phase 6E). In the handler: 100 simultaneous established requests are all served with no database traffic; 200 simultaneous first-time accounts against a cap of 120 give exactly 120 passes and 80 refusals; 20 simultaneous first-time requests for one account against a cap of 6 give exactly 6 passes, and every concurrent write is the identical constant claim |
| Multiple function instances | Shared across instances: the database counters (per account, project-wide, per address). **Not** shared: the memory limiters (account, established-account, revocation valve, per-address memory). See section 5 |

### Behaviour changes versus deployed v1 (for review)
1. No pre-verification limit with the IP mode off.
2. `verifyIdToken(token, checkRevoked)`: local verification first, revocation check second.
3. New 429 sources, all with `Retry-After`: established-account limit (60 s), revocation valve (60 s). Existing: first-time account in memory (60 s), account in the database (600 s), project-wide (60 s), per address (60 s).
4. Firebase trouble in the revocation check, or while fetching Google's keys, is 503 instead of 401.
5. In IP mode, the per-address memory cap is 120/min (was 30) because the database counter (`RATE_IP_PER_MIN`, default 60) is the real limit.

## 3. Files changed (all local, uncommitted)

| File | Change |
|---|---|
| `supabase/functions/auth-role-bootstrap/handler.ts` | the flow above; two new dependencies `fastLimiter`, `revocationLimiter`; `verifyIdToken(token, checkRevoked)` |
| `supabase/functions/auth-role-bootstrap/index.ts` | wiring: `fastLimiter` 120/min, `revocationLimiter` 600/min (one shared key), IP memory cap 120; `admin().verifyIdToken(token, checkRevoked === true)` |
| `supabase/functions/auth-role-bootstrap/handler.ts`, `index.ts` (review addition) | fail-closed guard: a function environment that contains `FIREBASE_AUTH_EMULATOR_HOST` makes the whole function answer 503 (section 7) |
| `tests/phase6e-limiter-fix.test.ts` (new) | 30 tests (24 limiter + 6 token-check review tests) |
| `tests/phase6d-bootstrap-function.test.ts`, `tests/phase6e-rate-limit.test.ts` | harnesses gain the two new dependencies and a revocation-call counter; three assertions follow the new call pattern (local vs revocation verification, the index.ts call signature). No assertion was weakened |
| `scripts/migration-baseline.json` | unit baseline 29 files / 616 tests |
| docs | this file; update notes in `PHASE6E_RATE_LIMIT_AND_QUOTA.md`, `PHASE7_SUPABASE_TRANSPORT.md`, `MIGRATION_CHECKPOINT.md` |

No SQL, no migration, no config change.

## 7. Review of the "cheap local token check" (what it really verifies)

**Question:** is `verifyIdToken(token, false)` genuine Firebase verification with trusted keys, or only a decode? **Answer: genuine verification.** Evidence from the real `firebase-admin@13.10.0` source (the version Deno resolves for `npm:firebase-admin@13`) and from running the real library:

| Property | Where it is enforced | Evidence |
|---|---|---|
| Signature, with trusted keys | `lib/utils/jwt.js` `PublicKeySignatureVerifier` calls `jsonwebtoken.verify(token, key, { algorithms: [RS256, ES256] })`. Keys come from the fixed URL `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com` (cached per its `max-age`), selected by the token's `kid`; the token cannot name its own key source | source read; probe: a token signed by an attacker key with a REAL Google `kid` is rejected; an unknown `kid` is rejected |
| Accepted algorithm | `lib/auth/token-verifier.js` `verifyContent`: header `alg` must equal `RS256` (and a `kid` must be present) | probe: `alg: none`, HS256 "algorithm confusion" (public certificate used as the HMAC secret) are rejected |
| Audience | `payload.aud` must equal the app's project id | probe: wrong audience rejected; the app is initialised with `projectId: sa.project_id`, which the function requires to equal `FIREBASE_PROJECT_ID` |
| Issuer | `payload.iss` must equal `https://securetoken.google.com/<project id>` | probe: wrong issuer rejected |
| Expiry | `jsonwebtoken` rejects an expired `exp` (no clock tolerance, no `ignoreExpiration`); mapped to `auth/id-token-expired` | probe: expired token rejected (a forged-and-expired one fails earlier, on the signature) |
| Subject | non-empty string, at most 128 characters | probe: empty `sub` rejected |

The probe (`denoattack/attack.ts`, scratch only, not committed) built 11 forged tokens and ran the real library: **all 11 rejected** (unsigned `alg: none` twice, attacker RS256 with an unknown kid, attacker RS256 with a real kid, HS256 confusion, wrong audience, wrong issuer, expired, empty `sub`, missing `kid`, not a JWT). It fetched only the public certificate list and used no credential. The positive case (a genuine token is accepted) is not repeated here: it was proven against production with the dedicated Google account (smoke tests B to F), and the local call is the same code minus the revocation step (`base-auth.js`: `if (checkRevoked || isEmulator)`).

**What the handler trusts.** Only the object the SDK returns after verification. The handler contains no base64, `atob`, `JSON.parse` or dot-splitting (asserted by a test); the only value taken from the request is the opaque bearer string, handed to the SDK twice; `role`, `uid`, `iss`, `aud`, `sub`, `iat` are read from the verified object; the handler additionally compares `iss`/`aud` with the configured project and requires `sub == uid`. The decision "established user" is made from the `role` claim of the **signature-verified** token, so an unverified or forged claim cannot select the established path, and no limiter key comes from the request (asserted by a test).

**One genuine hazard found and closed.** In the same source, `useEmulator()` reads `process.env.FIREBASE_AUTH_EMULATOR_HOST`; when it is set, `verifyIdToken` switches to `EmulatorSignatureVerifier`, which accepts **unsigned (`alg: none`) tokens**. Nothing sets it in production (the project has only the three custom secrets and the platform defaults), but a stray environment variable would silently disable signature checking. `parseConfig` now returns `emulator-host-set` when the variable is non-empty, and `index.ts` passes the real environment value in, so the function answers 503 to everything and verifies nothing (tests: the config check, the 503 with zero verifications, and that `index.ts` wires the variable). Removing the check fails a test.

**Residual notes.** The SDK accepts `ES256` in the library call, but `verifyContent` requires an `RS256` header and Google publishes RSA certificates, so an ES256 token cannot verify. Key rotation: the SDK refreshes from Google's `max-age`; a fetch failure is surfaced as `auth/internal-error` (now a 503, not a verdict on the token).

## 4. Test evidence (this checkout)

| Check | Result (ran on this checkout) |
|---|---|
| New limiter and token-check tests | `tests/phase6e-limiter-fix.test.ts`: **30 / 30** (24 limiter + 6 token-check review tests) (first-time throttling with 429 / `Retry-After` 60 and 600, established users during throttling, invalid tokens, concurrency, IP mode, source order). Mutation-checked: restoring the old shared cap (7 tests fail), making the established path consume the first-time counter (5), dropping the established-path revocation check (2), and counting bad tokens against the budget (3) each failed tests, as did removing the emulator-host guard (1); all reverted. A separate probe ran the real `firebase-admin` against 11 forged tokens: all rejected (section 7) |
| Earlier handler tests (`phase6d-bootstrap-function`, `phase6e-rate-limit`) | 60 / 60 pass with only their harnesses adapted |
| Deno type-check of the real entry point (`index.ts`, real `firebase-admin@13`, isolated copy) | passes |
| `npm run migration:health` (full) | **HEALTHY**: unit 29 files / 616 tests (clean unlinked copy); Firestore rules 4 files / 64 tests, **PASSED ON RETRY** (the first attempt failed only in the known flaky `identity.test.ts` case; no rules or application code changed); typecheck clean; lint 0 errors / 75 warnings (unchanged); e2e 7 suites 203/203; `next build` succeeded |
| Local pgTAP | 327 / 327 (no SQL changed) |
| Local Supabase transport tests / shadow-reader integration | 16 / 16 and 14 / 14 |
| Production, deployed function, Vercel, Firebase, flags | untouched; function still version 1 |
| Not run | any production test of the fixed function (needs a redeploy, which needs approval); real-Firebase behaviour of the new 503 mapping |

## 5. Remaining limitations (not fixed, documented)

* **Garbage-token floods** cost Edge Function invocations (Free: 500,000 per month, verified in `PHASE6E_RATE_LIMIT_AND_QUOTA.md`) and log events. Function code cannot stop an invocation that already happened; only a platform or edge control in front of the function could, and none is available on the Free plan as far as is known. The function's own cost per junk request is negligible.
* **Memory limiters are per instance.** An attacker with valid role-bearing tokens spread across several instances gets a multiple of the per-account (120/min) and valve (600/min) limits. The valve is one shared bucket per instance: if abused with valid role-bearing tokens, established users on that instance get 429 for the rest of the minute (they retry). Abuse needs valid Firebase accounts (anonymous sign-up is currently disabled in production Firebase, so real Google accounts), which is what makes it costly; but it is a residual, not a cure.
* **The project-wide first-time budget (120/min) can still be exhausted** by 120 or more distinct valid accounts a minute, delaying NEW users' first bootstrap (established users unaffected). That is the deliberate trade-off against unbounded Admin API use.
* **Revocation on the established path costs a Firebase look-up per request** (bounded by the per-account limit and the valve). It is kept because the bridge's contract says a revoked or disabled account should not get a success; dropping it would reduce load but is a security-policy decision for the owner (the response grants nothing, but the client would proceed to refresh and fail later).
* **IP mode** keeps its documented weaknesses (header trust unverified; a shared campus address shares a bucket; established users from that address also count).
* **Not tested against real Firebase or the deployed platform**: the new revocation-error mapping (`auth/internal-error` and friends are inferred from the SDK, not observed), the real distribution of requests across instances, and the Retry-After values as seen by the client (the client reads status only and uses its own backoff).

## 6. Deploying this later (needs the owner's explicit approval; not done)

1. Review this document and the diff; commit.
2. `npx supabase functions deploy auth-role-bootstrap --project-ref ajfyyknqdqaptuuzbwnv --no-verify-jwt`. No migration, no secret, no config change is involved. Rollback: redeploy the previous commit (v1 behaviour) or delete the function.
3. Smoke tests with the dedicated Google test account (the local sign-in page used before): bootstrap succeeds; **150 sequential requests with the role-bearing token all return 200** (v1 would return 429 after about 30 if they hit one instance); a request with a garbage token is still 401; a second never-used account closes the still-open production per-account rate-limit test; a stale role-less token after the claim exists is 200.
4. Stop. Flags stay off.

---

## 8. Production deployment and smoke test (recorded after the fact)

The sections above describe the fix as reviewed and committed (`f08c412`). It was then deployed with the owner's explicit approval; this section records what was done and observed. No tokens, secrets or personal data are recorded here.

### 8.1 Deployment
* `auth-role-bootstrap` was deployed from `f08c412` (working tree clean, source byte-identical to the commit, emulator guard present) with `--no-verify-jwt`. Only that function was deployed. No migration, secret or configuration change was involved.
* Result: **ACTIVE, version 2** (it was version 1), `verify_jwt` false. Nothing was pushed; no flag, Vercel or Firebase setting changed; the backend is still Firebase.

### 8.2 Tests that need no account (12 requests, after the deployment)
| Test | Result |
|---|---|
| no Authorization; garbage bearer; well-formed but meaningless bearer; wrong auth scheme | **PASS** (401 each) |
| unsigned `alg: none` token with `role=authenticated` and correct `iss`/`aud` | **PASS** (401) |
| attacker-signed RS256 token with `role=authenticated` | **PASS** (401; body is only `{"success":false,"error":"invalid-token"}`) |
| OPTIONS from a foreign origin / from the production origin | **PASS** (403 without allow-origin / 204 with the exact allow-origin and POST) |
| POST from a foreign origin | **PASS** (403, no allow-origin) |
| GET | **PASS** (405) |
| a refused POST from the production origin | **PASS** (401, exact allow-origin, `no-store`) |

A forged `role=authenticated` claim therefore cannot select the established path in production.

### 8.3 Established-account smoke test (dedicated Google test account; UID safety check passed)
| # | Test | Result |
|---|---|---|
| 0 | token is for the production project (`iss`/`aud`), provider google; token carries `role=authenticated` | **PASS** |
| 1 | one established request: 200 `{"success":true}`, exact allow-origin, `no-store` | **PASS** |
| 2 | **150 sequential established-account requests, paced at about one per second** | **PASS**: all 150 returned HTTP 200, over 162 s (about 56 per minute); latency min 341 ms, median 820 ms, max 4483 ms; **no 429** |
| 3 | a garbage bearer immediately afterwards | **PASS**: 401 |
| 4 | an established-account request afterwards | **PASS**: 200 (not throttled by the garbage request) |
| 5 | unpaced burst of 150 from one account | **NOT RUN, deliberately** (it would legitimately reach the per-account limit of 120 per minute per instance, an unnecessary rate-limit event on production) |
| 6 | **first-time per-account rate limit with a second never-used account** | **NOT RUN**: needs the owner's separate authorization |

**Correction to section 6, step 3 above:** it said 150 sequential requests should all return 200. With the per-account limit of 120 per minute per instance, an unpaced burst of 150 from one account can legitimately receive 429. The test was therefore paced at about one request per second (about 56 per minute): below that limit, and nearly twice the old shared cap of 30 per minute that the fix removed. It passed.

### 8.4 What this does and does not establish
* **Established:** in production, established (role-bearing) requests at about 56 per minute from one account are all served, bad tokens are a cheap 401 that does not affect them, and forged role claims are refused. The first-time path still works from the earlier happy-path test (version 1), but was **not re-exercised on version 2**.
* **Not established:** production **first-time** per-account and project-wide throttling on version 2 (the 429 and `Retry-After: 600` path) has not been observed in production; it rests on unit tests, the real-database race test and the local pgTAP suite. Expiry behaviour, real revocation and disabled-user error strings, and the function logs are also still unverified in production.
* **How the run was carried out:** a local-only sign-in page (loopback, one-time key, UID safety check). Earlier attempts timed out without a hand-off; the diagnostic version showed every stage (page loaded, sign-in clicked, completed, Run clicked, callback received, test started) and the run completed when opened in Chrome. The earlier timeouts are most plausibly a link without its one-time key and the Brave default browser; that was not proven.
