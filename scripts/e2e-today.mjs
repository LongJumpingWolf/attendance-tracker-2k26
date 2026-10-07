/**
 * End-to-end checks of the Today list, slot-aware marking and demo isolation, in a real browser against the real app.
 * Same setup as scripts/e2e-sync.mjs (dev server with the Firebase keys blanked so sync uses the dev store, and
 * puppeteer-core installed with --no-save). Real clicks, real IndexedDB, real network requests.
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

const TODAY_DOW = new Date().getDay()
const OTHER_DOW = (TODAY_DOW + 1) % 7
const slot = (day, start, end, kind) => ({ day, start, end, ...(kind ? { kind } : {}) })
const mk = (id, name, slots) => ({ id, name, attended: 0, missed: 0, requirement: 75, glowColor: "#3a86ff", tags: [], ...(slots ? { slots } : {}) })
const A = mk("a", "Pharmacology", [slot(TODAY_DOW, "00:01", "23:58", "Lecture")]) // on today, all day
const B = mk("b", "Anatomy", [slot(OTHER_DOW, "11:00", "12:00")]) // only on another day
const C = mk("c", "Ethics") // no timetable at all
const D = mk("d", "Biochem", [slot(TODAY_DOW, "00:02", "23:57", "Lecture"), slot(TODAY_DOW, "00:03", "23:56", "Practical")]) // two lectures today

const idbPut = (page, entries) =>
  page.evaluate(
    (entries) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("college-tracker", 1)
        open.onupgradeneeded = () => open.result.createObjectStore("kv")
        open.onsuccess = () => {
          const tx = open.result.transaction("kv", "readwrite")
          for (const [k, v] of Object.entries(entries)) tx.objectStore("kv").put(v, k)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        }
      }),
    entries,
  )
const idbGet = (page, key) =>
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
const subjectById = async (page, id) => (await idbGet(page, "subjects"))?.find((s) => s.id === id)
const text = (page) => page.evaluate(() => document.body.innerText)

/** Clicks Present/Absent on the carousel card of the named subject (and class number, for subjects with several) */
async function markCard(page, name, status, nth = 0) {
  const cards = await page.$$("article[data-key]")
  const mine = []
  for (const c of cards) if ((await c.$eval("h3", (h) => h.textContent).catch(() => "")) === name) mine.push(c)
  const card = mine[nth]
  if (!card) return false
  const btns = await card.$$("button")
  for (const b of btns) {
    const label = await b.evaluate((e) => e.textContent?.trim())
    if (label === (status === "P" ? "Present" : "Absent")) {
      await b.click()
      return true
    }
  }
  return false
}
const clickByText = async (page, label, selector = "button") => {
  const els = await page.$$(selector)
  for (const e of els) if ((await e.evaluate((x) => x.textContent?.trim())) === label) return (await e.click(), true)
  return false
}
const decode = (stored) => (stored.startsWith("gz1:") ? zlib.gunzipSync(Buffer.from(stored.slice(4), "base64")).toString() : stored)
/** Clicks the first element whose text contains the label (a subject card also holds its percentage and tags) */
const clickContaining = async (page, label, selector = "button") => {
  const els = await page.$$(selector)
  for (const e of els) if ((await e.evaluate((x) => x.textContent ?? "")).includes(label)) return (await e.click(), true)
  return false
}
const cloudGet = async (owner) => {
  const r = await fetch(`${BASE}/api/dev-sync/${owner}`)
  if (r.status === 404) return null
  const d = await r.json()
  return { ...d, data: decode(d.data) }
}
const cloudPut = (owner, obj, rev) =>
  fetch(`${BASE}/api/dev-sync/${owner}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: JSON.stringify(obj), expectedRev: rev }) })
const backup = (subjects) => ({ app: "college-tracker", version: 1, exportedAt: new Date().toISOString(), data: { subjects, tasks: [], tags: [], mates: [], reminders: [] } })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--window-size=420,900"] })
const newPhone = async (ctx) => {
  const page = await ctx.newPage()
  await page.setViewport({ width: 420, height: 900, isMobile: true, hasTouch: false })
  return page
}

// ---------------- 1. Today list, slot-aware marking, Subject Detail, offline ----------------
{
  const ctx = await browser.createBrowserContext()
  const page = await newPhone(ctx)
  await page.goto(BASE + "/manifest.json")
  await page.evaluate(() => localStorage.setItem("onboardingDone", "1"))
  await idbPut(page, { subjects: [A, B, C, D], tasks: [], tags: [], mates: [] })
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await wait(800)

  let t = await text(page)
  check("Today lists a subject scheduled today", /Pharmacology/.test(t) && /Biochem/.test(t))
  check("Today does NOT list a subject scheduled only on another day", !/Anatomy/.test(t))
  check("Today does NOT list a subject with no timetable", !/Ethics/.test(t))
  check("'N to mark' counts only real classes (1 + 2 = 3, not 4 subjects)", /3 to mark/.test(t))
  const cards = await page.$$eval("article[data-key] h3", (hs) => hs.map((h) => h.textContent))
  check("two lectures of one subject are two separate cards", cards.filter((n) => n === "Biochem").length === 2, cards.join(", "))

  // offline: no connection at all, marking must still work and be saved
  await ctx.setOffline?.(true).catch(() => {})
  const cdp = await page.createCDPSession()
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  check("a real tap on Present works (clickable, offline)", await markCard(page, "Pharmacology", "P"))
  await wait(900)
  let a = await subjectById(page, "a")
  check("offline mark is saved in IndexedDB as one record", a?.attended === 1 && a?.log?.length === 1 && a.log[0].t === "00:01", JSON.stringify(a?.log))
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

  // Subject Detail shows the same state and edits the same record
  await clickByText(page, "Subjects", "nav button, nav a, button")
  await wait(500)
  check("opened the subject from the Subjects list", await clickContaining(page, "Pharmacology"))
  await wait(600)
  const state = await page.$eval('[data-testid="today-state"]', (e) => e.textContent).catch(() => "")
  check("Subject Detail shows today's class as already marked present", /present/i.test(state), state.trim())
  await clickByText(page, "Present")
  await wait(500)
  a = await subjectById(page, "a")
  check("tapping Present again from Subject Detail does not count twice", a?.attended === 1 && a?.log?.length === 1, `attended ${a?.attended}, log ${a?.log?.length}`)
  await clickByText(page, "Absent")
  await wait(700)
  a = await subjectById(page, "a")
  check("switching to Absent from Subject Detail moves the same record", a?.attended === 0 && a?.missed === 1 && a?.log?.length === 1 && a.log[0].s === "A")
  const detail = await page.$$eval('[data-testid="today-class"]', (els) => els.length)
  check("Subject Detail shows one row for a one-lecture subject", detail === 1)

  // back on Today the same state is shown
  await clickByText(page, "Today", "nav button, nav a, button")
  await wait(600)
  t = await text(page)
  check("Today shows Pharmacology under 'Marked today'", /marked today/i.test(t) && /Pharmacology/.test(t), t.split("\n").slice(0, 12).join(" | "))
  check("'N to mark' dropped to 2 after one class was marked", /2 to mark/.test(t))

  // mark the rest -> all done is reachable even with the other 2 subjects unmarked
  await markCard(page, "Biochem", "P", 0)
  await wait(700)
  await markCard(page, "Biochem", "A", 0)
  await wait(900)
  t = await text(page)
  check("every real class marked -> 'all caught up' (reachable with unscheduled subjects present)", /You.re all caught up/.test(t) && !/to mark/.test(t.replace(/Marked today/g, "")), t.split("\n").slice(0, 4).join(" | "))
  const d = await subjectById(page, "d")
  check("the two Biochem lectures were recorded separately", d?.log?.length === 2 && new Set(d.log.map((e) => e.t)).size === 2, JSON.stringify(d?.log))

  // reopen: nothing is duplicated, state is the same
  await page.reload({ waitUntil: "networkidle0" })
  await wait(600)
  const a2 = await subjectById(page, "a")
  const d2 = await subjectById(page, "d")
  check("reopening the app keeps exactly the same marks (no duplicates)", a2?.log?.length === 1 && d2?.log?.length === 2 && a2.missed === 1 && d2.attended + d2.missed === 2)
  const b = await subjectById(page, "b")
  const c = await subjectById(page, "c")
  check("subjects with no class today were never marked", b?.log === undefined && c?.log === undefined && b.attended + b.missed + c.attended + c.missed === 0)
  await ctx.close()
}

// ---------------- 2. Demo mode cannot contaminate real data or reach the cloud ----------------
async function demoScenario({ blockPut }) {
  const owner = `e2e2a${run}${blockPut ? "b" : "a"}`
  const base = backup([A])
  await cloudPut(owner, base, null) // rev 1
  const ctx = await browser.createBrowserContext()
  const page = await newPhone(ctx)
  await page.goto(BASE + "/manifest.json")
  await page.evaluate((owner) => {
    localStorage.setItem("devAccount", JSON.stringify({ id: owner, email: "t@example.com", name: "Tester" }))
    localStorage.setItem("syncOwner", owner)
    localStorage.setItem("syncRev", "1")
    localStorage.setItem("onboardingDone", "1")
  }, owner)
  // real data: Pharmacology present today (blockPut: one more change the cloud hasn't got, so a retry is waiting)
  const real = blockPut ? { ...A, attended: 1, log: [{ d: new Date().toLocaleDateString("sv"), s: "P", t: "00:01", k: "Lecture" }] } : A
  await idbPut(page, { subjects: [real], tasks: [], tags: [], mates: [], syncBase: base.data })

  const t0 = Date.now()
  let inDemo = false // true only while demo data is on screen
  let putsAfterDemo = 0
  let putsInSecondDemo = 0
  await page.setRequestInterception(true)
  page.on("request", (req) => {
    const isPut = req.method() === "PUT" && req.url().includes("/api/dev-sync/")
    if (isPut && process.env.DEBUG) console.log(`   [PUT +${((Date.now() - t0) / 1000).toFixed(1)}s ${inDemo ? 'DEMO ON' : 'demo off'}]`)
    if (isPut && inDemo) putsAfterDemo++
    if (isPut && blockPut) req.abort("failed")
    else req.continue()
  })
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await wait(2500) // sync connects; with blockPut the first upload fails and a retry is now waiting

  // start the demo
  await page.click('button[aria-label="Settings"]')
  await wait(500)
  await clickByText(page, "Start")
  await wait(900)
  inDemo = true
  await page.click('button[aria-label="End tour"]').catch(() => {})
  await wait(500)
  let t = await text(page)
  check(`demo is on screen${blockPut ? " (retry already waiting)" : ""}`, /Viewing demo data/.test(t))
  check("demo shows demo subjects, not the real one", !/Pharmacology/.test(t))

  // change attendance inside the demo
  const btn = await page.$("article[data-key] button")
  let clicked = false
  const pres = await page.$$("article[data-key]")
  if (pres.length) {
    const bs = await pres[0].$$("button")
    for (const b of bs) if ((await b.evaluate((e) => e.textContent?.trim())) === "Present") { await b.click(); clicked = true; break }
  }
  await wait(1200)
  if (blockPut) await wait(18000) // longer than the 15 s retry delay, with the demo still on
  const duringDemo = await idbGet(page, "subjects")
  check("while in the demo, IndexedDB still holds only the real subject", duringDemo?.length === 1 && duringDemo[0].name === "Pharmacology", `${duringDemo?.map((s) => s.name).join(",")}${clicked ? "" : " (note: no demo card to tap)"}`)
  check("while in the demo, nothing was uploaded", putsAfterDemo === 0, `${putsAfterDemo} upload attempt(s)`)

  // close and reopen mid-demo (the demo is gone with the page; a fresh launch is the real app again)
  inDemo = false
  await page.reload({ waitUntil: "networkidle0" })
  await wait(1200)
  t = await text(page)
  check("closing and reopening during the demo brings back the real data, not the demo", /Pharmacology/.test(t) && !/Viewing demo data/.test(t))
  const reopened = await idbGet(page, "subjects")
  check("the saved data is exactly what it was before the demo", JSON.stringify(reopened) === JSON.stringify([real]))

  // start again, then exit properly
  await page.click('button[aria-label="Settings"]')
  await wait(500)
  await clickByText(page, "Start")
  await wait(700)
  inDemo = true
  await page.click('button[aria-label="End tour"]').catch(() => {})
  await wait(1500) // demo on screen again for a moment: still nothing may be sent
  putsInSecondDemo = putsAfterDemo
  inDemo = false
  await clickByText(page, "Exit demo")
  await wait(1200)
  t = await text(page)
  const exited = await idbGet(page, "subjects")
  check("Exit demo restores the real state", /Pharmacology/.test(t) && !/Viewing demo data/.test(t))
  check("after exit the saved data is still exactly the original", JSON.stringify(exited) === JSON.stringify([real]))

  const cloud = await cloudGet(owner)
  const cloudNames = JSON.parse(cloud.data).data.subjects.map((s) => s.name)
  // (rev may move: with no Firebase keys the app's mock social mode adds two dummy mates to real data on load, which syncs legitimately)
  check("the cloud copy never received demo data (real subject only)", cloudNames.join() === "Pharmacology", `rev ${cloud.rev}, ${cloudNames.join(",")}`)
  check("no upload was attempted at any moment the demo was on screen", putsAfterDemo === 0 && putsInSecondDemo === 0, `${putsAfterDemo}`)
  await ctx.close()
}
await demoScenario({ blockPut: false })
await demoScenario({ blockPut: true })

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
