-- Phase 2B: social core tables. Schema only: no RLS, no RPCs, no triggers (Phase 3 and later).
-- Governing documents: MIGRATION_DECISIONS.md (wins over MIGRATION_PLAN.md) decisions 1, 2a, 2b, 3.
--
-- Conventions
--   * User ids are Firebase uids stored as TEXT. Never uuid, never rewritten. Nothing uses auth.uid().
--   * Table CHECKs are limited to what EVERY historical row satisfies. Limits that old rows may violate
--     (name lengths, timestamps present, item counts) belong to the create RPCs (new-data invariants), not here.
--   * Genuine server timestamps are timestamptz and nullable where Firestore never validated them.

-- ---------------------------------------------------------------------------------------------------------------
-- profiles  <-  users/{uid}
-- ---------------------------------------------------------------------------------------------------------------
create table public.profiles (
  uid        text primary key,
  name       text not null check (char_length(name) between 1 and 40),
  updated_at timestamptz default now()
);
comment on table public.profiles is 'users/{uid}. Display name only. Readable only through a future RPC (no name directory).';

-- ---------------------------------------------------------------------------------------------------------------
-- invites  <-  invites/{token}
-- ---------------------------------------------------------------------------------------------------------------
create table public.invites (
  token      text primary key,
  owner      text not null,
  owner_name text,
  expires_at timestamptz not null,
  created_at timestamptz default now()
);
comment on table public.invites is 'invites/{token}. Old client-side expiry was weak: expires_at is stored as given; enforcement is a later RPC concern.';
create index invites_owner_idx   on public.invites (owner);
create index invites_expires_idx on public.invites (expires_at);

-- ---------------------------------------------------------------------------------------------------------------
-- connections  <-  requests/{requestId}   (accepted = a mate connection)
-- Keeps the ORIGINAL Firestore request document id. Exactly one live row per pair; historical duplicates live in
-- legacy_requests + connection_aliases (decision 2a), so this table never needs to hold two rows for one pair.
-- ---------------------------------------------------------------------------------------------------------------
create table public.connections (
  id           text primary key,
  from_uid     text not null,
  to_uid       text not null,
  from_name    text,
  to_name      text,
  status       text not null check (status in ('pending', 'accepted', 'declined')),
  created_at   timestamptz default now(),
  responded_at timestamptz
);
comment on table public.connections is 'requests/{id}. id is the original Firestore document id. No from<>to or name-length CHECK: legacy rows may violate them; the create RPC enforces them for new rows.';

-- New active pairs only: ignores declined rows, and is symmetric in (from, to) so A->B and B->A collide.
create unique index connections_active_pair_uq
  on public.connections (least(from_uid, to_uid), greatest(from_uid, to_uid))
  where status in ('pending', 'accepted');
create index connections_from_idx on public.connections (from_uid);
create index connections_to_idx   on public.connections (to_uid);

-- ---------------------------------------------------------------------------------------------------------------
-- legacy_requests: verbatim archive of non-canonical duplicate request documents (decision 2a, step 4)
-- ---------------------------------------------------------------------------------------------------------------
create table public.legacy_requests (
  id          text primary key,                 -- original Firestore request document id
  raw         jsonb not null,                   -- the complete original document, unaltered
  source      text not null default 'firestore:requests',
  imported_at timestamptz not null default now()
);
comment on table public.legacy_requests is 'Answers "which original Firestore request document did this row come from?" for every non-canonical duplicate. Never deleted, never altered.';

-- ---------------------------------------------------------------------------------------------------------------
-- connection_aliases: legacy request id -> canonical connection id
-- canonical_id is deliberately NOT a foreign key: removing a connection must not erase the trace of its aliases,
-- and a legacy Ping may name an id whose canonical row was later removed. Validated by migration checks instead.
-- ---------------------------------------------------------------------------------------------------------------
create table public.connection_aliases (
  legacy_id    text primary key references public.legacy_requests (id),
  canonical_id text not null,
  reason       text not null check (reason in ('D-1', 'D-2', 'D-3', 'D-4', 'D-5', 'D-6')),
  note         text,
  created_at   timestamptz not null default now()
);
comment on table public.connection_aliases is 'Decision 2a. reason is the duplicate kind D-1..D-6. canonical_id has no FK on purpose.';
create index connection_aliases_canonical_idx on public.connection_aliases (canonical_id);
