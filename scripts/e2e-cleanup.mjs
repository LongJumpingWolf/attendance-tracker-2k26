/**
 * End-to-end checks after the Tier 2C cleanup: full JSON backup, JSON restore, restore points, local reminders while the
 * app is open, honest settings copy, and that no removed endpoint is ever called. Same setup as scripts/e2e-today.mjs.
 */
import puppeteer from "puppeteer-core"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const BASE = process.env.BASE ?? "http://localhost:3458"
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`)
}

const every = (...times) => [0, 1, 2, 3, 4, 5, 6].flatMap((day) => times.map(([start, end, kind]) => ({ day, start, end, kind })))
const PH = { id: "p", name: "Pharmacology", attended: 9, missed: 1, requirement: 75, glowColor: "#3a86ff", tags: [], slots: every(["00:01", "23:58", "Lecture"]) }
const BI = { id: "b", name: "Biochem", attended: 6, missed: 2, requirement: 75, glowColor: "#3a86ff", tags: [], slots: every(["00:02", "23:57", "Lecture"]) }

const idbPut = (page, entries) =>
  page.evaluate((entries) => new Promise((resolve, reject) => {
    const open = indexedDB.open("college-tracker", 1)
    open.onupgradeneeded = () => open.result.createObjectStore("kv")
    open.onsuccess = () => {
      const tx = open.result.transaction("kv", "readwrite")
      for (const [k, v] of Object.entries(entries)) tx.objectStore("kv").put(v, k)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
  }), entries)
const idbGet = (page, key) =>
  page.evaluate((key) => new Promise((resolve) => {
    const open = indexedDB.open("college-tracker", 1)
    open.onsuccess = () => {
      const r = open.result.transaction("kv").objectStore("kv").get(key)
      r.onsuccess = () => resolve(r.result ?? null)
    }
  }), key)
const subj = async (page, id) => (await idbGet(page, "subjects"))?.find((s) => s.id === id)
const text = (page) => page.evaluate(() => document.body.innerText)
const clickText = async (page, label, { exact = true, selector = "button" } = {}) => {
  const els = await page.$$(selector)
  for (const e of els) {
    const t = (await e.evaluate((x) => x.textContent ?? "")).trim()
    if (exact ? t === label : t.includes(label)) {
      await e.evaluate((x) => x.scrollIntoView({ block: "center" }))
      await wait(120)
      await e.click()
      return true
    }
  }
  return false
}
const openSettingsRow = async (page, title) => {
  await page.click('button[aria-label="Settings"]')
  await wait(500)
  return clickText(page, title, { exact: false })
}
const markPresent = async (page, name) => {
  for (const c of await page.$$("article[data-key]")) {
    if ((await c.$eval("h3", (h) => h.textContent).catch(() => "")) !== name) continue
    for (const b of await c.$$("button")) if ((await b.evaluate((e) => e.textContent?.trim())) === "Present") return (await b.click(), true)
  }
  return false
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--window-size=420,900"] })
const ctx = await browser.createBrowserContext()
await ctx.overridePermissions(BASE, ["notifications"]).catch(() => {})
const page = await ctx.newPage()
await page.setViewport({ width: 420, height: 900, isMobile: true })

// every request the app makes, so we can prove no removed endpoint is called
const requested = []
page.on("request", (r) => requested.push(`${r.method()} ${new URL(r.url()).pathname}`))
// capture the file the app offers for download (it is made from a Blob)
await page.evaluateOnNewDocument(() => {
  window.__blobs = []
  const orig = URL.createObjectURL.bind(URL)
  URL.createObjectURL = (b) => (window.__blobs.push(b), orig(b))
})

await page.goto(BASE + "/manifest.json")
await page.evaluate(() => localStorage.setItem("onboardingDone", "1"))
await idbPut(page, { subjects: [PH, BI], tasks: [], tags: [], mates: [] })
await page.goto(BASE + "/", { waitUntil: "networkidle0" })
await wait(900)

// ---- 1. full JSON backup ----
check("Backup & restore opens", await openSettingsRow(page, "Backup & restore"))
await wait(500)
let t = await text(page)
check("no spreadsheet / ZIP export is offered any more", !/spreadsheet|\bZIP\b/i.test(t))
check("the file picker accepts only .json", (await page.$eval('input[type="file"]', (i) => i.accept)) === ".json")
check("'Save a full backup' is still there", await clickText(page, "Save a full backup", { exact: false }))
await wait(600)
const saved = await page.evaluate(async () => (await window.__blobs.at(-1)?.text()) ?? "")
let backup = null
try { backup = JSON.parse(saved) } catch {}
check("the full JSON backup downloads and holds everything", backup?.app === "college-tracker" && backup.data.subjects.length === 2 && backup.data.subjects[0].attended === 9, saved.slice(0, 60).replace(/\s+/g, " "))
const file = path.join(os.tmpdir(), `e2e-backup-${Date.now()}.json`)
fs.writeFileSync(file, saved)

// ---- 2. JSON restore (change something first, then restore the file) ----
await page.keyboard.press("Escape")
await page.evaluate(() => document.querySelector('[role="dialog"] button[aria-label*="lose"]')?.click())
await page.goto(BASE + "/", { waitUntil: "networkidle0" })
await wait(600)
check("marked Pharmacology present so data differs from the backup", await markPresent(page, "Pharmacology"))
await wait(800)
check("data changed (10 attended)", (await subj(page, "p")).attended === 10)

await openSettingsRow(page, "Backup & restore")
await wait(500)
const [chooser] = await Promise.all([page.waitForFileChooser({ timeout: 8000 }), clickText(page, "Restore from a backup", { exact: false })])
await chooser.accept([file])
await wait(900)
t = await text(page)
check("restoring shows what is inside before anything changes", /Replace your data\?/.test(t) && /2 subjects/.test(t))
check("confirming restores the backup exactly (back to 9 attended)", await clickText(page, "Restore"))
await wait(1000)
let p = await subj(page, "p")
check("JSON restore put the saved data back", p.attended === 9 && !(p.log ?? []).length, `${p.attended}/${p.missed}`)

// ---- 3. restore points ----
const points = (await idbGet(page, "restorePoints")) ?? []
const before = points.find((x) => x.reason === "Before restoring a backup")
check("restoring made a restore point of what was there before", before?.data.subjects.find((s) => s.id === "p").attended === 10, `${points.length} point(s)`)
await page.goto(BASE + "/", { waitUntil: "networkidle0" }) // close Settings, come back to it later
await wait(600)
await openSettingsRow(page, "Backup & restore")
await wait(900)
t = await text(page)
check("restore points are listed in Backup & restore", /restore points/i.test(t) && /Before restoring a backup/.test(t))
check("tapping Restore on a point asks first", await clickText(page, "Restore"))
await wait(400)
check("then restores it", (await text(page)).includes("replaces what is on this device now") && (await clickText(page, "Restore")))
await wait(1000)
p = await subj(page, "p")
check("a restore point brings back the earlier state (10 attended)", p.attended === 10, `${p.attended}/${p.missed}`)

// ---- 4. Notifications panel is honest, and the schedule importer is gone ----
await page.goto(BASE + "/", { waitUntil: "networkidle0" })
await wait(500)
await openSettingsRow(page, "Notifications")
await wait(500)
t = await text(page)
check("notification copy does not promise delivery when the app is closed", !/even when the app is closed/i.test(t) && /app is open/i.test(t), t.split("\n").filter((l) => /open|closed/i.test(l)).slice(0, 2).join(" | "))
check("the Firestore schedule importer ('Import a reminder schedule') is gone", !/Import a reminder schedule|paste a schedule/i.test(t))

// ---- 5. local reminders still fire while the app is open ----
const rem = await ctx.newPage()
await rem.setViewport({ width: 420, height: 900 })
await rem.goto(BASE + "/manifest.json")
await rem.evaluate(() => localStorage.setItem("onboardingDone", "1"))
const now = new Date()
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
const start = new Date(now.getTime() + 5 * 60000)
const end = new Date(now.getTime() + 65 * 60000)
await rem.evaluate((e) => localStorage.setItem("notificationSchedule", JSON.stringify([e])), { id: "r1", day: now.getDay(), startTime: hhmm(start), endTime: hhmm(end), subjectName: "Pharmacology", notifyOffset: 5, notifyWhen: "before" })
await idbPut(rem, { subjects: [PH], tasks: [], tags: [], mates: [] })
const reqs = []
rem.on("request", (r) => reqs.push(new URL(r.url()).pathname))
await rem.goto(BASE + "/", { waitUntil: "networkidle0" })
await wait(2500)
const shown = await rem.evaluate(async () => {
  const reg = await navigator.serviceWorker.ready
  return (await reg.getNotifications()).map((n) => `${n.title}: ${n.body}`)
})
check("a due local reminder is shown while the app is open", shown.some((s) => /Class Reminder/.test(s) && /Pharmacology/.test(s)), shown.join(" || ").replace(/\n/g, " / "))
const fired = await rem.evaluate(() => localStorage.getItem("remindersFired"))
check("and it is only fired once for the day", (fired ?? "").includes("r1"))
await rem.close()

// ---- 6. no removed endpoint is called, and they no longer exist ----
const dead = [...requested, ...reqs.map((p) => `? ${p}`)].filter((r) => /api\/notifications|export-xlsx/.test(r))
check("the app never called a removed endpoint during any of this", dead.length === 0, dead.join(", "))
for (const route of ["/api/notifications/subscribe", "/api/notifications/schedule", "/api/notifications/send", "/api/export-xlsx"]) {
  const status = (await fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })).status
  check(`${route} is gone (404)`, status === 404, String(status))
}
check("the unused worker file is gone", (await fetch(BASE + "/firebase-messaging-sw.js")).status === 404)
check("the concept pages are gone", (await fetch(BASE + "/concepts/index.html")).status === 404)
const sw = await (await fetch(BASE + "/sw.js")).text()
check("the service worker has no built-in Firebase project", !/college-tracker-2024|AIza/.test(sw))

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
