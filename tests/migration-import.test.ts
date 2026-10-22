/**
 * Phase 6C: the initial-import tooling (scripts/migration/*). Pure transformation, validation, the read-only exporter, the
 * idempotent importer and the verifier, all with fakes. No network, no Firebase, no Supabase, no credentials.
 */
import { describe, expect, it } from "vitest"
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { exportFirestore, serviceAccountTokenProvider, COLLECTIONS } from "../scripts/migration/export.mjs"
import { createExportWriter, loadExport } from "../scripts/migration/io.mjs"
import { transformExport } from "../scripts/migration/transform.mjs"
import { validate } from "../scripts/migration/validate.mjs"
import { buildSummary, renderReport } from "../scripts/migration/report.mjs"
import { checkSchema, createPostgrest, redactor, REQUIRED_COLUMNS, runImport, runVerify } from "../scripts/migration/supabase-import.mjs"
import { decodeFields } from "../scripts/migration/firestore-values.mjs"

const ROOT = path.resolve(import.meta.dirname, "..")
const EXPORTED_AT = "2026-10-08T12:00:00.000Z"
const PAST = "2026-09-01T10:00:00.000000Z"

// ---- typed Firestore values and records ---------------------------------------------------------------------------
type F = Record<string, unknown>
const s = (v: string) => ({ stringValue: v })
const n = (v: number) => ({ integerValue: String(v) })
const t = (iso: string) => ({ timestampValue: iso })
const arr = (...v: unknown[]) => ({ arrayValue: { values: v } })
const map = (o: F) => ({ mapValue: { fields: o } })
const nul = { nullValue: null }
const rec = (collection: string, id: string, fields: F) => ({ collection, id, createTime: PAST, updateTime: PAST, fields })
const item = (k: number, answer?: string | null) => map({ key: s(`k${k}`), subjectId: s(`s${k}`), name: s(`S${k}`), t: s("09:00"), answer: answer == null ? nul : s(answer) })

const A = "uidAlice00000000000000000001"
const B = "uidBob0000000000000000000002"
const C = "uidCarol000000000000000000003"
const D = "uidDave0000000000000000000004"

const req = (id: string, from: string, to: string, status: string, created?: string) =>
  rec("requests", id, { from: s(from), to: s(to), fromName: s("F"), toName: s("T"), participants: arr(s(from), s(to)), status: s(status), ...(created ? { createdAt: t(created) } : {}) })
const pingFields = (over: F = {}): F => ({
  from: s(A), to: s(B), fromName: s("Alice"), toName: s("Bob"), participants: arr(s(A), s(B)), requestId: s("reqOK"), date: s("2026-09-01"),
  items: arr(item(1)), status: s("asking"), createdAt: t(PAST), ...over,
})
const ping = (id: string, over: F = {}) => rec("pings", id, pingFields(over))

// The modules are plain JavaScript; the tests read nested rows freely, so results are typed loosely on purpose
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>
type Recs = Record<string, ReturnType<typeof rec>[]>
const empty = (): Recs => Object.fromEntries(COLLECTIONS.map((c: string) => [c, []]))
const run = (r: Partial<Recs>) => {
  const records = { ...empty(), ...r } as Recs
  const result = transformExport(records, { exportedAt: EXPORTED_AT }) as unknown as Row
  const manifest = { collections: Object.fromEntries(COLLECTIONS.map((c: string) => [c, { count: records[c].length, digest: "x" }])) }
  const validation = validate({ manifest, records, result: result as never }) as Row
  return { records, result, validation }
}

// =====================================================================================================================
describe("1-2. profiles and invites", () => {
  it("a profile keeps the Firebase uid as its key and copies the name and time as they are", () => {
    const { result } = run({ users: [rec("users", A, { name: s("Alice"), updatedAt: t(PAST) })] })
    expect(result.tables.profiles).toEqual([{ uid: A, name: "Alice", updated_at: PAST }])
  })
  it("a profile the CHECK would refuse is quarantined with its complete original, never altered", () => {
    const { result } = run({ users: [rec("users", B, { name: s("") }), rec("users", C, { name: s("x".repeat(41)) }), rec("users", D, {})] })
    expect(result.tables.profiles).toEqual([])
    expect(result.tables.quarantined_records.map((q: { doc_id: string; reasons: string[] }) => [q.doc_id, q.reasons])).toEqual([[B, ["profile-name-invalid"]], [C, ["profile-name-invalid"]], [D, ["profile-name-invalid"]]])
    expect(result.tables.quarantined_records[0].raw.fields).toEqual({ name: s("") })
  })
  it("an invite keeps its token, owner and expiry; an already expired invite is imported, not dropped", () => {
    const { result } = run({ invites: [rec("invites", "tokExpired0000000001", { owner: s(A), ownerName: s("Alice"), expiresAt: t("2020-01-01T00:00:00Z"), createdAt: t(PAST) })] })
    expect(result.tables.invites).toEqual([{ token: "tokExpired0000000001", owner: A, owner_name: "Alice", expires_at: "2020-01-01T00:00:00Z", created_at: PAST }])
  })
  it("an invite without an expiry cannot satisfy NOT NULL: it is quarantined, not given an invented one", () => {
    const { result } = run({ invites: [rec("invites", "tokNoExpiry00000001", { owner: s(A) })] })
    expect(result.tables.invites).toEqual([])
    expect(result.tables.quarantined_records[0].reasons).toEqual(["invite-expiry-missing"])
  })
})

describe("3. duplicate friend requests (decision 2a)", () => {
  it("accepted beats pending; the others are archived verbatim with an alias; nothing is deleted", () => {
    const { result, validation } = run({
      requests: [
        req("reqPendingAB", A, B, "pending", "2026-08-01T00:00:00Z"),
        req("reqAcceptedBA", B, A, "accepted", "2026-08-05T00:00:00Z"),
        req("reqDeclinedAB", A, B, "declined", "2026-07-01T00:00:00Z"),
      ],
    })
    expect(result.tables.connections.map((r: { id: string }) => r.id)).toEqual(["reqAcceptedBA", "reqDeclinedAB"])
    expect(result.tables.legacy_requests.map((r: { id: string }) => r.id)).toEqual(["reqPendingAB"])
    expect(result.tables.legacy_requests[0].raw.fields.status).toEqual(s("pending")) // the complete original, typed
    expect(result.tables.connection_aliases).toEqual([{ legacy_id: "reqPendingAB", canonical_id: "reqAcceptedBA", reason: "D-3", note: expect.any(String) }])
    expect(validation.ok).toBe(true)
  })
  it("two accepted (D-4), same direction (D-1) and opposite direction (D-2) follow the fixed canonical order", () => {
    const { result } = run({
      requests: [
        req("reqZ", A, B, "accepted", "2026-08-01T00:00:00Z"),
        req("reqY", B, A, "accepted", "2026-08-01T00:00:00Z"), // same time: smallest id wins
        req("reqP1", C, D, "pending", "2026-08-01T00:00:00Z"),
        req("reqP2", C, D, "pending", "2026-08-02T00:00:00Z"),
        req("reqP3", D, C, "pending"), // no createdAt sorts last
      ],
    })
    expect(result.tables.connections.map((r: { id: string }) => r.id)).toEqual(["reqP1", "reqY"])
    const reasons = Object.fromEntries(result.tables.connection_aliases.map((a: { legacy_id: string; reason: string }) => [a.legacy_id, a.reason]))
    expect(reasons).toEqual({ reqZ: "D-4", reqP2: "D-1", reqP3: "D-2" })
    expect(result.findings.duplicatePairs).toHaveLength(2)
  })
  it("a pair with one live request and any number of declined ones is not a duplicate: all import as they are", () => {
    const { result } = run({ requests: [req("r1", A, B, "declined"), req("r2", A, B, "declined"), req("r3", B, A, "pending")] })
    expect(result.tables.connections).toHaveLength(3)
    expect(result.tables.legacy_requests).toHaveLength(0)
  })
  it("a request with an unknown status or no participant is quarantined", () => {
    const { result } = run({ requests: [rec("requests", "reqBad1", { from: s(A), to: s(B), status: s("weird") }), rec("requests", "reqBad2", { status: s("pending") })] })
    expect(result.tables.connections).toEqual([])
    expect(result.tables.quarantined_records.map((q: { reasons: string[] }) => q.reasons[0]).sort()).toEqual(["request-participant-missing", "request-status-invalid"])
  })
})

describe("4-7. Pings (decision 2b)", () => {
  const known = [req("reqOK", A, B, "accepted", "2026-08-01T00:00:00Z")]
  it("a current Ping imports as a normal row, with its id, dates and items exactly as exported", () => {
    const { result } = run({ requests: known, pings: [ping("ping-AB-00000001")] })
    const p = result.tables.pings[0]
    expect(p).toMatchObject({ id: "ping-AB-00000001", from_uid: A, to_uid: B, request_id: "reqOK", class_date: "2026-09-01", status: "asking", created_at: PAST, legacy: false, legacy_flags: [] })
    expect(p.items).toEqual((decodeFields({ i: arr(item(1)) }) as Row).i)
  })
  it("4. a legacy Ping with more than 8 items is preserved intact and flagged, never truncated", () => {
    const items = Array.from({ length: 12 }, (_, k) => item(k))
    const { result, validation } = run({ requests: known, pings: [ping("pingTwelve0001", { items: arr(...items) })] })
    expect(result.tables.pings[0].items).toHaveLength(12)
    expect(result.tables.pings[0]).toMatchObject({ legacy: true, legacy_flags: ["items>8"] })
    expect(validation.ok).toBe(true)
  })
  it("5. an old Ping date format is kept as the text it was, and a missing createdAt stays null", () => {
    const { result } = run({ requests: known, pings: [ping("pingOldDate0001", { date: s("9/5/2026 (Sat)"), createdAt: nul })] })
    expect(result.tables.pings[0]).toMatchObject({ class_date: "9/5/2026 (Sat)", created_at: null, legacy: true })
    expect(result.tables.pings[0].legacy_flags.sort()).toEqual(["date-format", "no-created-at"])
  })
  it("6. an answered-but-unprocessed Ping stays answered (finalizable); only its short lease is cleared", () => {
    const { result } = run({ requests: known, pings: [ping("pingAnswered001", { status: s("answered"), items: arr(item(1, "yes")), respondedAt: t(PAST), claimedBy: s("deviceAAAAAAAA"), claimedAt: t(PAST) })] })
    expect(result.tables.pings[0]).toMatchObject({ status: "answered", responded_at: PAST, claimed_by: null, claimed_at: null, processed_at: null })
    expect(result.findings.leaseCleared).toBe(1)
  })
  it("6b. a forged Ping is quarantined, and an answered one is reported separately and loudly", () => {
    const { result, validation } = run({
      requests: known,
      pings: [
        ping("pingForgedAns01", { status: s("answered"), participants: arr(s(B), s(A)) }),
        ping("pingFuture00001", { createdAt: t("2030-01-01T00:00:00Z") }),
        ping("pingSelf0000001", { to: s(A), participants: arr(s(A), s(A)) }),
        ping("pingBadStatus01", { status: s("weird") }),
        ping("pingBadAnswer01", { status: s("answered"), items: arr(item(1, "maybe")) }),
        ping("short", {}),
      ],
    })
    expect(result.tables.pings).toEqual([])
    expect(result.tables.quarantined_records).toHaveLength(6)
    expect(result.findings.quarantinedAnsweredPings).toContain("pingForgedAns01")
    expect(validation.warnings.some((w: string) => w.startsWith("LOUD"))).toBe(true)
    expect(result.tables.quarantined_records.find((q: { doc_id: string }) => q.doc_id === "pingFuture00001").reasons).toEqual(["created-after-export"])
  })
  it("7. a Ping whose request is missing, declined or archived is imported and flagged; no foreign key can reject it", () => {
    const { result, validation } = run({ requests: known, pings: [ping("pingNoRequest01", { requestId: s("reqLongGone") }), ping("pingNoRequestId1", { requestId: nul })] })
    expect(result.tables.pings.map((p: { legacy_flags: string[] }) => p.legacy_flags)).toEqual([["request-missing"], ["request-missing"]])
    expect(validation.referential.pingsWithMissingRequest).toBe(2)
    expect(validation.ok).toBe(true)
    const archived = run({ requests: [req("reqOK", A, B, "accepted", "2026-08-01T00:00:00Z"), req("reqDup", A, B, "pending", "2026-08-02T00:00:00Z")], pings: [ping("pingViaAlias001", { requestId: s("reqDup") })] })
    expect(archived.result.tables.pings[0].legacy).toBe(false) // the archived id is still a request that exists in the export
  })
  it("name length, item shape and extra item fields are flagged, not rejected", () => {
    const { result } = run({ requests: known, pings: [ping("pingShape000001", { fromName: s("x".repeat(41)), items: arr(map({ key: s("k"), subjectId: s("s"), name: s("n"), extra: s("e") })) })] })
    expect(result.tables.pings[0].legacy_flags.sort()).toEqual(["item-shape", "name-length"])
  })
})

describe("8. push tokens", () => {
  it("one row per account, device 'legacy'; two accounts with the same token string are never merged", () => {
    const { result } = run({ pushTokens: [rec("pushTokens", A, { token: s("same-token"), updatedAt: t(PAST) }), rec("pushTokens", B, { token: s("same-token") })] })
    expect(result.tables.push_tokens).toEqual([
      { uid: A, device_id: "legacy", token: "same-token", updated_at: PAST },
      { uid: B, device_id: "legacy", token: "same-token", updated_at: null },
    ])
  })
  it("a token the CHECK would refuse is quarantined", () => {
    const { result } = run({ pushTokens: [rec("pushTokens", A, { token: s("") }), rec("pushTokens", B, { token: s("x".repeat(4096)) })] })
    expect(result.tables.push_tokens).toEqual([])
    expect(result.tables.quarantined_records).toHaveLength(2)
  })
})

describe("9-10. sync documents are copied byte for byte", () => {
  const awkward = ["gz1:H4sIAAAAAAAA/+3 +/= é中", '  {"v":1,\n "x":"a\\"b"}  \n\t', "gz1:AAAA\r\nBBBB", "   😀 emoji", "   "]
  it("the stored text, the revision and the SHA-256 are identical for strings with whitespace, newlines, quotes and non-ASCII", () => {
    const syncs = awkward.map((d, i) => rec("syncs", `${A}${i}`, { data: s(d), rev: n(i + 1), updatedAt: n(1788000000000 + i) }))
    const { result, validation } = run({ syncs })
    expect(validation.ok).toBe(true)
    result.tables.syncs.forEach((row: { uid: string; data: string; rev: number; updated_at: number }, i: number) => {
      expect(row.data).toBe(awkward[i])
      expect(row.rev).toBe(i + 1)
      expect(row.updated_at).toBe(1788000000000 + i)
      const sha = (x: string) => crypto.createHash("sha256").update(Buffer.from(x, "utf8")).digest("hex")
      expect(sha(row.data)).toBe(sha(awkward[i]))
    })
    expect(validation.syncChecks.every((c: { same: boolean }) => c.same)).toBe(true)
  })
  it("a changed byte is caught: the validator refuses a transformed row that differs from the source", () => {
    const records = { ...empty(), syncs: [rec("syncs", A, { data: s("gz1:abc"), rev: n(2) })] } as Recs
    const result = transformExport(records, { exportedAt: EXPORTED_AT }) as unknown as Row
    result.tables.syncs[0].data = "gz1:abc " // one trailing space
    const v = validate({ manifest: { collections: { syncs: { count: 1 } } }, records, result: result as never })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toMatch(/sync document was changed/)
    result.tables.syncs[0].data = "gz1:abc"
    result.tables.syncs[0].rev = 3
    expect(validate({ manifest: { collections: { syncs: { count: 1 } } }, records, result: result as never }).errors.join()).toMatch(/sync document was changed/)
  })
  it("a sync document with no usable revision or text is quarantined, never repaired", () => {
    const { result } = run({ syncs: [rec("syncs", A, { data: s("x"), rev: n(0) }), rec("syncs", B, { data: n(5), rev: n(1) })] })
    expect(result.tables.syncs).toEqual([])
    expect(result.tables.quarantined_records.map((q: { reasons: string[] }) => q.reasons[0]).sort()).toEqual(["sync-data-not-a-string", "sync-rev-invalid"])
  })
  it("a NUL character (which PostgreSQL cannot store) is a validation error, not a silent change", () => {
    const { validation } = run({ syncs: [rec("syncs", A, { data: s("a\u0000b"), rev: n(1) })] })
    expect(validation.ok).toBe(false)
    expect(validation.errors.join()).toMatch(/NUL/)
  })
})

describe("11-14. determinism, rejects, conservation, no invented ids", () => {
  const mixed = (): Partial<Recs> => ({
    users: [rec("users", A, { name: s("Alice") }), rec("users", B, { name: s("") })],
    requests: [req("reqOK", A, B, "accepted", "2026-08-01T00:00:00Z"), req("reqDup", B, A, "pending"), rec("requests", "reqBad", { status: s("pending") })],
    pings: [ping("pingGood000001"), ping("pingBad0000001", { status: s("weird") })],
    pushTokens: [rec("pushTokens", A, { token: s("tok") })],
    syncs: [rec("syncs", A, { data: s("gz1:x"), rev: n(1) })],
    invites: [rec("invites", "tokInvite0000001", { owner: s(A), expiresAt: t(PAST) })],
  })
  it("11. the transformation is idempotent: the same input twice gives identical output, and the input is untouched", () => {
    const input = mixed() as Recs
    const before = JSON.stringify(input)
    const one = transformExport({ ...empty(), ...input }, { exportedAt: EXPORTED_AT })
    const two = transformExport({ ...empty(), ...input }, { exportedAt: EXPORTED_AT })
    expect(JSON.stringify(one.tables)).toBe(JSON.stringify(two.tables))
    expect(JSON.stringify(input)).toBe(before)
  })
  it("12. every reject is listed with its reasons and the complete original document", () => {
    const { result } = run(mixed())
    expect(result.tables.quarantined_records.map((q: { collection: string; doc_id: string }) => `${q.collection}/${q.doc_id}`)).toEqual(["pings/pingBad0000001", "requests/reqBad", "users/" + B])
    for (const q of result.tables.quarantined_records) {
      expect(q.reasons.length).toBeGreaterThan(0)
      expect(q.raw.fields).toBeTruthy()
      expect(q.exported_at).toBe(EXPORTED_AT)
    }
  })
  it("13. source count = accepted + archived + rejected, for every collection, and nothing is placed twice", () => {
    const { validation } = run(mixed())
    expect(validation.ok).toBe(true)
    expect(validation.conservation.users).toMatchObject({ exported: 2, accepted: 1, rejected: 1 })
    expect(validation.conservation.requests).toMatchObject({ exported: 3, accepted: 1, archived: 1, rejected: 1 })
    expect(validation.conservation.pings).toMatchObject({ exported: 2, accepted: 1, rejected: 1 })
    for (const c of Object.values(validation.conservation) as { exported: number; accepted: number; archived: number; rejected: number }[]) expect(c.accepted + c.archived + c.rejected).toBe(c.exported)
  })
  it("13b. a record that disappears is a loud error", () => {
    const records = { ...empty(), ...mixed() } as Recs
    const result = transformExport(records, { exportedAt: EXPORTED_AT }) as unknown as Row
    result.tables.pings = []
    const v = validate({ manifest: { collections: Object.fromEntries(COLLECTIONS.map((c: string) => [c, { count: records[c].length }])) }, records, result: result as never })
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toMatch(/placed 0 times/)
  })
  it("14. no id is ever generated: every output key is a source id, and an injected one is caught", () => {
    const { records, result, validation } = run(mixed())
    expect(validation.ok).toBe(true)
    const ids = new Set(Object.values(records).flat().map((r) => r.id))
    for (const row of result.tables.profiles as Row[]) expect(ids.has(row.uid)).toBe(true)
    for (const row of [...result.tables.connections, ...result.tables.legacy_requests, ...result.tables.pings] as Row[]) expect(ids.has(row.id)).toBe(true)
    for (const row of result.tables.connection_aliases as Row[]) expect(ids.has(row.legacy_id) && ids.has(row.canonical_id)).toBe(true)
    for (const row of result.tables.quarantined_records as Row[]) expect(ids.has(row.doc_id)).toBe(true)
    result.tables.profiles.push({ uid: "uidInvented0000000000000000", name: "X", updated_at: null })
    const v = validate({ manifest: { collections: Object.fromEntries(COLLECTIONS.map((c: string) => [c, { count: records[c].length }])) }, records, result: result as never })
    expect(v.errors.join()).toMatch(/not in the export/)
  })
})

// =====================================================================================================================
describe("15. secrets never reach a message, a report or a summary", () => {
  it("the redactor removes the service key, JWTs, Supabase keys and private keys", () => {
    const key = "super-secret-service-role-key-value-123456"
    const red = redactor(key)
    const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJyb2xlIjoic2VydmljZV9yb2xlIn0", "c2lnbmF0dXJl"].join(".") // dummy, built at run time so no secret-looking text sits in the repository
    const text = `boom ${key} and ${jwt} and ${"sb_" + "secret_abcdef123456"} and ${"-----BEGIN " + "PRIVATE KEY-----"}
MIIEvQ
${"-----END " + "PRIVATE KEY-----"}`
    const out = red(text)
    for (const bad of [key, jwt, "sb_" + "secret_abcdef123456", "MIIEvQ"]) expect(out).not.toContain(bad)
  })
  it("an importer failure message never contains the key, even if the server echoes it", async () => {
    const key = "super-secret-service-role-key-value-123456"
    const pg = createPostgrest({ url: "http://x.test", serviceKey: key, fetchFn: (async () => new Response(JSON.stringify({ code: "42501", message: key }), { status: 403 })) as unknown as typeof fetch })
    const result = run({ users: [rec("users", A, { name: s("Alice") })] }).result
    const report = await runImport(pg, result, {})
    expect(report.errors.length).toBeGreaterThan(0)
    expect(JSON.stringify(report)).not.toContain(key)
  })
  it("the report and the summary hold no name, token, sync data or full uid", () => {
    const { records, result, validation } = run({
      users: [rec("users", A, { name: s("Secret Person Name") })],
      pushTokens: [rec("pushTokens", A, { token: s("FCM-TOKEN-SECRET-VALUE") })],
      syncs: [rec("syncs", A, { data: s("gz1:USER-BACKUP-BLOB"), rev: n(1) })],
      requests: [req("reqOK", A, B, "accepted"), req("reqDup", A, B, "pending")],
    })
    const summary = buildSummary({ mode: "dry-run", manifest: { source: { projectId: "p", database: "(default)" }, exportedAt: EXPORTED_AT, finishedAt: EXPORTED_AT, totalDocuments: 5, httpGets: 1, writes: 0, deletes: 0, collections: {} }, result, validation })
    const text = JSON.stringify(summary) + renderReport(summary)
    for (const secret of ["Secret Person Name", "FCM-TOKEN-SECRET-VALUE", "USER-BACKUP-BLOB", A, B, "reqOK", "reqDup"]) expect(text, secret).not.toContain(secret)
    expect(records.users).toHaveLength(1)
  })
})

// =====================================================================================================================
describe("the exporter is read-only, complete and deterministic", () => {
  const doc = (collection: string, id: string, fields: F) => ({ name: `projects/p/databases/(default)/documents/${collection}/${id}`, fields, createTime: PAST, updateTime: PAST })
  function fakeFirestore(data: Record<string, ReturnType<typeof doc>[]>) {
    const calls: { method: string; url: string }[] = []
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url })
      const u = new URL(url)
      const collection = u.pathname.split("/").pop() as string
      const all = data[collection] ?? []
      const size = Number(u.searchParams.get("pageSize"))
      const start = Number(u.searchParams.get("pageToken") ?? 0)
      const page = all.slice(start, start + size)
      const next = start + size < all.length ? { nextPageToken: String(start + size) } : {}
      return new Response(JSON.stringify({ documents: page, ...next }), { status: 200 })
    }) as unknown as typeof fetch
    return { fetchFn, calls }
  }
  const sample = {
    users: [doc("users", "u2", { name: s("B") }), doc("users", "u1", { name: s("A") })],
    syncs: Array.from({ length: 45 }, (_, i) => doc("syncs", `s${String(i).padStart(3, "0")}`, { data: s(`d${i}`), rev: n(1) })),
  }
  it("issues only GETs on the documents endpoint, follows every page, sorts by id, and records counts and digests", async () => {
    const f = fakeFirestore(sample)
    const lines: Record<string, string[]> = {}
    const m = (await exportFirestore({ projectId: "p", getToken: async () => "t", fetchFn: f.fetchFn, writeLine: (c: string, l: string) => (lines[c] ??= []).push(l), now: () => Date.parse(EXPORTED_AT) })) as Row
    expect(f.calls.every((c) => c.method === "GET" && c.url.startsWith("https://firestore.googleapis.com/v1/projects/p/databases/(default)/documents/"))).toBe(true)
    expect(m.collections.users.count).toBe(2)
    expect(m.collections.syncs.count).toBe(45)
    expect(JSON.parse(lines.users[0]).id).toBe("u1")
    expect(m).toMatchObject({ writes: 0, deletes: 0, totalDocuments: 47, source: { projectId: "p", database: "(default)" } })
    const again = await exportFirestore({ projectId: "p", getToken: async () => "t", fetchFn: fakeFirestore(sample).fetchFn, writeLine: () => {}, now: () => Date.parse(EXPORTED_AT) })
    expect(again.collections).toEqual(m.collections) // the same state always gives the same digests
  })
  it("refuses any non-read URL, and the emulator for a non-demo project", async () => {
    await expect(exportFirestore({ projectId: "p", getToken: async () => "t", fetchFn: fakeFirestore({}).fetchFn, emulatorHost: "127.0.0.1:8080", writeLine: () => {} })).rejects.toThrow(/demo-/)
    const src = fs.readFileSync(path.join(ROOT, "scripts/migration/export.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    expect(src).not.toMatch(/method:\s*["'](?:PATCH|PUT|DELETE)["']/)
    expect([...src.matchAll(/method:\s*["']([A-Z]+)["']/g)].map((x) => x[1]).sort()).toEqual(["GET", "POST"]) // POST is the Google OAuth token request only
  })
  it("a service account for a different project is refused", () => {
    expect(() => serviceAccountTokenProvider({ client_email: "a@b", private_key: "k", project_id: "other" }, "p")).toThrow(/different project/)
  })
  it("an export directory is checked against its manifest: a changed file is detected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exp-"))
    const w = createExportWriter(dir)
    const f = fakeFirestore(sample)
    const m = await exportFirestore({ projectId: "p", getToken: async () => "t", fetchFn: f.fetchFn, writeLine: w.writeLine })
    await w.finish(m)
    expect(loadExport(dir).integrity).toEqual([])
    fs.appendFileSync(path.join(dir, "users.ndjson"), JSON.stringify({ collection: "users", id: "u9", fields: {} }) + "\n")
    expect(loadExport(dir).integrity.join()).toMatch(/users has 3 lines but the manifest says 2/)
    const loaded = loadExport(dir)
    const result = transformExport(loaded.records as never, { exportedAt: (m as Row).finishedAt })
    expect(validate({ manifest: loaded.manifest, records: loaded.records, result: result as never, integrity: loaded.integrity }).ok).toBe(false)
  })
})

// =====================================================================================================================
/** An in-memory PostgREST for the importer: GET, POST with on_conflict and Prefer, PATCH with eq/lt filters */
function fakeSupabase(opts: { missingTable?: string } = {}) {
  const pk: Record<string, string[]> = { profiles: ["uid"], invites: ["token"], connections: ["id"], legacy_requests: ["id"], connection_aliases: ["legacy_id"], pings: ["id"], push_tokens: ["uid", "device_id"], syncs: ["uid"], quarantined_records: ["collection", "doc_id"], shadow_mismatch: ["id"] }
  const db: Record<string, Record<string, unknown>[]> = Object.fromEntries(Object.keys(pk).map((k) => [k, []]))
  const log: { method: string; table: string; query: string }[] = []
  let ids = 0
  const fetchFn = (async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const table = u.pathname.replace("/rest/v1/", "").replace(/\/$/, "")
    log.push({ method: init.method ?? "GET", table, query: u.search })
    if (table === "") {
      const definitions = Object.fromEntries(Object.keys(pk).filter((t) => t !== opts.missingTable).map((t) => [t, { properties: Object.fromEntries((REQUIRED_COLUMNS as Record<string, string[]>)[t].map((c) => [c, {}])) }]))
      return new Response(JSON.stringify({ definitions }), { status: 200 })
    }
    const rows = db[table]
    if (init.method === "GET") {
      const limit = Number(u.searchParams.get("limit") ?? 1000)
      const offset = Number(u.searchParams.get("offset") ?? 0)
      return new Response(JSON.stringify(JSON.parse(JSON.stringify(rows.slice(offset, offset + limit)))), { status: 200 })
    }
    const body = JSON.parse(String(init.body))
    if (init.method === "POST") {
      const prefer = new Headers(init.headers).get("prefer") ?? ""
      for (const r of body as Record<string, unknown>[]) {
        const key = (x: Record<string, unknown>) => pk[table].map((k) => x[k]).join("\u0000")
        const at = rows.findIndex((x) => key(x) === key(r))
        const withDefaults = { ...(table === "quarantined_records" ? { id: ++ids } : {}), ...r }
        if (at < 0) rows.push(withDefaults)
        else if (prefer.includes("merge-duplicates")) rows[at] = { ...rows[at], ...r }
      }
      return new Response(null, { status: 201 })
    }
    if (init.method === "PATCH") {
      const uid = decodeURIComponent((u.searchParams.get("uid") ?? "").replace("eq.", ""))
      const lt = Number((u.searchParams.get("rev") ?? "").replace("lt.", ""))
      const hit = rows.filter((x) => x.uid === uid && (x.rev as number) < lt)
      hit.forEach((x) => Object.assign(x, body))
      return new Response(JSON.stringify(hit.map((x) => ({ uid: x.uid }))), { status: 200 })
    }
    return new Response("no", { status: 405 })
  }) as unknown as typeof fetch
  return { fetchFn, db, log }
}

describe("the importer is idempotent and never moves a copy backwards", () => {
  const data = (): Partial<Recs> => ({
    users: [rec("users", A, { name: s("Alice"), updatedAt: t(PAST) }), rec("users", B, { name: s("Bob") })],
    requests: [req("reqOK", A, B, "accepted", "2026-08-01T00:00:00Z"), req("reqDup", B, A, "pending", "2026-08-02T00:00:00Z")],
    pings: [ping("pingGood000001"), ping("pingTwelve0001", { items: arr(...Array.from({ length: 12 }, (_, k) => item(k))) }), ping("pingForged00001", { status: s("weird") })],
    pushTokens: [rec("pushTokens", A, { token: s("tok-a") })],
    syncs: [rec("syncs", A, { data: s("gz1:abc \n"), rev: n(4), updatedAt: n(5) }), rec("syncs", B, { data: s("plain"), rev: n(1) })],
    invites: [rec("invites", "tokInvite0000001", { owner: s(A), expiresAt: t(PAST) })],
  })
  const client = (fs_: ReturnType<typeof fakeSupabase>) => createPostgrest({ url: "https://abc.supabase.co", serviceKey: "service-key-value-123456", fetchFn: fs_.fetchFn })

  it("the schema check passes for the intended tables and names the problem when a table is missing", async () => {
    expect(await checkSchema(client(fakeSupabase()))).toEqual([])
    expect(await checkSchema(client(fakeSupabase({ missingTable: "syncs" })))).toEqual(["missing table: syncs"])
  })
  it("imports everything, verifies PASS, and a second run changes nothing", async () => {
    const { records, result } = run(data())
    const fake = fakeSupabase()
    const pg = client(fake)
    const first = await runImport(pg, result, {})
    expect(first.errors).toEqual([])
    expect(first.syncs).toMatchObject({ inserted: 2, updated: 0 })
    const v = await runVerify(pg, result, records)
    expect(v.checks.filter((c: { status: string }) => c.status === "FAIL")).toEqual([])
    expect(v.ok).toBe(true)
    expect(v.checks.some((c: { status: string }) => c.status === "EXPLAINED-REJECT")).toBe(true)
    const snapshot = JSON.stringify(fake.db)
    const second = await runImport(pg, result, {})
    expect(second.errors).toEqual([])
    expect(second.syncs).toMatchObject({ inserted: 0, updated: 0, unchanged: 2 })
    expect(JSON.stringify(fake.db)).toBe(snapshot)
    expect(fake.db.syncs.find((r) => r.uid === A)).toMatchObject({ data: "gz1:abc \n", rev: 4, updated_at: 5 })
  })
  it("a copy that is behind is brought up; a copy that is ahead is never overwritten", async () => {
    const { result } = run(data())
    const fake = fakeSupabase()
    const pg = client(fake)
    fake.db.syncs.push({ uid: A, data: "old", rev: 2, updated_at: 1 }, { uid: B, data: "newer", rev: 9, updated_at: 1 })
    const r = await runImport(pg, result, {})
    expect(r.syncs).toMatchObject({ updated: 1, targetAhead: 1, inserted: 0 })
    expect(fake.db.syncs.find((x) => x.uid === A)).toMatchObject({ data: "gz1:abc \n", rev: 4 })
    expect(fake.db.syncs.find((x) => x.uid === B)).toMatchObject({ data: "newer", rev: 9 })
  })
  it("verification FAILS on a missing row, a changed byte, a different revision and an unexpected extra", async () => {
    const { records, result } = run(data())
    const fake = fakeSupabase()
    const pg = client(fake)
    await runImport(pg, result, {})
    fake.db.syncs.find((r) => r.uid === A)!.data = "gz1:abc " // one byte different
    fake.db.syncs.find((r) => r.uid === B)!.rev = 3
    fake.db.profiles.pop()
    fake.db.invites.push({ token: "tokNotFromExport0001", owner: A, owner_name: null, expires_at: PAST, created_at: null })
    const v = await runVerify(pg, result, records)
    const failed = v.checks.filter((c: { status: string }) => c.status === "FAIL").map((c: { table: string; name: string }) => `${c.table}.${c.name}`)
    expect(v.ok).toBe(false)
    expect(failed).toEqual(expect.arrayContaining(["syncs.sha256(data)", "syncs.rev", "profiles.count", "profiles.ids", "invites.ids"]))
  })
  it("legacy and archived rows are imported as they are: 12-item Ping flagged, duplicate request archived with its alias", async () => {
    const { result } = run(data())
    const fake = fakeSupabase()
    await runImport(client(fake), result, {})
    expect((fake.db.pings.find((p) => p.id === "pingTwelve0001")!.items as unknown[]).length).toBe(12)
    expect(fake.db.pings.find((p) => p.id === "pingTwelve0001")).toMatchObject({ legacy: true, legacy_flags: ["items>8"] })
    expect(fake.db.legacy_requests.map((r) => r.id)).toEqual(["reqDup"])
    expect(fake.db.connection_aliases).toMatchObject([{ legacy_id: "reqDup", canonical_id: "reqOK" }])
    expect(fake.db.quarantined_records.map((r) => r.doc_id)).toEqual(["pingForged00001"])
  })
  it("the importer can only GET, POST and PATCH: no DELETE and no other table is reachable", async () => {
    const pg = createPostgrest({ url: "https://abc.supabase.co", serviceKey: "service-key-value-123456", fetchFn: (async () => new Response("[]")) as unknown as typeof fetch })
    await expect(pg.call("DELETE", "profiles", "", undefined)).rejects.toThrow(/refusing/)
    await expect(pg.call("GET", "auth.users", "", undefined)).rejects.toThrow(/unknown table/)
    const { result } = run(data())
    const fake = fakeSupabase()
    await runImport(client(fake), result, {})
    expect(fake.log.every((l) => ["GET", "POST", "PATCH"].includes(l.method))).toBe(true)
  })
})

// =====================================================================================================================
describe("the command line", () => {
  const cli = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [path.join(ROOT, "scripts/migration-import.mjs"), ...args], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } as unknown as NodeJS.ProcessEnv, cwd: ROOT })

  it("does nothing without exactly one mode", () => {
    expect(cli([]).status).toBe(2)
    expect(cli(["--dry-run", "--import"]).status).toBe(2)
  })
  it("--import and --verify refuse to run without an export directory", () => {
    expect(cli(["--import"]).stderr).toMatch(/needs --from/)
    expect(cli(["--verify"]).status).toBe(2)
  })
  it("--import refuses without the project ref confirmation and the acknowledgement, before any network call", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-"))
    const w = createExportWriter(dir)
    return exportFirestore({ projectId: "p", getToken: async () => "t", fetchFn: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch, writeLine: w.writeLine }).then(async (m) => {
      await w.finish(m)
      const env = { SUPABASE_URL: "https://abcdefgh.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key-value-123456" }
      const noRef = cli(["--import", "--from", dir], env)
      expect(noRef.status).toBe(2)
      expect(noRef.stderr).toMatch(/confirm-project-ref/)
      const noAck = cli(["--import", "--from", dir, "--confirm-project-ref", "abcdefgh"], env)
      expect(noAck.status).toBe(2)
      expect(noAck.stderr).toMatch(/yes-supabase-is-a-copy/)
      expect(noAck.stderr + noAck.stdout).not.toContain("service-key-value-123456")
      const wrong = cli(["--verify", "--from", dir, "--confirm-project-ref", "other"], env)
      expect(wrong.status).toBe(2)
    })
  })
  it("--dry-run from an export directory validates and reports offline, writes nothing to Supabase, and prints no secret", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-dry-"))
    const w = createExportWriter(dir)
    const lines: [string, string][] = [
      ["users", JSON.stringify(rec("users", A, { name: s("Secret Name") }))],
      ["syncs", JSON.stringify(rec("syncs", A, { data: s("gz1:BLOB"), rev: n(1) }))],
    ]
    return exportFirestore({
      projectId: "p",
      getToken: async () => "t",
      fetchFn: (async (url: string) => {
        const c = new URL(url).pathname.split("/").pop() as string
        const docs = lines.filter(([k]) => k === c).map(([, l]) => JSON.parse(l)).map((r) => ({ name: `projects/p/databases/(default)/documents/${r.collection}/${r.id}`, fields: r.fields, createTime: r.createTime, updateTime: r.updateTime }))
        return new Response(JSON.stringify({ documents: docs }), { status: 200 })
      }) as unknown as typeof fetch,
      writeLine: w.writeLine,
    }).then(async (m) => {
      await w.finish(m)
      const r = cli(["--dry-run", "--from", dir], { SUPABASE_SERVICE_ROLE_KEY: "service-key-value-123456", SUPABASE_URL: "https://abcdefgh.supabase.co" })
      expect(r.status).toBe(0)
      expect(r.stdout).toMatch(/Nothing was written to Supabase/)
      const report = fs.readFileSync(path.join(dir, "report.md"), "utf8") + fs.readFileSync(path.join(dir, "summary.json"), "utf8")
      for (const bad of ["Secret Name", "gz1:BLOB", "service-key-value-123456"]) expect(report + r.stdout + r.stderr).not.toContain(bad)
      expect(JSON.parse(fs.readFileSync(path.join(dir, "summary.json"), "utf8")).validation.ok).toBe(true)
    })
  })
})

describe("the tooling is isolated from the application and from secrets", () => {
  const walk = (d: string): string[] => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.posix.join(d, e.name)) : [path.posix.join(d, e.name)]))
  it("no application file imports the import tooling, and the tooling imports nothing from the application", () => {
    const app = ["app", "components", "hooks", "lib"].flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f))
    expect(app.filter((f) => /migration-import|scripts\/migration/.test(fs.readFileSync(path.join(ROOT, f), "utf8")))).toEqual([])
    for (const f of walk("scripts/migration")) expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/from\s+["'](?:\.\.\/)+(?:lib|app|hooks|components)\//)
  }, 15000)
  it("no source file contains a key, a token or a private key, and the ignore rules cover exports and key files", () => {
    for (const f of [...walk("scripts/migration"), "scripts/migration-import.mjs", "scripts/migration-import-selftest.mjs"]) expect(fs.readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/BEGIN (RSA )?PRIVATE KEY|eyJ[A-Za-z0-9_-]{20,}\.|sb_(secret|publishable)_[A-Za-z0-9]/)
    const ignore = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8")
    for (const rule of ["/migration-output/", "*.ndjson", "*service-account*.json", "*-firebase-adminsdk-*.json"]) expect(ignore).toContain(rule)
  })
  it("the importer does not run SQL and cannot delete: its only verbs are GET, POST and PATCH", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts/migration/supabase-import.mjs"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    expect(src).not.toMatch(/["']DELETE["']\s*[,\]]|\.rpc\(|\/rpc\/|execute|truncate/i)
  })
})
