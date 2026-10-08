/**
 * Idempotent import into a NON-AUTHORITATIVE Supabase project, and the verification of it (Phase 6C parts D and E).
 *
 * Talks to PostgREST with the service-role key (read from the environment by the CLI, never from source, never printed).
 * The only operations this module can issue are GET, POST (insert / upsert) and PATCH on the ten migration tables. There is
 * no DELETE and no way to run SQL, so it cannot remove data. The key is redacted from every message.
 *
 * Idempotency: every table is upserted on its primary key from deterministic rows, so a second run changes nothing.
 * Sync documents are special: Supabase is only a copy, but it must never go backwards, so a row is inserted if absent,
 * updated only when the target revision is LOWER than the source (a guarded PATCH), and left alone (and reported) when the
 * target is equal or ahead.
 */
import { sha256OfString, TABLES } from "./transform.mjs"

const ALLOWED_TABLES = new Set(TABLES)
/** The ten tables of the intended schema: the nine the import writes plus the migration-only shadow_mismatch */
export const INTENDED_TABLES = [...TABLES, "shadow_mismatch"].sort()

/** Columns the importer relies on, per table (checked against the target's OpenAPI description before any write) */
export const REQUIRED_COLUMNS = {
  profiles: ["uid", "name", "updated_at"],
  invites: ["token", "owner", "owner_name", "expires_at", "created_at"],
  connections: ["id", "from_uid", "to_uid", "from_name", "to_name", "status", "created_at", "responded_at"],
  legacy_requests: ["id", "raw", "source", "imported_at"],
  connection_aliases: ["legacy_id", "canonical_id", "reason", "note", "created_at"],
  pings: ["id", "from_uid", "to_uid", "from_name", "to_name", "request_id", "class_date", "items", "status", "created_at", "responded_at", "claimed_by", "claimed_at", "processed_at", "legacy", "legacy_flags"],
  push_tokens: ["uid", "device_id", "token", "updated_at"],
  syncs: ["uid", "data", "rev", "updated_at"],
  quarantined_records: ["id", "collection", "doc_id", "raw", "reasons", "exported_at", "created_at"],
  shadow_mismatch: ["id", "at", "domain", "key", "detail"],
}

const CONFLICT_KEYS = {
  profiles: "uid",
  invites: "token",
  connections: "id",
  legacy_requests: "id",
  connection_aliases: "legacy_id",
  pings: "id",
  push_tokens: "uid,device_id",
  quarantined_records: "collection,doc_id",
  syncs: "uid",
}
const BATCH = { default: 200, syncs: 5, pings: 100, legacy_requests: 50, quarantined_records: 50 }

/** Removes the service key and anything that looks like a JWT or a private key from a message */
export function redactor(...secrets) {
  const list = secrets.filter((s) => typeof s === "string" && s.length >= 8)
  return (text) => {
    let out = String(text ?? "")
    for (const s of list) out = out.split(s).join("[redacted]")
    return out
      .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted-key]")
      .replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]")
  }
}

export const projectRefOf = (url) => {
  const host = new URL(url).hostname
  return host.endsWith(".supabase.co") ? host.split(".")[0] : host
}

export function createPostgrest({ url, serviceKey, fetchFn = fetch }) {
  const base = url.replace(/\/+$/, "")
  const redact = redactor(serviceKey)
  const counters = { gets: 0, writes: 0 }

  async function call(method, table, query, body, prefer) {
    if (!["GET", "POST", "PATCH"].includes(method)) throw new Error("refusing a non-GET/POST/PATCH request")
    if (table !== "" && !ALLOWED_TABLES.has(table) && table !== "shadow_mismatch") throw new Error(`refusing a request to an unknown table`)
    if (method !== "GET") counters.writes++
    else counters.gets++
    const res = await fetchFn(`${base}/rest/v1/${table}${query ? `?${query}` : ""}`, {
      method,
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        "content-type": "application/json",
        ...(table === "" ? { accept: "application/openapi+json" } : {}),
        ...(prefer ? { prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) {
      let code = ""
      try {
        code = JSON.parse(text).code ?? ""
      } catch {
        /* not JSON */
      }
      const err = new Error(`${method} ${table || "/"} failed: HTTP ${res.status}${code ? ` ${code}` : ""}`)
      err.status = res.status
      err.code = code
      throw err
    }
    return text ? JSON.parse(text) : null
  }

  /** All rows of a table, in pages */
  async function selectAll(table, columns = "*", order = "") {
    const out = []
    for (let offset = 0; ; offset += 1000) {
      const page = await call("GET", table, `select=${encodeURIComponent(columns)}&limit=1000&offset=${offset}${order ? `&order=${order}` : ""}`)
      out.push(...page)
      if (page.length < 1000) return out
    }
  }

  return {
    call,
    selectAll,
    counters,
    redact,
    openApi: () => call("GET", "", ""),
    insertIgnore: (table, rows) => call("POST", table, `on_conflict=${CONFLICT_KEYS[table]}`, rows, "resolution=ignore-duplicates,return=minimal"),
    upsert: (table, rows) => call("POST", table, `on_conflict=${CONFLICT_KEYS[table]}`, rows, "resolution=merge-duplicates,return=minimal"),
    patchSyncIfLower: (uid, rev, fields) => call("PATCH", "syncs", `uid=eq.${encodeURIComponent(uid)}&rev=lt.${rev}&select=uid`, fields, "return=representation"),
  }
}

// ---- schema check (before any write) -------------------------------------------------------------------------------

/** Compares the target's OpenAPI description with the intended Phase 2B/3 schema. Returns a list of problems (empty = match). */
export async function checkSchema(pg) {
  const spec = await pg.openApi()
  const defs = spec?.definitions ?? spec?.components?.schemas ?? {}
  const problems = []
  const tables = Object.keys(defs).sort()
  for (const t of INTENDED_TABLES) {
    if (!defs[t]) {
      problems.push(`missing table: ${t}`)
      continue
    }
    const cols = Object.keys(defs[t].properties ?? {})
    for (const c of REQUIRED_COLUMNS[t] ?? []) if (!cols.includes(c)) problems.push(`missing column: ${t}.${c}`)
  }
  const extra = tables.filter((t) => !INTENDED_TABLES.includes(t))
  if (extra.length) problems.push(`unexpected exposed relation(s): ${extra.join(", ")}`)
  return problems
}

// ---- import --------------------------------------------------------------------------------------------------------

export async function runImport(pg, result, { log = () => {} } = {}) {
  const t = result.tables
  const report = { tables: {}, syncs: { inserted: 0, updated: 0, unchanged: 0, targetAhead: 0, errors: 0 }, errors: [] }
  const chunks = (rows, n) => Array.from({ length: Math.ceil(rows.length / n) }, (_, i) => rows.slice(i * n, i * n + n))

  // parents before children: legacy_requests before aliases
  const order = ["profiles", "invites", "connections", "legacy_requests", "connection_aliases", "pings", "push_tokens"]
  for (const table of order) {
    report.tables[table] = { sent: 0, failed: 0 }
    for (const batch of chunks(t[table], BATCH[table] ?? BATCH.default)) {
      try {
        await pg.upsert(table, batch)
        report.tables[table].sent += batch.length
      } catch (e) {
        // isolate the failing row(s) so one bad record cannot hide the rest
        for (const row of batch) {
          try {
            await pg.upsert(table, [row])
            report.tables[table].sent++
          } catch (e2) {
            report.tables[table].failed++
            report.errors.push(`${table}: ${pg.redact(e2.message)}`)
          }
        }
        void e // the batch error is superseded by the per-row errors above
      }
    }
    log(`${table}: ${report.tables[table].sent} written, ${report.tables[table].failed} failed`)
  }

  // quarantine: insert once; an existing (collection, doc_id) is never changed
  report.tables.quarantined_records = { sent: 0, failed: 0 }
  for (const batch of chunks(t.quarantined_records, BATCH.quarantined_records)) {
    try {
      await pg.insertIgnore("quarantined_records", batch)
      report.tables.quarantined_records.sent += batch.length
    } catch (e) {
      report.tables.quarantined_records.failed += batch.length
      report.errors.push(`quarantined_records: ${pg.redact(e.message)}`)
    }
  }

  // syncs: never move a copy backwards, never overwrite an equal-or-newer revision
  let existing
  try {
    existing = new Map((await pg.selectAll("syncs", "uid,rev")).map((r) => [r.uid, r.rev]))
  } catch (e) {
    report.syncs.errors++
    report.errors.push(`syncs: could not read the existing revisions: ${pg.redact(e.message)}`)
    report.writes = pg.counters.writes
    return report
  }
  for (const row of t.syncs) {
    try {
      const have = existing.get(row.uid)
      if (have === undefined) {
        await pg.insertIgnore("syncs", [row])
        report.syncs.inserted++
      } else if (have < row.rev) {
        const done = await pg.patchSyncIfLower(row.uid, row.rev, { data: row.data, rev: row.rev, updated_at: row.updated_at })
        if (done.length) report.syncs.updated++
        else report.syncs.unchanged++
      } else if (have === row.rev) report.syncs.unchanged++
      else report.syncs.targetAhead++
    } catch (e) {
      report.syncs.errors++
      report.errors.push(`syncs: ${pg.redact(e.message)}`)
    }
  }
  log(`syncs: ${JSON.stringify(report.syncs)}`)
  report.writes = pg.counters.writes
  return report
}

// ---- verification --------------------------------------------------------------------------------------------------

const ms = (v) => (v === null || v === undefined ? null : Date.parse(v))
const norm = {
  profiles: (r) => [r.uid, r.name, ms(r.updated_at)],
  invites: (r) => [r.token, r.owner, r.owner_name, ms(r.expires_at), ms(r.created_at)],
  connections: (r) => [r.id, r.from_uid, r.to_uid, r.from_name, r.to_name, r.status, ms(r.created_at), ms(r.responded_at)],
  legacy_requests: (r) => [r.id, JSON.stringify(r.raw), r.source],
  connection_aliases: (r) => [r.legacy_id, r.canonical_id, r.reason, r.note],
  pings: (r) => [r.id, r.from_uid, r.to_uid, r.from_name, r.to_name, r.request_id, r.class_date, JSON.stringify(r.items), r.status, ms(r.created_at), ms(r.responded_at), r.claimed_by, ms(r.claimed_at), ms(r.processed_at), r.legacy, [...r.legacy_flags].sort().join(",")],
  push_tokens: (r) => [r.uid, r.device_id, r.token, ms(r.updated_at)],
  quarantined_records: (r) => [r.collection, r.doc_id, JSON.stringify(r.raw), [...r.reasons].join(",")],
}
const stable = (v) => JSON.stringify(v)
// jsonb does not keep key order, so objects are compared by canonical form
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v)
const withCanon = (row) => ({ ...row, ...(row.items !== undefined ? { items: canon(row.items) } : {}), ...(row.raw !== undefined ? { raw: canon(row.raw) } : {}) })

export async function runVerify(pg, result, records) {
  const checks = []
  const add = (table, name, status, detail = "") => checks.push({ table, name, status, detail })
  const keyOf = result.primaryKey

  for (const table of ["profiles", "invites", "connections", "legacy_requests", "connection_aliases", "pings", "push_tokens", "quarantined_records"]) {
    const target = (await pg.selectAll(table)).map(withCanon)
    const expected = result.tables[table].map(withCanon)
    const tk = new Map(target.map((r) => [keyOf[table](r), r]))
    const ek = new Map(expected.map((r) => [keyOf[table](r), r]))
    const missing = [...ek.keys()].filter((k) => !tk.has(k))
    const extra = [...tk.keys()].filter((k) => !ek.has(k))
    add(table, "count", expected.length === target.length ? "PASS" : "FAIL", `source-side ${expected.length}, target ${target.length}`)
    add(table, "ids", missing.length === 0 && extra.length === 0 ? "PASS" : "FAIL", `${missing.length} missing, ${extra.length} not from this export`)
    let differ = 0
    for (const [k, e] of ek) {
      const g = tk.get(k)
      if (g && stable(norm[table](e)) !== stable(norm[table](g))) differ++
    }
    add(table, "fields", differ === 0 ? "PASS" : "FAIL", `${differ} row(s) differ`)
  }

  // quarantined source records are EXPLAINED rejects only if they are present in quarantined_records
  const q = new Set(result.tables.quarantined_records.map((r) => `${r.collection}\u0000${r.doc_id}`))
  const qTarget = new Set((await pg.selectAll("quarantined_records", "collection,doc_id")).map((r) => `${r.collection}\u0000${r.doc_id}`))
  add("quarantined_records", "explained-rejects", [...q].every((k) => qTarget.has(k)) ? "EXPLAINED-REJECT" : "FAIL", `${q.size} source record(s) rejected, each recorded with its reasons`)

  // syncs: uid set, exact rev, exact SHA-256 of data
  const target = await pg.selectAll("syncs")
  const tmap = new Map(target.map((r) => [r.uid, r]))
  const exp = result.tables.syncs
  const missing = exp.filter((r) => !tmap.has(r.uid)).length
  const extra = target.filter((r) => !exp.some((e) => e.uid === r.uid)).length
  const revDiff = exp.filter((r) => tmap.has(r.uid) && tmap.get(r.uid).rev !== r.rev).length
  const shaDiff = exp.filter((r) => tmap.has(r.uid) && sha256OfString(tmap.get(r.uid).data) !== sha256OfString(r.data)).length
  const bytesDiff = exp.filter((r) => tmap.has(r.uid) && tmap.get(r.uid).data !== r.data).length
  add("syncs", "uid-set", missing === 0 && extra === 0 ? "PASS" : "FAIL", `${missing} missing, ${extra} not from this export`)
  add("syncs", "rev", revDiff === 0 ? "PASS" : "FAIL", `${revDiff} differ`)
  add("syncs", "sha256(data)", shaDiff === 0 && bytesDiff === 0 ? "PASS" : "FAIL", `${shaDiff} hash difference(s), ${bytesDiff} byte difference(s)`)

  // every source record is accounted for
  for (const c of Object.keys(records)) {
    const placed = (records[c] ?? []).length
    add(c, "source-accounted", placed === (result.perCollection[c]?.exported ?? 0) ? "PASS" : "FAIL", `${placed} source record(s)`)
  }

  const bad = checks.filter((c) => c.status === "FAIL").length
  return { ok: bad === 0, checks, failed: bad }
}

