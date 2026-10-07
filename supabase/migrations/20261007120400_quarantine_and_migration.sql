-- Phase 2B: quarantine (decision 2b, rule 4) and the one migration-only table the plan names (section 12.2).

-- Records that are provably invalid or forged. Never live, never deleted, never repaired. Invisible to clients.
create table public.quarantined_records (
  id          bigint generated always as identity primary key,
  collection  text not null,                  -- original Firestore collection, e.g. 'pings'
  doc_id      text not null,                  -- original document id
  raw         jsonb not null,                 -- the complete original document
  reasons     text[] not null check (cardinality(reasons) > 0),
  exported_at timestamptz not null,           -- when the source was exported (createdAt later than this is impossible)
  created_at  timestamptz not null default now(),
  unique (collection, doc_id)                 -- re-importing the same export changes nothing
);
comment on table public.quarantined_records is 'Decision 2b. Narrow, evidence-based criteria only. An answered-but-unprocessed Ping here is reported separately by the import.';

-- Migration-only: shadow-run mismatches (Phase 6). Dropped at the end of the migration (Phase 13).
create table public.shadow_mismatch (
  id     bigint generated always as identity primary key,
  at     timestamptz not null default now(),
  domain text not null,
  key    text not null,
  detail jsonb
);
comment on table public.shadow_mismatch is 'MIGRATION-ONLY. Drop in the final cleanup phase.';
