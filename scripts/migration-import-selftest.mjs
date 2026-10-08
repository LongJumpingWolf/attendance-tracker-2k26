#!/usr/bin/env node
/**
 * End-to-end self test of the import tooling against LOCAL systems only: the Firestore emulator (seeded with fixtures,
 * then exported read-only) and the local Supabase stack. It refuses to run against anything else.
 *
 *   firebase emulators:exec --only firestore --project demo-import "node scripts/migration-import-selftest.mjs"
 *   (with SUPABASE_URL=http://127.0.0.1:54321 and SUPABASE_SERVICE_ROLE_KEY from `npx supabase status -o env`)
 *
 * Seeds fixtures, exports, transforms, validates, imports, verifies, imports AGAIN (idempotency: nothing may change),
 * verifies again, then empties the local tables. No production system, credential or data is involved.
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { exportFirestore } from "./migration/export.mjs"
import { createExportWriter, loadExport } from "./migration/io.mjs"
import { transformExport } from "./migration/transform.mjs"
import { validate } from "./migration/validate.mjs"
import { checkSchema, createPostgrest, runImport, runVerify } from "./migration/supabase-import.mjs"

const host = process.env.FIRESTORE_EMULATOR_HOST
const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!host || !/^(127\.0\.0\.1|localhost)/.test(host)) throw new Error("run under the Firestore emulator (FIRESTORE_EMULATOR_HOST)")
if (!url || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(url) || !key) throw new Error("SUPABASE_URL must be the LOCAL Supabase and SUPABASE_SERVICE_ROLE_KEY set")
const PROJECT = "demo-import"

const s = (v) => ({ stringValue: v })
const i = (n) => ({ integerValue: String(n) })
const ts = (iso) => ({ timestampValue: iso })
const arr = (...v) => ({ arrayValue: { values: v } })
const map = (o) => ({ mapValue: { fields: o } })
const item = (n, answer) => map({ key: s(`k${n}@09:00`), subjectId: s(`s${n}`), name: s(`Subject ${n}`), t: s("09:00"), answer: answer === undefined ? { nullValue: null } : s(answer) })

const A = "uidAlice00000000000000000001"
const B = "uidBob0000000000000000000002"
const C = "uidCarol000000000000000000003"
const D = "uidDave0000000000000000000004"
const PAST = "2026-09-01T10:00:00.000000Z"
const blob = "gz1:H4sIAAAAAAAAA+3 +/= é中 \"q\" \\ \n\t  {not json}  "
const plain = '{"v":1,"note":"  keeps   whitespace é "}'

const fixtures = {
  users: { [A]: { name: s("Alice"), updatedAt: ts(PAST) }, [B]: { name: s("Bob"), updatedAt: ts(PAST) }, [C]: { name: s("") } },
  invites: { inviteTokenAAAAAAAA: { owner: s(A), ownerName: s("Alice"), expiresAt: ts("2026-09-01T10:15:00.000Z"), createdAt: ts(PAST) } },
  requests: {
    reqAcceptedAB000000001: { from: s(A), to: s(B), fromName: s("Alice"), toName: s("Bob"), participants: arr(s(A), s(B)), status: s("accepted"), createdAt: ts("2026-08-01T10:00:00Z") },
    reqPendingBA0000000002: { from: s(B), to: s(A), fromName: s("Bob"), toName: s("Alice"), participants: arr(s(B), s(A)), status: s("pending"), createdAt: ts("2026-08-02T10:00:00Z") },
    reqPendingCD0000000003: { from: s(C), to: s(D), participants: arr(s(C), s(D)), status: s("pending"), createdAt: ts("2026-08-03T10:00:00Z") },
    reqPendingCD0000000004: { from: s(C), to: s(D), participants: arr(s(C), s(D)), status: s("pending"), createdAt: ts("2026-08-04T10:00:00Z") },
    reqBadStatus0000000005: { from: s(A), to: s(C), status: s("weird") },
  },
  pings: {
    pingNormal000001: { from: s(A), to: s(B), fromName: s("Alice"), toName: s("Bob"), participants: arr(s(A), s(B)), requestId: s("reqAcceptedAB000000001"), date: s("2026-09-01"), items: arr(item(1)), status: s("asking"), createdAt: ts(PAST) },
    pingTwelve000001: { from: s(A), to: s(B), fromName: s("Alice"), toName: s("Bob"), participants: arr(s(A), s(B)), requestId: s("reqAcceptedAB000000001"), date: s("2026-09-01"), items: arr(...Array.from({ length: 12 }, (_, n) => item(n))), status: s("asking"), createdAt: ts(PAST) },
    pingOldDate00001: { from: s(A), to: s(B), participants: arr(s(A), s(B)), requestId: s("reqGoneNoSuchRequest"), date: s("9/5/2026 (Sat)"), items: arr(item(1, "yes")), status: s("processed"), processedAt: ts(PAST) },
    pingAnswered0001: { from: s(A), to: s(B), fromName: s("Alice"), toName: s("Bob"), participants: arr(s(A), s(B)), requestId: s("reqAcceptedAB000000001"), date: s("2026-09-01"), items: arr(item(1, "yes")), status: s("answered"), createdAt: ts(PAST), respondedAt: ts(PAST), claimedBy: s("deviceAAAAAAAA"), claimedAt: ts(PAST) },
    pingForged000001: { from: s(A), to: s(B), participants: arr(s(B), s(A)), requestId: s("reqAcceptedAB000000001"), date: s("2026-09-01"), items: arr(item(1)), status: s("asking"), createdAt: ts(PAST) },
  },
  pushTokens: { [A]: { token: s("same-token-value-for-two-accounts"), updatedAt: ts(PAST) }, [B]: { token: s("same-token-value-for-two-accounts"), updatedAt: ts(PAST) } },
  syncs: { [A]: { data: s(blob), rev: i(3), updatedAt: i(1788000000000) }, [B]: { data: s(plain), rev: i(1), updatedAt: i(1788000000001) } },
}

async function seed() {
  for (const [collection, docs] of Object.entries(fixtures)) {
    for (const [id, fields] of Object.entries(docs)) {
      const res = await fetch(`http://${host}/v1/projects/${PROJECT}/databases/(default)/documents/${collection}/${id}`, {
        method: "PATCH", // the EMULATOR only (host checked above)
        headers: { authorization: "Bearer owner", "content-type": "application/json" },
        body: JSON.stringify({ fields }),
      })
      if (!res.ok) throw new Error(`seeding ${collection}/${id} failed: ${res.status}`)
    }
  }
}

const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${detail ? ` (${detail})` : ""}`)
  if (!ok) process.exitCode = 1
}

await seed()
const dir = mkdtempSync(join(tmpdir(), "import-selftest-"))
const writer = createExportWriter(dir)
const manifest = await exportFirestore({ projectId: PROJECT, getToken: async () => "owner", emulatorHost: host, writeLine: writer.writeLine })
await writer.finish(manifest)
check("export is read-only and complete", manifest.writes === 0 && manifest.deletes === 0 && manifest.totalDocuments === 18, `${manifest.totalDocuments} documents, ${manifest.httpGets} GETs`)

const loaded = loadExport(dir)
const result = transformExport(loaded.records, { exportedAt: manifest.finishedAt })
const validation = validate({ manifest: loaded.manifest, records: loaded.records, result, integrity: loaded.integrity })
check("validation passes", validation.ok, validation.errors.join("; "))
check("conservation holds", Object.values(validation.conservation).every((c) => c.ok))
check("sync documents byte-identical", validation.syncChecks.length === 2 && validation.syncChecks.every((x) => x.same))

const pg = createPostgrest({ url, serviceKey: key })
const problems = await checkSchema(pg)
check("target schema matches", problems.length === 0, problems.join("; "))

const first = await runImport(pg, result, {})
check("first import without errors", first.errors.length === 0, first.errors.join("; "))
const v1 = await runVerify(pg, result, loaded.records)
check("verify passes after import", v1.ok, v1.checks.filter((c) => c.status === "FAIL").map((c) => `${c.table}.${c.name}`).join(","))

const dump = async () => JSON.stringify(await Promise.all(["profiles", "invites", "connections", "legacy_requests", "connection_aliases", "pings", "push_tokens", "syncs", "quarantined_records"].map((t) => pg.selectAll(t, "*", t === "quarantined_records" ? "id" : ""))), (k, v) => (k === "created_at" || k === "imported_at" ? undefined : v))
const before = await dump()
const second = await runImport(pg, result, {})
check("second import without errors", second.errors.length === 0)
check("second import changes nothing (idempotent)", before === (await dump()))
check("second import left every sync document unchanged", second.syncs.inserted === 0 && second.syncs.updated === 0)
const v2 = await runVerify(pg, result, loaded.records)
check("verify passes after the second import", v2.ok)

// a copy that is ahead must never be moved backwards
const ahead = createPostgrest({ url, serviceKey: key })
await ahead.call("PATCH", "syncs", `uid=eq.${A}`, { rev: 9 })
const third = await runImport(pg, result, {})
check("a target that is ahead is left alone and reported", third.syncs.targetAhead === 1 && (await pg.selectAll("syncs", "uid,rev")).find((r) => r.uid === A).rev === 9)

// empty the LOCAL tables (docker exec into the local database container)
execFileSync("docker", ["exec", "supabase_db_Attendance_tracker", "psql", "-U", "postgres", "-q", "-c", "truncate public.profiles, public.invites, public.connection_aliases, public.legacy_requests, public.connections, public.pings, public.push_tokens, public.syncs, public.quarantined_records restart identity"])
console.log(process.exitCode ? "SELFTEST FAILED" : "SELFTEST PASSED")
