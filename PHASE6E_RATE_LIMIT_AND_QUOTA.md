# PHASE6E_RATE_LIMIT_AND_QUOTA.md

Rate-limit design and Supabase Free-plan usage budget for the production auth bridge. **Nothing here is deployed or applied.** The new migration is local only.

```
VERIFIED  = read on an official Supabase page during this phase (fetched 2026-10-09; the pages show no "last updated" date)
MEASURED  = taken from this repository or the pre-guard backup
ESTIMATE  = my arithmetic from stated assumptions; not observed usage
UNKNOWN   = not found in official documentation or not observable without the dashboard
```

## 1. Rate limiting: what was built

Migration `supabase/migrations/20261009000200_bootstrap_rate_limit.sql` (local only; **not applied to production**; `db push --dry-run --linked` first, then owner approval).

| Piece | Design |
|---|---|
| Storage | `app_private.rate_limits (bucket, key, window_start, hits)`, primary key on the first three. `app_private` is not exposed by the Data API; RLS on, no policy, no grant to `anon`/`authenticated`/PUBLIC |
| Function | `public.bootstrap_rate_check(bucket, key, limit, window_seconds) -> boolean`. SECURITY DEFINER, `search_path=''`, schema-qualified, input validated (bucket in `uid`/`ip`/`global`; key 1..128; limit 1..100000; window 1..86400 s), EXECUTE revoked from PUBLIC/anon/authenticated and **granted to `service_role` only** |
| Counting | Atomic upsert (`insert ... on conflict do update hits = hits + 1`) in a fixed window. Concurrent callers serialize on the row. Refused calls are still counted, so probing is not free |
| Cleanup | 2 % of calls delete windows older than two days. No scheduler needed. Tested with a fixed random seed |
| Fail mode | If the counter is unreachable, the function answers 503 and does no Admin work (fail closed). A request whose token already carries the role needs no counter and still succeeds |

Layers in the function, in order:

1. **Per-instance memory** (secondary): cheap burst brake. Not shared across instances.
2. **Database, per client address**: only if the owner enables `CLIENT_IP_MODE` (see section 2). Key is a 32-hex SHA-256 prefix of the address; the address itself is never stored.
3. **Token verification with revocation checking.**
4. **Database, per verified account**: default 6 attempts per 10 minutes. The key is the verified `sub`, never a client value.
5. **Database, project-wide**: default 120 attempts per minute, counted only for requests that would reach the Admin API (accounts without the role). Existing users with the role never touch it, so exhausting it cannot lock out established users.

Thresholds are configuration, not code: `RATE_UID_PER_10MIN`, `RATE_GLOBAL_PER_MIN`, `RATE_IP_PER_MIN` (integers 1..10000; invalid values fail closed). Rationale: a legitimate account bootstraps once; 6 per 10 minutes tolerates retries (the client makes at most 3 attempts then pauses 30 s) and a few devices. 120 per minute lets a class of ~100 students onboard together; if more arrive at once they get 429, retry with backoff, and finish within a couple of minutes. Raise it if that is too tight.

## 2. Client IP trust: **blocker documented, IP limiting stays OFF**

| Question | Answer |
|---|---|
| Does official documentation say how `X-Forwarded-For` is set for Edge Functions? | Only that official examples read it (`x-forwarded-for`, first entry) to get a user IP. **No official statement** that the platform overwrites or strips a client-supplied value, or appends to it |
| `x-real-ip`, `cf-connecting-ip`, `forwarded` | not mentioned in official docs |
| Community evidence | one GitHub discussion (not official documentation): a maintainer said in 2022 the header was fixed to carry the client IP; a user reported in 2023 it is "not always set" |
| Built-in per-IP / per-function rate limiting for Edge Functions | **not established**; the official rate-limiting guide has you build your own (it uses Upstash and keys on the user id) |

Therefore the IP layer is **not claimed to be secure**. If a client can choose the value, a per-address limit would let an attacker lock a victim address (for example a whole campus) out of sign-up and fill the counter table with chosen keys. Default `CLIENT_IP_MODE=off`: the header is ignored entirely (tested: spoofed headers change nothing and no `ip` row is ever written). What still protects the project with the header untrusted: verified-account limits, the project-wide cap, per-instance memory, Firebase's own sign-up throttling (not verified here), and the fast path that makes established users free.

To turn it on safely (owner-approved, after deployment): send test requests with and without a forged `X-Forwarded-For` and look at which value the function actually sees (the smoke test in the runbook), then set `xff-first` or `xff-last` accordingly. If a forged value is honoured, leave it `off`.

Campus effect when enabled: many students share one public address. With the default 60 per minute per address, the 61st sign-in in a minute from that address is refused for the rest of the minute (tested). Raise `RATE_IP_PER_MIN` for a campus deployment.

Residual risks that remain either way: a determined distributed attacker who holds many valid Firebase accounts can exhaust the project-wide cap and delay new-user bootstraps (not established users). The cap is the deliberate trade-off between that and unbounded Admin API/quota consumption. Kill switches are in section 5.

## 3. Verified Free-plan limits

| Item | Free plan | Source |
|---|---|---|
| Database size | 500 MB per project | supabase.com/pricing; docs/guides/platform/org-based-billing |
| Egress | 5 GB (billed monthly) | same |
| Monthly active users | 50,000; third-party MAU 50,000 | same |
| Edge Function invocations | 500,000 (monthly) | same |
| Realtime concurrent peak connections | 200 | same; docs/guides/realtime/limits |
| Realtime messages | 2 million (monthly) | pricing; org-based-billing |
| Realtime messages per second / channel joins per second / channels per connection | 100 / 100 / 100 | docs/guides/realtime/limits |
| Realtime payload | broadcast 256 KB; Postgres change 1,024 KB | same |
| Storage | 1 GB | pricing |
| API requests | "unlimited" | pricing |
| Backups | not included (no point-in-time recovery) | pricing |
| Log retention | 1 day | pricing |
| Active free projects | 2 (paused projects do not count) | pricing; billing-faq |
| Compute | shared CPU, 500 MB RAM | pricing |
| Edge Function CPU time per request | 2 s (async I/O excluded) | docs/guides/functions/limits |
| Edge Function wall clock / request idle timeout | 150 s (Free) / 150 s | same |
| Edge Function memory | 256 MB | same |
| Edge Function bundle size | 20 MB (CLI) / 5 MB (server-side bundling) | same |
| Functions per project | 100 on Free | same |
| Secrets | max 100; name up to 256 characters; value up to 48 KiB; names may not start with `SUPABASE_` | same |
| Free-project inactivity | "Free projects are paused after 1 week of inactivity" | pricing |
| Quota exceeded | notification first; if it continues, restrictions can apply: pausing, **read-only database, HTTP 402 on all API requests**, no new projects; usage-based restrictions lift when the quota refills next billing cycle or on upgrading to Pro. No spend cap or charges on Free | docs/guides/platform/billing-faq; cost-control; troubleshooting/http-status-codes |

Not found in the pages read (so **UNKNOWN**): how a paused project is restored and for how long data is kept; what counts as "activity"; any per-IP or per-second Edge Function invocation limit; Edge Function request body size limit; the live dashboard usage of this project (the dashboard was not opened).

## 4. Usage budget

Assumptions are mine and labelled. Replace with real numbers from the dashboard once available.

**MEASURED:** the one production sync document is ~1.5 KB (its line in the backup is 1,530 characters); the server refuses a sync blob of 900,000 bytes or more; production holds 1 profile and 1 sync.

| Resource | Normal (ESTIMATE: 100 active users, 2 app sessions/day) | Conservative high (ESTIMATE: 2,000 active users, 3 sessions/day) | Verdict vs Free limit |
|---|---|---|---|
| Edge Function invocations (one bootstrap per session start once the bridge is on; the 3-attempt retry multiplies only failures) | ~6,000 / month (1.2 %) | ~180,000 / month (36 %); a retry storm of 3x would be ~540,000 and exceed it | fine normally; the failure cooldown (30 s) and bounded retries exist to keep storms below the limit |
| Rate-limit RPCs (non-fast-path only: new accounts and stale tokens) | ~ a few hundred / month | a few thousand / month | negligible |
| Rate-limit table size (~100-150 bytes per row, rows kept 2 days) | < 100 KB | < 1 MB even at 10k rows | negligible; bounded by cleanup |
| Database size, typical sync (the one real document is 1.5 KB; assume 50 KB typical as data grows) | 100 x 50 KB = 5 MB | 2,000 x 50 KB = 100 MB (20 %) | fine |
| Database size, worst case (every user at the 900 KB cap) | 90 MB | 1.8 GB: **exceeds 500 MB at about 550 users** | the cap, not the user count, is the risk; watch average blob size |
| Egress from sync reads (a read returns the blob; assume 4 reads/day) | 100 x 4 x 50 KB x 30 = 0.6 GB (12 %) | 2,000 x 4 x 50 KB x 30 = 12 GB: **exceeds 5 GB** | the first quota likely to bind if shadow reads or cutover happen at scale; shadow writes are upload-only |
| Third-party MAU | 100 | 2,000 (4 %) | fine |
| Realtime (not implemented yet; each open app = 1 connection) | <= 100 concurrent | up to 2,000 concurrent: **exceeds 200** | the Realtime phase needs a plan for > 200 simultaneous users (for example fall back to polling above a threshold) |
| Realtime messages / month | far below 2 M | depends on ping volume; unknown | revisit in the Realtime phase |

The estimates ignore PostgREST request volume (stated as unlimited), logs and Auth refresh traffic.

## 5. Alerts, backoff and kill switches

| Item | Recommendation |
|---|---|
| Usage alerts | owner checks the dashboard usage page weekly during shadow operation; act at **70 %** of any quota (database 350 MB, egress 3.5 GB, invocations 350k, Realtime peak 140), and treat **90 %** as an incident. Whether Free projects get automatic emails at thresholds is not established in the pages read; do not rely on it |
| Client backoff | already bounded: 3 attempts, 500 ms base, 8 s cap, +25 % jitter, then a 30 s failure cooldown; 429 is retried like other transient errors |
| Server backoff | 429 carries `Retry-After` (not yet read by the client) |
| Kill switch 1 (client) | unset `NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE` and the shadow flags in Vercel and redeploy; Firebase never stopped being authoritative. Takes one deploy |
| Kill switch 2 (server, fastest) | blank `ALLOWED_ORIGINS` or delete the function: browsers get 503 / 404 and the client treats the bridge as unavailable. Whether a changed secret takes effect without redeploying is **not verified** |
| Kill switch 3 (database) | tighten `RATE_GLOBAL_PER_MIN` |
| Inactivity pause | with shadow traffic the project will be active; if the site is idle for a week the project may pause and every shadow write fails until it is unpaused (restoring is the owner's dashboard action; the procedure and data-retention terms were not found). Shadow writes are best effort and Firebase is unaffected |
| Quota exceeded | HTTP 402 / read-only: shadow writes fail and are recorded; Firebase unaffected. After cutover this would be an outage, which is why Free-plan capacity must be re-reviewed before any cutover |

## 6. Verification of this phase

See `PHASE6E_PRODUCTION_PREFLIGHT.md` "Update: deployment hardening" for the test results.
