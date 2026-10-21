/**
 * END-TO-END: the real app, the real `useCloudSync` hook, the real Firebase Auth SDK (against the Firebase Auth EMULATOR), the real
 * auth bridge and bootstrap handler, the real Supabase adapter and Realtime transport, and the real LOCAL Supabase stack with its RLS.
 * LOCAL ONLY. Run it with  node scripts/run-hook-supabase.mjs  (which starts the emulators and passes the local stack's coordinates).
 *
 * What stands in for production, and why (details in PHASE8_REALTIME.md section 7):
 *   - sign-in: the Firebase Auth emulator's own "Google" popup (a real signInWithPopup / linkWithPopup through the app's real UI);
 *   - bootstrap: scripts/local-supabase-gateway.mjs runs the REAL handler with the emulator behind it (set custom claim `role`);
 *   - token acceptance: the same gateway verifies each Firebase emulator token with the emulator and swaps in a local-stack token for
 *     the same subject (production: Supabase third-party auth does this). Forged/unknown/role-less tokens get 401.
 * The app is built with NEXT_PUBLIC_* values for the emulators and the loopback gateway only; the Supabase feature flags are set for this
 * child dev server alone. Nothing here can reach hosted Supabase or the real Firebase project: the script refuses non-loopback values.
 */
import puppeteer from "puppeteer-core"
import zlib from "node:zlib"
import path from "node:path"
import { spawn, spawnSync, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PORT = Number(process.env.E2E_PORT ?? 3459)
const BASE = `http://localhost:${PORT}` // device A
const BASE_B = `http://device-b.localhost:${PORT}` // device B: a different ORIGIN, so its storage is its own, while one browser profile keeps the emulator's Google account list (the same Google account can sign in on both)
const GW_PORT = Number(process.env.GATEWAY_PORT ?? 54399)
const GW = `http://127.0.0.1:${GW_PORT}`
const AUTH_EMU = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9099"
const FS_EMU = process.env.FIRESTORE_EMULATOR_HOST ?? "127.0.0.1:8080"
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const DB = "supabase_db_Attendance_tracker"
const PROJECT = "demo-hook"
const run = Date.now().toString(36)

// ---- safety: everything must be loopback ---------------------------------------------------------------------------------------
const loop = (hp) => /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(hp)
for (const [n, v] of [["FIREBASE_AUTH_EMULATOR_HOST", AUTH_EMU], ["FIRESTORE_EMULATOR_HOST", FS_EMU]]) if (!loop(v)) throw new Error(`refusing to run: ${n} is not loopback`)
if (!process.env.LOCAL_SUPABASE_API_URL || !process.env.LOCAL_SUPABASE_JWT_SECRET || !process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY) throw new Error("run this through scripts/run-hook-supabase.mjs")
if (!loop(new URL(process.env.LOCAL_SUPABASE_API_URL).host)) throw new Error("refusing to run: the Supabase API is not loopback")

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`)
}
const until = async (fn, ms = 20000, every = 250) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return true
    } catch {
      /* try again */
    }
    await wait(every)
  }
  return false
}

// ---- processes ---------------------------------------------------------------------------------------------------------------------
const children = []
const killTree = (c) => {
  try {
    spawnSync("taskkill", ["/pid", String(c.pid), "/T", "/F"], { windowsHide: true })
  } catch {
    /* gone */
  }
}
const reachable = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(2000) })
    return true
  } catch {
    return false
  }
}
async function startGateway() {
  if (await reachable(`${GW}/__test/stats`)) return
  const c = spawn("node", [path.join(ROOT, "scripts/local-supabase-gateway.mjs")], {
    cwd: ROOT,
    env: { ...process.env, FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMU, FIREBASE_PROJECT_ID: PROJECT, ALLOWED_ORIGIN: `${BASE},${BASE_B}`, GATEWAY_PORT: String(GW_PORT) },
    windowsHide: true,
  })
  children.push(c)
  if (!(await until(() => reachable(`${GW}/__test/stats`), 30000))) throw new Error("the gateway did not start")
}
async function startApp() {
  if (await reachable(BASE + "/manifest.json")) throw new Error(`port ${PORT} is already serving something: stop it first so the app is built with the test settings`)
  const env = {
    ...process.env,
    NEXT_PUBLIC_FIREBASE_API_KEY: "local-emulator-key",
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT,
    NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:0",
    NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: "0",
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "localhost",
    NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID: "",
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "",
    NEXT_PUBLIC_FIREBASE_VAPID_KEY: "",
    NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: AUTH_EMU,
    NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST: FS_EMU,
    NEXT_PUBLIC_BACKEND_SYNC: "supabase", // ONLY the sync domain: social, connections, invites, Pings and push tokens stay on Firebase (the emulators)
    NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE: "true",
    NEXT_PUBLIC_SUPABASE_REALTIME: "true",
    NEXT_PUBLIC_SUPABASE_URL: GW,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.LOCAL_SUPABASE_PUBLISHABLE_KEY,
  }
  const c = spawn("node", [path.join(ROOT, "node_modules/next/dist/bin/next"), "dev", "-p", String(PORT)], { cwd: ROOT, env, windowsHide: true })
  children.push(c)
  c.stdout.on("data", () => {})
  c.stderr.on("data", () => {})
  if (!(await until(() => reachable(BASE + "/manifest.json"), 120000, 1000))) throw new Error("the app did not start")
}
const emuUsers = () =>
  fetch(`http://${AUTH_EMU}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:query`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer owner" },
    body: JSON.stringify({ returnUserInfo: true }),
  })
    .then((r) => r.json())
    .then((j) => j.userInfo ?? [])
    .catch(() => [])
const stats = async () => (await fetch(`${GW}/__test/stats`)).json()
const killSockets = async () => (await fetch(`${GW}/__test/kill-sockets`)).json()
const failReads = (n) => fetch(`${GW}/__test/fail-reads?n=${n}`)

// ---- the stored copy, read straight from the local database ---------------------------------------------------------------------
const psql = (sql) => execFileSync("docker", ["exec", "-i", DB, "psql", "-U", "postgres", "-X", "-t", "-A", "-F", "|", "-c", sql], { encoding: "utf8" }).trim()
function stored(uid) {
  if (!uid) return null
  const row = psql(`select rev, data from public.syncs where uid = '${uid.replace(/'/g, "")}'`)
  if (!row) return null
  const i = row.indexOf("|")
  const rev = Number(row.slice(0, i))
  const raw = row.slice(i + 1)
  const text = raw.startsWith("gz1:") ? zlib.gunzipSync(Buffer.from(raw.slice(4), "base64")).toString() : raw
  return { rev, data: JSON.parse(text).data }
}
const uids = []
const cleanup = () => {
  if (!uids.length) return
  try {
    psql(`delete from public.syncs where uid in (${uids.map((u) => `'${u.replace(/'/g, "")}'`).join(",")})`)
  } catch {
    /* best effort: only rows of accounts this run created */
  }
}

// ---- browser helpers -------------------------------------------------------------------------------------------------------------------
const errors = []
async function newDevice(ctx, label, base, seed) {
  const page = await ctx.newPage()
  page.on("pageerror", (e) => errors.push(`${label}: ${String(e.message).slice(0, 160)}`))
  await page.goto(base + "/manifest.json")
  await page.evaluate(
    (seed) =>
      new Promise((resolve, reject) => {
        localStorage.clear()
        localStorage.setItem("onboardingDone", "1")
        const open = indexedDB.open("college-tracker", 1)
        open.onupgradeneeded = () => open.result.createObjectStore("kv")
        open.onsuccess = () => {
          const tx = open.result.transaction("kv", "readwrite")
          const kv = tx.objectStore("kv")
          if (seed) for (const k of ["subjects", "tasks", "tags", "mates"]) kv.put(seed[k], k)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    seed ?? null,
  )
  await page.goto(base + "/", { waitUntil: "load", timeout: 120000 })
  await wait(2500)
  return { page, ctx, label }
}
const clickText = (page, text, sel = "button") =>
  page.evaluate(
    (t, sel) => {
      const b = [...document.querySelectorAll(sel)].find((x) => (x.getAttribute("aria-label") || x.textContent || "").trim().startsWith(t))
      if (b) b.click()
      return Boolean(b)
    },
    text,
    sel,
  )
const trustedClick = async (page, text) => {
  const h = await page.evaluateHandle((t) => [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || x.textContent || "").trim().startsWith(t)) ?? null, text)
  const el = h.asElement()
  if (!el) return false
  await el.click()
  return true
}
const idb = (page, key) =>
  page.evaluate(
    (key) =>
      new Promise((resolve) => {
        const open = indexedDB.open("college-tracker", 1)
        open.onsuccess = () => {
          const r = open.result.transaction("kv").objectStore("kv").get(key)
          r.onsuccess = () => resolve(r.result ?? null)
        }
      }),
    key,
  )
const tagsOf = async (d) => ((await idb(d.page, "tags")) ?? []).slice().sort()
const ls = (page, k) => page.evaluate((k) => localStorage.getItem(k), k)
const bodyText = (page) => page.evaluate(() => document.body.innerText)

/** Opens Settings (if it is closed) and goes to the list of panels */
async function settingsHome(page) {
  await page.bringToFront() // two pages share one profile; only the front one runs at full speed
  if (!(await page.$('button[aria-label="Close"]'))) {
    await clickText(page, "Settings")
    await wait(600)
  }
  if (await page.$('button[aria-label="Back"]')) {
    await clickText(page, "Back")
    await wait(500)
  }
}
async function openPanel(page, label) {
  await settingsHome(page)
  await clickText(page, label)
  await wait(600)
}
const closeSheet = async (page) => {
  if (await page.$('button[aria-label="Close"]')) await clickText(page, "Close")
  await wait(400)
}

/** Real sign-in through the app's Settings > Sync, and the emulator's Google popup */
async function signIn(d, email, name) {
  const { page } = d
  await openPanel(page, "Sync between browsers")
  const popupSeen = new Promise((res) => {
    const t0 = Date.now()
    const poll = async () => {
      const p = (await d.ctx.pages()).find((x) => x.url().includes("/emulator/auth/handler"))
      if (p) return res(p)
      if (Date.now() - t0 > 15000) return res(null)
      setTimeout(poll, 200)
    }
    poll()
  })
  if (!(await trustedClick(page, "Sign in with Google"))) {
    console.log(`DIAG ${d.label}: no sign-in button at ${page.url()}. buttons: ${JSON.stringify(await page.evaluate(() => [...document.querySelectorAll("button")].map((b) => (b.getAttribute("aria-label") || b.textContent || "").trim().slice(0, 30))))}; text: ${JSON.stringify((await bodyText(page)).slice(0, 200))}; errors: ${errors.slice(-3).join(" | ")}`)
    return false
  }
  const pop = await popupSeen
  if (!pop) {
    console.log(`DIAG ${d.label}: no popup. page says: ${JSON.stringify((await bodyText(page)).slice(-240))}; errors: ${errors.slice(-3).join(" | ")}`)
    return false
  }
  await wait(1500)
  if (process.env.E2E_DEBUG) console.log(`DIAG ${d.label}: popup elements`, JSON.stringify(await pop.evaluate(() => [...document.querySelectorAll("li,button,input,a,div")].filter((e) => e.children.length === 0).map((e) => (e.id || "") + ":" + (e.textContent || e.value || "").trim().slice(0, 50)))))
  // The emulator's popup lists the Google accounts that already exist in it; signing in again as one of them is how a second device
  // gets the SAME user. (Adding a "new account" always creates a new identity, even with the same email.)
  const existing = await pop.evaluate((email) => {
    const li = [...document.querySelectorAll(".js-reuse-account")].find((e) => JSON.parse(decodeURIComponent(e.dataset.idToken)).email === email)
    if (li) li.click()
    return Boolean(li)
  }, email)
  if (process.env.E2E_DEBUG) {
    console.log(`DIAG ${d.label}: existing-account click=${existing}; emulator users=${JSON.stringify((await emuUsers()).map((u) => [u.localId.slice(0, 6), u.email, (u.providerUserInfo ?? []).map((p) => p.providerId), u.providerUserInfo?.[0]?.rawId?.slice(0, 6)]))}`)
  }
  if (existing) {
    /* clicked */
  } else {
    await pop.click("#add-account-button")
    await wait(600)
    await pop.click("#autogen-button")
    await wait(300)
    for (const [sel, v] of [["#email-input", email], ["#display-name-input", name]]) {
      await pop.$eval(sel, (el) => {
        el.value = ""
        el.dispatchEvent(new Event("input", { bubbles: true }))
      })
      await pop.type(sel, v)
    }
    await pop.click("#sign-in")
  }
  const done = await until(async () => Boolean(await ls(page, "syncOwner")) || Boolean(await page.$('[data-testid="reconcile-sheet"]')), 30000)
  if (!done) console.log(`DIAG ${d.label}: sign-in did not finish. page says: ${JSON.stringify((await bodyText(page)).slice(-300))}; errors: ${errors.slice(-3).join(" | ")}`)
  return done
}
async function addTag(d, tag) {
  await openPanel(d.page, "Tags")
  await d.page.click('input[placeholder^="New tag"]')
  await d.page.type('input[placeholder^="New tag"]', tag)
  await d.page.keyboard.press("Enter")
  await wait(500)
  await closeSheet(d.page)
}
const hasTag = async (d, tag) => (await tagsOf(d)).includes(tag)

// ============================================================================================================================================
const A_SEED = {
  subjects: [{ id: "s-a", name: "Pharmacology", attended: 1, missed: 0, requirement: 75, glowColor: "#3a86ff", tags: [], log: [{ d: "2026-10-01", s: "P" }] }],
  tasks: [],
  tags: ["a0"],
  mates: [],
}
const EMAIL_X = `hook-x-${run}@example.com`
const EMAIL_Y = `hook-y-${run}@example.com`

let browser
let exitCode = 1
try {
  await startGateway()
  await startApp()
  browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", protocolTimeout: 120000 })
  const profile = await browser.createBrowserContext() // one profile: the emulator remembers its Google accounts; the two app origins keep device storage apart

  // ---- 1. first sign-in, with data on the device and an empty account ------------------------------------------------------------------
  const A = await newDevice(profile, "A", BASE, A_SEED)
  check("1. the app starts with ONLY the sync domain routed to Supabase, and Firebase Auth on the emulator", !(await bodyText(A.page)).includes("Application error"))
  const ok1 = await signIn(A, EMAIL_X, "Hook X")
  check("1. the real Google popup sign-in (Auth emulator) completes", ok1)
  const uidX = await ls(A.page, "syncOwner")
  if (uidX) uids.push(uidX)
  check("1. the hook connected and recorded the signed-in account as its owner", Boolean(uidX), uidX ?? "")
  const s1 = await stats()
  check("1. the real bootstrap handler ran and a verified token was exchanged for the database", s1.bootstrap >= 1 && s1.exchanged >= 1, JSON.stringify(s1))
  check("1. the device's data was uploaded as the account's first stored copy (revision 1, through RLS)", await until(() => stored(uidX)?.rev === 1, 25000))
  check("1. the stored copy holds this device's subject and tag", stored(uidX)?.data.subjects?.[0]?.name === "Pharmacology" && (stored(uidX)?.data.tags ?? []).includes("a0"))
  check("1. the Realtime channel is open (a socket reached the local Realtime service through the gateway)", await until(async () => (await stats()).wsOpen >= 1, 20000))
  await closeSheet(A.page)

  // ---- 2. a second device signs in to the SAME account -----------------------------------------------------------------------------------
  const B = await newDevice(profile, "B", BASE_B)
  const ok2 = await signIn(B, EMAIL_X, "Hook X")
  check("2. device B signs in with the same Google account", ok2)
  const uidB = await ls(B.page, "syncOwner")
  check("2. the same Google account gives the same user id on both devices", Boolean(uidB) && uidB === uidX, `${uidB} vs ${uidX}`)
  check("2. B (empty) takes the account's data: its tags and subjects arrive in B's own storage", await until(async () => (await hasTag(B, "a0")) && ((await idb(B.page, "subjects")) ?? []).some((s) => s.name === "Pharmacology"), 25000))
  await closeSheet(B.page)

  // ---- 3. bidirectional changes, live ------------------------------------------------------------------------------------------------------
  const wsBefore = (await stats()).wsOpen
  await addTag(A, "from-A")
  check("3. A's change reaches the stored copy", await until(() => (stored(uidX)?.data.tags ?? []).includes("from-A"), 20000))
  check("3. B receives A's change live, with no reload", await until(() => hasTag(B, "from-A"), 20000))
  await addTag(B, "from-B")
  check("3. B's change reaches the stored copy", await until(() => (stored(uidX)?.data.tags ?? []).includes("from-B"), 20000))
  check("3. A receives B's change live, with no reload", await until(() => hasTag(A, "from-B"), 20000))
  check("3. both devices hold the same tags", JSON.stringify(await tagsOf(A)) === JSON.stringify(await tagsOf(B)), JSON.stringify(await tagsOf(A)))
  check("3. no extra sockets were opened for this (two devices, two channels)", (await stats()).wsOpen === wsBefore, `${wsBefore} -> ${(await stats()).wsOpen}`)

  // ---- 3b. a social action (saving the profile name in Mates) goes to Firebase, not to Supabase ---------------------------------------------------
  // Only the sync domain is routed to Supabase. The profile name is a social-domain write: it must land in the Firestore emulator, and the gateway
  // must see no request for it. (With one global Supabase switch the same action would reach the gateway as a profile request instead.)
  const SOCIAL_NAME = "Hook Social"
  const fsUserName = async (uid) =>
    fetch(`http://${FS_EMU}/v1/projects/${PROJECT}/databases/(default)/documents/users/${encodeURIComponent(uid)}`, { headers: { authorization: "Bearer owner" } })
      .then((r) => r.json())
      .then((j) => j.fields?.name?.stringValue ?? null)
      .catch(() => null)
  await A.page.bringToFront() // a background tab never paints, and a click on its element waits for a paint
  await closeSheet(A.page)
  await clickText(A.page, "Mates")
  const nameBox = 'input[placeholder="Your name"]'
  const shown = await until(async () => Boolean(await A.page.$(nameBox)), 30000)
  check("3b. the Mates tab asks for a name once the account is connected for social", shown)
  if (shown) {
    const typed = await until(async () => {
      try {
        const box = await A.page.$(nameBox)
        if (!box) return false
        await box.evaluate((el) => { el.scrollIntoView({ block: "center" }); el.focus() })
        await A.page.keyboard.type(SOCIAL_NAME)
        return (await box.evaluate((el) => el.value)) === SOCIAL_NAME
      } catch {
        return false
      }
    }, 20000, 1000)
    if (!typed) throw new Error("could not type the name")
    await A.page.keyboard.press("Enter")
  }
  check("3b. the social action completed: the name is stored in Firebase (Firestore emulator)", shown && (await until(async () => (await fsUserName(uidX)) === SOCIAL_NAME, 30000)), `users/${uidX} name=${await fsUserName(uidX)}`)
  const socialTargets = Object.keys((await stats()).targets ?? {}).filter((t) => t !== "syncs" && t !== "rpc:sync_put")
  check("3b. ... and the gateway saw no request for it (it did not go to Supabase)", socialTargets.length === 0, JSON.stringify((await stats()).targets))
  await clickText(A.page, "Today")
  await wait(600)

  // ---- 4. simultaneous edits: both devices change while apart, then meet ---------------------------------------------------------------------
  await B.page.setOfflineMode(true)
  await wait(500)
  await addTag(B, "b-while-apart")
  await addTag(A, "a-while-apart")
  check("4. A's change is stored while B is cut off", await until(() => (stored(uidX)?.data.tags ?? []).includes("a-while-apart"), 20000))
  check("4. B has not seen A's change yet (it really was apart)", !(await hasTag(B, "a-while-apart")))
  const revBefore = stored(uidX).rev
  await B.page.setOfflineMode(false)
  check("4. B's reconnect merges: B ends with both changes", await until(async () => (await hasTag(B, "a-while-apart")) && (await hasTag(B, "b-while-apart")), 40000))
  check("4. the merged result is stored (nothing lost, nothing overwritten)", await until(() => ["a-while-apart", "b-while-apart"].every((t) => (stored(uidX)?.data.tags ?? []).includes(t)), 30000))
  check("4. A converges on the same set", await until(() => hasTag(A, "b-while-apart"), 30000))
  check("4. the stored revision moved forward", stored(uidX).rev > revBefore, `${revBefore} -> ${stored(uidX).rev}`)

  // ---- 5. Realtime recovery: sockets killed, a change made meanwhile, then restored -----------------------------------------------------------
  await B.page.setOfflineMode(true)
  const killed = await killSockets()
  await wait(1500)
  check("5. the live sockets were killed from the server side", killed.killed >= 1, JSON.stringify(killed))
  await addTag(A, "while-socket-down")
  check("5. the change is stored while B has no channel", await until(() => (stored(uidX)?.data.tags ?? []).includes("while-socket-down"), 20000))
  await B.page.setOfflineMode(false)
  check("5. B recovers: it re-subscribes and converges on the change it missed (nothing replays it)", await until(() => hasTag(B, "while-socket-down"), 40000))
  check("5. B's channel is open again", await until(async () => (await stats()).wsOpen >= 2, 20000), JSON.stringify(await stats()))

  // ---- 6. failed refetch: the reads made on reconnecting fail, and nothing else happens ------------------------------------------------------------
  await B.page.setOfflineMode(true)
  await killSockets()
  await wait(1200)
  await addTag(A, "after-failed-read")
  await failReads(3) // the read B makes on coming back, the read after it re-subscribes, and the first retry all fail
  const inj0 = (await stats()).injected
  await B.page.setOfflineMode(false)
  check("6. the reads B makes on reconnecting really failed, more than once (injected 503s consumed: the retry kept trying)", await until(async () => (await stats()).injected - inj0 >= 3, 45000), JSON.stringify(await stats()))
  check("6. B still converges without any further change by A (bounded retry)", await until(() => hasTag(B, "after-failed-read"), 45000))
  await failReads(0)

  // ---- 7. sign-out and account switching -----------------------------------------------------------------------------------------------------------
  const bTagsBefore = await tagsOf(B)
  await openPanel(B.page, "Sync between browsers")
  await trustedClick(B.page, "Sign out in this browser")
  await wait(400)
  await trustedClick(B.page, "Sign out")
  check("7. B signs out: the hook forgets the account", await until(async () => !(await ls(B.page, "syncOwner")), 20000))
  check("7. sign-out deletes nothing here or in the account", JSON.stringify(await tagsOf(B)) === JSON.stringify(bTagsBefore) && Boolean(stored(uidX)))
  await closeSheet(B.page)
  const revX = stored(uidX).rev
  await addTag(A, "x-after-b-signed-out")
  check("7. the account keeps working for A", await until(() => (stored(uidX)?.data.tags ?? []).includes("x-after-b-signed-out"), 20000))
  await wait(2500)
  check("7. a signed-out B receives nothing of it", !(await hasTag(B, "x-after-b-signed-out")))

  const okY = await signIn(B, EMAIL_Y, "Hook Y")
  check("7. B signs in as a DIFFERENT account", okY)
  const sheetShown = await until(async () => Boolean(await B.page.$('[data-testid="reconcile-sheet"]')), 25000)
  check("7. the data on B belongs to the previous account, so B is asked what to do (nothing is combined silently)", sheetShown)
  const uidY = await ls(B.page, "syncOwner")
  const uidYseen = uidY ?? (await B.page.evaluate(() => Object.keys(localStorage).join(",")))
  if (sheetShown) await B.page.click('[data-testid="reconcile-later"]')
  await wait(1500)
  // find the new account's uid from the emulator (the hook has not connected yet)
  const uidYreal = (await emuUsers()).find((u) => u.email === EMAIL_Y)?.localId
  if (uidYreal) uids.push(uidYreal)
  check("7. the new account exists in the emulator and is a different user", Boolean(uidYreal) && uidYreal !== uidX, String(uidYreal))
  check("7. after 'decide later' the new account has no stored copy", uidYreal ? stored(uidYreal) === null : false)
  check("7. B's own data is untouched", JSON.stringify(await tagsOf(B)) === JSON.stringify(bTagsBefore))
  await addTag(A, "x-while-b-undecided")
  await wait(2500)
  check("7. account X's later changes do not reach B while B is undecided", !(await hasTag(B, "x-while-b-undecided")))
  check("7. B did not write into account X", !(stored(uidX).data.tags ?? []).includes("y-only") && stored(uidX).rev >= revX)

  // B chooses to use this device's data for account Y (explicit, confirmed)
  await openPanel(B.page, "Sync between browsers")
  await trustedClick(B.page, "Choose")
  await until(async () => Boolean(await B.page.$('[data-testid="reconcile-sheet"]')), 10000)
  await B.page.$eval('[data-testid="reconcile-option-device"] input', (el) => el.click())
  await wait(400)
  if (await B.page.$('[data-testid="reconcile-confirm"]')) await B.page.$eval('[data-testid="reconcile-confirm"]', (el) => el.click())
  await wait(400)
  await B.page.$eval('[data-testid="reconcile-apply"]', (el) => el.click())
  const connectedY = await until(async () => (await ls(B.page, "syncOwner")) === uidYreal, 30000)
  if (!connectedY) console.log(`DIAG B: after the choice: owner=${await ls(B.page, "syncOwner")}; sheet=${Boolean(await B.page.$('[data-testid="reconcile-sheet"]'))}; error=${await B.page.$eval('[data-testid="reconcile-error"]', (e) => e.textContent).catch(() => null)}; notice=${await B.page.$eval('[data-testid="reconcile-notice"]', (e) => e.textContent).catch(() => null)}; options=${JSON.stringify(await B.page.evaluate(() => [...document.querySelectorAll('[data-testid^="reconcile-option"]')].map((e) => [e.dataset.testid, e.querySelector("input").checked, e.querySelector("input").disabled])))}; confirm=${Boolean(await B.page.$('[data-testid="reconcile-confirm"]'))}; apply disabled=${await B.page.$eval('[data-testid="reconcile-apply"]', (e) => e.disabled).catch(() => null)}; text=${JSON.stringify((await bodyText(B.page)).slice(-300))}`)
  check("7. after the explicit choice, B connects as account Y", connectedY, String(await ls(B.page, "syncOwner")))
  check("7. account Y now stores B's data (and only B's data)", await until(() => uidYreal && stored(uidYreal)?.data.tags?.includes("from-B"), 25000))
  check("7. account Y's copy holds nothing that A added after B left account X", !(stored(uidYreal)?.data.tags ?? []).includes("x-after-b-signed-out"))
  await addTag(B, "y-only")
  check("7. B's new change goes to account Y", await until(() => (stored(uidYreal)?.data.tags ?? []).includes("y-only"), 20000))
  await wait(2500)
  check("7. account X never receives account Y's change", !(stored(uidX).data.tags ?? []).includes("y-only"))
  check("7. A (account X) never receives account Y's change", !(await hasTag(A, "y-only")))
  await addTag(A, "x-final")
  await wait(3000)
  check("7. B (account Y) never receives account X's later changes", !(await hasTag(B, "x-final")))
  check("7. account Y's stored copy never receives account X's later changes", !(stored(uidYreal)?.data.tags ?? []).includes("x-final"))

  // ---- summary ---------------------------------------------------------------------------------------------------------------------------------------
  const real = errors.filter((e) => !/404|Failed to load resource/.test(e))
  // Only sync was routed to Supabase: whatever the app did for social, connections, invites, Pings and push tokens went to Firebase (the emulators).
  const targets = Object.keys((await stats()).targets ?? {})
  const strays = targets.filter((t) => t !== "syncs" && t !== "rpc:sync_put")
  check("sync is the ONLY thing that reached Supabase (no profiles, connections, invites, Pings or push-token request)", targets.length > 0 && strays.length === 0, JSON.stringify((await stats()).targets))
  check("no uncaught page errors in either device", real.length === 0, real.slice(0, 3).join(" | "))
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  exitCode = failed.length ? 1 : 0
} catch (e) {
  console.log("FATAL", e?.stack ?? e)
} finally {
  try {
    await browser?.close()
  } catch {
    /* closed */
  }
  cleanup()
  for (const c of children) killTree(c)
  process.exit(exitCode)
}
