# PHASE7_SUPABASE_TRANSPORT.md

Phase 7 preparation: the missing Supabase read/RPC transport. **Local work only.** Nothing was deployed, committed, pushed or applied; every production flag is OFF; Firebase is authoritative; no Vercel, Firebase, production data or schema change was made.

```
STATE
  Production backend: Firebase (NEXT_PUBLIC_BACKEND unset). Bridge and shadow flags: unset (OFF) in Vercel and .env.local.
  New code is reachable only when NEXT_PUBLIC_BACKEND=supabase AND NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE=true AND the Supabase
  URL/publishable key exist AND the bridge holds a token. None of that is set anywhere.
```

## 1. What was missing (from the readiness audit)

The adapter (`lib/backend/supabase/index.ts`) was written against a two-method `SupabaseTransport` (`rpc`, `select`), but no implementation existed, so `getBackend()` built the Supabase backend with a guard and **no transport**: every operation threw "not configured". The shadow writer is a separate, write-only client.

## 2. What was built

| File | Change |
|---|---|
| `lib/backend/supabase/transport.ts` (new) | `createFetchTransport({ config, fetch?, timeoutMs?, maxResponseChars? })` implementing `rpc` over `POST /rest/v1/rpc/<fn>` and `select` over `GET /rest/v1/<table>?select=*&<col>=eq.<value>`. No new dependency (plain `fetch`). Also `safeOrigin()` |
| `lib/backend/index.ts` | `buildSupabaseTransport()`; passed to `createSupabaseBackend` **only in the `supabase` branch**. A missing or unsafe configuration yields no transport, so the adapter still refuses as "not configured". The Firebase branch and its shadow wrapper are untouched |
| `tests/phase7-supabase-transport.test.ts` (new) | 38 unit tests with a fake `fetch` |
| `tests/local-supabase/transport-e2e.test.ts` (new) | 16 end-to-end checks against the **real local Supabase stack** (real PostgREST + the 12 migrations) |
| `vitest.local-supabase.config.mts` (new), `vitest.config.mts`, `package.json` | `npm run test:local-supabase`; the e2e folder is excluded from `npm test` (it needs the local stack, and the health command treats a skipped test as a failure) |
| `scripts/migration-baseline.json` | unit baseline 26 / 521 to 27 / 559 |

Not changed: the adapter, the guard, the bridge client, the Firebase adapter, the SQL, any existing test, any security check.

## 3. Behaviour and security properties

* Talks only to the configured origin: `https` required (plain `http` only for `localhost`/`127.0.0.1`/`[::1]`); no credentials, path, query or fragment in the URL; redirects are refused (`redirect: "error"`).
* **No anonymous fallback.** With no token, or a malformed one (wrong characters, CR/LF, too short), nothing is sent and the call fails as `unauthorized`. The token is read synchronously when the request is built.
* Names are validated (`^[a-z][a-z0-9_]{0,62}$`) for functions, tables and filter columns; filter values are URL-encoded, so a value cannot alter the path or add parameters.
* The token is only in the `Authorization` header; never in a URL, body, error or log. The transport has no `console` output.
* Responses: bounded (default 4 MB; a sync blob is under 900 KB) and a hard timeout (default 10 s) that holds even if `fetch` ignores the abort signal or the body never finishes.
* Error model: database answers are returned as `{ error: { code, message } }` (message truncated to 200 characters; `details`, `hint` and the body dropped) so the adapter maps the SQLSTATE; PostgREST JWT errors (`PGRST301/302/303`) are normalised to `PGRST301` (unauthorized); a 401/403 without a body becomes `42501`. Offline, timeout, `402` (quota restriction), `408`, `429`, gateway trouble and connection/resource classes (`08`, `53`, `57`, `58`) are thrown, so the adapter reports `unavailable` (retryable). A malformed 2xx body is a distinct, generic `unknown` error (`supabase-malformed`).
* A sync blob round-trips byte for byte (whitespace, CRLF, unicode), as required by the opaque-blob rule.

### A defect found and fixed by the real-stack test
PostgREST answers errors **raised by our own functions** with HTTP **500** and a normal body, for example sync_put's stale revision: `500 {"code":"40001","message":"revision conflict"}`. The first version threw on every 5xx, which would have turned a revision conflict into a retryable "unavailable". My fake-`fetch` tests had assumed 409 and could not see it; the local stack test did. A 5xx whose body carries a 5-character SQLSTATE (outside the transient classes) is now a database answer. Unit tests were added for both sides of that rule.

## 4. Verification (run on this checkout)

| Check | Result |
|---|---|
| New transport unit tests | 38 / 38 pass; mutation-checked (allowing a request without a token, allowing remote `http`, and leaking server details each failed tests; reverted) |
| Real local stack, `npm run test:local-supabase` | **16 / 16 pass**: profiles, sync (byte-exact blob, compare-and-set, cross-user), invites, connections, ping create / answer / lease / finalize-once / remove, push tokens; wrong issuer, wrong audience, missing issuer/audience, expired, wrong signature, `anon` role, empty `sub`, no token (nothing sent), direct table writes denied, limiter RPC denied, dead port = `unavailable`. Rows are cleaned up (0 left) |
| Wrong-issuer / wrong-audience reads | return nothing of the real data (fail closed); writes are refused with `unauthorized` |
| Full results (unit, typecheck, lint, build, rules, e2e, pgTAP) | see section 7 |

The end-to-end test signs its own tokens with the **local stack's development secret** and refuses any non-loopback URL; no production credential or URL is involved.

## 5. What this does NOT do (unchanged gaps)

| Gap | Status |
|---|---|
| Realtime | still "not live"; the session controller is not wired; no socket code |
| Shadow reads / reconciliation | the read-only reader and report are built and tested locally (Part 2, section 9); not used by the app, not run against production; nothing persists mismatches and there is no scheduled report or UI |
| Connections and pings are not mirrored by the shadow writer (6B) | unchanged |
| Pings and push promotion (Phases 9, 10) | not started |
| The transport has not touched production | by design; there is no production test of it |
| Bootstrap function: per-instance limiter (30/min, shared key when IP mode is off) applies to established users too | open; needs a code change, redeploy and re-test (readiness audit, finding A) |
| Production tests not run: per-account rate limit, expired token, revoked/disabled errors, function logs | open |
| Anonymous sign-up is disabled in production Firebase while `lib/social.ts` calls `signInAnonymously` | open owner question |

## 6. Stale documentation (superseded; history not rewritten)

| Document | Stale statement | Current truth |
|---|---|---|
| `MIGRATION_CHECKPOINT.md` sections 10 to 12 | function "NOT DEPLOYED"; guard "exists locally only (remote still has the original 10)" | function deployed (version 1) and guard + rate-limit migrations applied; see its section 13 |
| `PHASE6A_SHADOW_INFRASTRUCTURE.md` section 4 | the bootstrap endpoint "does not exist in production" | deployed on 2026-10-11 |
| `PHASE6D_PRODUCTION_BRIDGE_READINESS.md` | function under `supabase/proposed/`; guard "proposed" | moved to `supabase/functions/`; guard applied |
| `PHASE6E_PRODUCTION_PREFLIGHT.md` header | "not deployed" | later sections record the deployment |
| `MIGRATION_DECISIONS.md` footer | "AWAITING OWNER SIGN-OFF" | the decision lock was resolved in a later commit; the footer was not updated |
| `MIGRATION_PLAN.md` | statuses before Phase 6 (for example "Cloud Functions written, not deployed") | still true for **Firebase** functions; the Supabase side has moved on |

## 7. Results of the full verification

| Check | Result (ran on this checkout) |
|---|---|
| `npm run migration:health` (full) | **HEALTHY**: unit 27 files / 559 tests (clean unlinked copy); Firestore rules 4 files / 64 tests (first attempt); typecheck clean; lint 0 errors / 75 warnings (unchanged); e2e 7 suites 203/203; `next build` succeeded |
| `npm run test:local-supabase` | 16 / 16 pass (real local PostgREST), re-run at the end |
| Local pgTAP (`supabase test db`) | 327 / 327 pass (unchanged) |
| Production | not touched: no deploy, no SQL, no flag, no Vercel or Firebase change |
| Not run | any production test of the transport (by design); the open production tests listed in section 5 |

## 8. Exact next step (superseded by section 9.7)

See section 9.7.

---

# Part 2: the read-only shadow reader and reconciliation report

## 9. Shadow reader (local only, OFF by default)

```
STATE
  Firebase authoritative. NEXT_PUBLIC_SUPABASE_SHADOW_READ is unset everywhere (Vercel, .env.local, .env.local.example). Nothing calls the reader.
  No production system was contacted. Nothing was committed, pushed, deployed or enabled.
```

### 9.1 What it does
For the SIGNED-IN user only, it reads (never writes) the Firebase and Supabase copies of (a) the sync backup and (b) the profile name, and reports whether they agree. Firebase is the reference; the shadow can never win and nothing is repaired.

| File | Change |
|---|---|
| `lib/backend/shadow-read.ts` (new) | `createShadowReader`, `readSurface`, `formatShadowReadReport`, `verdict` |
| `lib/backend/flags.ts` | `parseShadowReadFlag`, `shadowReadEnabled` (`NEXT_PUBLIC_SUPABASE_SHADOW_READ`), independent of the write flags; `ShadowFlags` / `shadowFlags()` are unchanged |
| `lib/backend/index.ts` | `getShadowReader()`: returns `null` unless the read flag AND the bridge flag are exactly `true`, the Supabase configuration is present and safe, and Firebase is the selected backend. The Firebase side is created without the anonymous sign-in helper, so reading can never create a user |
| `tests/phase7-shadow-read.test.ts` (new) | 27 unit tests |
| `tests/shadow-integration/shadow-read.test.ts` (new), `vitest.shadow-integration.config.mts`, `package.json`, `vitest.config.mts` | 14 integration tests against the Firestore emulator and the local Supabase stack: `npm run test:shadow-integration` (excluded from `npm test`) |
| `tests/phase7-supabase-transport.test.ts` | one assertion updated: `buildSupabaseTransport()` now has three mentions (definition, supabase branch, the flag-gated `getShadowReader`), and the test now also checks that the flags are tested first |

### 9.2 Safety properties (all tested)
* **Read only by construction:** the reader receives `{ sync.get, profiles.getName }` built by `readSurface()`; no write method is reachable from it. The integration test snapshots Firestore documents and Supabase rows before and after, in every outcome and across repeated runs, and records every HTTP request: only `GET /rest/v1/syncs?...` and `POST /rest/v1/rpc/get_profile_name` (a stable read function) were made. A control proves the snapshots do detect a write.
* **One user:** only the current Firebase uid is ever read (asserted for every call on both sides); a neighbour's data present on both sides never appears in the report or in any request. If the account changes during a read or during the re-read, the whole result is discarded.
* **No data in the report:** statuses, revision numbers, lengths and a shortened uid (`Alic***`). Never the sync blob, a name, a token or the full uid; server error text is never included. The reader writes no logs.
* **Independent, off-by-default flag:** absent, empty, `false`, `1`, `yes`, `tru`, `TRUE-ish` and every other value are OFF; the write flags cannot turn it on and it cannot turn them on; it is read in one file only.

### 9.3 How outcomes are classified

| Outcome | Meaning | What to do |
|---|---|---|
| `match` | same revision and same stored text (or both absent); same name | nothing |
| `missing-in-supabase` | Firebase has it, the mirror does not | expected until the initial import has covered the account and mirror writes have run; if it persists after a soak, check the shadow-write diagnostics |
| `missing-in-firebase` | only the shadow has it | unexpected; Firebase wins; investigate a deletion or a write that bypassed Firebase |
| `revision-mismatch` + `supabase-behind` | the mirror lags (a write has not landed or failed) | usually transient; the reader re-reads once before reporting, so a `[confirmed]` entry that stays across runs means a failed mirror write |
| `revision-mismatch` + `supabase-ahead` | the shadow is ahead of Firebase | never expected; treat as serious (a write reached Supabase without Firebase) |
| `value-mismatch` | same revision, different stored text (lengths shown) or different name | serious: corruption or a transform bug; the revision is compared first, then the opaque text |
| `firebase-error` (unavailable, unauthorized, ...) | the authoritative read failed | inconclusive; nothing is concluded about the shadow |
| `shadow-error` unavailable / unauthorized / malformed / invalid / unknown | the Supabase read failed (offline, token refused, bad row, validation) | inconclusive; **never** treated as "missing" |
| skipped (`no-user`, `identity-changed`) | nobody signed in, or the account changed mid-read | nothing was reported |

Verdict: `clean` (both match), `differs` (a confirmed difference), `inconclusive` (any read failed).

Two design points worth knowing:
* **Auth probe first.** A token the database guard refuses makes a table read return zero rows (fail closed), which would look like "missing in Supabase". The profile read goes through an RPC that raises for such a token, so it runs first; if it is refused or unreachable, both domains are reported as a Supabase error and the sync table is not read at all (tested against the real stack with a wrong-issuer token).
* **Confirm before reporting.** The two reads are not simultaneous and mirror writes are asynchronous, so any difference is re-read after 750 ms; a difference that disappears is reported as a match (`rechecked: yes`).

### 9.4 How to generate a report
Today there is no UI and nothing in the app calls the reader. The report is produced by code:

```ts
import { getShadowReader } from "@/lib/backend"
import { formatShadowReadReport } from "@/lib/backend/shadow-read"

const reader = getShadowReader()            // null unless every flag and configuration condition holds
if (reader) console.log(formatShadowReadReport(await reader.run()))   // or inspect the typed result
```

* **Locally, now:** `npm run test:shadow-integration` (Firestore emulator + local Supabase) exercises every outcome.
* **In a controlled build (needs your approval, not done):** `NEXT_PUBLIC_SUPABASE_SHADOW_READ=true` together with the bridge flag and the Supabase URL and publishable key, then a developer panel or a temporary call as above.

Example (exactly as pinned by a unit test):

```
Shadow read, read-only. Reference: Firebase (authoritative). Account: Alic***. Re-read before reporting: yes.
  sync:    revision-mismatch (supabase-behind) [confirmed]: firebase rev 3, supabase rev 1
  profile: match
  verdict: differs
```

### 9.5 Verification (this checkout)

| Check | Result (ran on this checkout) |
|---|---|
| `npm run migration:health` (full) | **HEALTHY**: unit 28 files / 586 tests (clean unlinked copy); Firestore rules 4 files / 64 tests (first attempt); typecheck clean; lint 0 errors / 75 warnings (unchanged); e2e 7 suites 203/203; `next build` succeeded |
| Shadow reader unit tests | 27 / 27; mutation-checked: removing the auth probe, the redaction of the uid, the final identity check, or the re-read each failed tests (reverted) |
| `npm run test:shadow-integration` (Firestore emulator + local Supabase, real adapters and transport) | **14 / 14 pass**: match, new account, missing on each side, revision lag, value mismatch, refused tokens (wrong issuer, expired, forged signature), Supabase unreachable, a Firebase-side refusal, neighbour data never read, no writes to either backend (snapshots + request log), snapshot-sensitivity control, no side created. 0 leftover local rows |
| `npm run test:local-supabase` | 16 / 16 pass |
| Local pgTAP (`supabase test db`) | 327 / 327 pass (unchanged; no SQL changed) |
| Production / Vercel / Firebase settings / flags | not touched. Nothing committed, pushed or deployed |
| BLOCKED / not run | none of the required local suites were blocked. Not run by design: any production use of the reader

### 9.6 Remaining risks and gaps
* **Not run against production** (by design) and not proven against real Firebase Auth tokens in production; the production bridge happy path was verified earlier.
* **Narrow scope:** only the sync backup and the profile name, only for the signed-in user. Connections, pings, push tokens and invites are not compared (the shadow writer does not mirror connections or pings yet).
* **No history:** mismatches are not persisted (`shadow_mismatch` is unused), there is no scheduled or nightly report, and no UI. A soak needs someone or something to call the reader repeatedly and keep the results.
* **Costs on the Free plan:** each run is one `GET` and one RPC to Supabase plus the Firebase reads; a difference doubles that. Fine for occasional use; a fleet-wide scheduled run would need the quota analysis in `PHASE6E_RATE_LIMIT_AND_QUOTA.md`.
* **Open from the earlier audit:** the bootstrap function's per-instance limiter (finding A), production tests for rate limiting / expiry / revocation / logs, and the anonymous sign-up question.

### 9.7 Recommended next step
**Close the two cheap production-facing gaps before any soak:** (1) fix finding A in the bootstrap function (raise or bypass the per-instance cap for role-bearing tokens), redeploy with approval and re-test with the dedicated Google test account; (2) run the remaining production bridge tests (rate limit with a second never-used account, expiry, disabled user). Then, with approval, build a controlled preview build with `SHADOW_READ`, the bridge flag and `SHADOW_SYNC` on for the test account only, and read its report. A persistence and scheduling layer for reports (Phase 7's nightly report) comes after that.

---

## Update: finding A is fixed locally (not committed, not deployed)

The bootstrap function's shared per-instance limiter no longer throttles established users in the local source; see `PHASE6E_LIMITER_FIX.md`. The "Open from the earlier audit" item about that limiter in section 9.6 is therefore addressed in code but **not in production** (the deployed function is still version 1). The other items in 9.6 remain open.

---

## Update: finding A is fixed AND deployed (function version 2)

The limiter fix (`f08c412`) is deployed and was smoke-tested in production for the established-account path; see `PHASE6E_LIMITER_FIX.md` section 8. Still open from section 9.6: production tests of the first-time per-account rate limit, expiry, revocation and function logs; the anonymous sign-up question; and everything listed as "not built" above (Realtime, mirroring of connections and pings, persisted reconciliation).
