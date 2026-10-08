/**
 * Pure transformation (Phase 6C part B): exported Firestore records -> rows for the Supabase tables built in Phase 2B.
 * No network, no clock, no randomness: the same input always gives the same output.
 *
 * Governing documents: MIGRATION_DECISIONS.md (wins) over MIGRATION_PLAN.md section 14. In short:
 *  - every id is the original Firestore id; this module never creates one;
 *  - nothing is merged, coerced, repaired or dropped: a record either becomes a row, becomes a legacy-archive row with an
 *    alias (non-canonical duplicate requests, decision 2a), or goes to quarantine with its reasons (and the complete original);
 *  - the sync blob is copied as the exact string; it is never parsed, decompressed or re-encoded.
 *
 * Conservation, per collection:  exported = live + flagged-legacy + archived + quarantined, and deleted = 0.
 */
import { createHash } from "node:crypto"
import { decodeFields, isTs, tsIso, tsMs } from "./firestore-values.mjs"

export const sha256OfString = (s) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex")
const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const charLen = (s) => [...s].length
const isStr = (v) => typeof v === "string"
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

export const PING_STATUSES = ["asking", "answered", "processed"]
export const REQUEST_STATUSES = ["pending", "accepted", "declined"]
export const TABLES = ["profiles", "invites", "connections", "legacy_requests", "connection_aliases", "pings", "push_tokens", "syncs", "quarantined_records"]
const PING_ID = /^[A-Za-z0-9_-]{8,64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^\d{2}:\d{2}$/

/** The complete original document, in Firestore's typed form (for the archive and for quarantine) */
const rawOf = (rec) => ({ id: rec.id, createTime: rec.createTime, updateTime: rec.updateTime, fields: rec.fields })

const reject = (rec, reasons) => ({ collection: rec.collection, doc_id: rec.id, raw: rawOf(rec), reasons: [...reasons] })

// ---- per collection ---------------------------------------------------------------------------------------------

function profile(rec, d) {
  if (!isStr(d.name) || charLen(d.name) < 1 || charLen(d.name) > 40) return { rejected: ["profile-name-invalid"] }
  return { row: { uid: rec.id, name: d.name, updated_at: tsIso(d.updatedAt) } }
}

function invite(rec, d) {
  if (!isStr(d.owner) || d.owner === "") return { rejected: ["invite-owner-missing"] }
  const exp = tsIso(d.expiresAt) ?? (typeof d.expiresAt === "number" && Number.isFinite(d.expiresAt) ? new Date(d.expiresAt).toISOString() : null)
  if (exp === null) return { rejected: ["invite-expiry-missing"] } // expires_at is NOT NULL; the old client-clock expiry is stored as given, never re-judged
  return { row: { token: rec.id, owner: d.owner, owner_name: isStr(d.ownerName) ? d.ownerName : null, expires_at: exp, created_at: tsIso(d.createdAt) } }
}

function pushToken(rec, d) {
  if (!isStr(d.token) || charLen(d.token) < 1 || charLen(d.token) > 4095) return { rejected: ["token-invalid"] }
  // one row per account, device 'legacy' (decision 3). Different accounts are never merged, even with an identical token string.
  return { row: { uid: rec.id, device_id: "legacy", token: d.token, updated_at: tsIso(d.updatedAt) } }
}

function sync(rec, d) {
  if (!isStr(d.data)) return { rejected: ["sync-data-not-a-string"] }
  const rev = d.rev
  if (!(typeof rev === "number" && Number.isInteger(rev) && rev >= 1 && rev <= 2147483647)) return { rejected: ["sync-rev-invalid"] }
  let updated = null
  if (typeof d.updatedAt === "number" && Number.isFinite(d.updatedAt)) updated = Math.trunc(d.updatedAt)
  else if (isTs(d.updatedAt)) updated = tsMs(d.updatedAt)
  // `data` is the exact string Firestore returned: no trimming, no parsing, no re-encoding
  return { row: { uid: rec.id, data: d.data, rev, updated_at: updated } }
}

// ---- requests (decision 2a) -------------------------------------------------------------------------------------

function requestRow(rec, d) {
  if (!isStr(d.from) || d.from === "" || !isStr(d.to) || d.to === "") return { rejected: ["request-participant-missing"] }
  if (!REQUEST_STATUSES.includes(d.status)) return { rejected: ["request-status-invalid"] }
  return {
    row: {
      id: rec.id,
      from_uid: d.from,
      to_uid: d.to,
      from_name: isStr(d.fromName) ? d.fromName : null,
      to_name: isStr(d.toName) ? d.toName : null,
      status: d.status,
      created_at: tsIso(d.createdAt),
      responded_at: tsIso(d.respondedAt),
    },
  }
}

/** accepted first, then earliest createdAt (missing last), then smallest id in byte order. Depends on the data only. */
const canonicalOrder = (a, b) => {
  const acc = (x) => (x.status === "accepted" ? 0 : 1)
  if (acc(a) !== acc(b)) return acc(a) - acc(b)
  const ta = a.created_at === null ? Infinity : Date.parse(a.created_at)
  const tb = b.created_at === null ? Infinity : Date.parse(b.created_at)
  if (ta !== tb) return ta < tb ? -1 : 1
  return byteOrder(a.id, b.id)
}

/** D-1..D-6 from the decision's table, decided by how the archived row relates to the canonical one */
function aliasFor(canon, other) {
  const sameDirection = canon.from_uid === other.from_uid && canon.to_uid === other.to_uid
  if (canon.status === "accepted" && other.status === "accepted") return { reason: "D-4", note: "two accepted records for one pair" }
  if (canon.status === "accepted") return { reason: "D-3", note: "pending record superseded by the accepted canonical row" }
  return sameDirection ? { reason: "D-1", note: "same direction, both pending" } : { reason: "D-2", note: "opposite directions, both pending" }
}

// ---- pings (decision 2b) ----------------------------------------------------------------------------------------

function itemShapeOk(it) {
  if (!isObj(it)) return false
  const allowed = new Set(["key", "subjectId", "name", "t", "answer"])
  if (Object.keys(it).some((k) => !allowed.has(k))) return false
  if (!isStr(it.key) || !isStr(it.subjectId) || !isStr(it.name) || charLen(it.name) > 60) return false
  if ("t" in it && it.t !== null && !(isStr(it.t) && HHMM.test(it.t))) return false
  if ("answer" in it && it.answer !== null && it.answer !== "yes" && it.answer !== "no") return false
  return true
}

function ping(rec, d, ctx) {
  const reasons = []
  if (!PING_ID.test(rec.id)) reasons.push("id-pattern") // the table CHECK would reject it
  const fromOk = isStr(d.from) && d.from !== ""
  const toOk = isStr(d.to) && d.to !== ""
  if (!fromOk || !toOk) reasons.push("participant-missing")
  else if (d.from === d.to) reasons.push("from-equals-to")
  if (!(Array.isArray(d.participants) && d.participants.length === 2 && d.participants[0] === d.from && d.participants[1] === d.to)) reasons.push("participants-mismatch")
  if (!PING_STATUSES.includes(d.status)) reasons.push("status-invalid")
  const created = tsMs(d.createdAt)
  if (created !== null && created > ctx.exportedAtMs) reasons.push("created-after-export")
  if (!isStr(d.date)) reasons.push("date-not-a-string")
  if (!Array.isArray(d.items)) reasons.push("items-not-an-array")
  else if ((d.status === "answered" || d.status === "processed") && d.items.some((it) => isObj(it) && "answer" in it && it.answer !== null && it.answer !== "yes" && it.answer !== "no")) reasons.push("answer-value-invalid")
  if (reasons.length) return { rejected: reasons }

  const flags = []
  if (d.items.length > 8) flags.push("items>8")
  if (d.items.some((it) => !itemShapeOk(it))) flags.push("item-shape")
  if (!DATE.test(d.date)) flags.push("date-format")
  if (created === null) flags.push("no-created-at")
  if (!isStr(d.requestId) || !ctx.requestIds.has(d.requestId)) flags.push("request-missing") // V8: no foreign key; flagged, never rejected
  if (!isStr(d.fromName) || !isStr(d.toName) || charLen(d.fromName) > 40 || charLen(d.toName) > 40) flags.push("name-length")
  const answered = d.status === "answered"
  return {
    row: {
      id: rec.id,
      from_uid: d.from,
      to_uid: d.to,
      from_name: isStr(d.fromName) ? d.fromName : null,
      to_name: isStr(d.toName) ? d.toName : null,
      request_id: isStr(d.requestId) ? d.requestId : null,
      class_date: d.date,
      items: d.items, // exactly as exported
      status: d.status,
      created_at: tsIso(d.createdAt),
      responded_at: tsIso(d.respondedAt),
      // plan section 14.8: an answered Ping migrates with its short lease cleared; the asker simply leases again
      claimed_by: answered ? null : isStr(d.claimedBy) ? d.claimedBy : null,
      claimed_at: answered ? null : tsIso(d.claimedAt),
      processed_at: tsIso(d.processedAt),
      legacy: flags.length > 0,
      legacy_flags: flags,
    },
    leaseCleared: answered && (isStr(d.claimedBy) || tsIso(d.claimedAt) !== null),
  }
}

// ---- the whole export ---------------------------------------------------------------------------------------------

/**
 * @param {{ [collection: string]: Array<{collection:string,id:string,createTime:string|null,updateTime:string|null,fields:object}> }} records
 * @param {{ exportedAt: string }} opts  the time the export finished: a createdAt after it is impossible
 */
export function transformExport(records, { exportedAt }) {
  const exportedAtMs = Date.parse(exportedAt)
  if (Number.isNaN(exportedAtMs)) throw new Error("exportedAt is not a timestamp")
  const tables = Object.fromEntries(TABLES.map((t) => [t, []]))
  const per = {}
  const findings = { duplicatePairs: [], pingFlagCounts: {}, quarantinedAnsweredPings: [], leaseCleared: 0, idsSeen: {} }
  const count = (c) => (per[c] ??= { exported: 0, live: 0, flagged: 0, archived: 0, quarantined: 0 })

  const decoded = {}
  for (const c of ["users", "invites", "requests", "pings", "pushTokens", "syncs"]) {
    decoded[c] = (records[c] ?? []).map((rec) => {
      let d
      let bad = null
      try {
        d = decodeFields(rec.fields)
      } catch (e) {
        d = {}
        bad = String(e.message)
      }
      return { rec, d, bad }
    })
    count(c).exported = decoded[c].length
  }

  const quarantine = (rec, reasons) => {
    tables.quarantined_records.push({ ...reject(rec, reasons), exported_at: exportedAt })
    count(rec.collection).quarantined++
  }

  // simple one-to-one collections
  const simple = [
    ["users", profile, "profiles"],
    ["invites", invite, "invites"],
    ["pushTokens", pushToken, "push_tokens"],
    ["syncs", sync, "syncs"],
  ]
  for (const [collection, fn, table] of simple) {
    for (const { rec, d, bad } of decoded[collection]) {
      const out = bad ? { rejected: ["undecodable-document"] } : fn(rec, d)
      if (out.rejected) quarantine(rec, out.rejected)
      else {
        tables[table].push(out.row)
        count(collection).live++
      }
    }
  }

  // requests: group by unordered pair, keep one canonical non-declined row, archive the rest with an alias
  const reqRows = []
  for (const { rec, d, bad } of decoded.requests) {
    const out = bad ? { rejected: ["undecodable-document"] } : requestRow(rec, d)
    if (out.rejected) quarantine(rec, out.rejected)
    else reqRows.push({ rec, row: out.row })
  }
  const pairs = new Map()
  for (const r of reqRows) {
    const key = [r.row.from_uid, r.row.to_uid].sort(byteOrder).join("\u0000")
    if (!pairs.has(key)) pairs.set(key, [])
    pairs.get(key).push(r)
  }
  const archived = new Set()
  for (const [, group] of [...pairs].sort((a, b) => byteOrder(a[0], b[0]))) {
    const live = group.filter((g) => g.row.status !== "declined").sort((a, b) => canonicalOrder(a.row, b.row))
    if (live.length < 2) continue
    const [canon, ...rest] = live
    const entry = { canonical: canon.rec.id, archived: [] }
    for (const o of rest) {
      const a = aliasFor(canon.row, o.row)
      tables.legacy_requests.push({ id: o.rec.id, raw: rawOf(o.rec), source: "firestore:requests" })
      tables.connection_aliases.push({ legacy_id: o.rec.id, canonical_id: canon.rec.id, reason: a.reason, note: a.note })
      archived.add(o.rec.id)
      entry.archived.push({ id: o.rec.id, reason: a.reason })
      count("requests").archived++
    }
    findings.duplicatePairs.push(entry)
  }
  for (const { rec, row } of reqRows) {
    if (archived.has(rec.id)) continue
    tables.connections.push(row)
    count("requests").live++
  }

  // pings
  const requestIds = new Set(decoded.requests.map((x) => x.rec.id)) // any exported request id, canonical or archived or rejected: resolvable
  for (const { rec, d, bad } of decoded.pings) {
    const out = bad ? { rejected: ["undecodable-document"] } : ping(rec, d, { exportedAtMs, requestIds })
    if (out.rejected) {
      quarantine(rec, out.rejected)
      if (!bad && d.status === "answered") findings.quarantinedAnsweredPings.push(rec.id) // holds an unapplied favour: reported loudly
      continue
    }
    tables.pings.push(out.row)
    if (out.row.legacy) {
      count("pings").flagged++
      for (const f of out.row.legacy_flags) findings.pingFlagCounts[f] = (findings.pingFlagCounts[f] ?? 0) + 1
    } else count("pings").live++
    if (out.leaseCleared) findings.leaseCleared++
  }

  // deterministic order everywhere
  const pk = {
    profiles: (r) => r.uid,
    invites: (r) => r.token,
    connections: (r) => r.id,
    legacy_requests: (r) => r.id,
    connection_aliases: (r) => r.legacy_id,
    pings: (r) => r.id,
    push_tokens: (r) => `${r.uid}\u0000${r.device_id}`,
    syncs: (r) => r.uid,
    quarantined_records: (r) => `${r.collection}\u0000${r.doc_id}`,
  }
  for (const t of TABLES) tables[t].sort((a, b) => byteOrder(pk[t](a), pk[t](b)))
  findings.duplicatePairs.sort((a, b) => byteOrder(a.canonical, b.canonical))
  findings.quarantinedAnsweredPings.sort(byteOrder)
  for (const c of ["users", "invites", "requests", "pings", "pushTokens", "syncs"]) findings.idsSeen[c] = decoded[c].map((x) => x.rec.id)

  const syncChecks = tables.syncs.map((r) => ({ uid: r.uid, rev: r.rev, bytes: Buffer.byteLength(r.data, "utf8"), sha256: sha256OfString(r.data) }))
  return { tables, perCollection: per, findings, syncChecks, exportedAt, primaryKey: pk }
}
