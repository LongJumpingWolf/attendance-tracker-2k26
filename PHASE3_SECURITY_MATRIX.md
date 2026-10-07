# PHASE3_SECURITY_MATRIX.md

How the deployed Firestore security boundary (`firestore.rules` at `3644948`, 64 emulator tests) is carried into the **local** Supabase schema. Nothing here is deployed or linked. Where documents disagree `MIGRATION_DECISIONS.md` wins. Test references are to `supabase/tests/database/security.test.sql` (S) and `supabase/tests/concurrency.sh` (C); assertion text is quoted from them.

## 1. Identity (the one assumption Phase 5 must satisfy)

Identity is **only** `auth.jwt()->>'sub'`, read through `app_private.current_uid()`. Nothing uses `auth.uid()` (it casts to uuid; Firebase uids are 28-character text). No write function takes the caller's uid as a parameter (asserted), and a token without `sub` is refused by every write function even if it carries an email or display name (asserted).

> **The future Phase 5 bridge must produce a JWT whose `sub` equals the Firebase uid and whose `role` claim is `authenticated`.** Not built, not tested here. These tests use hand-built claims of that shape. They prove the database model under the expected identity, not that Firebase tokens will be accepted (decision 1, spike S1 to S12).

## 2. Security matrix (client-facing)

Legend: **R** direct SELECT under RLS, **RPC** `SECURITY DEFINER` function, **none** no grant at all (RLS enabled, no policy), **svc** `service_role` / owner only.

| Resource | Class | SELECT | INSERT | UPDATE | DELETE | Who | Conditions | Supabase mechanism |
|---|---|---|---|---|---|---|---|---|
| profiles | client (via RPC) | none | RPC `upsert_profile` | RPC `upsert_profile` | none | caller, own row | name 1..40; read = one name by exact uid | RLS on, no grant. `get_profile_name(uid)`: no directory |
| invites | client (via RPC) | none | RPC `create_invite` | none | RPC `delete_invite` | caller (owner) | token `^[A-Za-z0-9_-]{16,64}$`, 1..1440 min, server-clock expiry, never overwrites | RLS on, no grant. `get_invite(token)` returns owner, name, expiry, `expired` (server clock) |
| connections | client | R: either participant | RPC `send_request` | RPC `respond_request` | RPC `remove_request` | participants | from = JWT; recipient-only respond while pending; one active pair per two people | RLS select policy + unique partial index |
| legacy_requests | server-only | none | svc | svc | svc | import | verbatim archive | RLS on, no grant |
| connection_aliases | server-only | none | svc | svc | svc | import | read inside `remove_request` / `create_ping` by the definer | RLS on, no grant |
| pings | client | R: either participant | RPC `create_ping` | RPC `answer_ping`, `lease_ping`, `finalize_ping` | RPC `remove_ping` | see section 4 | state machine, server clock | RLS select policy + RPCs with row locks |
| push_tokens | client | R: owner | RPC `save_push_token` | RPC `save_push_token` | RPC `delete_push_token` | owner | token 1..4095, device id, max 20 devices | RLS select policy + RPCs. Edge Functions read with `service_role` later |
| syncs | client | R: owner | RPC `sync_put` | RPC `sync_put` | none (no path) | owner | compare-and-set on `rev`; blob < 900000 bytes, never parsed | RLS select policy + RPC |
| quarantined_records | server-only | none | svc | svc | svc | owner of the project | | RLS on, no grant |
| shadow_mismatch | migration-only | none | svc | svc | svc | migration tooling | dropped at the end | RLS on, no grant |

**Client-accessible production tables:** profiles, invites (RPC only), connections, pings, push_tokens, syncs. **Migration-only:** shadow_mismatch. **Server-only:** legacy_requests, connection_aliases, quarantined_records.

Verified directly from the local catalog: RLS on 10 of 10 tables; `anon` holds no grant anywhere; `authenticated` holds SELECT on exactly 4 tables and no INSERT/UPDATE/DELETE/TRUNCATE on any; 4 RLS policies (all SELECT, `to authenticated`); 16 public functions, all `SECURITY DEFINER` with `search_path=""`, none executable by `anon` or PUBLIC, all executable by `authenticated`; of the private helpers only `current_uid()` is executable by `authenticated`.

## 3. SECURITY DEFINER justification

All 16 public functions are `SECURITY DEFINER` because clients have no write grant (and for profiles and invites no read grant) on the tables; the function is the only door, and it needs to set identity and timestamps from the server and take a row lock. Each pins `search_path = ''`, schema-qualifies every object, derives the caller from the JWT, and is granted to `authenticated` only (`REVOKE ... FROM public, anon, authenticated` then `GRANT ... TO authenticated`). Helpers `current_uid()` and `require_uid()` are `SECURITY INVOKER` (they only read the caller's own claim). The three Ping helpers are invoker functions only reachable through the definer functions (no grant). No service-role capability is exposed to a browser.

## 4. Firestore rule versus Supabase enforcement

### users/{uid}  -> profiles
| Firestore | Supabase | Test |
|---|---|---|
| any signed-in user can read; owner writes; name 1..40 | **intentional difference** (decision: no directory): no SELECT. `get_profile_name(uid)` returns one name for one exact uid. Owner writes through `upsert_profile`, name 1..40 | S "there is no profile directory", "a signed-in user can look up one name", "name over 40 refused", "one user's write never changes another's profile" |

### invites/{token}
| Firestore | Supabase | Test |
|---|---|---|
| `get` by any signed-in user, `list` denied | `get_invite(token)`; no table SELECT, so listing is impossible | "token listing is impossible", "can look up one invite by token" |
| create: owner == auth, `expiresAt is timestamp` (client clock) | **intentional difference:** owner = JWT; expiry = server `now()` + 1..1440 minutes; an existing token is never overwritten | "invite created; expiry comes from the server clock", "malformed token", "zero / absurd lifetime", "never overwritten" |
| delete: owner | `delete_invite`: owner only, missing = no-op | "non-owner cannot delete", "owner deletes" |
| expiry not enforced anywhere | `expired` is computed on the server clock in `get_invite`; no client value is trusted. Hard enforcement at accept time is not needed because invites are not consumed by the database | "expiry is judged on the server clock" |
| no update | no UPDATE path (no owner takeover) | "direct UPDATE (owner takeover) denied", "direct INSERT (forging an owner) denied" |
| **legacy:** old invites may lack names/created_at | importable as is (no CHECK) | "legacy invite with null name and null created_at is representable and readable" |

### requests/{id}  -> connections
| Firestore | Supabase | Test |
|---|---|---|
| read: participants | SELECT policy `from_uid = sub or to_uid = sub` | "participant reads only connections involving them", "unrelated user cannot read" |
| create: `from == auth`, `to != from`, names <= 40, status pending, key whitelist | `send_request(to, from_name, to_name)`: from = JWT, status pending, `created_at = now()`, no forging possible (no from parameter), names <= 40, `to <> from` | "sender is the caller and status is pending", "request to oneself refused", "name over 40 refused", "forged direct INSERT denied" |
| *(no uniqueness; the known race)* | **new-world rule:** one active (pending or accepted) pair in either direction: unique partial index, `23505` | "NEW duplicate active pair refused (same / opposite direction)" |
| update: only the asked person, only pending, only `status`/`respondedAt` | `respond_request(id, accepted|declined)`: recipient only, pending only, sets `responded_at = now()` | "sender cannot accept their own", "stranger cannot respond", "only accepted or declined", "cannot be answered twice", "direct UPDATE denied" |
| delete: either participant, any status | `remove_request(id)`: either participant; a legacy id resolves through `connection_aliases` to the canonical row; the archive is untouched; missing = no-op | "stranger cannot delete", "either participant can remove", "removing by a legacy id removes the canonical connection", "archived legacy document is untouched" |
| ids: Firestore auto-id | server-generated 32-hex id; imported rows keep their original ids | |
| `participants` array | dropped (membership = from or to) | |

### pings/{id}
| Firestore rule | Supabase enforcement | Test |
|---|---|---|
| read: participants | SELECT policy on `from_uid`/`to_uid` | "asker reads it", "receiver reads it", "unrelated user reads no Pings" |
| create: signed in, `from == auth` | `create_ping`: asker = JWT; no from parameter; direct INSERT denied | "direct INSERT of a forged Ping is denied", "forged asker" |
| create: `to != from`, `participants == [from,to]` | `to <> caller`; participants dropped | "a Ping to oneself is refused" |
| create: `connected(requestId)` accepted and both uids in it | caller and `to` must be the two ends of an **accepted** connection named by `p_request_id` (directly or via alias) | "forged receiver", "forged connection: it names a different pair", "... does not exist" |
| create: id `^[A-Za-z0-9_-]{8,64}$` | same pattern (also a table CHECK) | "the id has to be a plain token" |
| create: `createdAt == request.time` | `created_at = now()`; no timestamp parameter exists | "created_at is the server clock", "forged timestamps: direct UPDATE denied" |
| create: names string <= 40 | same | "a name over 40 is refused" |
| create: date `YYYY-MM-DD` and within [now-3d, now+1d] (UTC midnight) | same window, same UTC-midnight rule; impossible dates refused | "class day weeks ago", "far ahead", "impossible calendar date", "non-YYYY-MM-DD" |
| create: 1..8 items; key/subjectId strings; name <= 60; `t` string; `answer == null`; only 5 keys | `valid_new_items`: same, plus key/subjectId <= 200 chars, `t` <= 16 chars, whole payload <= 16 KB | ">8", "zero classes", "exactly 8 allowed", "born already answered", "extra field", "name over 60", "non-string subjectId" |
| create: status `asking` | set by the function | |
| retry with same id resolves to the existing Ping; different request under same id is refused | `create_ping` returns `existing` for the same logical request (checked first, so it still resolves after answering or after the connection ended), `23505` otherwise. Atomic `INSERT ... ON CONFLICT DO NOTHING` | "retry ... is the same Ping", "different request ... refused", C "double create leaves exactly one Ping" |
| answer: receiver only, `asking`, `now < createdAt + 3d`, `createdAt <= now`, items <= 8, connected, status answered, `respondedAt == now`, item count equal, only `answer` changes to yes/no | `answer_ping(id, items)`: same, on the row after `FOR UPDATE`. **Intentional difference (decision 2b rule 6):** "connected" is **pair-based** (an accepted connection between exactly from and to), not by the stored request id | "asker cannot answer", "stranger cannot answer", "only yes or no", "number of classes cannot change", "name / subject / key / time cannot change", "field cannot be added", "cannot be answered twice", "expired cannot be answered", "just inside its life can be answered", "cannot be answered once the connection has ended" |
| lease: asker, `answered`, free / same holder / 2 min elapsed on server clock, id pattern, `claimedAt == now` | `lease_ping(id, device)`: same; returns true/false (false = another device holds a live lease or not answered), `42501` for a non-asker | "only the asker can lease", "unanswered cannot be leased", "first device takes it", "second device cannot", "holder renews", "takeover after it has run out", C "lease race: exactly one device wins" |
| finalize: asker, `answered -> processed`, `processedAt == now` | `finalize_ping(id)`: same; second call returns `already`; unanswered `55000` | "asker finishes it", "second finalize is recognised", "unanswered cannot be finalized", C "finalize race" |
| processed is final | no function changes a processed row except `remove_ping` | "processed cannot be leased again / changed by an answer" |
| delete: participant, not while `answered` | `remove_ping`: same | "answer cannot be thrown away (asker / receiver)", "stranger cannot withdraw", "either person can withdraw", "processed can be cleared" |
| **legacy** (R1/R2 rows) | imported verbatim (`legacy`, `legacy_flags`); **cannot be answered** if > 8 items, no `created_at`, expired or future-dated; **can be leased and finalized** when answered; no FK so a removed request does not matter | "legacy 12 classes cannot be answered", "legacy with no created_at cannot be answered", "answered legacy Ping can be leased" and "finished" |

### pushTokens/{uid}  -> push_tokens
| Firestore | Supabase | Test |
|---|---|---|
| owner read/delete; create/update with token 1..4095 | owner SELECT policy; `save_push_token(token, device_id default 'legacy')`; `delete_push_token(device_id)` (null = all of the caller's). **Intentional difference (decision 3):** one row per device; max 20 devices per account | "owner reads their own", "another user reads none", "deleting 'all' removes only their own", "token of 4096 refused", "more than 20 devices refused" |

### syncs/{uid}
| Firestore | Supabase | Test |
|---|---|---|
| owner read | SELECT policy `uid = sub` | "owner reads the blob back byte-identical", "a non-owner reads nothing" |
| create: owner, `rev == 1`, data string < 900000 | `sync_put(0, data, updated_at)` -> rev 1; size measured in bytes (stricter) | "owner creates", "blob at the size limit refused" |
| update: owner, `rev == old + 1` | `sync_put(old, ...)` is an atomic compare-and-set; mismatch = `40001` | "owner updates", "stale revision refused", "creating over an existing sync refused", C "sync CAS" |
| delete: denied | no grant, no function | "DELETE of syncs is denied" |
| client-supplied owner | impossible: uid from JWT | "non-owner cannot update the owner's sync" |

### Everything else
Firestore's default deny maps to RLS enabled with no policy and no grant (legacy_requests, connection_aliases, quarantined_records, shadow_mismatch, and the write side of everything). Tests: "authenticated/anon cannot read/write legacy_requests, connection_aliases, quarantined_records, shadow_mismatch".

## 5. What RLS cannot express, and what is used instead

| Firestore capability | Why RLS alone cannot do it | Used instead |
|---|---|---|
| `diff().affectedKeys().hasOnly(...)` field-level immutability | RLS checks rows, not which columns or JSON elements changed | no UPDATE grant; RPCs that write only the intended columns; `valid_answer` compares each class with `answer` removed |
| `request.time` stamping | a client may insert any value | timestamps are `now()` inside the function; no timestamp parameter |
| `get()` of another document inside a rule | a policy cannot atomically lock and read another row | the RPC reads the connection in the same transaction |
| state-machine transitions and the lease | needs old and new row plus a lock | `FOR UPDATE` row locks in `answer/lease/finalize` |
| idempotent create by client-chosen id | n/a | `INSERT ... ON CONFLICT DO NOTHING` plus a same-request comparison |
| per-document profile `get` without `list` | RLS cannot allow one and deny the other | no SELECT; `get_profile_name` |

## 6. Intentional differences, in one place
1. No profile directory (decision).
2. Invite expiry on the server clock; token never overwritten.
3. One active request per pair (new data only; history is archived and aliased).
4. Ping answer uses a **pair-based** connected check (decision 2b rule 6); create still requires the named connection.
5. `push_tokens` per device with a 20-device cap (decision 3).
6. `sync_put` measures size in bytes; uses an explicit expected revision.
7. `create_ping` additionally caps key/subjectId at 200 chars, `t` at 16 and the payload at 16 KB (the rule had no such caps; none of the app's real data approaches them). The **HH:MM format of `t` is not enforced**, to match the deployed rule (decision 2b lists it as a legacy violation; tightening it is a later product decision).
8. Errors are SQLSTATE codes (`42501` not allowed, `22023` invalid input, `55000` wrong state, `P0002` not found, `23505` duplicate, `40001` revision conflict, `54000` limit) instead of `permission-denied`. The future repository layer must map them.

## 7. Legacy compatibility
New-world limits live only in the RPCs. Tables carry no CHECK that old rows violate, so every legacy shape from Phase 2B stays importable and readable by its participants. Legacy Pings are never made answerable by weakening a rule: 9 to 12 items, missing `created_at`, expired or future-dated rows cannot be answered, while answered ones can still be leased and finalized so no unapplied favour is lost.
