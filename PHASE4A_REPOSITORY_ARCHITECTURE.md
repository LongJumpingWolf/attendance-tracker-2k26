# PHASE4A_REPOSITORY_ARCHITECTURE.md

Phase 4A separates application code from the backend: **UI / domain -> repository contracts -> Firebase adapter**. Behaviour is unchanged. **Firebase is the default and the only active backend.** Supabase has a compile-safe, inactive skeleton and cannot be reached. The Firebase Auth bridge is not started and Firebase Auth is untouched.

## 1. Inventory of backend calls (before the refactor)

Traced by reading each caller, not by grep alone. "Offline" says whether the app needs it to work without a network (none do: the app is local-first, and every one of these fails soft).

### Sync (`syncs/{uid}`), caller `hooks/use-cloud-sync.ts` through `lib/cloud-sync.ts`
| Operation | Input -> output | Errors | Realtime | Sensitive |
|---|---|---|---|---|
| `cloudGet` | owner -> `CloudDoc` or null | throws; the hook turns it into a status | no | yes, the whole backup |
| `cloudPut` | owner, text, expected rev -> `{ok,rev}` / `conflict` / `unavailable` / `too-large` | every failure becomes `unavailable` | no | yes. Transaction compare-and-set on `rev` |
| `watchCloud` | owner, callbacks -> unsubscribe | listener restarted by `resilient`; `onLive(false)` | yes (one document) | yes |

### Profiles (`users/{uid}`), callers `use-social.ts` and `lib/identity.ts`
| `saveProfile` (rename; `announceProfile` after sign-in, errors swallowed) | `getProfileName` (look up a QR owner) |
|---|---|
| uid, name -> void; owner-only by rule | uid -> name or null; any signed-in user by rule (Phase 3 turns this into a one-name RPC) |

### Invites (`invites/{token}`), caller `use-social.ts`
`createInvite(uid, name, 15)` -> `{token, expiresAt}` (client clock, 18-char token); `readInvite(token)` -> owner, name, `expired`, `expiresAt` or null. No delete is called by the app (the contract has `remove` because the rules allow it).

### Connections (`requests/{id}`), callers `use-social.ts`, `lib/identity.ts`, `lib/social-session.ts`
`watchRequests(uid)` (live, `participants array-contains`), one-off list (the account-switch carry in `identity.ts`), `sendRequest` (non-idempotent `addDoc`), `respondToRequest` (`status`, `respondedAt`), `removeRequest` (`deleteDoc`). All security-sensitive (rules); realtime only for the watch.

### Pings (`pings/{id}`), callers `use-social.ts`, `lib/use-ping-processing.ts`
`watchPings(uid)` live; `createPing` (client-chosen id, retry resolves to the existing one); `answerPing`; `leasePing` (transaction, 2-minute server lease); `finalizePing` (`already` is success); `removePing`. The most security-sensitive surface. Writes are wrapped by `attempt()` (offline returns at once, nothing queued; 10 s "not confirmed").

### Push tokens (`pushTokens/{uid}`), callers `use-social.ts`, `lib/identity.ts`
`savePushToken` (one token per account, never fatal), `deletePushToken` (on account switch and sign-out, errors swallowed). The token itself comes from FCM (`lib/firebase.ts`, `lib/notifications.ts`), which is not part of the data backend.

### Auth: unchanged
`ensureSignedIn` (anonymous sign-in), `onAuthStateChanged` in `social-session.ts`, `linkWithCredential`, `signInWith*`, `signOut` in `account.ts` and `identity.ts`, FCM `getToken`. **Kept exactly as is.**

## 2. The contracts (`lib/backend/contracts.ts`)

Six focused interfaces plus one container:

| Interface | Methods |
|---|---|
| `CloudSyncStore` | `get(owner)`, `put(owner, data, expectedRev)`, `watch(owner, sub)` |
| `ProfileStore` | `save(uid, name)`, `getName(uid)` |
| `InviteStore` | `create(uid, name, minutes)`, `read(token)`, `remove(token)` |
| `ConnectionStore` | `watch(uid, sub)`, `list(uid)`, `send(me, to)` (returns the new id), `respond(id, status)`, `remove(id)` |
| `PingStore` | `watch(uid, sub)`, `create(p)`, `answer(id, items)`, `lease(id, deviceId, now?)`, `finalize(id)`, `remove(id)` |
| `PushTokenStore` | `save(uid, token)`, `remove(uid)` |
| `Backend` | `kind` plus the six stores. A bag of stores, not a service object |

Rules the contracts keep: they use the app's own types (`FriendRequest`, `Ping`, `PingItem`); **no Firebase, Firestore or Supabase type appears** (asserted by a test); timestamps leave as **milliseconds** (the adapter converts Firestore `Timestamp`; `null` while a write is pending is kept; `msOf` reads either); authentication is not in them.

**Subscriptions.** `Subscription<T> = { onData(value), onState?(live, error?) }` and `watch` returns an unsubscribe. `onData` carries the current state first and every later change. `onState(false, error)` means the feed stopped; the adapter restarts it, then `onState(true)` (the reconnect). A subscription never throws into the caller. The Firebase implementation is the existing `resilient()` wrapper (`lib/realtime.ts`, hash-protected and unchanged), so reconnect, back-off and "stop retrying on permission-denied" are exactly as before.

**Errors (`lib/backend/errors.ts`).** One `BackendError { kind, retryable, code }`:

| kind | meaning | Firebase codes | Postgres SQLSTATE (Phase 3) |
|---|---|---|---|
| `unavailable` (retryable) | offline, timeout, quota | unavailable, deadline-exceeded, cancelled, resource-exhausted, network-request-failed | none (transport errors) |
| `unauthorized` | signed out or not allowed | permission-denied, unauthenticated | 42501, PGRST301 |
| `conflict` | state changed under us | aborted, already-exists, failed-precondition | 23505, 40001, 55000 |
| `not-found` | | not-found | P0002 |
| `invalid` | the request is wrong | invalid-argument, out-of-range | 22023, 54000 |
| `unknown` | | anything else | anything else |

`code` keeps the backend's own code, so the existing readers of `error.code` (`resilient`'s "hopeless" check, anything comparing to `"permission-denied"`) behave as before.

## 3. Firebase adapter (`lib/backend/firebase/index.ts`)

`createFirebaseBackend({ db, ensureSignedIn? })`. This is now the **only file** that calls Firestore functions (plus `lib/firebase.ts`, which only creates the app and `getFirestore`). The code was moved, not rewritten: same documents (`syncs`, `users`, `invites`, `requests`, `pings`, `pushTokens`), same payload fields, same `runTransaction` compare-and-set, same lease transaction, same `serverTimestamp()`, same "refused overwrite means look at what is there" fallbacks in `create` and `finalize`, same listeners. Differences, all at the edge: timestamps are converted to ms, and failures are wrapped as `BackendError` (with the original `code`). The database is injected, so the emulator tests and the app share the code.

**Old module paths are kept as thin forwards** so nothing outside the adapter needed new signatures:
- `lib/social.ts` keeps the Firebase **Auth** code (`ensureSignedIn`, `socialConfigured`, link helpers) and forwards `saveProfile`, `watchRequests`, `sendRequest` and the rest to the adapter (each takes the optional `database`, as before).
- `lib/ping-server.ts` forwards `createPing(db, ...)` and the others, and re-exports `LEASE_MS`.
- `lib/cloud-sync.ts` keeps `pack`/`unpack`, the size check and the dev-server path, and now asks `getBackend().sync` for the three Firebase seams.

## 4. Supabase adapter (`lib/backend/supabase/index.ts`): inactive skeleton

- `createSupabaseBackend({ transport? })`. **No Supabase package is installed** (none is needed: the adapter depends on a two-method interface, `rpc` and `select`, that a future client will satisfy). Nothing creates a client, reads a URL or a key, or opens a connection.
- **Without a transport** (the only way the app builds it) every operation rejects with `BackendError(unauthorized, "Supabase backend not configured/authorized: ...", code supabase-not-configured)`. A test stubs `fetch` and `XMLHttpRequest` to throw and proves they are never called.
- **Realtime is not implemented:** a subscription immediately reports `onState(false, not-configured)` and returns a no-op unsubscribe.
- **With an injected fake transport** (tests only) each operation maps to the Phase 3 function it will call (`sync_put`, `send_request`, `create_ping`, `lease_ping`, ...), with arguments checked by tests. The owner is never sent (identity is the JWT `sub`); SQLSTATEs map to the error kinds above; a transport failure is `unavailable`. **This proves argument mapping only. It does not prove the identity bridge, which is not built (decision 1, Phase 5).**
- Variables a later phase will need, **documented, with no values anywhere in the repository**: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

## 5. Backend selection (`lib/backend/index.ts`)

One selector, `getBackend()`. One setting, `NEXT_PUBLIC_BACKEND`:

| Value | Result |
|---|---|
| unset, empty, `firebase` | Firebase (the default and production) |
| `supabase` (any case) | the inactive skeleton, which refuses every call: fail closed |
| anything else | `BackendError(invalid, "Unknown backend ...")`: never a silent fallback |

No other file checks the setting (a test scans for that), there is no UI setting, and Supabase variables being present changes nothing. `cloudKind()` (firebase / dev / none) still describes which Firebase-world sync is available and is unrelated to this selector.

## 6. The sync seam

`hooks/use-cloud-sync.ts` is **byte-identical** (it is hash-protected and its import line is asserted by a test). It still imports the same five names from `lib/cloud-sync`. Behind them, only the Firebase branch changed from inline Firestore code to `getBackend().sync.get / put / watch`. Fingerprinting, debounce, expected revision, conflict handling, three-way merge, restore points before merges, retry timers, `syncBase` after a confirmed write and offline behaviour all live in the hook and are untouched. `pack`/`unpack` and the pre-send size check stay in `cloud-sync.ts`.

## 7. The Ping seam

`ping-id.ts`, `ping-processing.ts`, `ping-apply.ts`, `pings.ts`, `ping-send.ts`, `ping-presentation.ts` (and so the deterministic id, the 8-class limit, the lease-then-apply-then-finalize order, retries, favour logic and presentation state) are unchanged. `use-social.ts` now calls `getBackend().pings.create / answer / lease / finalize / remove` instead of the Firestore functions, with identical arguments minus the database handle. Nothing in the domain layer knows these are Firestore operations.

## 8. Remaining direct Firebase usage (searched after the move)

| Where | What | Why it stays |
|---|---|---|
| `lib/backend/firebase/index.ts` | all Firestore calls | **the adapter** |
| `lib/firebase.ts` | `initializeApp`, `getFirestore`, FCM | app bootstrap and push token source |
| `lib/social.ts`, `lib/identity.ts`, `lib/account.ts`, `lib/social-session.ts`, `lib/use-social.ts` | **Firebase Auth** (anonymous and Google sign-in, link, switch, sign-out, `onAuthStateChanged`) | Auth is out of scope by instruction |
| `lib/identity.ts`, `lib/social-session.ts`, `lib/social.ts`, `lib/ping-server.ts` | `import type { Firestore }` only, in the signatures of the forwards | the emulator tests and the account-switch code pass a database handle. **No runtime Firestore call remains in them.** |
| `lib/use-social.ts` | `getAuth(app)` and `db` passed to `followIdentity`, `announceProfile`, `completeCarry` | the identity layer is Firebase-bound; its listeners are the same adapter underneath |
| `app/page.tsx`, `lib/notifications.ts` | FCM messaging (`getClientMessaging`, `getToken`) | notifications are unchanged by instruction |

Raw collection names (`"requests"`, `"pings"`, ...) appear **nowhere** outside `lib/backend` (asserted). Runtime `firebase/firestore` imports exist only in the adapter and `lib/firebase.ts` (asserted).

## 9. Known limitations

1. **The Firestore rules suite (64 emulator tests) could NOT be run in this environment: Java is not installed here, so the health check reports it BLOCKED.** It is the strongest guard on these exact code paths. Run `npm run test:rules` on a machine with Java before relying on this refactor. In its place: 41 adapter contract tests against a fake Firestore, and a **differential run** (below).
2. The identity layer (account switch, follow identity) still takes a Firestore handle and is Firebase-bound. In Supabase mode it would still use Firestore until the Auth bridge phase reworks it. Supabase cannot be activated, so nothing is exposed.
3. `cloudKind()` and the pre-send size check (800,000 bytes by Firestore's accounting) are Firebase-world. A real Supabase sync store will need its own limit (the RPC already refuses 900,000 bytes or more).
4. In supabase mode with Firebase keys present, sync reports "unavailable" rather than falling back to Firebase. That is the intended fail-closed behaviour.
5. Supabase `watch` is not implemented, and the Supabase `select` mapping for lists is unexercised against a real database.
6. Timestamps are now ms numbers where Firestore objects used to pass through. Every reader goes through `msOf`, which accepts both, and the differential run shows identical values.

## 10. How parity was checked

| Check | Result |
|---|---|
| Unit tests | 19 files, 304 tests pass (was 16 / 232; +72 new) |
| Adapter contract tests (Firebase, fake Firestore) | 41 pass: payloads, CAS, lease, finalize, listeners, errors |
| Supabase skeleton tests | not-configured on every op, no network, argument mapping, error mapping |
| Selection and architecture tests | default firebase, fail closed, Firestore only in the adapter |
| **Differential run** | the pre-refactor code (`HEAD`) and the new code ran the same scripted scenario (profiles, invite, request, Ping create, retry, refused overwrite, answer, lease race, finalize, remove, sync create/stale/next/offline, three live listeners) against the same fake Firestore: **every write, return value and listener delivery is byte-identical (879 lines)** |
| Typecheck, lint, build | clean; 0 lint errors and 75 warnings (unchanged); `next build` succeeds |
| E2E (Chrome) | 203 of 203 (same per-suite numbers). Note: e2e runs in local/mock mode (no Firebase keys), so it does not exercise the adapter |
| Firestore rules (emulator) | **BLOCKED: no Java.** Not run |

Deliberate edits to guards: `lib/identity.ts` changed (two Firestore calls became forwards), so its entry in `tests/migration-protected.json` was regenerated; the "no source mentions Supabase" invariant now allows `lib/backend/` only. `scripts/migration-baseline.json` raised to 19 files / 304 tests.
