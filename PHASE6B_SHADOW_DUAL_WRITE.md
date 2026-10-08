# PHASE6B_SHADOW_DUAL_WRITE.md

Phase 6B adds the **capability** to mirror confirmed Firebase writes to Supabase. It is **switched off everywhere**.

```
CURRENT PRODUCTION STATE
  Firebase authoritative
  Supabase is not read and not selected
  Shadow flags: ALL OFF (sync, social, push)
  Auth bridge flag: OFF
  Production shadow traffic has NOT been enabled
  No production data has been sent to Supabase
  Rollback = turn the shadow flags off (or simply do not set them)
```

## 1. What now exists

| Piece | File | Role |
|---|---|---|
| Shadow flags | `lib/backend/flags.ts` | three OFF-by-default switches |
| Real shadow writer | `lib/backend/shadow-supabase.ts` | mirrors one confirmed write to one Supabase RPC, best effort |
| Firebase wrapper | `lib/backend/shadow-backend.ts` | runs the Firebase operation first, then starts the shadow without waiting |
| Diagnostics | `lib/backend/shadow-diagnostics.ts` | bounded in-memory record of outcomes; holds no data |
| Wiring | `lib/backend/index.ts` | wraps the Firebase backend only when every condition in section 3 holds |
| Interface | `lib/backend/shadow.ts` | (Phase 6A) gained `invite`; `getShadowWriter()` is still the no-op |

## 2. Flags (exact names; every default is OFF)

| Variable | Effect when exactly `true` | Default |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_SHADOW_SYNC` | mirror each confirmed sync write (opaque blob and its revision) | off |
| `NEXT_PUBLIC_SUPABASE_SHADOW_SOCIAL` | mirror profile names and invites | off |
| `NEXT_PUBLIC_SUPABASE_SHADOW_PUSH` | mirror the push token | off |

Anything other than `true` (unset, empty, `false`, `1`, a typo) is off. No flag has a user-visible setting. None of them is set in `.env.local` or `.env.local.example` (a test checks this). Connections and Pings have **no flag** because they are not mirrored (section 7).

## 3. When a shadow write can happen (all must hold)

1. `NEXT_PUBLIC_BACKEND` is Firebase (unset or `firebase`);
2. the domain's shadow flag is `true`;
3. `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE` is `true`;
4. `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` exist;
5. at the moment of the write, the account in the payload is the current Firebase user, and the Phase 6A bridge has an authenticated token for that user.

If 2, 3 or 4 fail, `getBackend()` returns **the unwrapped Firebase backend object itself** (same object as before 6B). If 1 or 5 fails, nothing is sent. Selecting `NEXT_PUBLIC_BACKEND=supabase` never enables shadow writes.

## 4. Failure isolation (the guarantees, each backed by tests)

- The Firebase operation runs first and its result, or its error, is returned **unchanged**. Only after it has succeeded is a shadow write started (a Firebase conflict, an offline failure or any thrown error starts none).
- The shadow is **never awaited** by the application: a put resolves while the shadow request is still pending.
- Nothing the shadow does can reach the caller: a thrown error, a rejected promise, a slow or hanging answer, a 4xx or 5xx, a non-JSON body, a missing or hanging authorization step. (Mutation-checked: making the wrapper await the shadow fails four tests.)
- A differential test runs the same scenario with the shadow off, working, failing, returning 500, unreachable and hanging: every Firebase write and return value is identical.
- Reads and subscriptions pass straight through; Supabase is never read (the writer only sends `POST /rest/v1/rpc/...`, and a test scans for any other call).
- Every request and the authorization step have a timeout (default 8 s), enforced even if `fetch` ignores its abort signal.
- Offline: the Firebase call fails exactly as before and no shadow write is started; a shadow write that finds the network down is only recorded as `failed/unavailable`.

## 5. What is mirrored, and exactly how

| Firebase operation (after it succeeds) | Supabase call | Notes |
|---|---|---|
| `sync.put(owner, data, expectedRev)` -> `{ok, rev}` | `sync_put(p_expected_rev = rev - 1, p_data = data, p_updated_at)` | `data` is the same string reference Firebase stored, sent unparsed; no owner is sent (the account is the JWT `sub`) |
| `profiles.save(uid, name)` | `upsert_profile(p_name)` | |
| `invites.create(uid, name, minutes)` | `create_invite(p_token, p_owner_name, p_minutes)` | the same token Firebase issued |
| `invites.remove(token)` | `delete_invite(p_token)` | |
| `pushTokens.save(uid, token)` | `save_push_token(p_token, 'legacy')` | the token is never written to diagnostics |
| `pushTokens.remove(uid)` | `delete_push_token('legacy')` | |

**Revision semantics.** Firebase moves the document from `rev - 1` to `rev`. The Supabase function increments by one, so `expected = rev - 1` makes the shadow copy end at the same `rev`. This only works once Supabase already holds `rev - 1`, which is what the initial import provides. Before that import, or if the copy has fallen behind, Supabase answers `40001` and the writer records `conflict`; it never forces a revision. If Supabase ever returns a revision other than Firebase's it is recorded as `conflict / rev-drift`. `updated_at` is the client time when the shadow write was started: the Firebase adapter does not expose the exact `updatedAt` it stored (and is hash-pinned), so that one field may differ by milliseconds. Reconciliation compares `rev` and the opaque text, not that field.

**Ordering and duplicates.** Writes for one account (and one invite) go out one at a time in the order Firebase confirmed them, so revision N + 1 can never overtake N. At most 20 wait per key; the rest are dropped and recorded (`dropped / queue-full`). Offering the same confirmed write twice is harmless: Supabase answers a conflict and it is recorded. There is no retry queue and nothing is persisted in 6B; a missed mirror is for reconciliation (Phase 7) to find.

**Pause on authorization trouble.** After the bridge or the authorization step fails, the writer stops attempting for 60 s (recorded as `skipped / cooldown`) instead of calling the bootstrap endpoint for every write.

## 6. Diagnostics

`shadowDiagnostics.snapshot()` returns the last 200 events and counts per outcome (`ok`, `conflict`, `failed`, `skipped`, `dropped`). An event holds only: time, domain, operation, the account as its first four characters plus `***`, outcome, a fixed reason word (`timeout`, `unavailable`, `http-4xx`, `http-5xx`, `unauthorized`, `rate-limited`, `conflict`, `rev-drift`, `cooldown`, `identity-mismatch`, `not-configured`, `queue-full`, `unsupported`, `invalid-rev`), the HTTP status and the duration. A test proves it never contains the blob, a name, a push token, a full uid, a header or a server message. Nothing in the UI reads it. Writing mismatches to `shadow_mismatch` is Phase 7.

## 7. Deliberately NOT implemented

- **Connections and Pings are not mirrored.** `send_request` generates its own id, so it cannot keep Firebase's request id (ids must never be regenerated), and `respond`/`remove` would fail for any connection created after the import. The plan (section 15) also forbids replaying Ping calls against Supabase's own state machine (timing and clock differences give false mismatches) and calls for a service-side upsert-of-current-state, which does not exist yet. The writer implements these two methods as `skipped / unsupported`, and the wrapper does not wrap `connections` or `pings`. Ping behaviour, leasing, application, notifications and push are untouched, and no second notification path exists.
- No initial import (see section 9), no shadow reads, no reconciliation (Phase 7), no Realtime promotion (Phase 8), no Ping promotion (Phase 9), no cutover.
- No change to IndexedDB, merge, backup/restore, attendance, scan, Ping processing/application, pack/unpack, `use-cloud-sync`, the service worker or the UI. The pinned files are byte-identical (a test re-checks every hash).

## 8. What was tested

`tests/phase6b-shadow-write.test.ts` (37 tests), all with an in-memory Firestore and a fake `fetch`: flags off by default and unset in the env files; same-object when off; no network with a flag but no bridge; skipped when no user; success path (request shape, no owner, Bearer token, POST only); profile, invite (same token) and push mirrors; revision drift; byte preservation (including quotes, backslashes, newlines, non-ASCII, a `gz1:` prefix) and `rev - 1` over five writes; unavailable, timeout, 400, 401, 429, 500, 503 with a non-JSON body, and a stale-revision conflict; non-blocking; guard that throws or hangs; a writer that throws or rejects (no unhandled rejection); a differential run proving Firebase writes and results are identical; Firebase conflict and offline error not mirrored; reads pass through; per-domain wrapping; duplicates, ordering, back-pressure, cooldown and the account-switch skip; diagnostics leak nothing; architecture (nothing outside `lib/backend` refers to the shadow code, write RPCs only, the wrapper awaits nothing).

One Phase 6A test was adjusted deliberately: "no application file uses the shadow writer" now allows `lib/backend/` to wire it (it still forbids every file outside `lib/backend`).

## 9. Next manual step (blocked on the owner)

The first shadow writes can only land on a Supabase project that already holds each account's current data at the same revision. That requires the **initial import** (plan section 14): a one-off, read-only export from Firebase and an idempotent, service-role import into the production Supabase project, run by the owner with a service-account key kept out of git. The repository has no approved import command, so none was written or run. Also needed before any flag is turned on: the bootstrap Edge Function deployed to production Supabase (CORS allow-list, rate limit, secret), restrictive `iss`/`aud` policies verified on production, and the Supabase URL and publishable key supplied to the build.

## 10. Rollback

Remove the shadow flags (or set them to anything but `true`) and rebuild: `getBackend()` returns the unwrapped Firebase backend again. Firebase is never modified by the shadow, so nothing needs restoring; the Supabase copy can be discarded or truncated and re-imported.
