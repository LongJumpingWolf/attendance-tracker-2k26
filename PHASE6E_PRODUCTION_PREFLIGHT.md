# PHASE6E_PRODUCTION_PREFLIGHT.md

Read-only preflight for the production auth bridge. **Nothing was deployed, applied, created, changed or enabled.**

```
STATE (verified in this phase)
  Branch migration/supabase, HEAD f668e6d, working tree clean at the start
  Remote database: 10 migrations applied; the guard migration is NOT applied
  Bridge Edge Function: not deployed. No secret set or changed. No export/import. All flags OFF (unset). Firebase authoritative.
```

## 1. Repository state

| Command | Outcome |
|---|---|
| `git branch --show-current`, `git log --oneline -3`, `git status --short` | `migration/supabase`; `f668e6d` (6D hardening), `3cfefea` (6D readiness), `f097e39`; **0 uncommitted files**. The intended 6D changes are all present |
| Read | `PHASE6D_PRODUCTION_BRIDGE_READINESS.md`, `PHASE6D_AUTH_HARDENING.md` (and, in earlier phases, the plan, decisions and Phase 5-6C reports) |

## 2. Production web origin

Commands (read-only; no variable values printed): `vercel domains ls`, `vercel alias ls --limit 100`, `vercel project inspect attendance-tracker-2k26`, `vercel ls --prod`, and an unauthenticated `HEAD`/`GET` of each candidate hostname.

* **No custom domain exists** (`0 Domains found`).
* The latest production deployment (age 2 d, status Ready) is aliased to exactly three hostnames:

| Hostname | HTTP result | Meaning |
|---|---|---|
| `attendance-tracker-2k26.vercel.app` | **200**, `<title>College Tracker</title>` | the public production site |
| `attendance-tracker-2k26-longjumpingwolfs-projects.vercel.app` | 302 | team alias; redirects (consistent with Vercel deployment protection; the redirect target was not followed or inspected) |
| `attendance-tracker-2k26-git-main-longjumpingwolfs-projects.vercel.app` | 302 | branch alias that follows `main`; same behaviour |

* The many per-deployment URLs (`attendance-tracker-2k26-<hash>-...vercel.app`) change on every deploy and must never be allow-listed. Other aliases in the account belong to unrelated projects.

**Conclusion.** The only publicly reachable production origin is **`https://attendance-tracker-2k26.vercel.app`**. This is the recommended single value for `ALLOWED_ORIGINS`. **The owner must still confirm it**, because (a) the 302s mean I could not see the other two as end users would, and (b) the owner may use a domain not visible to the CLI. Quick owner check: the origin that appears under Firebase > Authentication > Settings > Authorized domains and that Google sign-in works from. If a custom domain is added later, `ALLOWED_ORIGINS` must change with it.

## 3. Migration preflight

| Command | Actual outcome |
|---|---|
| `npx supabase migration list --linked` | local and remote match for the 10 migrations `20261007120100` ... `20261007130500`; `20261009000100` is **local only** (remote column empty) |
| `npx supabase db push --dry-run --linked` | "DRY RUN: migrations will not be pushed". **Would push exactly one migration: `20261009000100_firebase_issuer_audience_guard.sql`.** No seeds, no roles. `upToDate:false` |

Exactly as expected; nothing unexpected. The migration was not applied.

## 4. Local verification re-run for this phase

| Check | Result |
|---|---|
| `npx supabase test db` (local DB, 11 migrations) | 290 / 290 pass |
| `npm run test:unlinked` | 25 files, 496 / 496 pass |
| Not re-run (no code changed this phase) | rules, e2e, build, lint, typecheck: all passed at `f668e6d` in `migration:health` |

## 5. Security readiness review

Consistent with the tested design; no new defect found. Re-checked: the guard compares `iss`/`aud` exactly to `attendance-tracker-2k26` inside `current_uid()` (so RPCs and RLS inherit it) with four restrictive policies as backup; the function's `ORIGIN_RE` accepts `https://attendance-tracker-2k26.vercel.app`, rejects wildcards, http, paths and localhost, and fails closed if unset; the UID comes only from the verified token; the body is never read; a different pre-existing `role` is never overwritten; only fixed error words are logged or returned; direct writes and cross-user reads stay denied (pgTAP above).

Unresolved items, documented rather than bypassed:

| # | Item | Status |
|---|---|---|
| 1 | Rate limiting is per function instance only | Open; owner decision (section 6) |
| 2 | The function buckets by `x-forwarded-for`/`cf-connecting-ip`; whether Supabase's gateway sets/overwrites them trustworthily is **not verified** | Open; matters only for the IP limiter. Verify during the smoke test (send a spoofed header, observe the bucket) |
| 3 | Guard project id is hard-coded in the SQL | Matches `.firebaserc`; owner confirms |
| 4 | Fast path (token already carries the role) skips the revocation check | By design: nothing is written on that path |
| 5 | Realtime: no table is published, so Realtime authorization is untested beyond the spike | Out of scope until the Realtime phase |
| 6 | Untested production conditions: Firebase proactive token refresh against a real SDK, a real Realtime socket, fresh Google account with `isNewUser=true`, cross-project token with copied `sub` + role, sign-out while another session is active | Open; covered by smoke tests where possible |

## 6. Prerequisite checklist and recommended defaults

| Prerequisite | Status | Recommended default / what the owner does |
|---|---|---|
| `ALLOWED_ORIGINS` | candidate found (section 2) | `https://attendance-tracker-2k26.vercel.app` only. No previews, no deployment URLs, no wildcard |
| Firebase registered under Third-Party Auth (prod) | **unverified** (needs dashboard) | Supabase dashboard > Authentication > Third-Party Auth: add or confirm Firebase, project ID `attendance-tracker-2k26`. Without it every Firebase token is rejected |
| Service account | not created | A **dedicated** service account (not the export key). Needs only user read and claim update: `firebaseauth.users.get` and `firebaseauth.users.update` (the predefined role "Firebase Authentication Admin" includes them; a custom role with just these two is tighter). *Permission names are from memory of the Firebase IAM docs; confirm in the IAM console.* Token verification itself needs no permission |
| Secrets | none set | Names: `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_PROJECT_ID` (= `attendance-tracker-2k26`), `ALLOWED_ORIGINS`. Owner sets them in the Supabase dashboard (Edge Functions > Secrets) or with `supabase secrets set --env-file <file outside the repo>`; delete the key file afterwards; never paste into chat or git |
| Existing `role` custom claims on Firebase users | **unknown** | Needs an Admin read the repo cannot do. Default: accept the risk because the function refuses (403) any user whose `role` is something other than `authenticated`, so the failure is safe and visible. Optional: Claude drafts a read-only script for owner review, owner runs it with the service account |
| Rate limit | open | Free default: ship option A (per-instance, already in the function). Recommended follow-up when approved: option B (Postgres counter, one more migration; details in `PHASE6D_AUTH_HARDENING.md` section D). Trade-off: A is free but weak against distributed abuse; B is free and stronger but is a schema change plus a second secret. Check the current Free-plan Edge Function invocation quota in the dashboard (not verified here) because quota exhaustion is the realistic denial of service |
| Token revocation | open | Default: no revocation on ordinary sign-out; owner-run `revokeRefreshTokens(uid)` for security events; accept up to ~1 h of access-token validity plus a short unmeasured grace (S13) |
| Client refresh behaviour | implemented, off | 120 s pre-expiry margin, 3-attempt bounded retry, 30 s failure cooldown; only reachable when the bridge flag is on. Firebase's own proactive refresh is relied on and not yet exercised live |
| Unresolved security policy | none decided silently | rate limit, revocation and role-claim census stay with the owner |

## 7. Owner decisions and dashboard actions still required

**Decisions:** confirm the origin (section 2); confirm project id `attendance-tracker-2k26`; rate-limit choice; revocation policy; go/no-go to apply the guard migration; service-account role scope.

**Dashboard actions only the owner can do:** (1) Supabase Third-Party Auth registration; (2) create the dedicated service account and key in Google Cloud / Firebase; (3) set the three Edge Function secrets; (4) confirm Authorized domains in Firebase Authentication; (5) review the Free-plan Edge Function limits and set any usage alert.

## 8. Exact deployment sequence (for later, explicit approval of EACH stage)

1. **Re-verify:** `git status` clean; `npm run migration:health` HEALTHY; `npx supabase migration list --linked` and `db push --dry-run --linked` still show only `20261009000100`.
2. **Take a safety copy** of the production database schema/data (`pg_dump` or dashboard backup; the Free plan has no point-in-time recovery).
3. **Apply the guard:** `npx supabase db push --linked` (only this migration). Verify with `migration list --linked`. Because no production client presents a Supabase token yet, this changes no user-visible behaviour.
4. **Owner provisions secrets** (section 6).
5. **Commit the deployable copy:** copy `supabase/proposed/functions/auth-role-bootstrap/` to `supabase/functions/auth-role-bootstrap/`, add `[functions.auth-role-bootstrap]` with `verify_jwt = false` to `supabase/config.toml`; update the one test that asserts the function is not deployable, saying why. Commit.
6. **Deploy:** `npx supabase functions deploy auth-role-bootstrap --project-ref ajfyyknqdqaptuuzbwnv --no-verify-jwt`.
7. **Smoke tests** (14, listed in `PHASE6D_PRODUCTION_BRIDGE_READINESS.md` section 9), with one throwaway anonymous Firebase user, deleted afterwards; include the spoofed `x-forwarded-for` check from section 5 item 2.
8. **Stop.** Do not set `NEXT_PUBLIC_SUPABASE_*`, `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE` or any shadow flag; those belong to a separate shadow-activation phase.

## 9. Rollback

* Before step 3: nothing to roll back.
* Guard migration applied (step 3): run the down SQL in `PHASE6D_PRODUCTION_BRIDGE_READINESS.md` section 7 (drop the four `*_firebase_project` policies; restore the original `current_uid()` body), then record it as a corrective migration so history stays consistent. No data is affected.
* Function deployed (step 6): `npx supabase functions delete auth-role-bootstrap --project-ref ajfyyknqdqaptuuzbwnv`; `npx supabase secrets unset FIREBASE_SERVICE_ACCOUNT_JSON FIREBASE_PROJECT_ID ALLOWED_ORIGINS --project-ref ajfyyknqdqaptuuzbwnv`; disable and delete the service-account key in Google Cloud; optionally remove Firebase from Third-Party Auth to make the database refuse its tokens.
* Claims already written (`role=authenticated`) are harmless without the registration; an owner-run Admin script can strip them if wanted.
* Client: nothing to roll back while flags are unset; later, unset the flags in Vercel and redeploy.

## 10. Safety confirmation

Commands run were read-only: git inspection, `vercel domains/alias/project inspect/ls`, public `HEAD`/`GET` of three hostnames, `supabase migration list --linked`, `supabase db push --dry-run --linked`, and local tests. No deployment, no remote SQL applied, no secret created or printed, no export/import, no flag enabled, no change to Vercel or Supabase configuration, no Firebase change.
