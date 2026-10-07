-- Phase 2B: push_tokens (decision 3: per device) and syncs (opaque blob).

-- ---------------------------------------------------------------------------------------------------------------
-- push_tokens  <-  pushTokens/{uid}
-- Schema is per device; the client keeps its one-token-per-account behaviour at cutover. Each existing
-- pushTokens/{uid} document imports as device_id = 'legacy'.
-- ---------------------------------------------------------------------------------------------------------------
create table public.push_tokens (
  uid        text not null,
  device_id  text not null,
  token      text not null check (char_length(token) between 1 and 4095),
  updated_at timestamptz default now(),
  primary key (uid, device_id)
);
comment on table public.push_tokens is 'Decision 3. PK (uid, device_id) also serves the uid lookup. device_id = ''legacy'' for imported single tokens.';

-- ---------------------------------------------------------------------------------------------------------------
-- syncs  <-  syncs/{uid}
-- `data` is an OPAQUE string ("gz1:" + base64(gzip(JSON)), or plain JSON). It must be copied byte-for-byte:
-- text type (no padding, no trimming), no CHECK that parses it, no trigger that touches it.
-- updated_at is the client's Date.now() exactly as the old system stored it (bigint), not a server timestamp.
-- ---------------------------------------------------------------------------------------------------------------
create table public.syncs (
  uid        text primary key,
  data       text not null,
  rev        integer not null check (rev >= 1),
  updated_at bigint
);
comment on table  public.syncs is 'syncs/{uid}. Compare-and-set on rev happens in a later RPC.';
comment on column public.syncs.data is 'Opaque. Never decompress, parse, normalise or reserialise. SHA-256 of convert_to(data, ''UTF8'') must equal the source.';
