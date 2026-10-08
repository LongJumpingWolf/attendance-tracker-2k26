/**
 * The human-readable report and the machine-readable summary (Phase 6C). Neither contains a secret, a token, a name, a sync
 * blob or a full user id: accounts are shown as their first four characters plus ***. The files they are written to live
 * in the git-ignored migration-output/ folder anyway.
 */
import { TABLES } from "./transform.mjs"

export const short = (id) => (typeof id === "string" && id.length ? `${id.slice(0, 4)}***` : "none")

/** @param {{ mode: string, manifest: any, result: any, validation: any, import?: any, verify?: any }} a */
export function buildSummary({ mode, manifest, result, validation, import: imp, verify }) {
  const reasons = {}
  for (const q of result.tables.quarantined_records) for (const r of q.reasons) reasons[`${q.collection}: ${r}`] = (reasons[`${q.collection}: ${r}`] ?? 0) + 1
  return {
    mode,
    source: manifest.source,
    exportedAt: manifest.exportedAt,
    finishedAt: manifest.finishedAt,
    export: { totalDocuments: manifest.totalDocuments, httpGets: manifest.httpGets, writes: manifest.writes, deletes: manifest.deletes, collections: manifest.collections },
    transformedCounts: validation.counts,
    perCollection: result.perCollection,
    conservation: validation.conservation,
    rejects: reasons,
    legacyPingFlags: result.findings.pingFlagCounts,
    duplicatePairs: result.findings.duplicatePairs.map((p) => ({ canonical: short(p.canonical), archived: p.archived.map((a) => ({ id: short(a.id), reason: a.reason })) })),
    quarantinedAnsweredPings: result.findings.quarantinedAnsweredPings.map(short),
    leaseCleared: result.findings.leaseCleared,
    referential: validation.referential,
    syncs: { count: validation.syncChecks.length, allIdentical: validation.syncChecks.every((s) => s.same), checks: validation.syncChecks.map((s) => ({ uid: short(s.uid), rev: s.rev, sha256: s.sourceSha256, same: s.same })) },
    validation: { ok: validation.ok, errors: validation.errors, warnings: validation.warnings },
    ...(imp ? { import: { tables: imp.tables, syncs: imp.syncs, errors: imp.errors, writes: imp.writes } } : {}),
    ...(verify ? { verify: { ok: verify.ok, failed: verify.failed, checks: verify.checks } } : {}),
  }
}

export function renderReport(summary) {
  const L = []
  const h = (t) => L.push("", t, "")
  L.push(`# Migration ${summary.mode.toUpperCase()} report`)
  L.push("", `Source: Firebase project \`${summary.source.projectId}\` (${summary.source.database})${summary.source.emulator ? " [EMULATOR]" : ""}. Export time: ${summary.exportedAt} to ${summary.finishedAt}.`)
  L.push("", `**Result: ${summary.validation.ok ? "VALIDATION PASSED" : "VALIDATION FAILED"}.** Firebase is read only (writes ${summary.export.writes}, deletes ${summary.export.deletes}, HTTP GETs ${summary.export.httpGets}). This report holds no secrets, names, tokens or sync data.`)
  if (summary.validation.errors.length) {
    h("## Errors (these block the import)")
    summary.validation.errors.forEach((e) => L.push(`- ${e}`))
  }
  if (summary.validation.warnings.length) {
    h("## Warnings (read these)")
    summary.validation.warnings.forEach((w) => L.push(`- ${w}`))
  }
  h("## Conservation: source = accepted + archived + rejected")
  L.push("| Collection | Exported | Accepted | Archived | Rejected | OK |", "|---|---|---|---|---|---|")
  for (const [c, v] of Object.entries(summary.conservation)) L.push(`| ${c} | ${v.exported} | ${v.accepted} | ${v.archived} | ${v.rejected} | ${v.ok ? "yes" : "NO"} |`)
  h("## Rows per Supabase table")
  L.push("| Table | Rows |", "|---|---|")
  for (const t of TABLES) L.push(`| ${t} | ${summary.transformedCounts[t] ?? 0} |`)
  h("## Rejects and legacy findings")
  L.push(Object.keys(summary.rejects).length ? Object.entries(summary.rejects).map(([k, n]) => `- ${k} x${n}`).join("\n") : "- no rejected record")
  L.push(Object.keys(summary.legacyPingFlags).length ? `- legacy Ping flags: ${Object.entries(summary.legacyPingFlags).map(([k, n]) => `${k} x${n}`).join(", ")}` : "- no legacy-flagged Ping")
  L.push(`- duplicate friend pairs: ${summary.duplicatePairs.length}`)
  L.push(`- quarantined answered-but-unprocessed Pings: ${summary.quarantinedAnsweredPings.length}`)
  L.push(`- answered Pings whose lease was cleared: ${summary.leaseCleared}`)
  h("## Referential diagnostics")
  L.push(`- connections involving an account with no profile: ${summary.referential.connectionsWithoutProfile}`)
  L.push(`- Pings whose request is not in the export: ${summary.referential.pingsWithMissingRequest}`)
  L.push(`- aliases that resolve to an imported canonical connection: ${summary.referential.aliasesResolving}`)
  h("## Sync documents (byte preservation)")
  L.push(`${summary.syncs.count} document(s); source text, revision and SHA-256 identical in every transformed row: **${summary.syncs.allIdentical ? "yes" : "NO"}**.`)
  if (summary.import) {
    h("## Import")
    for (const [t, v] of Object.entries(summary.import.tables)) L.push(`- ${t}: ${v.sent} written, ${v.failed} failed`)
    L.push(`- syncs: ${JSON.stringify(summary.import.syncs)}`)
    summary.import.errors.forEach((e) => L.push(`- ERROR ${e}`))
  }
  if (summary.verify) {
    h(`## Verification: ${summary.verify.ok ? "PASS" : "FAIL"}`)
    L.push("| Table | Check | Status | Detail |", "|---|---|---|---|")
    for (const c of summary.verify.checks) L.push(`| ${c.table} | ${c.name} | ${c.status} | ${c.detail} |`)
  }
  return L.join("\n") + "\n"
}
