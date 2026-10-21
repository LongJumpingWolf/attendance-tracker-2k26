/**
 * LOCAL INTEGRATION TEST GATEWAY. Not part of the app, not deployed, not used by any real build.
 *
 * Why it exists: in production the browser sends its FIREBASE ID TOKEN to Supabase, which accepts it through third-party auth
 * (Google's published signing keys) once the bootstrap function has put the `role` claim on the user. A local Supabase stack cannot
 * verify tokens issued by the Firebase Auth EMULATOR (they are unsigned), so this gateway stands where Supabase's own token acceptance
 * stands, in front of the REAL local stack:
 *
 *   POST /functions/v1/auth-role-bootstrap   the REAL handler (supabase/functions/auth-role-bootstrap/handler.ts), with the Admin SDK
 *                                            calls replaced by the Auth emulator's REST API (verify, read user, set custom claims)
 *   /rest/v1/*                               proxied to the local PostgREST after the bearer token is VERIFIED
 *   /realtime/v1/websocket                   proxied to the local Realtime service; the token inside join / access_token frames is verified
 *
 * "Verified" = the Auth emulator itself confirms the ID token (a forged, expired, unknown-user or wrong-project token is refused with
 * 401) AND it carries role = authenticated (put there by the bootstrap call, as in production). Only then is an HS256 token minted
 * with the LOCAL stack's own development secret, for the same subject, and swapped in. No token is accepted without the emulator saying
 * yes; there is no fixed token, no shortcut, and nothing is trusted from a request body.
 *
 * Refuses to start unless everything it touches is loopback (the Auth emulator, the local Supabase API, its own listener, the allowed
 * origin). The local stack's development secret comes from the environment (the runner reads `supabase status`) and is held in memory only.
 *
 * env: FIREBASE_AUTH_EMULATOR_HOST (127.0.0.1:9099), LOCAL_SUPABASE_API_URL, LOCAL_SUPABASE_JWT_SECRET (else `supabase status`),
 *      GATEWAY_PORT (54399), FIREBASE_PROJECT_ID (demo-hook; the emulator's project), ALLOWED_ORIGIN (http://localhost:3459)
 */
import http from "node:http"
import crypto from "node:crypto"
import { execFileSync } from "node:child_process"
import { fileURLToPath, pathToFileURL } from "node:url"
import path from "node:path"
import { WebSocketServer, WebSocket } from "ws"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])
const hostOf = (hostport) => hostport.replace(/:\d+$/, "")

const PORT = Number(process.env.GATEWAY_PORT ?? 54399)
const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? ""
const PROJECT = process.env.FIREBASE_PROJECT_ID ?? "demo-hook"
const ORIGINS = (process.env.ALLOWED_ORIGIN ?? "http://localhost:3459").split(",").map((o) => o.trim()) // loopback origins of the test app (two, so two devices can have separate storage)
/** The issuer / audience the LOCAL database guard policy expects (migration 20261009000100); a public identifier, not a secret */
const DB_PROJECT = "attendance-tracker-2k26"

if (!AUTH_HOST || !LOOPBACK.has(hostOf(AUTH_HOST))) throw new Error("refusing to start: FIREBASE_AUTH_EMULATOR_HOST must be set to a loopback host:port")
const loopbackOrigin = (o) => { const h = new URL(o).hostname; return LOOPBACK.has(h) || h.endsWith(".localhost") } // *.localhost always resolves to this machine
if (ORIGINS.some((o) => !loopbackOrigin(o))) throw new Error("refusing to start: ALLOWED_ORIGIN must be loopback origins")

function localStatus() {
  if (process.env.LOCAL_SUPABASE_API_URL && process.env.LOCAL_SUPABASE_JWT_SECRET) return { API_URL: process.env.LOCAL_SUPABASE_API_URL, JWT_SECRET: process.env.LOCAL_SUPABASE_JWT_SECRET }
  const out = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: ROOT })
  return JSON.parse(out.slice(out.indexOf("{")))
}
const status = localStatus()
const API = new URL(status.API_URL)
if (!LOOPBACK.has(API.hostname)) throw new Error("refusing to start: the Supabase API is not loopback")
const JWT_SECRET = status.JWT_SECRET
if (!JWT_SECRET) throw new Error("the local Supabase stack is not running (npx supabase start)")

const { createHandler, createRateLimiter } = await import("" + pathToFileURL(path.join(ROOT, "supabase/functions/auth-role-bootstrap/handler.ts")))

// ---- the Auth emulator, through its REST API (what the Admin SDK would do against Google) ---------------------------------------
const emu = `http://${AUTH_HOST}`
const post = async (p, body, admin = false) => {
  const res = await fetch(`${emu}${p}${p.includes("?") ? "&" : "?"}key=local`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(admin ? { authorization: "Bearer owner" } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
const err = (code) => Object.assign(new Error("x"), { code })
const decode = (t) => {
  const [h, p] = t.split(".")
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), payload: JSON.parse(Buffer.from(p ?? "", "base64url").toString()) }
}

/** Asks the emulator whether this ID token is real (it only knows tokens it issued) and returns its claims */
async function verifyWithEmulator(token) {
  let claims
  try {
    claims = decode(token).payload
  } catch {
    throw err("auth/argument-error")
  }
  let r
  try {
    r = await post("/identitytoolkit.googleapis.com/v1/accounts:lookup", { idToken: token })
  } catch {
    throw err("auth/internal-error")
  }
  const user = r.json?.users?.[0]
  if (r.status !== 200 || !user) throw err("auth/invalid-id-token")
  if (user.disabled) throw err("auth/user-disabled")
  if (!claims.sub || user.localId !== claims.sub) throw err("auth/invalid-id-token")
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) throw err("auth/id-token-expired")
  return claims
}

const adminUser = async (uid) => {
  const r = await post(`/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { localId: [uid] }, true)
  const u = r.json?.users?.[0]
  if (!u) throw err("auth/user-not-found")
  return {
    disabled: Boolean(u.disabled),
    tokensValidAfterTime: u.validSince ? new Date(Number(u.validSince) * 1000).toUTCString() : undefined,
    customClaims: u.customAttributes ? JSON.parse(u.customAttributes) : null,
  }
}

// ---- the bootstrap function: the REAL handler, emulator-backed dependencies ------------------------------------------------------
const windowCounter = new Map()
const dbLimiter = {
  async take(bucket, key, limit, windowSeconds) {
    const k = `${bucket}:${key}:${Math.floor(Date.now() / (windowSeconds * 1000))}`
    const n = (windowCounter.get(k) ?? 0) + 1
    windowCounter.set(k, n)
    return n <= limit
  },
}
const stats = { bootstrap: 0, rest: 0, restRefused: 0, wsOpened: 0, wsOpen: 0, exchanged: 0, injected: 0, targets: {} } // targets: how often each table / function was addressed
let failReads = 0 // test control: the next N reads of the sync table answer 503
const handleBootstrap = createHandler(
  { ok: true, config: { allowedOrigins: ORIGINS, projectId: PROJECT, ipMode: "off", rate: { uidPer10Min: 600, globalPerMin: 6000, ipPerMin: 6000 } } },
  {
    verifyIdToken: async (token) => {
      const c = await verifyWithEmulator(token)
      return { uid: c.sub, sub: c.sub, iss: c.iss, aud: c.aud, iat: c.iat, role: c.role }
    },
    getUser: adminUser,
    setCustomClaims: async (uid, claims) => {
      const r = await post(`/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, { localId: uid, customAttributes: JSON.stringify(claims) }, true)
      if (r.status !== 200) throw err("auth/internal-error")
    },
    ipLimiter: createRateLimiter({ windowMs: 60_000, max: 100_000 }),
    uidLimiter: createRateLimiter({ windowMs: 600_000, max: 100_000 }),
    fastLimiter: createRateLimiter({ windowMs: 60_000, max: 100_000 }),
    revocationLimiter: createRateLimiter({ windowMs: 60_000, max: 100_000 }),
    dbLimiter,
    log: () => {},
  },
)

// ---- token exchange: a verified, role-bearing emulator token for a local-stack token of the same subject --------------------------
const b64u = (b) => Buffer.from(b).toString("base64url")
const mint = (sub, exp) => {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const now = Math.floor(Date.now() / 1000)
  const body = b64u(JSON.stringify({ sub, role: "authenticated", iss: `https://securetoken.google.com/${DB_PROJECT}`, aud: DB_PROJECT, iat: now, exp }))
  return `${head}.${body}.${crypto.createHmac("sha256", JWT_SECRET).update(`${head}.${body}`).digest("base64url")}`
}
const cache = new Map()
async function exchange(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9._-]{20,8192}$/.test(token)) return null
  const hit = cache.get(token)
  if (hit && hit.until > Date.now()) return hit.out
  try {
    const c = await verifyWithEmulator(token)
    if (c.role !== "authenticated" || c.aud !== PROJECT || c.iss !== `https://securetoken.google.com/${PROJECT}`) return null
    const out = mint(c.sub, Math.min(c.exp, Math.floor(Date.now() / 1000) + 3600))
    cache.set(token, { out, until: Date.now() + 20_000 })
    stats.exchanged++
    return out
  } catch {
    return null
  }
}

// ---- the HTTP side -------------------------------------------------------------------------------------------------------------
const cors = (res, origin) => {
  if (ORIGINS.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin)
    res.setHeader("vary", "Origin")
    res.setHeader("access-control-allow-headers", "authorization, apikey, content-type, prefer, accept-profile, content-profile, x-client-info")
    res.setHeader("access-control-allow-methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
    res.setHeader("access-control-expose-headers", "content-range, content-type")
  }
}
const readBody = (req) =>
  new Promise((resolve) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
  })

const sockets = new Set()
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://gateway")
  const origin = req.headers.origin
  try {
    if (url.pathname.startsWith("/__test/")) {
      if (!LOOPBACK.has(hostOf(req.headers.host ?? "")) || origin) return void res.writeHead(403).end() // test control: loopback, never from a web page
      if (url.pathname === "/__test/stats") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ...stats, wsOpen: sockets.size }))
      if (url.pathname === "/__test/fail-reads") {
        failReads = Number(url.searchParams.get("n") ?? 0) || 0
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ failReads }))
      }
      if (url.pathname === "/__test/kill-sockets") {
        const n = sockets.size
        for (const s of [...sockets]) s.terminate()
        return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ killed: n }))
      }
      return void res.writeHead(404).end()
    }
    if (url.pathname === "/functions/v1/auth-role-bootstrap") {
      stats.bootstrap++
      const headers = new Headers()
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v)
      const r = await handleBootstrap(new Request(`http://gateway${url.pathname}`, { method: req.method, headers }))
      res.writeHead(r.status, Object.fromEntries(r.headers))
      return void res.end(Buffer.from(await r.arrayBuffer()))
    }
    if (url.pathname.startsWith("/rest/v1/")) {
      cors(res, origin)
      if (req.method === "OPTIONS") return void res.writeHead(204).end()
      stats.rest++
      {
        const target = url.pathname.replace("/rest/v1/", "").replace(/^rpc\//, "rpc:")
        stats.targets[target] = (stats.targets[target] ?? 0) + 1
      }
      if (failReads > 0 && req.method === "GET" && url.pathname === "/rest/v1/syncs") {
        failReads--
        stats.injected++
        return void res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ message: "injected failure" }))
      }
      const headers = {}
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && !["host", "connection", "content-length", "origin", "referer"].includes(k)) headers[k] = v
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]
      if (bearer) {
        const swapped = await exchange(bearer)
        if (!swapped) {
          stats.restRefused++
          return void res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ code: "PGRST301", message: "JWT invalid" }))
        }
        headers.authorization = `Bearer ${swapped}`
      }
      const body = ["GET", "HEAD"].includes(req.method ?? "GET") ? undefined : await readBody(req)
      const up = await fetch(`${API.origin}${url.pathname}${url.search}`, { method: req.method, headers, body })
      const out = {}
      up.headers.forEach((v, k) => {
        if (!["content-encoding", "content-length", "transfer-encoding", "connection", "access-control-allow-origin"].includes(k)) out[k] = v
      })
      res.writeHead(up.status, out)
      return void res.end(Buffer.from(await up.arrayBuffer()))
    }
    res.writeHead(404).end()
  } catch {
    if (!res.headersSent) res.writeHead(502)
    res.end()
  }
})

// ---- the WebSocket side: Realtime, with the token inside the frames verified and swapped ---------------------------------------------
const wss = new WebSocketServer({ noServer: true })
server.on("upgrade", (req, socket, head) => {
  if (!req.url?.startsWith("/realtime/v1/websocket") || (req.headers.origin && !ORIGINS.includes(req.headers.origin))) return void socket.destroy()
  wss.handleUpgrade(req, socket, head, (client) => relay(client, req.url))
})
function relay(client, pathAndQuery) {
  const upstream = new WebSocket(`ws://${API.host}${pathAndQuery}`)
  stats.wsOpened++
  sockets.add(client)
  const queue = []
  let closed = false
  const end = () => {
    if (closed) return
    closed = true
    sockets.delete(client)
    try {
      client.terminate()
    } catch {}
    try {
      upstream.terminate()
    } catch {}
  }
  upstream.on("open", () => queue.splice(0).forEach((m) => upstream.send(m)))
  upstream.on("message", (data, isBinary) => client.readyState === WebSocket.OPEN && client.send(data, { binary: isBinary }))
  upstream.on("close", end)
  upstream.on("error", end)
  client.on("close", end)
  client.on("error", end)
  client.on("message", async (data, isBinary) => {
    let out = data
    if (!isBinary) {
      try {
        const f = JSON.parse(data.toString())
        if ((f.event === "phx_join" || f.event === "access_token") && f.payload && typeof f.payload === "object") {
          const t = f.payload.access_token
          if (t !== undefined && t !== null) {
            const swapped = await exchange(t)
            if (!swapped) return void end() // an unverifiable token: the connection is dropped, nothing is forwarded
            f.payload.access_token = swapped
            out = JSON.stringify(f)
          }
        }
      } catch {
        /* not JSON: forwarded as it is */
      }
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(out, { binary: isBinary })
    else queue.push(out)
  })
}

server.listen(PORT, "127.0.0.1", () => console.log(`local-supabase-gateway listening on http://127.0.0.1:${PORT} (auth emulator ${AUTH_HOST}, project ${PROJECT}, origins ${ORIGINS.join(", ")})`))
process.on("SIGTERM", () => process.exit(0))
