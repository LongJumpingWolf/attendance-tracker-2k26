/**
 * End-to-end checks of the simplified navigation (Tier 2D) in a real browser: one Subjects list, Today without the
 * duplicate secondary views, history on Subject Detail, past-day correction still in the Calendar, old links and saved
 * settings still working, and no data touched by moving around. Same setup as scripts/e2e-today.mjs.
 */
import puppeteer from "puppeteer-core"

const BASE = process.env.BASE ?? "http://localhost:3458"
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  (" + detail + ")" : ""}`)
}

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const YESTERDAY_D = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1)
const YESTERDAY = ymd(YESTERDAY_D)
const TODAY_DOW = new Date().getDay()
const OTHER_DOW = (TODAY_DOW + 3) % 7
const every = (...times) => [0, 1, 2, 3, 4, 5, 6].flatMap((day) => times.map(([start, end, kind]) => ({ day, start, end, kind })))
const mk = (id, name, attended, missed, extra = {}) => ({ id, name, attended, missed, requirement: 75, glowColor: "#3a86ff", tags: [], ...extra })
const SUBJECTS = [
  mk("p", "Pharmacology", 9, 1, { tags: ["Theory"], slots: every(["00:01", "23:58", "Lecture"]) }), //   90%  safe
  mk("b", "Biochem", 6, 2, { tags: ["Theory"], slots: every(["00:02", "23:57", "Lecture"], ["00:03", "23:56", "Practical"]), log: [{ d: YESTERDAY, s: "A" }] }), // 75%  at the edge, one older untimed mark
  mk("r", "Pathology", 1, 3, { tags: ["Practical"], slots: [{ day: OTHER_DOW, start: "10:00", end: "11:00" }], log: [{ d: YESTERDAY, s: "A", t: "10:00", k: "Lecture" }] }), // 25%  below, not on today
  mk("e", "Ethics", 4, 0), //  100%, no timetable
  mk("n", "Newsubject", 0, 0), //   nothing marked yet, no timetable
]

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
const text = (page) => page.evaluate(() => document.body.innerText)
const nav = (page, label) => page.evaluate((label) => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().endsWith(label))?.click(), label)
const rows = (page) => page.$$eval('[data-testid="subject-row"]', (els) => els.map((e) => e.innerText.replace(/\s+/g, " ").trim()))
const clickText = async (page, label, { exact = true, selector = "button" } = {}) => {
  for (const e of await page.$$(selector)) {
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
const subjectsFromDb = async (page) => JSON.stringify(await idbGet(page, "subjects"))
/** Same, but an empty mark list counts as no list: marking then clearing a class leaves "log": [] behind */
const subjectsNormalised = async (page) => JSON.stringify((await idbGet(page, "subjects")).map((s) => ({ ...s, log: s.log?.length ? s.log : undefined })))

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--window-size=420,900"] })
const ctx = await browser.createBrowserContext()
const page = await ctx.newPage()
await page.setViewport({ width: 420, height: 900, isMobile: true })

await page.goto(BASE + "/manifest.json")
await page.evaluate(() => {
  localStorage.setItem("onboardingDone", "1")
  localStorage.setItem("subjectsView", "timetable") // a view chosen under the old three-view screen
})
await idbPut(page, { subjects: SUBJECTS, tasks: [], tags: [], mates: [] })
const seeded = await subjectsFromDb(page)
await page.goto(BASE + "/", { waitUntil: "networkidle0" })
await wait(900)

// ============ Today ============
let t = await text(page)
const cards = await page.$$eval("article[data-key] h3", (hs) => hs.map((h) => h.textContent))
check("Today lists today's real classes (Pharmacology, and Biochem's two lectures)", cards.filter((c) => c === "Pharmacology").length === 1 && cards.filter((c) => c === "Biochem").length === 2, cards.join(", "))
check("Today does not list subjects that have no class today", !cards.includes("Pathology") && !cards.includes("Ethics") && !cards.includes("Newsubject"))
check("the duplicate day strip is gone from Today", (await page.$('section[aria-label="Today\'s timetable"]')) === null)
check("'Recently missed' is gone from Today", !/recently missed/i.test(t))

// ============ Subjects: one list ============
await nav(page, "Subjects")
await wait(700)
t = await text(page)
check("no view switcher (cards / by tag / by timetable) any more", (await page.$('[role="tablist"]')) === null && !/By timetable|By tag/i.test(t))
check("an old saved 'timetable' view setting doesn't break the screen", (await rows(page)).length === 5)
let r = await rows(page)
check("every subject is in the list", ["Pharmacology", "Biochem", "Pathology", "Ethics", "Newsubject"].every((n) => r.some((x) => x.includes(n))), r.length + " rows")
check("least safe first, no-marks last", ["Pathology", "Biochem", "Pharmacology", "Ethics", "Newsubject"].every((n, i) => r[i].startsWith(n)), r.map((x) => x.split(" ")[0]).join(" > "))
check("each row shows percentage, target and status", /Pathology.*25% · 75% needed · Attend next \d+/.test(r[0]) && /Pharmacology.*90% · 75% needed · 2 skips available/.test(r[2]) && /Newsubject.*75% needed · Not started/.test(r[4]), r[0])
check("each row shows its class days", /Pharmacology.*Every day/.test(r[2]) && /Biochem.*Every day/.test(r[1]) && /Pathology.*Sat|Pathology.*(Sun|Mon|Tue|Wed|Thu|Fri)/.test(r[0]) && /Ethics.*No class days yet/.test(r[3]), r[2])
check("no class cards or mark buttons on Subjects (today's classes stay on Today)", (await page.$("article[data-key]")) === null && !(await clickText(page, "Present")) )

// filters
check("'Needs attention' shows how many need a look (Pathology and Biochem)", /Needs attention\s*2/.test(await text(page)))
await clickText(page, "Needs attention", { exact: false })
await wait(300)
r = await rows(page)
check("that filter narrows to those two", r.length === 2 && r[0].startsWith("Pathology") && r[1].startsWith("Biochem"), r.map((x) => x.split(" ")[0]).join(", "))
await clickText(page, "Needs attention", { exact: false })
await wait(300)
check("and turning it off brings every subject back", (await rows(page)).length === 5)
await clickText(page, "Theory")
await wait(300)
r = await rows(page)
t = await text(page)
check("a tag chip narrows the list and keeps the tag average", r.length === 2 && /Theory · 2 subjects · avg 83%/.test(t), t.match(/Theory · \d subjects[^\n]*/)?.[0])
await clickText(page, "Theory")
await wait(200)
await page.type('input[type="search"]', "path")
await wait(300)
check("search finds a subject quickly", (await rows(page)).length === 1 && (await rows(page))[0].startsWith("Pathology"))
await page.evaluate(() => { const i = document.querySelector('input[type="search"]'); i.focus(); i.select() })
await page.keyboard.press("Backspace")
await wait(300)

// subject detail from the list, with history
await clickText(page, "Pathology", { exact: false, selector: '[data-testid="subject-row"]' })
await wait(700)
t = await text(page)
check("a row opens Subject Detail", /Pathology/.test(t) && /Required/.test(t))
check("Subject Detail now shows recent marks (where 'Recently missed' went)", (await page.$('[data-testid="history"]')) !== null && /Absent/.test(await page.$eval('[data-testid="history"]', (e) => e.innerText)))
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes("Subjects"))?.click()) // back
await wait(600)
await clickText(page, "Biochem", { exact: false, selector: '[data-testid="subject-row"]' })
await wait(600)
check("a subject with an older untimed mark shows it in history as having no class time", /No class time/.test(await page.$eval('[data-testid="history"]', (e) => e.innerText)))
await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().includes("Subjects"))?.click())
await wait(500)

check("browsing Subjects (filters, search, details) changed no attendance data", (await subjectsFromDb(page)) === seeded)

// ============ Calendar: past-day correction still reachable ============
await nav(page, "Calendar")
await wait(600)
const dayLabel = YESTERDAY_D.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" })
const monthDiffers = YESTERDAY_D.getMonth() !== new Date().getMonth()
if (monthDiffers) await page.click('button[aria-label="Previous month"]')
await wait(200)
await page.evaluate((day) => [...document.querySelectorAll("section button[aria-pressed]")].find((b) => b.textContent.trim().startsWith(String(day)))?.click(), YESTERDAY_D.getDate())
await wait(500)
const calButtons = await page.$$('[data-testid="cal-present"]')
check("the Calendar still lists yesterday's classes with Present/Absent to correct them", calButtons.length >= 2, `${calButtons.length} class rows for ${dayLabel}`)
await calButtons[0].evaluate((e) => e.scrollIntoView({ block: "center" }))
await wait(150)
await calButtons[0].click()
await wait(700)
const afterCal = (await idbGet(page, "subjects")).find((s) => s.id === "p")
check("a past-day mark made there is saved", afterCal.log?.some((e) => e.d === YESTERDAY && e.s === "P" && e.t === "00:01"))
// put it back so the "no data lost" check below compares like with like
await calButtons[0].click()
await wait(700)

// ============ nothing was lost by moving around ============
await nav(page, "Mates")
await wait(400)
await nav(page, "Today")
await wait(500)
const seededNormalised = JSON.stringify(SUBJECTS.map((s) => ({ ...s, log: s.log?.length ? s.log : undefined })))
check("after a past-day edit and back, and every tab visited, the data is exactly as it started", (await subjectsNormalised(page)) === seededNormalised)

// ============ Today still marks, shows the result, and undoes exactly ============
const card = (await page.$$("article[data-key]"))[0]
for (const b of await card.$$("button")) if ((await b.evaluate((e) => e.textContent?.trim())) === "Present") { await b.click(); break }
await wait(300)
const toast = await page.evaluate(() => document.querySelector('[role="status"]')?.textContent ?? "")
check("marking still shows the new percentage", /Present · Pharmacology · now 91%/.test(toast), toast)
await wait(700)
t = await text(page)
check("the marked class shows its result in 'Marked today'", /marked today/i.test(t) && /91%/.test(t))
await page.evaluate(() => [...document.querySelectorAll('[role="status"] button')].find((b) => b.textContent.trim() === "Undo")?.click())
await wait(800)
check("exact undo still works (back to exactly the starting data)", (await subjectsNormalised(page)) === seededNormalised)

// ============ offline: the whole simplified navigation works with no connection ============
const cdp = await page.createCDPSession()
await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
await nav(page, "Subjects")
await wait(500)
check("offline: the Subjects list and its filters work", (await rows(page)).length === 5)
await clickText(page, "Pharmacology", { exact: false, selector: '[data-testid="subject-row"]' })
await wait(500)
const todayRow = await page.$('[data-testid="today-class"]')
check("offline: Subject Detail opens and marking today's class is available", todayRow !== null)
await page.$$eval('[data-testid="today-class"] button', (bs) => bs.find((b) => b.textContent.trim() === "Present")?.click())
await wait(700)
check("offline: marking from Subject Detail is saved", (await idbGet(page, "subjects")).find((s) => s.id === "p").log?.some((e) => e.d === ymd(new Date()) && e.s === "P"))
await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
await ctx.close()

// ============ links and shortcuts still behave ============
const scan = await fetch(BASE + "/scan", { redirect: "manual" })
check("/scan still redirects to the scan link", [307, 308, 302].includes(scan.status) && /\/\?scan=1$/.test(scan.headers.get("location") ?? ""), `${scan.status} ${scan.headers.get("location")}`)
check("the home page still loads", (await fetch(BASE + "/")).status === 200)
const ctx2 = await browser.createBrowserContext()
const p2 = await ctx2.newPage()
await p2.setViewport({ width: 420, height: 900, isMobile: true })
await p2.goto(BASE + "/manifest.json")
await p2.evaluate(() => localStorage.setItem("onboardingDone", "1"))
await idbPut(p2, { subjects: SUBJECTS, tasks: [], tags: [], mates: [] })
for (const [go, expect, label] of [["subjects", /5 subjects/, "Subjects"], ["calendar", /open/, "Calendar"], ["mates", /mates?/i, "Mates"]]) {
  await p2.goto(`${BASE}/?go=${go}`, { waitUntil: "networkidle0" })
  await wait(500)
  check(`/?go=${go} still opens ${label}`, expect.test(await p2.evaluate(() => document.querySelector("header")?.innerText ?? "")))
}
await p2.goto(`${BASE}/?mark=next`, { waitUntil: "networkidle0" })
await wait(900)
check("/?mark=next still marks the class that has started", (await idbGet(p2, "subjects")).find((s) => s.id === "p").log?.some((e) => e.d === ymd(new Date()) && e.s === "P"))
await ctx2.close()

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
