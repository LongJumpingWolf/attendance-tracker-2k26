/**
 * READ-ONLY Firestore export (Phase 6C part A). Streams the six migrated collections to NDJSON.
 *
 * SAFETY
 *  - Only HTTP GET against the Firestore documents list endpoint is ever issued (`guardedGet` throws on anything else),
 *    so this code has no path that writes, updates or deletes. The one POST in this module is the OAuth token request to
 *    Google when a service account is used; it never touches Firestore.
 *  - Credentials: a service-account file named by GOOGLE_APPLICATION_CREDENTIALS, read in memory, used to sign one OAuth
 *    request, never printed, never written anywhere. Grant it the read-only role `roles/datastore.viewer`.
 *  - It refuses a service account that belongs to a different project than the one it was asked to export.
 *  - The Firestore emulator is allowed only for a project id starting with "demo-" (tests).
 *
 * Each record is { collection, id, createTime, updateTime, fields } with `fields` in Firestore's typed REST form, which is
 * lossless (a sync blob is a stringValue and stays byte-exact). Records are written sorted by id, so the same database
 * state always gives the same file.
 */
import { createHash, createSign } from "node:crypto"

export const COLLECTIONS = ["users", "invites", "requests", "pings", "pushTokens", "syncs"]
export const EXPORT_FORMAT = 1
const PAGE_SIZE = { syncs: 20 } // sync documents are large
const DEFAULT_PAGE = 200

export const sha256Hex = (s) => createHash("sha256").update(s, "utf8").digest("hex")
const byteOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

export function documentsBase(projectId, emulatorHost) {
  return emulatorHost ? `http://${emulatorHost}/v1/projects/${projectId}/databases/(default)/documents` : `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`
}

/** An OAuth access-token provider from a service-account object. No dependency: one signed JWT and one token request. */
export function serviceAccountTokenProvider(sa, projectId, fetchFn = fetch, nowMs = Date.now) {
  if (!sa || typeof sa.client_email !== "string" || typeof sa.private_key !== "string") throw new Error("the credentials file is not a service-account key")
  if (sa.project_id !== projectId) throw new Error(`the service account belongs to a different project than ${projectId}; refusing`)
  const tokenUri = "https://oauth2.googleapis.com/token"
  let cached = null
  return async () => {
    if (cached && cached.exp > nowMs() + 60_000) return cached.token
    const iat = Math.floor(nowMs() / 1000)
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
    const unsigned = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iss: sa.client_email, scope: "https://www.googleapis.com/auth/datastore", aud: tokenUri, iat, exp: iat + 3600 })}`
    const signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url")
    const res = await fetchFn(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}&assertion=${unsigned}.${signature}`,
    })
    if (!res.ok) throw new Error(`could not get a Google access token (HTTP ${res.status})`)
    const j = await res.json()
    cached = { token: j.access_token, exp: nowMs() + (j.expires_in ?? 3600) * 1000 }
    return cached.token
  }
}

/**
 * @param {object} o
 * @param {string} o.projectId
 * @param {() => Promise<string>} o.getToken
 * @param {typeof fetch} [o.fetchFn]
 * @param {string} [o.emulatorHost] only with a demo-* project id
 * @param {(collection: string, line: string) => void} o.writeLine  receives each NDJSON line, in id order
 * @param {() => number} [o.now]
 * @param {(msg: string) => void} [o.log]
 */
export async function exportFirestore({ projectId, getToken, fetchFn = fetch, emulatorHost, writeLine, now = Date.now, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  if (emulatorHost && !projectId.startsWith("demo-")) throw new Error("the emulator may only be used with a demo-* project id")
  const base = documentsBase(projectId, emulatorHost)
  const stats = { httpGets: 0, errors: [] }

  /** The only way this module talks to Firestore */
  async function guardedGet(url) {
    if (!url.startsWith(`${base}/`) || /:(commit|batchWrite|runQuery|rollback|beginTransaction|runAggregationQuery)/.test(url)) throw new Error("refusing a non-read URL")
    for (let attempt = 0; ; attempt++) {
      stats.httpGets++
      const res = await fetchFn(url, { method: "GET", headers: { authorization: `Bearer ${await getToken()}` } })
      if (res.ok) return res.json()
      if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
        await sleep(500 * 2 ** attempt)
        continue
      }
      throw new Error(`Firestore read failed (HTTP ${res.status}) for ${url.slice(base.length).split("?")[0]}`)
    }
  }

  const startedAt = now()
  const manifest = {
    format: EXPORT_FORMAT,
    tool: "scripts/migration/export.mjs",
    source: { projectId, database: "(default)", emulator: Boolean(emulatorHost) },
    exportedAt: new Date(startedAt).toISOString(),
    collections: {},
  }

  for (const collection of COLLECTIONS) {
    const docs = []
    let pageToken = ""
    do {
      const url = `${base}/${collection}?pageSize=${PAGE_SIZE[collection] ?? DEFAULT_PAGE}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`
      const page = await guardedGet(url)
      for (const d of page.documents ?? []) {
        docs.push({ collection, id: d.name.slice(d.name.lastIndexOf("/") + 1), createTime: d.createTime ?? null, updateTime: d.updateTime ?? null, fields: d.fields ?? {} })
      }
      pageToken = page.nextPageToken ?? ""
    } while (pageToken)
    docs.sort((a, b) => byteOrder(a.id, b.id))
    const lineHashes = []
    for (const rec of docs) {
      const line = JSON.stringify(rec)
      writeLine(collection, line)
      lineHashes.push(sha256Hex(line))
    }
    manifest.collections[collection] = { count: docs.length, digest: sha256Hex(lineHashes.join("\n")) }
    log(`exported ${collection}: ${docs.length}`)
  }
  manifest.httpGets = stats.httpGets
  manifest.writes = 0
  manifest.deletes = 0
  manifest.totalDocuments = Object.values(manifest.collections).reduce((n, c) => n + c.count, 0)
  manifest.finishedAt = new Date(now()).toISOString()
  return manifest
}

/** Re-computes the per-collection digest of already parsed lines, to check an export directory against its manifest */
export function digestOf(lines) {
  return sha256Hex(lines.map((l) => sha256Hex(l)).join("\n"))
}
