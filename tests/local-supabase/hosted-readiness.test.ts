/**
 * Hosted-readiness checks that can be made WITHOUT contacting or changing production. LOCAL ONLY: everything runs inside the local
 * Supabase Postgres container, in throwaway databases that are created here and dropped at the end; the main local database is only
 * read from (and used for one clean test row). Nothing here reads a hosted secret or reaches a hosted service.
 *
 *   A. the 13 migrations replay cleanly, in order, on an EMPTY database; the last one (Realtime publication) changes the schema by
 *      exactly one line and is idempotent. (Production already has the first 12: see HOSTED_READINESS_PLAN.md.)
 *   B. a large sync document (the limit is just under 900 kB) still produces a change notification through the real Realtime path.
 *   C. the PROPOSED push outbox (proposals/push_outbox.sql, NOT a migration) behaves as designed: exactly-once enqueue from the
 *      Ping row, no push for legacy/imported Pings, no access for clients, disjoint concurrent claims, lease takeover, retry, and refusal
 *      of bad arguments.
 * Run with: npm run test:local-supabase
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { execFile, execFileSync } from "node:child_process"

import { createSupabaseBackend } from "@/lib/backend/supabase"
import { createPhoenixRealtimeTransport } from "@/lib/backend/supabase/realtime-transport"
import { createFetchTransport } from "@/lib/backend/supabase/transport"

const ROOT = path.resolve(import.meta.dirname, "../..")
const CONTAINER = "supabase_db_Attendance_tracker"
const run = Date.now().toString(36)
const pad = (s: string) => (s + "0".repeat(28)).slice(0, 28)
const MIGRATIONS = fs.readdirSync(path.join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort()

const psqlArgs = (db: string, extra: string[]) => ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-X", "-q", "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1", "-d", db, ...extra]
/** Runs SQL (stdin) in a database of the LOCAL container; returns trimmed stdout, throws with stderr on error */
function sql(db: string, text: string): string {
  try {
    return execFileSync("docker", psqlArgs(db, []), { input: text, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
  } catch (e) {
    const err = e as { stderr?: string }
    throw new Error((err.stderr ?? String(e)).trim())
  }
}
const sqlAsync = (db: string, text: string) =>
  new Promise<string>((resolve, reject) => {
    const p = execFile("docker", psqlArgs(db, []), { encoding: "utf8" }, (err, stdout, stderr) => (err ? reject(new Error(stderr.trim())) : resolve(stdout.trim())))
    p.stdin?.end(text)
  })
const fails = (db: string, text: string): string | null => {
  try {
    sql(db, text)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

const BOOT = `create publication supabase_realtime; create schema if not exists auth;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;`
const scratch: string[] = []
function freshDb(tag: string, upTo = MIGRATIONS.length, extraSql?: string): string {
  const db = `scratch_${tag}_${run}`
  scratch.push(db)
  sql("postgres", `create database ${db}`)
  sql(db, BOOT)
  for (const f of MIGRATIONS.slice(0, upTo)) sql(db, fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"))
  if (extraSql) sql(db, extraSql)
  return db
}
const dump = (db: string) =>
  execFileSync("docker", ["exec", CONTAINER, "pg_dump", "-U", "postgres", "-s", db], { encoding: "utf8", maxBuffer: 50_000_000 })
    .split("\n")
    .filter((l) => !/^\\(un)?restrict /.test(l))
    .join("\n")

beforeAll(() => {
  const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", CONTAINER], { encoding: "utf8" }).trim()
  if (out !== "true") throw new Error("the local Supabase database container is not running (npx supabase start)")
})
afterAll(() => {
  for (const db of scratch) {
    try {
      sql("postgres", `drop database if exists ${db} with (force)`)
    } catch {
      /* best effort: throwaway databases of this run only */
    }
  }
})

describe("A. the migrations replay cleanly (what a hosted push would run)", () => {
  it("there are exactly the 13 known migrations, in a strictly increasing order, the last being the Realtime publication", () => {
    expect(MIGRATIONS).toHaveLength(13)
    expect([...MIGRATIONS].sort()).toEqual(MIGRATIONS)
    expect(MIGRATIONS.at(-1)).toBe("20261011000100_realtime_syncs.sql")
    expect(MIGRATIONS.slice(0, 12).at(-1)).toBe("20261009000200_bootstrap_rate_limit.sql") // the newest one production already has
  })

  it("all 13 apply, in order, on an empty database", () => {
    const db = freshDb("all")
    expect(sql(db, "select count(*) from information_schema.tables where table_schema = 'public'")).toMatch(/^\d+$/)
    expect(sql(db, "select tablename from pg_publication_tables where pubname = 'supabase_realtime'")).toBe("syncs")
  })

  it("the 13th migration changes the schema by exactly one statement (the publication membership) and is idempotent", () => {
    const db = freshDb("twelve", 12)
    const before = dump(db)
    sql(db, fs.readFileSync(path.join(ROOT, "supabase/migrations", MIGRATIONS[12]), "utf8"))
    const after = dump(db)
    const added = after.split("\n").filter((l) => !before.split("\n").includes(l)).filter((l) => l.trim() !== "" && !l.startsWith("--"))
    const removed = before.split("\n").filter((l) => !after.split("\n").includes(l))
    expect(added).toEqual(["ALTER PUBLICATION supabase_realtime ADD TABLE ONLY public.syncs;"])
    expect(removed).toEqual([])
    sql(db, fs.readFileSync(path.join(ROOT, "supabase/migrations", MIGRATIONS[12]), "utf8")) // again: no error ...
    expect(dump(db)).toBe(after) // ... and no change
  })

  it("on a database without the Realtime publication it does nothing (no error)", () => {
    const db = `scratch_nopub_${run}`
    scratch.push(db)
    sql("postgres", `create database ${db}`)
    sql(db, "create schema if not exists auth; create or replace function auth.jwt() returns jsonb language sql stable as $$ select '{}'::jsonb $$;")
    for (const f of MIGRATIONS) sql(db, fs.readFileSync(path.join(ROOT, "supabase/migrations", f), "utf8"))
    expect(sql(db, "select count(*) from pg_publication")).toBe("0")
  })

  it("replaying the migrations twice fails loudly rather than half-applying (they are one-shot, which is why `db push` tracks them)", () => {
    const db = freshDb("twice", 1)
    expect(fails(db, fs.readFileSync(path.join(ROOT, "supabase/migrations", MIGRATIONS[0]), "utf8"))).toMatch(/already exists/)
  })
})

describe("B. a near-limit sync document still notifies through the real Realtime path", () => {
  it("a ~850 kB blob update produces a change notification (the client re-reads; the payload is never used as data)", async () => {
    const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: ROOT })
    const s = JSON.parse(out.slice(out.indexOf("{")))
    if (!["127.0.0.1", "localhost"].includes(new URL(s.API_URL).hostname)) throw new Error("refusing to run: the API URL is not loopback")
    const uid = pad(`BigDoc${run}`)
    const b64u = (x: Buffer | string) => Buffer.from(x).toString("base64url")
    const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))
    const body = b64u(JSON.stringify({ sub: uid, role: "authenticated", iss: "https://securetoken.google.com/attendance-tracker-2k26", aud: "attendance-tracker-2k26", exp: Math.floor(Date.now() / 1000) + 3600 }))
    const token = `${head}.${body}.${crypto.createHmac("sha256", s.JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`
    const rest = createSupabaseBackend({ transport: createFetchTransport({ config: { url: s.API_URL, publishableKey: s.PUBLISHABLE_KEY }, timeoutMs: 15000 }), guard: async () => token })
    const rt = createPhoenixRealtimeTransport({ config: { url: s.API_URL, publishableKey: s.PUBLISHABLE_KEY }, table: "syncs", filter: `uid=eq.${uid}` })
    rt.setAuth(token)
    let live = false
    let changes = 0
    const off = rt.subscribe({ onStatus: (st) => void (live = st === "subscribed"), onChange: () => void changes++ })
    try {
      await rest.sync.put(uid, "small", null)
      const t0 = Date.now()
      while (!live && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50))
      expect(live).toBe(true)
      const before = changes
      const big = "x".repeat(850_000)
      expect((await rest.sync.put(uid, big, 1)).ok).toBe(true)
      const t1 = Date.now()
      while (changes === before && Date.now() - t1 < 10000) await new Promise((r) => setTimeout(r, 50))
      expect(changes).toBeGreaterThan(before)
      expect((await rest.sync.get(uid))!.data.length).toBe(850_000) // and the normal read returns all of it
    } finally {
      off()
      try {
        execFileSync("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-X", "-q", "-c", `delete from public.syncs where uid = '${uid}'`], { stdio: "ignore" })
      } catch {
        /* best effort: this run's row only */
      }
    }
  })
})

describe("C. the PROPOSED push outbox (proposals/push_outbox.sql)", () => {
  const OUTBOX = fs.readFileSync(path.join(ROOT, "proposals/push_outbox.sql"), "utf8")
  const A = pad("OutAsker")
  const B = pad("OutMate")
  const C = pad("OutStranger")
  let db = ""
  const claims = (uid: string) => JSON.stringify({ sub: uid, role: "authenticated", iss: "https://securetoken.google.com/attendance-tracker-2k26", aud: "attendance-tracker-2k26" })
  const asUser = (uid: string, text: string) => sql(db, `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims(uid)}', true); ${text}; commit;`)
  const asRole = (role: "anon" | "authenticated" | "service_role", text: string) => sql(db, `begin; set local role ${role}; ${text}; commit;`)
  const count = (where = "true") => Number(sql(db, `select count(*) from public.push_outbox where ${where}`))
  const day = new Date().toISOString().slice(0, 10)
  const items = JSON.stringify([{ key: "m@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer: null }])
  const answered = JSON.stringify([{ key: "m@09:00", subjectId: "s1", name: "Maths", t: "09:00", answer: "yes" }])
  let connectionId = ""

  beforeAll(() => {
    db = freshDb("outbox", MIGRATIONS.length, OUTBOX)
    const lines = asUser(A, `select public.send_request('${B}', 'Asker', 'Mate')`).split("\n")
    connectionId = lines.find((l) => l.length > 5 && !/^(BEGIN|SET|COMMIT|set_config)/.test(l) && !l.includes("{")) ?? ""
    expect(connectionId).not.toBe("")
    asUser(B, `select public.respond_request('${connectionId}', 'accepted')`)
  })

  const createPing = (id: string, as = A) => asUser(as, `select public.create_ping('${id}', '${B}', 'Asker', 'Mate', '${connectionId}', '${day}', '${items}'::jsonb)`)

  it("creating a Ping enqueues exactly one 'incoming' event for the person asked, and a retry of the same request adds none", () => {
    createPing("ob-ping-0001")
    expect(sql(db, "select kind, recipient_uid, status, attempts from public.push_outbox where ping_id = 'ob-ping-0001'")).toBe(`incoming|${B}|pending|0`)
    createPing("ob-ping-0001") // a retry: 'existing'
    expect(count("ping_id = 'ob-ping-0001'")).toBe(1)
  })

  it("answering enqueues exactly one 'result' event for the ASKER; leasing and finalizing enqueue nothing", () => {
    asUser(B, `select public.answer_ping('ob-ping-0001', '${answered}'::jsonb)`)
    expect(sql(db, "select kind, recipient_uid from public.push_outbox where ping_id = 'ob-ping-0001' order by kind")).toBe(`incoming|${B}\nresult|${A}`)
    asUser(A, "select public.lease_ping('ob-ping-0001', 'device-0001')")
    asUser(A, "select public.finalize_ping('ob-ping-0001')")
    expect(count("ping_id = 'ob-ping-0001'")).toBe(2)
  })

  it("even if the Ping row passes through the same transition again (a replay, a repair), the event is not enqueued twice", () => {
    sql(db, "update public.pings set status = 'asking' where id = 'ob-ping-0001'") // as the table owner, bypassing the RPC rules: a maintenance replay
    sql(db, "update public.pings set status = 'answered' where id = 'ob-ping-0001'")
    expect(count("ping_id = 'ob-ping-0001'")).toBe(2)
    expect(count("ping_id = 'ob-ping-0001' and kind = 'result'")).toBe(1)
  })

  it("a refused attempt enqueues nothing (not connected / invalid)", () => {
    const before = count()
    expect(fails(db, `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims(C)}', true); select public.create_ping('ob-ping-0002', '${B}', 'S', 'M', '${connectionId}', '${day}', '${items}'::jsonb); commit;`)).toMatch(/not connected|violates|permission/i)
    expect(count()).toBe(before)
  })

  it("imported legacy Pings (service-role import, legacy = true) never enqueue a push, whatever their status", () => {
    const before = count()
    sql(db, `insert into public.pings (id, from_uid, to_uid, class_date, items, status, legacy) values ('legacy-ping-0001', '${A}', '${B}', '2026-01-01', '${items}'::jsonb, 'asking', true)`)
    sql(db, "update public.pings set status = 'answered' where id = 'legacy-ping-0001'")
    expect(count()).toBe(before)
  })

  it("clients have no access at all: anon and signed-in users can neither read, write, nor call the claim/finish functions", () => {
    for (const role of ["anon", "authenticated"] as const) {
      expect(fails(db, `begin; set local role ${role}; select * from public.push_outbox; commit;`), `${role} select`).toMatch(/permission denied/)
      expect(fails(db, `begin; set local role ${role}; insert into public.push_outbox (ping_id, kind, recipient_uid) values ('x', 'incoming', '${A}'); commit;`), `${role} insert`).toMatch(/permission denied/)
      expect(fails(db, `begin; set local role ${role}; update public.push_outbox set status = 'sent'; commit;`), `${role} update`).toMatch(/permission denied/)
      expect(fails(db, `begin; set local role ${role}; select * from public.push_outbox_claim(10, 60); commit;`), `${role} claim`).toMatch(/permission denied/)
      expect(fails(db, `begin; set local role ${role}; select public.push_outbox_finish(1, 'sent', null); commit;`), `${role} finish`).toMatch(/permission denied/)
    }
    expect(fails(db, `begin; set local role authenticated; select app_private.enqueue_ping_push(); commit;`)).toMatch(/permission denied|schema app_private/)
  })

  it("clients cannot make a Ping appear answered (so cannot forge a 'result' event) or change who it is for", () => {
    expect(fails(db, `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims(A)}', true); update public.pings set status = 'answered' where id = 'ob-ping-0001'; commit;`)).toMatch(/permission denied/)
    expect(fails(db, `begin; set local role authenticated; select set_config('request.jwt.claims', '${claims(B)}', true); update public.pings set to_uid = '${C}' where id = 'ob-ping-0001'; commit;`)).toMatch(/permission denied/)
  })

  it("two senders claiming at once never get the same row", async () => {
    sql(db, "delete from public.push_outbox")
    sql(db, "insert into public.push_outbox (ping_id, kind, recipient_uid) select 'bulk-' || g, 'incoming', 'u' from generate_series(1, 40) g")
    const claim = () => sqlAsync(db, "begin; set local role service_role; select id from public.push_outbox_claim(25, 60); commit;")
    const [x, y] = await Promise.all([claim(), claim()])
    const ids = (t: string) => t.split("\n").filter((l) => /^\d+$/.test(l)).map(Number)
    const a = ids(x)
    const b = ids(y)
    expect(a.length + b.length).toBe(40) // 40 due rows, all claimed ...
    expect(new Set([...a, ...b]).size).toBe(40) // ... none twice
    expect(count("status = 'claimed' and attempts = 1")).toBe(40)
  })

  it("a sender that dies loses its lease: after it runs out the row is claimable again (attempt 2); until then it is not", () => {
    sql(db, "delete from public.push_outbox")
    sql(db, "insert into public.push_outbox (ping_id, kind, recipient_uid) values ('lease-1', 'incoming', 'u')")
    expect(asRole("service_role", "select id from public.push_outbox_claim(5, 30)").split("\n").filter((l) => /^\d+$/.test(l))).toHaveLength(1)
    expect(asRole("service_role", "select id from public.push_outbox_claim(5, 30)").split("\n").filter((l) => /^\d+$/.test(l))).toHaveLength(0) // still leased
    sql(db, "update public.push_outbox set lease_until = now() - interval '1 second'")
    const again = asRole("service_role", "select id, attempts from public.push_outbox_claim(5, 30)").split("\n").filter((l) => /^\d+\|/.test(l))
    expect(again).toHaveLength(1)
    expect(again[0].endsWith("|2")).toBe(true)
  })

  it("finish: final outcomes are recorded once; retry delays the row; a row that is not claimed cannot be finished", () => {
    sql(db, "delete from public.push_outbox")
    sql(db, "insert into public.push_outbox (ping_id, kind, recipient_uid) values ('fin-1', 'incoming', 'u'), ('fin-2', 'incoming', 'u')")
    const ids = asRole("service_role", "select id from public.push_outbox_claim(5, 60)").split("\n").filter((l) => /^\d+$/.test(l)).map(Number)
    expect(ids).toHaveLength(2)
    asRole("service_role", `select public.push_outbox_finish(${ids[0]}, 'sent', null)`)
    expect(sql(db, `select status, done_at is not null from public.push_outbox where id = ${ids[0]}`)).toBe("sent|t")
    asRole("service_role", `select public.push_outbox_finish(${ids[0]}, 'gave-up', null)`) // already finished: no effect
    expect(sql(db, `select status from public.push_outbox where id = ${ids[0]}`)).toBe("sent")
    asRole("service_role", `select public.push_outbox_finish(${ids[1]}, 'retry', 120)`)
    expect(sql(db, `select status, next_attempt_at > now() + interval '100 seconds', lease_until is null from public.push_outbox where id = ${ids[1]}`)).toBe("pending|t|t")
    expect(asRole("service_role", "select id from public.push_outbox_claim(5, 60)").split("\n").filter((l) => /^\d+$/.test(l))).toHaveLength(0) // not due yet
    sql(db, `update public.push_outbox set next_attempt_at = now() - interval '1 second' where id = ${ids[1]}`)
    expect(asRole("service_role", "select id from public.push_outbox_claim(5, 60)").split("\n").filter((l) => /^\d+$/.test(l))).toHaveLength(1)
  })

  it("bad arguments are refused", () => {
    expect(fails(db, "begin; set local role service_role; select * from public.push_outbox_claim(0, 60); commit;")).toMatch(/invalid batch/)
    expect(fails(db, "begin; set local role service_role; select * from public.push_outbox_claim(10, 5); commit;")).toMatch(/invalid lease/)
    expect(fails(db, "begin; set local role service_role; select public.push_outbox_finish(1, 'bogus', null); commit;")).toMatch(/invalid outcome/)
    expect(fails(db, "begin; set local role service_role; select public.push_outbox_finish(1, 'retry', 0); commit;")).toMatch(/invalid delay/)
    expect(fails(db, "insert into public.push_outbox (ping_id, kind, recipient_uid, status) values ('z', 'incoming', 'u', 'weird')")).toMatch(/violates check/)
    expect(fails(db, "insert into public.push_outbox (ping_id, kind, recipient_uid) values ('dup', 'incoming', 'u'), ('dup', 'incoming', 'u')")).toMatch(/duplicate key/)
  })

  it("the draft stays out of supabase/migrations (nothing can push it by accident) and holds no secret", () => {
    expect(MIGRATIONS.some((f) => /outbox/i.test(f))).toBe(false)
    expect(OUTBOX).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}|sb_secret|private_key|service_account/i)
  })
})
