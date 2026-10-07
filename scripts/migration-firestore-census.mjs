#!/usr/bin/env node
/**
 * READ-ONLY production Firestore census for the Firebase -> Supabase migration.
 * See MIGRATION_DECISIONS.md (decisions 2a and 2b) and MIGRATION_PRODUCTION_CENSUS.md.
 *
 *   node scripts/migration-firestore-census.mjs
 *
 * SAFETY
 *  - Only HTTP GET is ever issued, and only against the Firestore documents list endpoint
 *    (plus one GET of the project record to verify the project id). `guardedGet` throws on anything else,
 *    so this script cannot write, update or delete. It has no code path that does.
 *  - It fails closed unless the target is exactly attendance-tracker-2k26 (.firebaserc, the Firebase API
 *    and the hard-coded constant must all agree).
 *  - Credentials: it reuses the signed-in Firebase CLI session already on this machine (read in memory,
 *    never printed, never written anywhere). No key is stored in the repo.
 *  - User ids are capabilities (`/?add=<uid>`), so reports show only a short one-way hash of each uid.
 *    Full-fidelity detail goes to a private JSON file OUTSIDE the repo (CENSUS_PRIVATE_DIR, default: OS temp).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const PROJECT = "attendance-tracker-2k26";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const PROJECT_URL = `https://firebase.googleapis.com/v1beta1/projects/${PROJECT}`;
const MS_DAY = 86_400_000;
const REPORT = join(ROOT, "MIGRATION_PRODUCTION_CENSUS.md");
const PRIVATE_DIR = process.env.CENSUS_PRIVATE_DIR || tmpdir();

const stats = { reads: { requests: 0, pings: 0, users: 0 }, httpGets: 0, writes: 0, deletes: 0, errors: [] };

// ---------- read-only plumbing ----------
function guardedGet(url, token) {
  const ok = url.startsWith(`${DOCS}/`) || url === PROJECT_URL;
  if (!ok || /:(commit|batchWrite|runQuery|rollback|beginTransaction)/.test(url)) throw new Error("refusing non-read URL");
  stats.httpGets++;
  return fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
}
function cliToken() {
  const store = JSON.parse(readFileSync(join(homedir(), ".config", "configstore", "firebase-tools.json"), "utf8"));
  const t = store.tokens;
  if (!t?.access_token || !(t.expires_at > Date.now() + 60_000)) {
    throw new Error("Firebase CLI session is missing or expired. Run `firebase projects:list` once, then re-run.");
  }
  return t.access_token;
}
function verifyProjectId() {
  const rc = JSON.parse(readFileSync(join(ROOT, ".firebaserc"), "utf8"));
  if (rc.projects?.default !== PROJECT) throw new Error(".firebaserc default project is not " + PROJECT);
}
async function listAll(collection, token) {
  const out = [];
  let pageToken = "";
  do {
    const url = `${DOCS}/${collection}?pageSize=300${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
    const res = await guardedGet(url, token);
    if (!res.ok) throw new Error(`${collection}: HTTP ${res.status}`);
    const body = await res.json();
    for (const d of body.documents ?? []) {
      out.push({ id: d.name.split("/").pop(), fields: decodeFields(d.fields ?? {}), createTime: d.createTime, updateTime: d.updateTime });
      stats.reads[collection]++;
    }
    pageToken = body.nextPageToken ?? "";
  } while (pageToken);
  return out;
}
// Firestore REST typed value -> JS. Timestamps become {__ts: ms}, nulls stay null.
function decodeValue(v) {
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("timestampValue" in v) return { __ts: Date.parse(v.timestampValue) };
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields ?? {});
  return { __unknown: Object.keys(v)[0] };
}
function decodeFields(f) {
  return Object.fromEntries(Object.entries(f).map(([k, v]) => [k, decodeValue(v)]));
}

// ---------- helpers ----------
const hash = (s) => "u:" + createHash("sha256").update(String(s)).digest("hex").slice(0, 6);
const isTs = (x) => x && typeof x === "object" && typeof x.__ts === "number";
const tsMs = (x) => (isTs(x) ? x.__ts : null);
const iso = (x) => (isTs(x) ? new Date(x.__ts).toISOString() : x == null ? "missing" : `non-timestamp(${typeof x})`);
const isStr = (x) => typeof x === "string";
const pairKey = (a, b) => [a, b].sort().join("|");
const bump = (m, k, n = 1) => m.set(k, (m.get(k) ?? 0) + n);
const obj = (m) => Object.fromEntries([...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), undefined, { numeric: true })));
function validDate(s) {
  if (!isStr(s) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
class Bucket {
  constructor() { this.m = new Map(); }
  add(reason, id) { const e = this.m.get(reason) ?? { count: 0, ids: [] }; e.count++; if (e.ids.length < 5) e.ids.push(id); this.m.set(reason, e); }
  toJSON() { return Object.fromEntries([...this.m.entries()].sort()); }
}

// ---------- census A: requests ----------
function censusRequests(reqs, userIds) {
  const STATUS = new Set(["pending", "accepted", "declined"]);
  const status = new Map();
  const malformed = new Bucket();
  const ghost = new Bucket();
  const byPair = new Map();
  const classOf = new Map(); // id -> {cls, why}
  const known = (r) => isStr(r.fields.from) && isStr(r.fields.to) && r.fields.from !== r.fields.to;

  for (const r of reqs) {
    const f = r.fields;
    bump(status, isStr(f.status) ? f.status : `(${typeof f.status})`);
    const probs = [];
    if (!isStr(f.from) || !isStr(f.to)) probs.push("from/to not strings");
    else if (f.from === f.to) probs.push("from == to");
    if (!STATUS.has(f.status)) probs.push("unknown status");
    if (!Array.isArray(f.participants) || f.participants.length !== 2 || f.participants[0] !== f.from || f.participants[1] !== f.to) probs.push("participants != [from,to]");
    if (!isStr(f.fromName) || !isStr(f.toName)) probs.push("name missing");
    else if (f.fromName.length > 40 || f.toName.length > 40) probs.push("name > 40 chars");
    if (!isTs(f.createdAt)) probs.push("createdAt missing/non-timestamp");
    if (f.status !== "pending" && !isTs(f.respondedAt)) probs.push("respondedAt missing on answered request");
    for (const p of probs) malformed.add(p, r.id);
    r.problems = probs;
    if (known(r)) {
      const k = pairKey(f.from, f.to);
      (byPair.get(k) ?? byPair.set(k, []).get(k)).push(r);
      for (const u of [f.from, f.to]) if (!userIds.has(u)) ghost.add("participant has no users/{uid} profile", r.id);
    }
  }

  const dupPairs = [];
  const multiAny = [];
  const multiAccepted = [];
  const opposite = [];
  const nonCanonical = new Set();
  const cmp = (a, b) => {
    const rank = (r) => (r.fields.status === "accepted" ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    const ta = tsMs(a.fields.createdAt) ?? Infinity, tb = tsMs(b.fields.createdAt) ?? Infinity;
    if (ta !== tb) return ta - tb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
  for (const [k, list] of byPair) {
    if (list.length > 1) multiAny.push(k);
    const dirs = new Set(list.map((r) => r.fields.from));
    if (dirs.size > 1) opposite.push(k);
    const live = list.filter((r) => r.fields.status === "pending" || r.fields.status === "accepted");
    if (list.filter((r) => r.fields.status === "accepted").length > 1) multiAccepted.push(k);
    if (live.length >= 2) {
      const sorted = [...live].sort(cmp);
      const canon = sorted[0];
      for (const r of sorted.slice(1)) nonCanonical.add(r.id);
      dupPairs.push({
        pair: k.split("|").map(hash).join(" <-> "),
        canonicalId: canon.id,
        records: list.map((r) => ({
          id: r.id, dir: hash(r.fields.from) + " -> " + hash(r.fields.to), status: r.fields.status,
          createdAt: iso(r.fields.createdAt), respondedAt: iso(r.fields.respondedAt), canonical: r.id === canon.id,
        })),
      });
    }
  }

  // conservation classes
  const ghostIds = new Set([...ghost.m.values()].flatMap(() => []));
  const hasGhost = (r) => known(r) && (!userIds.has(r.fields.from) || !userIds.has(r.fields.to));
  const tally = { live: 0, legacyCompatible_archivedAliased: 0, legacyCompatible_other: 0, flagged: 0, quarantined: 0 };
  for (const r of reqs) {
    if (nonCanonical.has(r.id)) tally.legacyCompatible_archivedAliased++;
    else if (r.problems.length) tally.flagged++; // malformed but importable verbatim; no documented quarantine rule for requests
    else if (hasGhost(r)) tally.flagged++;
    else tally.live++;
  }
  void ghostIds;
  return {
    total: reqs.length, status: obj(status), uniquePairs: byPair.size,
    pairsWithMultipleRecords: multiAny.length, pairsWithMultipleAccepted: multiAccepted.length,
    oppositeDirectionPairs: opposite.length, duplicatePairs: dupPairs.length,
    malformed: malformed.toJSON(), missingUserProfile: ghost.toJSON(), dupPairs, tally,
    malformedRecordCount: reqs.filter((r) => r.problems.length).length,
  };
}

// ---------- census B: pings ----------
function censusPings(pings, requestIds, userIds, now) {
  const STATUS = new Set(["asking", "answered", "processed"]);
  const status = new Map(), age = new Map(), itemCount = new Map();
  const quarantine = new Bucket(), legacy = new Bucket(), attention = new Bucket(), info = new Bucket();
  const tally = { live: 0, legacy: 0, flagged: 0, quarantined: 0 };
  const quarantinedAnsweredUnprocessed = [];
  const answeredUnprocessed = [];
  const itemKeyOk = (i) => i && typeof i === "object" && !Array.isArray(i) && isStr(i.key) && isStr(i.subjectId) && isStr(i.name) && i.name.length <= 60 &&
    (i.t === undefined || (isStr(i.t) && /^\d{2}:\d{2}$/.test(i.t))) && Object.keys(i).every((k) => ["key", "subjectId", "name", "t", "answer"].includes(k));
  const ageBucket = (ms) => (ms < 0 ? "future" : ms < MS_DAY ? "<1d" : ms < 3 * MS_DAY ? "1-3d" : ms < 7 * MS_DAY ? "3-7d" : ms < 14 * MS_DAY ? "7-14d" : ms < 31 * MS_DAY ? "14-31d" : ">31d");

  for (const p of pings) {
    const f = p.fields;
    const q = [], lg = [], at = [];
    bump(status, isStr(f.status) ? f.status : `(${typeof f.status})`);
    const created = tsMs(f.createdAt);
    bump(age, created == null ? "createdAt missing" : ageBucket(now - created));
    const items = Array.isArray(f.items) ? f.items : null;
    bump(itemCount, items ? String(items.length) : "(not an array)");

    // --- quarantine criteria: ONLY the four documented in MIGRATION_DECISIONS.md 2b ---
    if (!Array.isArray(f.participants) || f.participants.length !== 2 || f.participants[0] !== f.from || f.participants[1] !== f.to) q.push("participants is not exactly [from,to]");
    if (isStr(f.from) && f.from === f.to) q.push("from == to");
    if (!STATUS.has(f.status)) q.push("status not one of asking/answered/processed");
    if (created != null && created > now) q.push("createdAt is later than the census time");
    if (items && (f.status === "answered" || f.status === "processed") && items.some((i) => !(i && typeof i === "object") || !(i.answer === null || i.answer === "yes" || i.answer === "no")))
      q.push("answered/processed item with answer other than yes/no/null");

    // --- legacy (violates a NEW constraint, but was valid when written) ---
    if (items && items.length > 8) lg.push("V1 items>8");
    if (items && items.length === 0) lg.push("V1 zero items");
    if (!items) lg.push("V2 items not an array");
    else if (!items.every(itemKeyOk)) lg.push("V2 item-shape");
    if (items && f.status === "asking" && items.some((i) => i && i.answer != null)) lg.push("V2 asking ping with answered item");
    if (items && items.some((i) => i && i.answer != null && !(i.answer === "yes" || i.answer === "no")) && f.status === "asking") lg.push("V2 asking ping with odd answer");
    if (!validDate(f.date)) lg.push("V4 date-format");
    if (created == null) lg.push("V6 no-created-at");
    if (!isStr(f.fromName) || !isStr(f.toName)) lg.push("V7 name-missing");
    else if (f.fromName.length > 40 || f.toName.length > 40) lg.push("V7 name-length");
    if (!isStr(f.requestId)) lg.push("V8 requestId missing");
    else if (!requestIds.has(f.requestId)) lg.push("V8 request-missing");
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(p.id)) lg.push("V10 id-pattern");

    // --- attention (conforms, but the owner should know) ---
    const unprocessed = f.status === "answered";
    if (unprocessed) at.push("V11 answered-unprocessed");
    if (f.status === "asking" && created != null && now > created + 3 * MS_DAY) at.push("V12 asking-expired");
    if (isStr(f.from) && isStr(f.to) && (!userIds.has(f.from) || !userIds.has(f.to))) at.push("V9 participant-without-profile");
    if (f.claimedBy != null && f.status === "answered") at.push("lease-present-on-answered");
    if (validDate(f.date) && created != null) {
      const d = Date.parse(f.date + "T00:00:00Z");
      if (d < created - 3 * MS_DAY - MS_DAY || d > created + 2 * MS_DAY) info.add("V5 date outside [createdAt-3d, createdAt+1d] window", p.id);
    }

    for (const r of q) quarantine.add(r, p.id);
    for (const r of lg) legacy.add(r, p.id);
    for (const r of at) attention.add(r, p.id);
    if (unprocessed) answeredUnprocessed.push(p.id);

    if (q.length) { tally.quarantined++; if (unprocessed) quarantinedAnsweredUnprocessed.push(p.id); }
    else if (lg.length) tally.legacy++;
    else if (at.length) tally.flagged++;
    else tally.live++;
    p.cls = q.length ? "quarantined" : lg.length ? "legacy" : at.length ? "flagged" : "live";
  }
  const expired = pings.filter((p) => p.fields.status === "asking" && tsMs(p.fields.createdAt) != null && now > tsMs(p.fields.createdAt) + 3 * MS_DAY).length;
  return {
    total: pings.length, status: obj(status), age: obj(age), itemCount: obj(itemCount),
    over8: pings.filter((p) => Array.isArray(p.fields.items) && p.fields.items.length > 8).length,
    processed: pings.filter((p) => p.fields.status === "processed").length,
    answeredUnprocessed: answeredUnprocessed.length, answeredUnprocessedIds: answeredUnprocessed.slice(0, 10),
    expiredAsking: expired,
    quarantine: quarantine.toJSON(), legacy: legacy.toJSON(), attention: attention.toJSON(), info: info.toJSON(),
    quarantinedAnsweredUnprocessed, tally,
  };
}

// ---------- report ----------
function renderReport(ctx) {
  const { startedAt, A, B } = ctx;
  const L = [];
  const table = (rows, head) => { L.push(`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`); rows.forEach((r) => L.push(`| ${r.join(" | ")} |`)); L.push(""); };
  const reasonRows = (b) => Object.entries(b).map(([k, v]) => [k, v.count, v.ids.map((i) => `\`${i}\``).join(", ")]);
  L.push("# MIGRATION_PRODUCTION_CENSUS.md", "");
  L.push("**READ-ONLY PRODUCTION CENSUS**  ", `**PROJECT: ${PROJECT}**  `, "**WRITES/DELETES: 0**", "");
  L.push(`Census time (UTC): \`${startedAt}\`. Produced by \`scripts/migration-firestore-census.mjs\` (GET-only; see the header of that script). Branch \`migration/supabase\`.`, "");
  L.push("User ids are capabilities in this app (`/?add=<uid>`), so they appear here only as a short one-way hash (`u:xxxxxx`). Full detail is in a private file outside the repository.", "");
  L.push("## Safety report", "");
  table([
    ["Firebase project id", PROJECT], ["Documents read: requests", stats.reads.requests], ["Documents read: pings", stats.reads.pings],
    ["Documents read: users (profile existence only; names never recorded)", stats.reads.users],
    ["Total documents read", stats.reads.requests + stats.reads.pings + stats.reads.users], ["HTTP GET calls", stats.httpGets],
    ["Write operations performed", stats.writes], ["Delete operations performed", stats.deletes],
    ["Errors", stats.errors.length ? stats.errors.join("; ") : "none"], ["Any data modified", "NO"],
  ], ["Item", "Value"]);

  L.push("## Census A: friend requests / connections", "");
  table([["Total request documents", A.total], ...Object.entries(A.status).map(([k, v]) => [`status = ${k}`, v]),
    ["Unique unordered user pairs", A.uniquePairs], ["Pairs with more than one request record (any status)", A.pairsWithMultipleRecords],
    ["Pairs with 2+ non-declined records (decision 2a duplicate pair)", A.duplicatePairs], ["Pairs with 2+ accepted records", A.pairsWithMultipleAccepted],
    ["Opposite-direction pairs (A to B and B to A both exist)", A.oppositeDirectionPairs], ["Malformed records (any problem)", A.malformedRecordCount]], ["Measure", "Count"]);
  L.push("### Malformed requests", ""); L.push(Object.keys(A.malformed).length ? "" : "None.", "");
  if (Object.keys(A.malformed).length) table(reasonRows(A.malformed), ["Reason", "Count", "Example ids"]);
  L.push("### Requests pointing at an apparently missing user", "", "Detectable only as 'no `users/{uid}` profile'. An anonymous user who never saved a profile also has none, so this is a hint, not proof.", "");
  if (Object.keys(A.missingUserProfile).length) table(reasonRows(A.missingUserProfile), ["Reason", "Count (participant slots)", "Example ids"]); else L.push("None.", "");
  L.push("### Duplicate pairs", "", "Provisional canonical rule: accepted first, then earliest `createdAt` (missing last), then smallest id. Nothing was merged or deleted.", "");
  if (!A.dupPairs.length) L.push("**No duplicate pairs found.**", "");
  for (const d of A.dupPairs) {
    L.push(`**${d.pair}** canonical: \`${d.canonicalId}\``, "");
    table(d.records.map((r) => [`\`${r.id}\``, r.dir, r.status, r.createdAt, r.respondedAt, r.canonical ? "CANONICAL" : "alias"]), ["Request id", "Direction", "Status", "createdAt", "respondedAt", "Role"]);
  }

  L.push("## Census B: pings", "");
  table([["Total pings", B.total], ["Processed", B.processed], ["Answered but unprocessed", B.answeredUnprocessed], ["Asking and past the 3 day expiry", B.expiredAsking], ["More than 8 items", B.over8]], ["Measure", "Count"]);
  L.push("Status distribution", ""); table(Object.entries(B.status).map(([k, v]) => [k, v]), ["Status", "Count"]);
  L.push("Age distribution (by `createdAt`)", ""); table(Object.entries(B.age).map(([k, v]) => [k, v]), ["Age", "Count"]);
  L.push("Item-count distribution", ""); table(Object.entries(B.itemCount).map(([k, v]) => [k, v]), ["Items", "Count"]);
  L.push("### Would be quarantined (the four documented criteria only)", "");
  if (Object.keys(B.quarantine).length) table(reasonRows(B.quarantine), ["Reason", "Count", "Example ids"]); else L.push("**None.**", "");
  L.push("### Legacy (breaks a new constraint, valid when written)", "");
  if (Object.keys(B.legacy).length) table(reasonRows(B.legacy), ["Flag", "Count", "Example ids"]); else L.push("**None.**", "");
  L.push("### Attention flags (conform to the new schema, owner should know)", "");
  if (Object.keys(B.attention).length) table(reasonRows(B.attention), ["Flag", "Count", "Example ids"]); else L.push("**None.**", "");
  L.push("### Informational", "");
  if (Object.keys(B.info).length) table(reasonRows(B.info), ["Note", "Count", "Example ids"]); else L.push("None.", "");
  if (B.answeredUnprocessedIds.length) L.push("Answered-but-unprocessed Ping ids (first 10): " + B.answeredUnprocessedIds.map((i) => `\`${i}\``).join(", "), "");

  L.push("## Census C: data conservation", "", "Precedence for a record in more than one category: quarantined, then legacy-compatible, then flagged, then live. Every record is counted exactly once.", "");
  const ta = A.tally, tb = B.tally;
  table([
    ["requests", A.total, ta.live, ta.legacyCompatible_archivedAliased + ta.legacyCompatible_other, ta.flagged, ta.quarantined, ta.live + ta.legacyCompatible_archivedAliased + ta.legacyCompatible_other + ta.flagged + ta.quarantined === A.total ? "OK" : "MISMATCH", 0],
    ["pings", B.total, tb.live, tb.legacy, tb.flagged, tb.quarantined, tb.live + tb.legacy + tb.flagged + tb.quarantined === B.total ? "OK" : "MISMATCH", 0],
  ], ["Collection", "Exported", "Valid/live", "Legacy-compatible", "Flagged", "Quarantined", "Sum equals exported", "Deleted"]);
  L.push(`Requests legacy-compatible = non-canonical duplicates preserved in \`legacy_requests\` with an alias (${ta.legacyCompatible_archivedAliased}). Requests "flagged" = malformed or referencing a user with no profile, imported verbatim; no quarantine rule is documented for requests, so none are quarantined.`, "");
  L.push(`Quarantined Pings that were answered-but-unprocessed (would hold an unapplied favour): **${B.quarantinedAnsweredUnprocessed.length}**.`, "");
  return L.join("\n");
}

// ---------- main ----------
async function main() {
  verifyProjectId();
  const token = cliToken();
  const pr = await guardedGet(PROJECT_URL, token);
  if (!pr.ok) throw new Error("project verification failed: HTTP " + pr.status);
  const pj = await pr.json();
  if (pj.projectId !== PROJECT) throw new Error(`project mismatch: got ${pj.projectId}`);
  console.log("READ-ONLY PRODUCTION CENSUS");
  console.log(`PROJECT: ${PROJECT}`);
  console.log("WRITES/DELETES: 0");

  const startedAt = new Date().toISOString();
  const now = Date.now();
  const reqs = await listAll("requests", token);
  const pings = await listAll("pings", token);
  const users = await listAll("users", token);
  const userIds = new Set(users.map((u) => u.id));
  const requestIds = new Set(reqs.map((r) => r.id));

  const A = censusRequests(reqs, userIds);
  const B = censusPings(pings, requestIds, userIds, now);

  mkdirSync(PRIVATE_DIR, { recursive: true });
  const privatePath = join(PRIVATE_DIR, `firestore-census-private-${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(privatePath, JSON.stringify({ startedAt, A, B, pingClasses: pings.map((p) => ({ id: p.id, cls: p.cls })) }, null, 1));
  writeFileSync(REPORT, renderReport({ startedAt, A, B }) + "\n");

  console.log(`requests=${stats.reads.requests} pings=${stats.reads.pings} users=${stats.reads.users} total=${stats.reads.requests + stats.reads.pings + stats.reads.users}`);
  console.log(`HTTP GETs=${stats.httpGets} writes=${stats.writes} deletes=${stats.deletes} errors=${stats.errors.length}`);
  console.log("report:", REPORT);
  console.log("private detail:", privatePath);
}
main().catch((e) => { console.error("CENSUS FAILED:", e.message); process.exit(1); });
