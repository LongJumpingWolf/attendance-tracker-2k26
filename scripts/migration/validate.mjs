/**
 * Deterministic validation (Phase 6C part C). No network. Fails loudly on any unexpected loss:
 * no record may disappear, no id may be invented, and nothing may be changed on its way into a row.
 *
 * Errors block the import. Warnings are findings a human should read (legacy records, missing references, ...).
 */
import { decodeFields } from "./firestore-values.mjs"
import { sha256OfString, TABLES } from "./transform.mjs"

const COLLECTION_TABLES = {
  users: ["profiles"],
  invites: ["invites"],
  requests: ["connections", "legacy_requests"],
  pings: ["pings"],
  pushTokens: ["push_tokens"],
  syncs: ["syncs"],
}

function hasNul(v) {
  if (typeof v === "string") return v.includes("\u0000")
  if (Array.isArray(v)) return v.some(hasNul)
  if (v !== null && typeof v === "object") return Object.values(v).some(hasNul)
  return false
}

/**
 * @param {{ manifest: object, records: object, result: ReturnType<import('./transform.mjs').transformExport>, integrity?: string[] }} input
 */
export function validate({ manifest, records, result, integrity = [] }) {
  const errors = [...integrity]
  const warnings = []
  const { tables, perCollection, findings } = result

  // 1. the export agrees with its manifest, and no source id repeats
  for (const [c, meta] of Object.entries(manifest.collections)) {
    const recs = records[c] ?? []
    if (recs.length !== meta.count) errors.push(`export: ${c} has ${recs.length} records but the manifest says ${meta.count}`)
    const seen = new Set()
    for (const r of recs) {
      if (seen.has(r.id)) errors.push(`export: duplicate source id in ${c}`)
      seen.add(r.id)
    }
  }

  // 2. conservation: source_count = accepted + archived + rejected, for every collection
  const conservation = {}
  for (const c of Object.keys(COLLECTION_TABLES)) {
    const p = perCollection[c] ?? { exported: 0, live: 0, flagged: 0, archived: 0, quarantined: 0 }
    const accepted = p.live + p.flagged
    const total = accepted + p.archived + p.quarantined
    conservation[c] = { exported: p.exported, accepted, archived: p.archived, rejected: p.quarantined, ok: total === p.exported && p.exported === (records[c] ?? []).length }
    if (!conservation[c].ok) errors.push(`conservation: ${c} exported ${p.exported} but accepted ${accepted} + archived ${p.archived} + rejected ${p.quarantined} = ${total}`)
  }

  // 3. no invented ids: every output key comes from a source id
  const sourceIds = Object.fromEntries(Object.keys(COLLECTION_TABLES).map((c) => [c, new Set((records[c] ?? []).map((r) => r.id))]))
  const idOf = {
    profiles: (r) => [["users", r.uid]],
    invites: (r) => [["invites", r.token]],
    connections: (r) => [["requests", r.id]],
    legacy_requests: (r) => [["requests", r.id]],
    connection_aliases: (r) => [["requests", r.legacy_id], ["requests", r.canonical_id]],
    pings: (r) => [["pings", r.id]],
    push_tokens: (r) => [["pushTokens", r.uid]],
    syncs: (r) => [["syncs", r.uid]],
    quarantined_records: (r) => [[r.collection, r.doc_id]],
  }
  for (const t of TABLES) {
    for (const row of tables[t]) for (const [c, id] of idOf[t](row)) if (!sourceIds[c]?.has(id)) errors.push(`ids: ${t} holds an id that is not in the export (${c})`)
  }

  // 4. no duplicate keys inside a table, and no source id placed twice
  for (const t of TABLES) {
    const seen = new Set()
    for (const row of tables[t]) {
      const k = result.primaryKey[t](row)
      if (seen.has(k)) errors.push(`keys: duplicate key in ${t}`)
      seen.add(k)
    }
  }
  for (const c of Object.keys(COLLECTION_TABLES)) {
    const placed = new Map()
    const bump = (id) => placed.set(id, (placed.get(id) ?? 0) + 1)
    for (const t of COLLECTION_TABLES[c]) for (const row of tables[t]) bump(result.primaryKey[t](row).split("\u0000")[0])
    for (const q of tables.quarantined_records) if (q.collection === c) bump(q.doc_id)
    for (const id of sourceIds[c]) if ((placed.get(id) ?? 0) !== 1) errors.push(`placement: a ${c} record is placed ${placed.get(id) ?? 0} times (must be exactly once)`)
  }

  // 5. aliases resolve, and the live pair rule holds
  const conn = new Set(tables.connections.map((r) => r.id))
  const legacy = new Set(tables.legacy_requests.map((r) => r.id))
  for (const a of tables.connection_aliases) {
    if (!legacy.has(a.legacy_id)) errors.push("aliases: an alias points at a legacy request that is not archived")
    if (!conn.has(a.canonical_id)) errors.push("aliases: an alias points at a canonical connection that is not imported")
  }
  const livePairs = new Set()
  for (const r of tables.connections) {
    if (r.status === "declined") continue
    const k = [r.from_uid, r.to_uid].sort().join("\u0000")
    if (livePairs.has(k)) errors.push("connections: two active rows for one pair (the unique index would reject the second)")
    livePairs.add(k)
  }

  // 6. syncs: the stored text, the revision and the SHA-256 are exactly the source's
  const syncOut = new Map(tables.syncs.map((r) => [r.uid, r]))
  const syncChecks = []
  for (const rec of records.syncs ?? []) {
    const out = syncOut.get(rec.id)
    if (!out) continue // rejected: reported as a quarantine
    const src = decodeFields(rec.fields)
    const srcSha = sha256OfString(src.data)
    const dstSha = sha256OfString(out.data)
    const same = src.data === out.data && srcSha === dstSha && src.rev === out.rev
    syncChecks.push({ uid: rec.id, rev: out.rev, sourceSha256: srcSha, targetSha256: dstSha, same })
    if (!same) errors.push("syncs: a sync document was changed on its way into a row (data, rev or SHA-256 differ)")
  }

  // 7. what Postgres cannot store
  for (const t of TABLES) for (const row of tables[t]) if (hasNul(row)) errors.push(`unrepresentable: a ${t} row contains a NUL character, which PostgreSQL text and jsonb cannot hold`)

  // warnings: things a human should read
  if (findings.quarantinedAnsweredPings.length) warnings.push(`LOUD: ${findings.quarantinedAnsweredPings.length} answered-but-unprocessed Ping(s) were quarantined (each holds an unapplied favour): decide by hand before cutover`)
  if (tables.quarantined_records.length) warnings.push(`${tables.quarantined_records.length} record(s) quarantined (see the reasons in the report)`)
  const flagged = tables.pings.filter((p) => p.legacy).length
  if (flagged) warnings.push(`${flagged} legacy-compatible Ping(s) imported verbatim with flags`)
  if (findings.duplicatePairs.length) warnings.push(`${findings.duplicatePairs.length} duplicate friend pair(s): one canonical row each, ${tables.legacy_requests.length} archived with an alias`)
  if (findings.leaseCleared) warnings.push(`${findings.leaseCleared} answered Ping(s) had their lease cleared (plan section 14.8)`)
  const profiles = new Set(tables.profiles.map((r) => r.uid))
  const noProfile = new Set()
  for (const r of tables.connections) for (const u of [r.from_uid, r.to_uid]) if (!profiles.has(u)) noProfile.add(u)
  if (noProfile.size) warnings.push(`${noProfile.size} account(s) in connections have no profile (an anonymous user who never saved a name has none; informational)`)
  const missing = tables.pings.filter((p) => p.legacy_flags.includes("request-missing")).length
  if (missing) warnings.push(`${missing} Ping(s) reference a request that is not in the export (flagged request-missing; no foreign key, so imported)`)

  const referential = {
    connectionsWithoutProfile: noProfile.size,
    pingsWithMissingRequest: missing,
    aliasesResolving: tables.connection_aliases.filter((a) => legacy.has(a.legacy_id) && conn.has(a.canonical_id)).length,
  }

  return {
    ok: errors.length === 0,
    errors: [...new Set(errors)],
    warnings,
    conservation,
    referential,
    syncChecks,
    counts: Object.fromEntries(TABLES.map((t) => [t, tables[t].length])),
  }
}
