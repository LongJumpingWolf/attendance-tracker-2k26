-- Phase 2B: pings. Schema only. No state-machine RPCs, no triggers (Phase 9).
-- MIGRATION_DECISIONS.md decision 2b: one table, legacy rows imported verbatim with a marker; strict limits live in RPCs.
--
-- Deliberately ABSENT (each would reject valid history):
--   * no foreign key on request_id  (V8: the friendship may have been removed, or the id may be a non-canonical duplicate)
--   * no item-count CHECK           (V1: R1/R2 allowed 9..12 items)
--   * no date-format CHECK          (V4: R1 allowed any string)
--   * no NOT NULL on created_at     (V6: missing/unpinned in older generations)
--   * no name-length CHECK          (V7)
-- `participants` is dropped: it was derived. Membership is from_uid = me OR to_uid = me.

create table public.pings (
  id           text primary key check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  from_uid     text not null,
  to_uid       text not null,
  from_name    text,
  to_name      text,
  request_id   text,                                    -- original requests/{id}; audit only, no FK
  class_date   text not null,                           -- original string as written ('YYYY-MM-DD' for new rows)
  items        jsonb not null check (jsonb_typeof(items) = 'array'),
  status       text not null check (status in ('asking', 'answered', 'processed')),
  created_at   timestamptz default now(),               -- nullable: legacy rows may lack it
  responded_at timestamptz,
  claimed_by   text,
  claimed_at   timestamptz,
  processed_at timestamptz,
  legacy       boolean not null default false,
  legacy_flags text[] not null default '{}',
  check (from_uid <> to_uid),                           -- never permitted by any rule generation
  check (legacy or cardinality(legacy_flags) = 0)       -- flags only make sense on legacy rows
);
comment on table  public.pings is 'pings/{id}. id is the original (client-chosen or Firestore auto) id.';
comment on column public.pings.class_date   is 'Text, not date: legacy values may not be YYYY-MM-DD (V4). Strict format enforced by the create RPC.';
comment on column public.pings.items        is 'Opaque-ish payload [{key,subjectId,name,t?,answer}]. Stored exactly as exported; never normalised by the schema.';
comment on column public.pings.request_id   is 'Original requests document id. Plain text, NO foreign key (decision 2b). Resolve through connection_aliases / pair lookup.';
comment on column public.pings.legacy       is 'True only for rows written under older rules. Set by the service-role import, never by clients.';
comment on column public.pings.legacy_flags is 'Which of V1..V12 apply, e.g. items>8, item-shape, date-format, no-created-at, request-missing, name-length.';

-- participant lookup / realtime filters (two subscriptions: from_uid=me and to_uid=me)
create index pings_from_idx on public.pings (from_uid);
create index pings_to_idx   on public.pings (to_uid);
