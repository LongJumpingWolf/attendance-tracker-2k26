-- Phase 2B: deny-by-default at the GRANT level. This is NOT RLS (that is Phase 3).
--
-- Supabase grants new public tables to anon and authenticated by default, which would expose them through the Data API
-- before any policy exists. Until Phase 3 adds RLS and RPCs, the API roles get nothing on these tables.
-- service_role and the table owner (used by migrations, the import and tests) are unaffected.

revoke all on table
  public.profiles,
  public.invites,
  public.connections,
  public.legacy_requests,
  public.connection_aliases,
  public.pings,
  public.push_tokens,
  public.syncs,
  public.quarantined_records,
  public.shadow_mismatch
from anon, authenticated;
