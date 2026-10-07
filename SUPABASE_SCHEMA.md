# SUPABASE_SCHEMA.md

The PostgreSQL schema for the Firebase to Supabase migration, as built in Phase 2B. **Local only**: applied to the local Docker database, never to a hosted project. No RLS, RPCs, triggers, application code or data exist yet.

Governing documents: `MIGRATION_DECISIONS.md` (wins) over `MIGRATION_PLAN.md` section 12.2. Source of the migrations: `supabase/migrations/`.

## Rules the schema follows

1. **User ids are Firebase uids as `text`.** No uuid, no second identity system, nothing uses `auth.uid()`.
2. **Table CHECKs hold only what every historical row satisfies.** Anything an old row may violate (name lengths, item count, date format, timestamps present, `from <> to` on requests) is a new-data rule for the create RPCs, not a constraint, so the import can never be blocked by it.
3. **Nothing is merged, coerced or deleted by the schema.** Duplicates, quarantined and legacy records stay recoverable verbatim.
4. **Genuine server times are `timestamptz`**, nullable where Firestore never validated them. A column default of `now()` applies to new rows only; an import that supplies `NULL` explicitly keeps `NULL`.
5. **Deny by default at the grant level** (not RLS): `anon` and `authenticated` have no privileges on any table until Phase 3.

## Tables

Legend: PK primary key, FK foreign key, NN not null.

### profiles  (from `users/{uid}`)
| Column | Type | Notes |
|---|---|---|
| uid | text | PK, NN. Firebase uid |
| name | text | NN, CHECK length 1..40 |
| updated_at | timestamptz | default `now()`, nullable (old `updatedAt` was never validated) |

Authoritative: display name. Not readable as a directory (a future `get_profile_name` RPC only).

### invites  (from `invites/{token}`)
| Column | Type | Notes |
|---|---|---|
| token | text | PK, NN |
| owner | text | NN, owner uid |
| owner_name | text | nullable (never validated before) |
| expires_at | timestamptz | NN. Stored as given; the old client-clock expiry is not re-judged |
| created_at | timestamptz | default `now()`, nullable |

Indexes: `invites_owner_idx (owner)`, `invites_expires_idx (expires_at)` (purge). Token lookup is the PK.

### connections  (from `requests/{requestId}`; accepted = a mate connection)
| Column | Type | Notes |
|---|---|---|
| id | text | PK, NN. **The original Firestore request document id** |
| from_uid, to_uid | text | NN |
| from_name, to_name | text | nullable (copied names; legacy rows may lack or exceed 40) |
| status | text | NN, CHECK in `pending, accepted, declined` |
| created_at | timestamptz | default `now()`, nullable |
| responded_at | timestamptz | nullable |

Unique: `connections_active_pair_uq` on `(least(from_uid,to_uid), greatest(from_uid,to_uid)) WHERE status IN ('pending','accepted')`. It rejects a **new** active pair in either direction, ignores declined rows, and never conflicts with history because historical duplicates are not stored here (they are archived, below). Other indexes: `connections_from_idx`, `connections_to_idx` (membership, realtime filters).
Deliberately not constrained: `from_uid <> to_uid`, name length (legacy-tolerant; the RPC will enforce them).

### legacy_requests  (verbatim archive, decision 2a)
| Column | Type | Notes |
|---|---|---|
| id | text | PK. Original Firestore request id |
| raw | jsonb | NN. The complete original document |
| source | text | NN, default `firestore:requests` |
| imported_at | timestamptz | NN, default `now()` |

Answers "which original Firestore request document did this row come from?" for every non-canonical duplicate.

### connection_aliases  (decision 2a)
| Column | Type | Notes |
|---|---|---|
| legacy_id | text | PK, FK to `legacy_requests(id)` |
| canonical_id | text | NN. **No FK on purpose**: removing a connection must not erase the alias trace, and a canonical id may be gone |
| reason | text | NN, CHECK in `D-1 .. D-6` |
| note | text | nullable |
| created_at | timestamptz | NN, default `now()` |

Index: `connection_aliases_canonical_idx (canonical_id)`.

### pings  (from `pings/{id}`; decision 2b)
| Column | Type | Notes |
|---|---|---|
| id | text | PK, CHECK `^[A-Za-z0-9_-]{8,64}$` (every generation satisfied it) |
| from_uid, to_uid | text | NN; CHECK `from_uid <> to_uid` (no rule generation ever allowed otherwise) |
| from_name, to_name | text | nullable |
| request_id | text | nullable. Original `requests` id. **No foreign key** (V8) |
| class_date | text | NN. The original string; not cast to `date` (V4) |
| items | jsonb | NN, CHECK `jsonb_typeof = 'array'` only. No count, shape or normalisation (V1, V2) |
| status | text | NN, CHECK in `asking, answered, processed` |
| created_at | timestamptz | default `now()`, nullable (V6) |
| responded_at, claimed_at, processed_at | timestamptz | nullable |
| claimed_by | text | nullable (lease holder device id) |
| legacy | boolean | NN default false. Set only by the service-role import |
| legacy_flags | text[] | NN default `{}`. CHECK: non-empty only when `legacy` |

`participants` is dropped (derived): membership is `from_uid = me OR to_uid = me`. Indexes: `pings_from_idx`, `pings_to_idx`. **No foreign keys at all.**

### push_tokens  (from `pushTokens/{uid}`; decision 3)
| Column | Type | Notes |
|---|---|---|
| uid | text | PK part 1 |
| device_id | text | PK part 2. Existing tokens import as `legacy` |
| token | text | NN, CHECK length 1..4095 |
| updated_at | timestamptz | default `now()`, nullable |

The composite PK also serves the uid lookup. Several devices per uid are supported; the client still behaves one-per-account until a later change.

### syncs  (from `syncs/{uid}`)
| Column | Type | Notes |
|---|---|---|
| uid | text | PK |
| data | text | NN. **Opaque.** Never decompressed, parsed, normalised, reserialised, trimmed or padded |
| rev | integer | NN, CHECK `>= 1` |
| updated_at | bigint | nullable. The client `Date.now()` exactly as the old system stored it |

Byte-for-byte contract: `sha256(convert_to(data,'UTF8'))` must equal the source. Plain `text` is used (no `char(n)`, no `varchar`, no CHECK or trigger on `data`).

### quarantined_records  (decision 2b, rule 4)
| Column | Type | Notes |
|---|---|---|
| id | bigint | PK, identity |
| collection, doc_id | text | NN. UNIQUE together (re-importing changes nothing) |
| raw | jsonb | NN. Original document |
| reasons | text[] | NN, CHECK non-empty |
| exported_at | timestamptz | NN |
| created_at | timestamptz | NN, default `now()` |

### shadow_mismatch  (MIGRATION-ONLY)
`id` bigint identity PK, `at` timestamptz default `now()`, `domain` text, `key` text, `detail` jsonb. Named by plan section 12.2 for the Phase 6 shadow run. **Dropped in the final cleanup phase.** It lives in its own migration file (`20261007120400_quarantine_and_migration.sql`, together with quarantine).

## Authoritative versus derived

| Authoritative | Derived or dropped |
|---|---|
| everything above except as listed here | `participants` (dropped); "connected" (derived from accepted connections, pair-based); `legacy_flags` (derived by the import from the data, but stored) |
| `syncs.data`, the only attendance-bearing data, remains an opaque blob | Attendance itself stays authoritative on the device (IndexedDB), unchanged |

## Not in this schema, on purpose (and where they go)

- RLS, policies, per-user visibility: Phase 3.
- All RPCs (`upsert_profile`, `send_request`, `create_ping`, `answer_ping`, ... and the `health()` keep-alive function from decision 5): later phases. **No state-machine logic or triggers exist.**
- The defence-in-depth trigger of decision 2b: Phase 9.
- A client of any kind, imports, Edge Functions, Realtime publication settings.

## Local-only status

All of this exists only in the local Docker database and in `supabase/migrations/`. The repository is not linked to a hosted project (`supabase/.temp/project-ref` does not exist), nothing was pushed, and no production data was read or imported.

## Migration files

| File | Contents |
|---|---|
| `20261007120100_social_core.sql` | profiles, invites, connections, legacy_requests, connection_aliases |
| `20261007120200_pings.sql` | pings |
| `20261007120300_push_tokens_syncs.sql` | push_tokens, syncs |
| `20261007120400_quarantine_and_migration.sql` | quarantined_records, shadow_mismatch |
| `20261007120500_revoke_api_grants.sql` | revoke all from `anon`, `authenticated` on the ten tables |
