/**
 * End-to-end checks of signing in on a device that already has data, in a real browser against the real app, real IndexedDB
 * and the dev sync store (see lib/signin-reconcile.ts for the rules, tests/signin-reconcile.test.ts for the unit layer).
 *
 * Needs a dev server with the Firebase keys blanked, so sync uses the built-in dev store (same as e2e-sync.mjs):
 *   NEXT_PUBLIC_FIREBASE_API_KEY= NEXT_PUBLIC_FIREBASE_PROJECT_ID= NEXT_PUBLIC_FIREBASE_APP_ID= \
 *   NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID= NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN= npx next dev -p 3458
 *   BASE=http://localhost:3458 CHROME="C:/Program Files/Google/Chrome/Application/chrome.exe" node scripts/e2e-reconcile.mjs
 * (npm run migration:health starts that server itself.) Each scenario uses its own browser context and its own account.
 */
import puppeteer from "puppeteer-core"

const BASE = process.env.BASE ?? "http://localhost:3458"
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const run = Date.now().toString(36)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`)
}

// ---- data ------------------------------------------------------------------------------------------------------------
const subject = (id, name, marks = []) => {
  const log = marks.map(([d, s]) => ({ d, s }))
  return { id, name, attended: log.filter((e) => e.s === "P").length, missed: log.filter((e) => e.s === "A").length, requirement: 75, glowColor: "#000", tags: [], log }
}
const task = (id, title) => ({ id, title, dueDate: "2026-11-01" })
const DEVICE = () => ({ subjects: [subject("d1", "DBMS", [["2026-10-01", "P"], ["2026-10-02", "P"]]), subject("d2", "Anatomy", [["2026-10-01", "A"]])], tasks: [task("t1", "Viva")], tags: [], mates: [] })
const ACCOUNT = () => ({ subjects: [subject("a1", "DBMS", [["2026-10-01", "P"], ["2026-10-03", "P"]]), subject("a2", "Pharmacology", [["2026-10-02", "P"]])], tasks: [task("t9", "Lab record")], tags: ["core"], mates: [] })
const EMPTY = () => ({ subjects: [], tasks: [], tags: [], mates: [] })
const names = (list) => (list ?? []).map((s) => s.name).sort()

const backupText = (d) => JSON.stringify({ app: "college-tracker", version: 1, exportedAt: new Date().toISOString(), data: { ...d, reminders: [] } })
const cloudGet = async (owner) => {
  const r = await fetch(`${BASE}/api/dev-sync/${owner}`)
  if (r.status === 404) return null
  const d = await r.json()
  const text = d.data.startsWith("gz1:") ? (await import("node:zlib")).gunzipSync(Buffer.from(d.data.slice(4), "base64")).toString() : d.data
  return { rev: d.rev, data: JSON.parse(text).data }
}
const cloudPut = (owner, d, expectedRev) =>
  fetch(`${BASE}/api/dev-sync/${owner}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: backupText(d), expectedRev }) })

/** A device before it is signed in: its own data, a stand-in account for the sign-in, and optionally a record of whose data it holds */
async function seedDevice(page, { owner, local, signedIn = true, dataOwner = null }) {
  await page.goto(BASE + "/manifest.json") // any page on the same origin, to reach its storage before the app starts
  await page.evaluate(
    (owner, local, signedIn, dataOwner) =>
      new Promise((resolve, reject) => {
        localStorage.clear()
        if (signedIn) localStorage.setItem("devAccount", JSON.stringify({ id: owner, email: "t@example.com", name: "Tester" }))
        if (dataOwner) localStorage.setItem("syncDataOwner", dataOwner)
        localStorage.setItem("onboardingDone", "1")
        const open = indexedDB.open("college-tracker", 1)
        open.onupgradeneeded = () => open.result.createObjectStore("kv")
        open.onsuccess = () => {
          const tx = open.result.transaction("kv", "readwrite")
          const kv = tx.objectStore("kv")
          kv.put(local.subjects, "subjects")
          kv.put(local.tasks, "tasks")
          kv.put(local.tags, "tags")
          kv.put(local.mates, "mates")
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    owner,
    local,
    signedIn,
    dataOwner,
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
    await wait(300)
  }
  return false
}
const sheet = (page) => page.$('[data-testid="reconcile-sheet"]')
const sheetShown = async (page, ms = 20000) => until(async () => Boolean(await sheet(page)), ms)
const rowNumbers = (page, key) =>
  page.$eval(`[data-row="${key}"]`, (el) => Array.from(el.querySelectorAll("span")).slice(1).map((s) => Number(s.textContent))).catch(() => null)
const isDisabled = (page, testid) => page.$eval(`[data-testid="${testid}"]`, (b) => b.disabled).catch(() => null)
const owners = []
const newOwner = (tag) => {
  const o = `rc${tag}${run}`
  owners.push(o)
  return o
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new" })
const open = async (page) => page.goto(BASE + "/", { waitUntil: "networkidle0" })

// ---- 1. both sides hold different data: the person is asked, and nothing is changed until they choose -------------------
{
  const owner = newOwner("a")
  await cloudPut(owner, ACCOUNT(), null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE() })
  await open(page)
  check("both sides differ: the comparison sheet appears", await sheetShown(page))
  check("it shows what each side has (subjects: this device 2, account 2, on both 1)", JSON.stringify(await rowNumbers(page, "subjects")) === "[2,2,1]", JSON.stringify(await rowNumbers(page, "subjects")))
  check("it shows deadlines (1, 1, 0)", JSON.stringify(await rowNumbers(page, "tasks")) === "[1,1,0]")
  check("merging is preselected and marked recommended", await page.$eval('[data-testid="reconcile-option-merge"] input', (i) => i.checked))
  check("the merge button does not need a confirmation", (await page.$('[data-testid="reconcile-confirm"]')) === null)
  await wait(2500)
  const untouched = await cloudGet(owner)
  check("while the sheet is open nothing is sent to the account", untouched?.rev === 1 && names(untouched.data.subjects).join() === "DBMS,Pharmacology")
  check("while the sheet is open this device's data is unchanged", names(await readIdb(page, "subjects")).join() === "Anatomy,DBMS")
  await page.click('[data-testid="reconcile-apply"]')
  const merged = await until(async () => (await cloudGet(owner))?.rev >= 2, 25000)
  const finalCloud = await cloudGet(owner)
  check("combining sends the merged copy to the account", merged && names(finalCloud.data.subjects).join() === "Anatomy,DBMS,Pharmacology", names(finalCloud?.data.subjects).join())
  check("this device holds all three subjects too", await until(async () => names(await readIdb(page, "subjects")).length === 3, 8000))
  const dbms = (await readIdb(page, "subjects")).find((s) => s.name === "DBMS")
  check("the shared subject kept every mark once (1, 2 and 3 Oct)", dbms?.log.length === 3, `${dbms?.log.length} marks`)
  check("the sheet closes when it is done", await until(async () => !(await sheet(page)), 8000))
  check("this account is now connected in this browser", (await page.evaluate(() => localStorage.getItem("syncOwner"))) === owner)
  // reopening changes nothing and asks nothing
  await page.reload({ waitUntil: "networkidle0" })
  await wait(3000)
  const after = await cloudGet(owner)
  check("reopening the app does not ask again and does not write again", !(await sheet(page)) && after.rev === finalCloud.rev)
  check("no subject or mark was duplicated by reopening", (await readIdb(page, "subjects")).length === 3)
  await ctx.close()
}

// ---- 2. 'use my account's data': needs a confirmation, keeps this device's data first --------------------------------------
{
  const owner = newOwner("b")
  await cloudPut(owner, ACCOUNT(), null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE() })
  await open(page)
  await sheetShown(page)
  await page.click('[data-testid="reconcile-option-cloud"] input')
  check("replacing this device's data asks for a confirmation (a checkbox appears)", Boolean(await page.$('[data-testid="reconcile-confirm"]')))
  check("the action is disabled until it is confirmed", (await isDisabled(page, "reconcile-apply")) === true)
  await page.click('[data-testid="reconcile-confirm"]')
  check("and enabled once it is", (await isDisabled(page, "reconcile-apply")) === false)
  await page.click('[data-testid="reconcile-apply"]')
  check("this device now holds exactly the account's data", await until(async () => names(await readIdb(page, "subjects")).join() === "DBMS,Pharmacology", 15000))
  const points = await readIdb(page, "restorePoints")
  const kept = points?.find((p) => names(p.data.subjects).join() === "Anatomy,DBMS")
  check("this device's previous data was saved as a restore point first", Boolean(kept), `${points?.length} point(s)`)
  check("the account's copy was not changed by choosing its data", (await cloudGet(owner)).rev === 1)
  check("the sheet closes", await until(async () => !(await sheet(page)), 8000))
  await ctx.close()
}

// ---- 3. 'use this device's data': needs a confirmation, keeps the account's copy first -------------------------------------
{
  const owner = newOwner("c")
  await cloudPut(owner, ACCOUNT(), null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE() })
  await open(page)
  await sheetShown(page)
  await page.click('[data-testid="reconcile-option-device"] input')
  check("replacing the account's copy also asks for a confirmation", (await isDisabled(page, "reconcile-apply")) === true)
  await page.click('[data-testid="reconcile-confirm"]')
  await page.click('[data-testid="reconcile-apply"]')
  const replaced = await until(async () => (await cloudGet(owner))?.rev === 2, 20000)
  const c = await cloudGet(owner)
  check("the account's copy is now this device's data", replaced && names(c.data.subjects).join() === "Anatomy,DBMS")
  const points = await readIdb(page, "restorePoints")
  check("the account's earlier copy is kept on this device under restore points", Boolean(points?.find((p) => names(p.data.subjects).join() === "DBMS,Pharmacology")))
  check("this device's data is unchanged", names(await readIdb(page, "subjects")).join() === "Anatomy,DBMS")
  await ctx.close()
}

// ---- 4. nothing to ask: empty device / no account copy / identical --------------------------------------------------------
{
  const owner = newOwner("d")
  await cloudPut(owner, ACCOUNT(), null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: EMPTY() })
  await open(page)
  check("empty device, account has data: no question, the account's data appears", await until(async () => names(await readIdb(page, "subjects")).join() === "DBMS,Pharmacology", 15000) && !(await sheet(page)))
  await ctx.close()
}
{
  const owner = newOwner("e")
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE() })
  await open(page)
  const up = await until(async () => (await cloudGet(owner))?.rev === 1, 20000)
  check("device has data, account has none: it is saved to the account without a question", up && !(await sheet(page)) && names((await cloudGet(owner)).data.subjects).join() === "Anatomy,DBMS")
  await ctx.close()
}
{
  const owner = newOwner("f")
  await cloudPut(owner, DEVICE(), null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE() })
  await open(page)
  const connected = await until(async () => (await page.evaluate(() => localStorage.getItem("syncOwner"))) === owner, 15000)
  await wait(3000)
  // (this dev environment seeds two derived mate rows on every device; the normal sync may send those, which is why the revision is not asserted)
  const after = await cloudGet(owner)
  check("identical on both sides: no question, the account is connected, and nothing is duplicated or lost", connected && !(await sheet(page)) && names(after.data.subjects).join() === "Anatomy,DBMS" && after.data.tasks.length === 1, `rev ${after.rev}`)
  await ctx.close()
}

// ---- 5. 'decide later' keeps everything as it is and can be reopened -----------------------------------------------------
{
  const owner = newOwner("g")
  await cloudPut(owner, ACCOUNT(), null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE() })
  await open(page)
  await sheetShown(page)
  await page.click('[data-testid="reconcile-later"]')
  check("'Decide later' closes the sheet", await until(async () => !(await sheet(page)), 5000))
  await wait(2500)
  check("and changes nothing on either side", names(await readIdb(page, "subjects")).join() === "Anatomy,DBMS" && (await cloudGet(owner)).rev === 1)
  check("the account is not connected yet (nothing will sync until a choice is made)", (await page.evaluate(() => localStorage.getItem("syncOwner"))) === null)
  await page.click('button[aria-label="Settings"]')
  await page.evaluate(() => Array.from(document.querySelectorAll("button")).find((b) => /Sync between browsers/.test(b.textContent ?? ""))?.click())
  const waiting = await until(async () => Boolean(await page.$('[data-testid="reconcile-waiting"]')), 8000)
  check("Settings > Sync says a choice is waiting", waiting)
  await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid="reconcile-waiting"] button')).find((b) => /Choose/.test(b.textContent ?? ""))?.click())
  check("and 'Choose' brings the comparison back", await sheetShown(page, 8000))
  await ctx.close()
}

// ---- 6. data from another account is never combined into this one unasked --------------------------------------------------
{
  const owner = newOwner("h")
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE(), dataOwner: "someone_else_" + run })
  await open(page)
  check("this device holds another account's data and this account is empty: the person is asked, nothing is uploaded", (await sheetShown(page)) && (await cloudGet(owner)) === null)
  const text = await page.$eval('[data-testid="reconcile-sheet"]', (el) => el.textContent ?? "")
  check("it says the data belongs to a different account", /different account/.test(text))
  check("combining and 'use my account's data' are not offered when the account has nothing", (await isDisabled(page, "reconcile-apply")) !== null && (await page.$eval('[data-testid="reconcile-option-merge"] input', (i) => i.disabled)) && (await page.$eval('[data-testid="reconcile-option-cloud"] input', (i) => i.disabled)))
  await wait(2500)
  check("still nothing was sent to the new account", (await cloudGet(owner)) === null)
  await ctx.close()
}

// ---- 7. differing values are named ------------------------------------------------------------------------------------------
{
  const owner = newOwner("i")
  await cloudPut(owner, { ...EMPTY(), subjects: [subject("a1", "DBMS", [["2026-10-02", "A"]])] }, null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: { ...EMPTY(), subjects: [subject("d1", "DBMS", [["2026-10-02", "P"]])] } })
  await open(page)
  await sheetShown(page)
  const conflicts = await page.$eval('[data-testid="reconcile-conflicts"]', (el) => el.textContent ?? "").catch(() => "")
  check("the same class marked differently is listed by subject name", /DBMS/.test(conflicts))
  check("and the sheet says what combining does with it", /Restore points/.test(conflicts))
  await page.click('[data-testid="reconcile-apply"]')
  await until(async () => (await cloudGet(owner))?.rev >= 2, 20000)
  const points = await readIdb(page, "restorePoints")
  check("combining keeps this device's mark and saves the account's other version", (await readIdb(page, "subjects"))[0].log[0].s === "P" && Boolean(points?.find((p) => p.data.subjects[0]?.log?.[0]?.s === "A")))
  await ctx.close()
}

// ---- 8. the account cannot be reached: nothing is lost, nothing is called empty, and it connects when it can -----------------
{
  const owner = newOwner("j")
  await cloudPut(owner, ACCOUNT(), null)
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await seedDevice(page, { owner, local: DEVICE() })
  await page.setRequestInterception(true)
  let down = true
  let puts = 0
  page.on("request", (req) => {
    if (req.url().includes("/api/dev-sync/")) {
      if (req.method() === "PUT") puts++
      if (down) return void req.abort("failed")
    }
    req.continue()
  })
  await open(page)
  await wait(4000)
  check("account unreachable: no question, no upload, this device's data intact", !(await sheet(page)) && puts === 0 && names(await readIdb(page, "subjects")).join() === "Anatomy,DBMS")
  check("it is not connected, and not treated as an empty account", (await page.evaluate(() => localStorage.getItem("syncOwner"))) === null && (await cloudGet(owner)).rev === 1)
  down = false
  await page.evaluate(() => window.dispatchEvent(new Event("online")))
  check("when the connection returns it picks up by itself and now asks (both sides have data)", await sheetShown(page, 20000))
  await ctx.close()
}

// ---- 9. anonymous use is untouched ------------------------------------------------------------------------------------------
{
  const owner = newOwner("k")
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  const calls = []
  page.on("request", (r) => r.url().includes("/api/dev-sync/") && calls.push(r.url()))
  await seedDevice(page, { owner, local: DEVICE(), signedIn: false })
  await open(page)
  await wait(3000)
  check("not signed in: the app works on its own data, shows no sheet and contacts no account", !(await sheet(page)) && calls.length === 0 && names(await readIdb(page, "subjects")).join() === "Anatomy,DBMS")
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
