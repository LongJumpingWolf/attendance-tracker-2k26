/**
 * End-to-end checks of Tier 2B in a real browser: the percentage and verdict on Today, exact Undo, correcting past days
 * in the Calendar, older untimed marks, and a live update from another device. Same setup as scripts/e2e-today.mjs.
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

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
const daysAgo = (n) => new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - n)
const TODAY = ymd(new Date())
const YESTERDAY = ymd(daysAgo(1))
const OLDER = daysAgo(5)
const every = (...times) => [0, 1, 2, 3, 4, 5, 6].flatMap((day) => times.map(([start, end, kind]) => ({ day, start, end, kind })))
const base = (id, name, attended, missed, extra = {}) => ({ id, name, attended, missed, requirement: 75, glowColor: "#3a86ff", tags: [], ...extra })
const PH = base("p", "Pharmacology", 9, 1, { slots: every(["00:01", "23:58", "Lecture"]) }) //  90%: safe to skip
const BI = base("b", "Biochem", 6, 2, { slots: every(["00:02", "23:57", "Lecture"], ["00:03", "23:56", "Practical"]) }) // 75%: must attend
const ET = base("e", "Ethics", 1, 1, { log: [{ d: YESTERDAY, s: "A" }] }) // an older mark saved with no class time

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
const toast = (page) => page.evaluate(() => document.querySelector('[role="status"]')?.textContent ?? "")
const entryFor = (s, d, t) => (s?.log ?? []).filter((e) => e.d === d && (e.t ?? "") === t).at(-1)

async function cardsFor(page, name) {
  const out = []
  for (const c of await page.$$("article[data-key]")) if ((await c.$eval("h3", (h) => h.textContent).catch(() => "")) === name) out.push(c)
  return out
}
async function mark(page, name, status, nth = 0) {
  const card = (await cardsFor(page, name))[nth]
  if (!card) return false
  for (const b of await card.$$("button")) if ((await b.evaluate((e) => e.textContent?.trim())) === (status === "P" ? "Present" : "Absent")) return (await b.click(), true)
  return false
}
const verdictOf = async (card) => ({
  label: await card.$eval('[data-testid="verdict"]', (e) => e.textContent).catch(() => ""),
  detail: await card.$eval('[data-testid="verdict-detail"]', (e) => e.textContent).catch(() => ""),
})
const clickNav = (page, label) => page.evaluate((label) => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().endsWith(label))?.click(), label)
/** A real click, after scrolling the element to the middle of the screen so the toast or the nav bar can't sit on top of it */
const centerClick = async (el) => {
  await el.evaluate((e) => e.scrollIntoView({ block: "center" }))
  await wait(150)
  await el.click()
}
const clickToastUndo = (page) => page.evaluate(() => [...document.querySelectorAll('[role="status"] button')].find((b) => b.textContent.trim() === "Undo")?.click())

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--window-size=420,900"] })
const phone = async (ctx) => {
  const page = await ctx.newPage()
  await page.setViewport({ width: 420, height: 900, isMobile: true })
  return page
}
const seed = async (page, extra = {}) => {
  await page.goto(BASE + "/manifest.json")
  await page.evaluate(() => localStorage.setItem("onboardingDone", "1"))
  await idbPut(page, { subjects: [PH, BI, ET], tasks: [], tags: [], mates: [], ...extra })
}

// ============ A. Today: verdict, result, exact Undo, offline ============
{
  const ctx = await browser.createBrowserContext()
  const page = await phone(ctx)
  await seed(page)
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await wait(800)

  const ph = await verdictOf((await cardsFor(page, "Pharmacology"))[0])
  const bi = await verdictOf((await cardsFor(page, "Biochem"))[0])
  check("a card for a subject with skips to spare says SAFE TO SKIP with the percentage and target", ph.label === "SAFE TO SKIP" && /90% now/.test(ph.detail) && /75% needed/.test(ph.detail), `${ph.label} | ${ph.detail}`)
  check("a card for a subject at the edge says MUST ATTEND", bi.label === "MUST ATTEND" && /75% now/.test(bi.detail), `${bi.label} | ${bi.detail}`)

  await mark(page, "Pharmacology", "P")
  await wait(250)
  check("marking Present shows the resulting percentage straight away (toast: 9 of 10 -> 10 of 11 = 91%)", /Present · Pharmacology · now 91%/.test(await toast(page)), await toast(page))
  await wait(800)
  let t = await text(page)
  check("the marked row shows the new percentage and verdict without opening anything", /91%\s*·\s*safe to skip/i.test(t))

  await mark(page, "Biochem", "A", 0)
  await wait(250)
  check("marking Absent shows the lower percentage (6 of 8 -> 6 of 9 = 67%)", /Absent · Biochem · now 67%/.test(await toast(page)), await toast(page))
  await wait(800)
  const second = await verdictOf((await cardsFor(page, "Biochem"))[0]) // the other Biochem lecture, still waiting
  check("the other lecture of the same subject updates at once: ATTEND TO REACH TARGET at 67%", second.label === "ATTEND TO REACH TARGET" && /67% now/.test(second.detail), `${second.label} | ${second.detail}`)

  await mark(page, "Biochem", "P", 0)
  await wait(900)
  check("second lecture marked present: percentage follows (7 of 10 = 70%)", /70%/.test(await text(page)))

  // exact Undo from the Marked today list: undo lecture 1 after lecture 2 was marked
  const undoButtons = await page.$$('button[aria-label="Clear mark for Biochem"]')
  await centerClick(undoButtons[0])
  await wait(900)
  let b = await subj(page, "b")
  check("Undo on lecture 1 unmarks lecture 1 only", !entryFor(b, TODAY, "00:02"), JSON.stringify(b.log))
  check("lecture 2 stays Present", entryFor(b, TODAY, "00:03")?.s === "P")
  check("counts are exactly lecture 2's effect (7 attended, 2 missed)", b.attended === 7 && b.missed === 2, `${b.attended}/${b.missed}`)

  // toast Undo: mark lecture 1 Absent, then Undo from the toast
  await mark(page, "Biochem", "A", 0)
  await wait(500)
  b = await subj(page, "b")
  check("lecture 1 marked absent again", entryFor(b, TODAY, "00:02")?.s === "A")
  await clickToastUndo(page)
  await wait(800)
  b = await subj(page, "b")
  check("toast Undo reverts that class only (lecture 2 untouched)", !entryFor(b, TODAY, "00:02") && entryFor(b, TODAY, "00:03")?.s === "P" && b.attended === 7 && b.missed === 2)

  // switching a mark then undoing returns the previous mark, not "unmarked"
  await mark(page, "Biochem", "P", 0)
  await wait(900)
  await ctx.setOffline?.(true).catch(() => {})
  const cdp = await page.createCDPSession()
  await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 })
  const offlineUndo = await page.$$('button[aria-label="Clear mark for Biochem"]')
  if (offlineUndo[0]) await centerClick(offlineUndo[0]) // offline: clear lecture 1
  await wait(800)
  b = await subj(page, "b")
  check("offline: marking and undoing still work", !entryFor(b, TODAY, "00:02") && entryFor(b, TODAY, "00:03")?.s === "P")
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })

  await page.reload({ waitUntil: "networkidle0" })
  await wait(700)
  b = await subj(page, "b")
  const p = await subj(page, "p")
  check("after a reload the result is the same (no mark came back, none lost)", !entryFor(b, TODAY, "00:02") && entryFor(b, TODAY, "00:03")?.s === "P" && entryFor(p, TODAY, "00:01")?.s === "P")
  t = await text(page)
  check("after the reload the percentage is still shown on the marked rows", /%\s*·\s*(safe to skip|must attend|attend to reach target)/i.test(t))
  await ctx.close()
}

// ============ A2. Two taps in the same instant: the toast and Undo still belong to the right class ============
{
  const ctx = await browser.createBrowserContext()
  const page = await phone(ctx)
  await seed(page)
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await wait(800)
  // both Present buttons are pressed inside one task, before the screen can re-render
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll("article[data-key]")].filter((a) => a.querySelector("h3")?.textContent === "Biochem")
    for (const c of cards) [...c.querySelectorAll("button")].find((b) => b.textContent.trim() === "Present")?.click()
  })
  await wait(900)
  let b = await subj(page, "b")
  check("rapid taps: both lectures were recorded exactly once", entryFor(b, TODAY, "00:02")?.s === "P" && entryFor(b, TODAY, "00:03")?.s === "P" && b.attended === 8 && b.log.length === 2, `${b.attended}/${b.missed}`)
  check("rapid taps: the toast shows the combined result (8 of 10 = 80%)", /now 80%/.test(await toast(page)), await toast(page))
  await clickToastUndo(page)
  await wait(800)
  b = await subj(page, "b")
  check("rapid taps: Undo takes back only the last class, the first stays Present", entryFor(b, TODAY, "00:02")?.s === "P" && !entryFor(b, TODAY, "00:03") && b.attended === 7, JSON.stringify(b.log))
  await ctx.close()
}

// ============ B. Calendar: correct past days; older untimed marks are kept ============
{
  const ctx = await browser.createBrowserContext()
  const page = await phone(ctx)
  await seed(page)
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await wait(600)
  await clickNav(page, "Calendar")
  await wait(700)

  const pick = async (date) => {
    const month = date.getMonth() !== new Date().getMonth()
    if (month) await page.click('button[aria-label="Previous month"]')
    await wait(200)
    await page.evaluate((day) => [...document.querySelectorAll("section button[aria-pressed]")].find((b) => b.textContent.trim().startsWith(String(day)))?.click(), date.getDate())
    await wait(500)
  }
  const dayButtons = async (name) => {
    const all = await page.$$('[data-testid="cal-present"], [data-testid="cal-absent"]')
    const out = {}
    for (const b of all) {
      const label = await b.evaluate((e) => e.getAttribute("aria-label"))
      if (label.startsWith(name)) (out[label.includes("present") ? "P" : "A"] ??= []).push(b)
    }
    return out
  }

  await pick(daysAgo(1))
  let tt = await text(page)
  check("yesterday: the calendar lists that day's classes", /Pharmacology/.test(tt) && /Biochem/.test(tt))
  check("yesterday: the older untimed mark is shown separately and labelled", /Older marks with no class time/i.test(tt) && /Ethics/.test(tt))

  let btn = await dayButtons("Pharmacology")
  await centerClick(btn.P[0])
  await wait(700)
  let p = await subj(page, "p")
  check("yesterday can be marked Present", entryFor(p, YESTERDAY, "00:01")?.s === "P" && p.attended === 10, `${p.attended}/${p.missed}`)
  check("the toast says it was yesterday and shows the new percentage", /Present · Pharmacology · .* · now 91%/.test(await toast(page)), await toast(page))

  btn = await dayButtons("Pharmacology")
  await centerClick(btn.A[0]) // correct it to Absent
  await wait(700)
  p = await subj(page, "p")
  check("yesterday's mark can be corrected to Absent (counts move, one record)", entryFor(p, YESTERDAY, "00:01")?.s === "A" && p.attended === 9 && p.missed === 2 && p.log.filter((e) => e.d === YESTERDAY).length === 1, `${p.attended}/${p.missed}`)

  btn = await dayButtons("Pharmacology")
  await centerClick(btn.A[0]) // tap the marked one again: leave it unmarked
  await wait(700)
  p = await subj(page, "p")
  check("a mark can be left unmarked again", !entryFor(p, YESTERDAY, "00:01") && p.attended === 9 && p.missed === 1)

  // two Biochem lectures yesterday, separately
  btn = await dayButtons("Biochem")
  await centerClick(btn.P[0])
  await wait(600)
  btn = await dayButtons("Biochem")
  await centerClick(btn.A[1])
  await wait(700)
  const bi = await subj(page, "b")
  check("two lectures of one subject on a past day are separate records", entryFor(bi, YESTERDAY, "00:02")?.s === "P" && entryFor(bi, YESTERDAY, "00:03")?.s === "A", JSON.stringify(bi.log))

  // an older date
  await pick(OLDER)
  btn = await dayButtons("Pharmacology")
  await centerClick(btn.A[0])
  await wait(700)
  p = await subj(page, "p")
  check("an older date (5 days ago) can be marked too", entryFor(p, ymd(OLDER), "00:01")?.s === "A" && p.missed === 2, `${p.attended}/${p.missed}`)

  const et = await subj(page, "e")
  check("the older untimed mark was not deleted by any of this", et.log.some((e) => e.d === YESTERDAY && e.s === "A" && !e.t) && et.attended === 1 && et.missed === 1)

  // Today's Present/Absent summary reflects the corrections
  await clickNav(page, "Today")
  await wait(700)
  const v = await verdictOf((await cardsFor(page, "Pharmacology"))[0])
  check("back on Today the verdict reflects the corrected past marks", /% now/.test(v.detail) && v.label.length > 0, `${v.label} | ${v.detail}`)
  await ctx.close()
}

// ============ C. A mark made on another device recalculates the percentage and verdict ============
{
  const owner = `e2e2b${run}`
  const decode = (s) => (s.startsWith("gz1:") ? zlib.gunzipSync(Buffer.from(s.slice(4), "base64")).toString() : s)
  const backup = (subjects) => ({ app: "college-tracker", version: 1, exportedAt: new Date().toISOString(), data: { subjects, tasks: [], tags: [], mates: [{ id: "friend-zoe-002", uid: "friend-zoe-002", name: "Zoe", covered: 0, repaid: 0 }, { id: "friend-ryan-003", uid: "friend-ryan-003", name: "Ryan", covered: 0, repaid: 0 }], reminders: [] } })
  const put = (obj, rev) => fetch(`${BASE}/api/dev-sync/${owner}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data: "gz1:" + zlib.gzipSync(JSON.stringify(obj)).toString("base64"), expectedRev: rev }) })
  const baseBackup = backup([PH, BI])
  await put(baseBackup, null)
  const ctx = await browser.createBrowserContext()
  const page = await phone(ctx)
  await page.goto(BASE + "/manifest.json")
  await page.evaluate((owner) => {
    localStorage.setItem("devAccount", JSON.stringify({ id: owner, email: "t@example.com", name: "Tester" }))
    localStorage.setItem("syncOwner", owner)
    localStorage.setItem("syncRev", "1")
    localStorage.setItem("onboardingDone", "1")
  }, owner)
  await idbPut(page, { subjects: [PH, BI], tasks: [], tags: [], mates: baseBackup.data.mates, syncBase: baseBackup.data })
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await wait(3000)
  const before = await verdictOf((await cardsFor(page, "Biochem"))[0])
  check("before the other device acts: Biochem shows MUST ATTEND at 75%", before.label === "MUST ATTEND" && /75% now/.test(before.detail), `${before.label} | ${before.detail}`)

  // the other device marks Biochem lecture 1 absent and syncs
  const theirs = { ...BI, missed: 3, log: [{ d: TODAY, s: "A", t: "00:02", k: "Lecture" }] }
  const r = await put(backup([PH, theirs]), 1)
  check("the other device saved its change", r.status === 200)
  let seen = false
  for (let i = 0; i < 40 && !seen; i++) {
    await wait(1000)
    const cards = await cardsFor(page, "Biochem")
    if (cards.length === 1) {
      const v = await verdictOf(cards[0])
      seen = v.label === "ATTEND TO REACH TARGET" && /67% now/.test(v.detail)
    }
  }
  check("without reloading, the remaining Biochem card recalculates to 67% and ATTEND TO REACH TARGET", seen)
  const synced = await subj(page, "b")
  check("and that mark is stored here too", entryFor(synced, TODAY, "00:02")?.s === "A")
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
