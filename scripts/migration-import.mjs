#!/usr/bin/env node
/**
 * Firebase -> Supabase INITIAL IMPORT tooling (Phase 6C). An operational migration tool only: it changes nothing in the
 * application, enables no flag, and Firebase stays authoritative. Supabase is a COPY.
 *
 *   npm run migration:import -- --dry-run  --project <firebase-project-id>      export + transform + validate + report. Writes nothing to Supabase and does not contact it.
 *   npm run migration:import -- --dry-run  --from <export-dir>                  the same, from an earlier export (offline)
 *   npm run migration:import -- --check-schema --confirm-project-ref <ref>      read-only: does the target hold exactly the intended schema?
 *   npm run migration:import -- --import   --from <export-dir> --confirm-project-ref <ref> --yes-supabase-is-a-copy
 *   npm run migration:import -- --verify   --from <export-dir> --confirm-project-ref <ref>
 *
 * Environment (never in source, never printed, never committed):
 *   GOOGLE_APPLICATION_CREDENTIALS   path to a READ-ONLY Firebase service-account key (role: Cloud Datastore Viewer). Export only.
 *   SUPABASE_URL                     the target project URL
 *   SUPABASE_SERVICE_ROLE_KEY        the target's service-role key. Import, verify and schema check only.
 *   FIRESTORE_EMULATOR_HOST          tests only, with a demo-* project id
 *
 * --import requires an export directory (so it imports exactly what a dry run validated), the target project ref typed
 * out, and an explicit acknowledgement. It refuses to run if validation has errors or the schema does not match.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { exportFirestore, serviceAccountTokenProvider } from "./migration/export.mjs"
import { createExportWriter, loadExport, writeJson, writeNdjson, writeText } from "./migration/io.mjs"
import { transformExport } from "./migration/transform.mjs"
import { validate } from "./migration/validate.mjs"
import { buildSummary, renderReport } from "./migration/report.mjs"
import { checkSchema, createPostgrest, projectRefOf, redactor, runImport, runVerify } from "./migration/supabase-import.mjs"

const args = process.argv.slice(2)
const flag = (n) => args.includes(`--${n}`)
const opt = (n) => {
  const i = args.indexOf(`--${n}`)
  return i >= 0 ? args[i + 1] : undefined
}
const modes = ["dry-run", "import", "verify", "check-schema"].filter(flag)
const log = (m) => console.log(m)
const redact = redactor(process.env.SUPABASE_SERVICE_ROLE_KEY)
const die = (m, code = 1) => {
  console.error(redact(m))
  process.exit(code)
}

if (modes.length !== 1) die("Choose exactly one mode: --dry-run, --import, --verify or --check-schema. Nothing was done.", 2)
const mode = modes[0]

function targetClient() {
  const url = process.env.SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) die("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the environment.", 2)
  const confirmed = opt("confirm-project-ref")
  if (!confirmed || confirmed !== projectRefOf(url)) die(`--confirm-project-ref must be given and equal the target project ref (${projectRefOf(url)}). Nothing was done.`, 2)
  return createPostgrest({ url, serviceKey })
}

function process_(dir, loaded) {
  const result = transformExport(loaded.records, { exportedAt: loaded.manifest.finishedAt ?? loaded.manifest.exportedAt })
  const validation = validate({ manifest: loaded.manifest, records: loaded.records, result, integrity: loaded.integrity })
  return { result, validation }
}

async function main() {
  if (mode === "check-schema") {
    const problems = await checkSchema(targetClient())
    if (problems.length) die(`SCHEMA MISMATCH, stop before importing:\n- ${problems.join("\n- ")}`)
    return log("Schema matches the intended migration schema (10 tables, required columns present). Nothing was written.")
  }

  let dir = opt("from")
  let loaded
  if (dir) loaded = loadExport(dir)
  else {
    if (mode !== "dry-run") die(`--${mode} needs --from <export-dir> (an export that a dry run validated). Nothing was done.`, 2)
    const projectId = opt("project") ?? process.env.FIREBASE_PROJECT_ID
    if (!projectId) die("--project <firebase-project-id> is required for an export. Nothing was done.", 2)
    const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST
    let getToken
    if (emulatorHost) getToken = async () => "owner"
    else {
      const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS
      if (!keyFile) die("GOOGLE_APPLICATION_CREDENTIALS must point at a read-only Firebase service-account key. Nothing was done.", 2)
      getToken = serviceAccountTokenProvider(JSON.parse(readFileSync(keyFile, "utf8")), projectId)
    }
    dir = opt("out") ?? join("migration-output", new Date().toISOString().replace(/[:.]/g, "-"))
    const writer = createExportWriter(dir)
    const manifest = await exportFirestore({ projectId, getToken, emulatorHost, writeLine: writer.writeLine, log })
    await writer.finish(manifest)
    loaded = loadExport(dir)
  }

  const { result, validation } = process_(dir, loaded)
  let summary = buildSummary({ mode, manifest: loaded.manifest, result, validation })
  writeNdjson(dir, "rejects.ndjson", result.tables.quarantined_records)
  writeText(dir, "report.md", renderReport(summary))
  writeJson(dir, "summary.json", summary)

  if (mode === "dry-run") {
    log(`DRY RUN complete. ${validation.ok ? "Validation PASSED" : "Validation FAILED"}. Nothing was written to Supabase. Report: ${join(dir, "report.md")}`)
    validation.warnings.forEach((w) => log(`  warning: ${w}`))
    return process.exit(validation.ok ? 0 : 1)
  }

  if (!validation.ok) die(`Validation FAILED, refusing to touch Supabase:\n- ${validation.errors.join("\n- ")}`)
  const pg = targetClient()

  if (mode === "verify") {
    const verify = await runVerify(pg, result, loaded.records)
    summary = buildSummary({ mode, manifest: loaded.manifest, result, validation, verify })
    writeText(dir, "verify-report.md", renderReport(summary))
    writeJson(dir, "verify-summary.json", summary)
    verify.checks.filter((c) => c.status !== "PASS").forEach((c) => log(`${c.status}  ${c.table}.${c.name}  ${c.detail}`))
    log(verify.ok ? "VERIFY: PASS" : `VERIFY: FAIL (${verify.failed} check(s))`)
    return process.exit(verify.ok ? 0 : 1)
  }

  // --import
  if (!flag("yes-supabase-is-a-copy")) die("--import also needs --yes-supabase-is-a-copy (Supabase is not authoritative; Firebase stays the source of truth). Nothing was done.", 2)
  const problems = await checkSchema(pg)
  if (problems.length) die(`SCHEMA MISMATCH, stopping before any write:\n- ${problems.join("\n- ")}`)
  if (result.findings.quarantinedAnsweredPings.length) log(`LOUD: ${result.findings.quarantinedAnsweredPings.length} answered-but-unprocessed Ping(s) are quarantined and hold unapplied favours.`)
  const imp = await runImport(pg, result, { log })
  const verify = await runVerify(pg, result, loaded.records)
  summary = buildSummary({ mode, manifest: loaded.manifest, result, validation, import: imp, verify })
  writeText(dir, "import-report.md", renderReport(summary))
  writeJson(dir, "import-summary.json", summary)
  log(imp.errors.length ? `IMPORT finished with ${imp.errors.length} error(s)` : "IMPORT finished without errors")
  log(verify.ok ? "VERIFY: PASS" : `VERIFY: FAIL (${verify.failed} check(s))`)
  process.exit(imp.errors.length === 0 && verify.ok ? 0 : 1)
}

main().catch((e) => die(`FAILED: ${e.message}`))
