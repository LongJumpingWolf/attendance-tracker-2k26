# PHASE6A_SHADOW_INFRASTRUCTURE.md

Phase 6A is **infrastructure and code scaffolding only**.

```
CURRENT PRODUCTION STATE
  Firebase authoritative
  Supabase inactive
  Shadow writes disabled
  Auth bridge disabled
  No production data sent to Supabase
```

Nothing in this phase changes what the application does. No production Firebase or Supabase resource, secret, rule, function or environment variable was touched. The throwaway spike projects are not referenced anywhere in the repository.

## 1. What Phase 5 requires of production code

Taken from `PHASE5_AUTH_SPIKE.md` (verdict **GO WITH CONDITIONS**). The expired-token investigation is still open (see section 11), and nothing here assumes it passed.

| # | Requirement (from the spike) | Where it is prepared in 6A |
|---|---|---|
| 1 | A new user's first token has no `role` and runs as `anon`. Bootstrap first; no authenticated cloud work until it has finished (retry on failure). | `lib/backend/supabase-auth.ts` (`ensureAuthenticated`), `lib/backend/supabase/guard.ts` |
| 2 | Force-refresh the Firebase token after the bootstrap (`getIdToken(true)`), because the claim only appears on a newly issued token. | `createAuthBridge` |
| 3 | Explicit `realtime.setAuth(token)` before subscribing and after every token change (without it every event is `401`). | `Backend.realtimeAuth` seam, `bridge.onToken` |
| 4 | Refetch after every Realtime reconnect/resubscribe: missed Postgres Changes events are not replayed. | contract note only; Realtime is not implemented (6A) |
| 5 | Issuer/audience validation everywhere (the bootstrap checks `iss`/`aud`; every table needs `as restrictive` iss/aud policies, because Firebase signs all projects with the same keys). | server side, a later phase (the bridge never reads a token) |
| 6 | Production CORS allow-list on the bootstrap function (the spike allowed one fixed origin and never echoed `Origin`). | server side, a later phase |
| 7 | Rate limiting on the bootstrap function. | server side, a later phase; the client maps `429` to `rate-limited` |
| 8 | An explicit sign-out/revocation strategy: client sign-out does not revoke the refresh token, and access tokens stay valid up to one hour. | `bridge.reset()` on sign-out/account switch; server-side `revokeRefreshTokens` is a later decision |
| 9 | Firebase UIDs are `text`; use `auth.jwt()->>'sub'`, never `auth.uid()`. | already in the schema (Phase 2/3); the adapter never sends an owner |

## 2. The feature flag

`NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE` (`lib/backend/flags.ts`). **Default: off.** Only the exact value `true` (any case, spaces ignored) turns it on; unset, empty, `false` and every other value (including typos like `tru`) are off. It is read in exactly one place, there is no user-visible setting, and there is no runtime switch.

With the flag off:
- the bridge never calls Firebase Auth, never sends anything, never caches anything (`ensureAuthenticated()` returns `unavailable / disabled`);
- the Supabase guard refuses every call as `supabase-not-configured`;
- `getBackend()` is unchanged.

## 3. The bootstrap client (`lib/backend/supabase-auth.ts`)

`createAuthBridge({ enabled, identity, bootstrap })`. Not called by any application file.

- **Identity comes only from Firebase.** `identity.current()` returns the current Firebase user; the uid is only ever read from it. The public methods take **no parameters**: no uid, role, claim or token can be passed in (a test calls them with forged extras and proves they are ignored and never sent).
- **State model:** `idle`, `bootstrapping`, `authenticated`, `unavailable`, `unauthorized`, `error`, with a `reason` (`disabled`, `no-firebase-user`, or one of the five bootstrap errors).
- **Flow:** `getIdToken()` -> bootstrap -> `getIdToken(true)` -> `authenticated`. Concurrent calls share one attempt; an already authenticated user is not bootstrapped again.
- **Account switch:** if the Firebase uid changes (also in the middle of an attempt), nothing from the old attempt survives and the bridge goes back to `idle`, emitting a `null` token. The existing account-switch logic is untouched.
- **It never** decodes, builds or signs a JWT, holds a service account, imports Firebase, or talks to the Admin SDK (a test scans the source for all of these).
- **Anonymous mode is not touched.** "A Firebase user exists" does not mean "sync identity ready". The bridge only reports whether a Firebase user can talk to Supabase; the anonymous/Google distinction stays in `lib/identity.ts`, `lib/account.ts` and `lib/social-session.ts` (all hash-protected and unchanged). Anonymous behaviour and Google auth remain Firebase-only, and no Supabase sync happens.

## 4. The bootstrap contract

`bootstrapFirebaseIdentity(idToken, send)`: input is a Firebase ID token; output is `{ ok: true, refreshRequired: true }` or `{ ok: false, error }` with one of `unavailable`, `unauthorized`, `invalid-token`, `rate-limited`, `server-error`. It never throws and **reads only the HTTP status**, never the body, so server internals cannot reach the UI.

| Status | Error |
|---|---|
| 200 | success (refresh required) |
| 401 | `invalid-token` |
| 403 | `unauthorized` |
| 429 | `rate-limited` |
| 404, 408, 502, 503, 504, or the request failed (offline, CORS, timeout) | `unavailable` |
| anything else | `server-error` |

The fetch transport (`createFetchBootstrapTransport`) sends only `Authorization: Bearer <Firebase token>` and the publishable key to `/functions/v1/auth-role-bootstrap`, with no body. **That endpoint does not exist in production**; it is only built when the flag is on and the Supabase configuration is present.

## 5. Token handling and the Realtime seam

- `bridge.getToken()` returns a Firebase token only while the bridge is authenticated for the **current** Firebase user; otherwise `null`.
- `bridge.onToken(listener)` is called with each new token and with `null` when the bridge stops being authenticated (sign-out, account switch). It follows Firebase's own `onIdTokenChanged` so the hourly refresh is passed on.
- `Backend.realtimeAuth?: { setToken(token | null) }` (in `contracts.ts`) is the adapter-level seam for `realtime.setAuth`. The **Supabase** adapter implements it by handing the token to an optional transport method `setRealtimeAuth`; the **Firebase adapter is unchanged and has no `realtimeAuth`** (a test pins `lib/backend/firebase/index.ts` byte for byte). Current Firebase listeners behave exactly as before.
- Supabase Realtime itself is **not implemented**: a subscription still reports "not live" and never subscribes.

## 6. The Supabase authorization guard

`lib/backend/supabase/guard.ts`. Asked before **every** adapter operation. The adapter proceeds only if, in order:
1. the flag is on, 2. `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` exist, 3. the bridge is `authenticated` and holds a token for the current Firebase user.

Otherwise: `BackendError` (`supabase-not-configured` for 1 and 2; `supabase-unauthenticated` for 3, `unavailable` kind when the bridge is unavailable) and **nothing is sent**. A selected Supabase backend never falls back to anonymous Supabase access and never to Firebase. `getBackend()` always installs the guard. With no transport (the only way the app builds it today) nothing can be sent even if the guard passes.

## 7. The shadow-writer interface (`lib/backend/shadow.ts`)

Interface and a **no-op** only: `syncBlob`, `profile`, `connection`, `ping`, `pushToken`. `getShadowWriter()` always returns the no-op; **no application file imports the module** (a test scans for this), so no shadow write can be emitted. Rules recorded for the future implementation: the sync blob is opaque (never parsed, normalized or turned into relational rows), Supabase gets no authority over connections or Pings (these only mirror transitions Firebase already made, so a Ping can never be processed twice), and a writer never throws or rejects (`isolateShadowFailures` enforces it). The existing sync orchestration (`hooks/use-cloud-sync.ts`, `lib/cloud-sync.ts`) is unchanged: GET is one document per Google account, PUT is a conditional revision write.

## 8. The reconciliation model (`lib/backend/reconcile.ts`)

Pure, read-only comparison of the authoritative Firebase state against the Supabase shadow. Mismatch kinds: `missing-in-supabase`, `missing-in-firebase`, `value-mismatch`, `revision-mismatch`, `auth-mismatch`, `relation-mismatch`, `unexpected-record`. Helpers: `compareSync` (revision first, then the opaque text as a string), `diffCollections`, `checkOwner`, `compareRelation`, `buildReport` (authority is fixed to `firebase`). No function accepts a store, writer or handle, so it cannot overwrite Firebase; it creates no records; mismatch details never contain the sync blob. Persisting mismatches is a later phase.

## 9. Backend selection

Unchanged: `NEXT_PUBLIC_BACKEND` is read only in `lib/backend/index.ts`. Unset/empty/`firebase` -> Firebase (production default); `supabase` -> the Supabase adapter (guarded, refuses everything while the flag is off); anything else -> `BackendError(invalid)`, never a silent fallback. Phase 6A did not change the production environment.

## 10. Configuration (documented, no values anywhere)

| Variable | Meaning | Production state |
|---|---|---|
| `NEXT_PUBLIC_BACKEND` | `firebase` (default) or `supabase` | unset (Firebase) |
| `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE` | `true` enables the bridge | unset (off) |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | not set |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` key; access is decided by RLS/RPCs. **Renamed in 6A from the earlier `NEXT_PUBLIC_SUPABASE_ANON_KEY`**; the legacy anon JWT is no longer read. | not set |

No secrets are added. No spike-project value is present in the repository (the Phase 5 lab is outside it).

## 11. Open item carried from Phase 5

The genuine expired-token test is not fully resolved: an expired role-less Firebase token was rejected by the bootstrap function and denied protected data, but Supabase's own handling of an expired token **carrying `role=authenticated`** was still being re-tested when 6A was written. 6A does not rely on it; it must be settled before activation (below).

## 12. Exact activation conditions (none are met by this phase)

All of these, in order, in a later phase and each with explicit approval:
1. Phase 5 conditions closed, including the expired authenticated-token question and a fresh-Google-account run.
2. The bootstrap Edge Function deployed to the **production** Supabase project with the production CORS allow-list, rate limiting and the service-account secret set by the owner.
3. Restrictive `iss`/`aud` policies verified on the production tables.
4. `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` set for the production build.
5. A real shadow writer and Supabase transport built and tested (next phase), behind their own switch.
6. `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE=true` for a controlled build; `NEXT_PUBLIC_BACKEND` stays `firebase` during shadow operation.

## 13. Rollback

There is nothing to roll back in production: Phase 6A adds no behaviour. Later, shadow mode is switched off by removing `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE` (or setting it to anything but `true`) and rebuilding; the application is then byte-for-byte Firebase-only again. Firebase is never modified by the shadow layer, so no data needs restoring. To discard this phase: revert the Phase 6A commit.

## 14. What changed in this phase

| File | Change |
|---|---|
| `lib/backend/flags.ts` | new: the feature flag |
| `lib/backend/supabase-auth.ts` | new: bootstrap contract + auth bridge client |
| `lib/backend/supabase/guard.ts` | new: configuration reader (publishable key) + authorization guard |
| `lib/backend/shadow.ts` | new: shadow-writer interface + no-op |
| `lib/backend/reconcile.ts` | new: mismatch model |
| `lib/backend/contracts.ts` | optional `realtimeAuth` on `Backend`, `RealtimeAuth` type |
| `lib/backend/supabase/index.ts` | guard before every operation, `setAccessToken`/`setRealtimeAuth` transport options, `realtimeAuth`; config reader moved to `guard.ts` |
| `lib/backend/index.ts` | `getAuthBridge()`; the supabase branch installs the guard |
| `tests/phase6a-auth-bridge.test.ts`, `tests/phase6a-shadow.test.ts` | 45 new tests |
| `tests/backend-supabase-adapter.test.ts`, `tests/backend-selection.test.ts` | the config assertion and one env stub renamed to the publishable key (the old name is now also asserted unread) |
| `tests/migration-invariants.test.ts`, `tests/migration-protected.json` | `lib/backend/firebase/index.ts` added to the protected files (a strengthening) |
| `scripts/migration-baseline.json` | unit baseline raised to 21 files / 349 tests |

Not changed: Firebase adapter, Firebase rules, functions, Firebase Auth code, IndexedDB, attendance/merge/restore-point/Ping/notification logic, UI, environment variables.

## 15. Verification (run on this commit)

| Check | Result |
|---|---|
| Unit | 21 files, 349 tests pass (baseline was 19 / 304; +45 new, none removed or weakened) |
| Firestore rules (emulator) | 4 files, 64 tests pass |
| Typecheck | clean |
| Lint | 0 errors, 75 warnings (unchanged) |
| Build | `next build` succeeds |
| E2E (Chrome) | 203 of 203, per-suite numbers unchanged |
| Migration health command | HEALTHY: every baseline check passed |
| Local Supabase | `supabase db reset` applied all migrations; `supabase test db`: 228 of 228 pass |

**Zero production shadow traffic:** the flag is off and nothing in the application imports the shadow writer or the reconciliation model; the guard refuses every Supabase call while the flag is off; tests with `fetch` and `XMLHttpRequest` stubbed to throw prove no request is made; the production build contains no `supabase.co` URL; `.env.local` (git-ignored) contains no Supabase, backend or bridge variable, so `NEXT_PUBLIC_BACKEND` is unset (Firebase) and the bridge is off; no credentials were added; the Firebase adapter is byte-identical (hash-pinned).
