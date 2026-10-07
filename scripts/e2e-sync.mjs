/**
 * End-to-end checks of the sync safety rules, in a real browser against the real app and real IndexedDB.
 *
 * Needs a dev server with the Firebase keys blanked, so sync uses the built-in dev store (a file on this computer):
 *   NEXT_PUBLIC_FIREBASE_API_KEY= NEXT_PUBLIC_FIREBASE_PROJECT_ID= NEXT_PUBLIC_FIREBASE_APP_ID= \
 *   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID= NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN= npx next dev -p 3458
 * and puppeteer-core (not a project dependency):  npm i --no-save puppeteer-core
 *   BASE=http://localhost:3458 CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/e2e-sync.mjs
 */
import puppeteer from "puppeteer-core"
import zlib from "node:zlib"

const BASE = process.env.BASE ?? "http://localhost:3458"
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const run = Date.now().toString(36)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`)
}

const backup = (subjects) => ({ app: "college-tracker", version: 1, exportedAt: new Date().toISOString(), data: { subjects, tasks: [], tags: [], mates: [], reminders: [] } })
const subject = (log) => ({ id: "s-1", name: "Pharmacology", attended: log.filter((e) => e.s === "P").length, missed: log.filter((e) => e.s === "A").length, requirement: 75, glowColor: "#3a86ff", tags: [], log })
const M1 = { d: "2026-10-01", s: "P" }
const M2P = { d: "2026-10-02", s: "P" }
const M2A = { d: "2026-10-02", s: "A" }

const decode = (stored) => (stored.startsWith("gz1:") ? zlib.gunzipSync(Buffer.from(stored.slice(4), "base64")).toString() : stored)
const cloudGet = async (owner) => {
  const r = await fetch(`${BASE}/api/dev-sync/${owner}`)
  if (r.status === 404) return null
  const d = await r.json()
  return { rev: d.rev, backup: JSON.parse(decode(d.data)), raw: d.data }
}
const cloudPut = (owner, obj, expectedRev, compressed) =>
  fetch(`${BASE}/api/dev-sync/${owner}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: compressed ? "gz1:" + zlib.gzipSync(JSON.stringify(obj)).toString("base64") : JSON.stringify(obj), expectedRev }),
  })

/** A device that was closed with changes the stored copy hasn't seen: signed in, synced up to rev 1, then one more mark */
async function seedDevice(page, owner, base, local) {
  await page.goto(BASE + "/manifest.json") // any page on the same origin, to reach its storage before the app starts
  await page.evaluate(
    (owner, base, local) =>
      new Promise((resolve, reject) => {
        localStorage.setItem("devAccount", JSON.stringify({ id: owner, email: "t@example.com", name: "Tester" }))
        localStorage.setItem("syncOwner", owner)
        localStorage.setItem("syncRev", "1")
        localStorage.setItem("onboardingDone", "1")
        const open = indexedDB.open("college-tracker", 1)
        open.onupgradeneeded = () => open.result.createObjectStore("kv")
        open.onsuccess = () => {
          const tx = open.result.transaction("kv", "readwrite")
          const kv = tx.objectStore("kv")
          kv.put(local.subjects, "subjects")
          kv.put([], "tasks")
          kv.put([], "tags")
          kv.put([], "mates")
          kv.put(base, "syncBase")
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    owner,
    base.data,
    local.data,
  )
}
const readIdb = (page, key) =>
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
const until = async (fn, ms = 20000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (await fn()) return true
    await wait(500)
  }
  return false
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" })

// ---- 1. An interrupted upload keeps the change, and reopening the app sends it ----
// Also covers: the stored copy is an OLD uncompressed document (compatibility), and a change surviving a restart.
{
  const owner = `e2e1${run}`
  const baseBackup = backup([subject([M1])])
  await cloudPut(owner, baseBackup, null, false) // rev 1, stored the old way (plain text)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, owner, baseBackup, backup([subject([M1, M2P])]))

  await page.setRequestInterception(true)
  let blocked = 0
  page.on("request", (req) => {
    if (req.method() === "PUT" && req.url().includes("/api/dev-sync/")) {
      blocked++
      req.abort("failed") // the upload dies mid-flight
    } else req.continue()
  })
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await until(async () => blocked > 0, 15000)
  await wait(1500)
  const stored = await cloudGet(owner)
  check("interrupted upload: the app tried to send and the connection failed", blocked > 0, `${blocked} attempt(s)`)
  check("interrupted upload: the stored copy is untouched (still rev 1)", stored?.rev === 1)
  // (a subject with no timetable is not on Today, so look for it in the Subjects list)
  await page.evaluate(() => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim() === "Subjects")?.click())
  await wait(600)
  check("the app loads normally with an old plain-text stored copy present", /Pharmacology/.test(await page.evaluate(() => document.body.innerText)))
  const idb = await readIdb(page, "subjects")
  check("interrupted upload: the unsynced mark is still in IndexedDB", idb?.[0]?.log?.length === 2)
  await page.close()

  // reopen: same browser profile, same IndexedDB, connection works now
  const again = await ctx.newPage()
  await again.goto(BASE + "/", { waitUntil: "networkidle0" })
  const sent = await until(async () => (await cloudGet(owner))?.rev === 2, 25000)
  const after = await cloudGet(owner)
  check("on reopening, the pending change is sent automatically", sent, `rev ${after?.rev}`)
  check("the sent copy holds the offline mark", after?.backup.data.subjects[0].log.length === 2)
  check("it is now stored compressed", after?.raw.startsWith("gz1:") === true)
  await ctx.close()
}

// ---- 2. Two devices change the same attendance mark ----
{
  const owner = `e2e2${run}`
  const baseBackup = backup([subject([M1])])
  await cloudPut(owner, baseBackup, null, true) // rev 1
  await cloudPut(owner, backup([subject([M1, M2A])]), 1, true) // device A marks 2 Oct ABSENT -> rev 2
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, owner, baseBackup, backup([subject([M1, M2P])])) // device B marked 2 Oct PRESENT offline
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  const merged = await until(async () => (await cloudGet(owner))?.rev >= 3, 25000)
  const final = await cloudGet(owner)
  const entry = final?.backup.data.subjects[0].log.find((e) => e.d === "2026-10-02")
  check("two devices: B's offline mark was merged and sent, not lost", merged && entry?.s === "P", `2 Oct = ${entry?.s}`)
  check("two devices: nothing else was dropped", final?.backup.data.subjects[0].log.length === 2)
  const points = await readIdb(page, "restorePoints")
  check("two devices: both versions were saved as restore points", Array.isArray(points) && points.length >= 2, `${points?.length} points`)
  const cloudCopy = points?.find((p) => /other browser/i.test(p.reason))
  check("two devices: the other device's version (Absent) is recoverable", cloudCopy?.data.subjects[0].log.find((e) => e.d === "2026-10-02")?.s === "A")
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
