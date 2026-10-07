/**
 * End-to-end checks of Ping reliability in a real browser: an answer that was never finished is recovered on reopening
 * and applied exactly once, another device's lease is respected, a favour only happens when attendance actually
 * changed, a double tap makes one Ping, the ledger shows who is really connected, and the old Ping bubbles are gone.
 *
 * Runs in the app's local social mode (Pings in localStorage). Everything about Firestore itself (rules, leases,
 * transactions, identity) is tested against the real emulators in tests/rules (npm run test:rules).
 * Same setup as scripts/e2e-today.mjs.
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
const YESTERDAY = ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1))
const ME = "mock-e2e-me"
const MATE = "mock-e2e-mate"
const THIS_DEVICE = "this-device-e2e-0001"
const OTHER_DEVICE = "other-device-e2e-0002"
const slots = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "09:00", end: "10:00", kind: "Lecture" }))
const subject = (log = [], attended = 3, missed = 1) => ({ id: "dbms", name: "DBMS", attended, missed, requirement: 75, glowColor: "#3a86ff", tags: [], slots, ...(log.length ? { log } : {}) })
const item = (answer = "yes", over = {}) => ({ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer, ...over })
const answered = (id, over = {}) => ({
  id, from: ME, to: MATE, fromName: "Me", toName: "Rahul", participants: [ME, MATE], date: YESTERDAY, items: [item()],
  status: "answered", respondedAt: Date.now(), createdAt: Date.now() - 3_600_000, ...over,
})
const rahul = (over = {}) => ({ id: "m1", name: "Rahul", uid: MATE, covered: 0, repaid: 0, ...over })
const accepted = { id: "req-1", from: ME, to: MATE, fromName: "Me", toName: "Rahul", participants: [ME, MATE], status: "accepted" }

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--window-size=420,900"] })

async function launch({ pings = [], subjects = [subject()], mates = [rahul()], requests = [accepted], url = "/" }) {
  const ctx = await browser.createBrowserContext()
  const page = await ctx.newPage()
  await page.setViewport({ width: 420, height: 900, isMobile: true })
  await page.goto(BASE + "/manifest.json")
  await page.evaluate(
    (ME, THIS_DEVICE, pings, subjects, mates, requests) => new Promise((resolve) => {
      localStorage.setItem("onboardingDone", "1")
      localStorage.setItem("deviceId", THIS_DEVICE)
      localStorage.setItem("mock-social-store", JSON.stringify({ uid: ME, name: "Me", requests, invites: {} }))
      localStorage.setItem("mock-pings", JSON.stringify(pings))
      const open = indexedDB.open("college-tracker", 1)
      open.onupgradeneeded = () => open.result.createObjectStore("kv")
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", "readwrite")
        const kv = tx.objectStore("kv")
        kv.put(subjects, "subjects")
        kv.put([], "tasks")
        kv.put([], "tags")
        kv.put(mates, "mates")
        tx.oncomplete = resolve
      }
    }),
    ME, THIS_DEVICE, pings, subjects, mates, requests,
  )
  await page.goto(BASE + url, { waitUntil: "networkidle0" })
  return { ctx, page }
}
const local = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key)
const idb = (page, key) =>
  page.evaluate((key) => new Promise((resolve) => {
    const open = indexedDB.open("college-tracker", 1)
    open.onsuccess = () => {
      const r = open.result.transaction("kv").objectStore("kv").get(key)
      r.onsuccess = () => resolve(r.result ?? null)
    }
  }), key)
const statusOf = async (page, id) => (await local(page, "mock-pings"))?.find((p) => p.id === id)?.status
const until = async (fn, ms = 8000) => {
  for (let t = 0; t < ms; t += 250) {
    if (await fn()) return true
    await wait(250)
  }
  return false
}
const closeDialog = async (page) => {
  for (let i = 0; i < 3; i++) {
    const done = await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Done")?.click() !== undefined)
    await wait(400)
    if (!(await page.$('[role="alertdialog"]'))) return
    void done
  }
}
const subjectOf = async (page) => (await idb(page, "subjects")).find((s) => s.id === "dbms")
const mateOf = async (page) => (await idb(page, "mates")).find((m) => m.uid === MATE)

// ============ A. an answer that was never finished is recovered, and applied exactly once ============
{
  // the app crashed after taking the lease and before applying: the Ping is answered, our lease is on it, nothing was applied
  const ping = answered("crashed-ping-0001", { claimedBy: THIS_DEVICE, claimedAt: Date.now() - 20_000 })
  const { ctx, page } = await launch({ pings: [ping], subjects: [subject([{ d: YESTERDAY, s: "A", t: "09:00" }], 3, 2)] })
  check("an unfinished answer is picked up on reopening (it ends processed)", await until(async () => (await statusOf(page, "crashed-ping-0001")) === "processed"))
  await wait(800)
  let s = await subjectOf(page)
  let m = await mateOf(page)
  check("the class that was Absent is now Present, moved across (not added on top)", s.log.find((e) => e.d === YESTERDAY)?.s === "P" && s.attended === 4 && s.missed === 1, `${s.attended}/${s.missed}`)
  check("exactly one favour was created, credited to the mate", m.covered === 1 && m.coveredPings?.length === 1 && m.coveredLog?.length === 1, JSON.stringify(m))
  await closeDialog(page)
  await page.reload({ waitUntil: "networkidle0" })
  await wait(1500)
  s = await subjectOf(page)
  m = await mateOf(page)
  check("reopening again changes nothing: still one favour, one mark, still processed", m.covered === 1 && s.attended === 4 && s.log.filter((e) => e.d === YESTERDAY).length === 1 && (await statusOf(page, "crashed-ping-0001")) === "processed")
  await ctx.close()
}

// ============ B. another device's lease is respected until it runs out ============
{
  const held = answered("held-ping-00001", { claimedBy: OTHER_DEVICE, claimedAt: Date.now() - 10_000 })
  const { ctx, page } = await launch({ pings: [held], subjects: [subject([], 3, 1)] })
  await wait(3500)
  check("while another device holds the lease this one does nothing", (await statusOf(page, "held-ping-00001")) === "answered" && (await mateOf(page)).covered === 0)
  await ctx.close()

  const expired = answered("expired-lease-001", { claimedBy: OTHER_DEVICE, claimedAt: Date.now() - 5 * 60_000 })
  const second = await launch({ pings: [expired], subjects: [subject([], 3, 1)] })
  check("once that lease has run out this device takes over and finishes the job", await until(async () => (await statusOf(second.page, "expired-lease-001")) === "processed"))
  check("with one favour", (await mateOf(second.page)).covered === 1)
  await second.ctx.close()
}

// ============ C. when a Ping is and is not a favour ============
{
  const present = await launch({ pings: [answered("already-present-01")], subjects: [subject([{ d: YESTERDAY, s: "P", t: "09:00" }], 4, 1)] })
  await until(async () => (await statusOf(present.page, "already-present-01")) === "processed")
  let m = await mateOf(present.page)
  let s = await subjectOf(present.page)
  check("a class that was already Present creates no favour and changes nothing", m.covered === 0 && !m.coveredPings && s.attended === 4 && s.log.length === 1, `${m.covered}`)
  await present.ctx.close()

  const noClass = await launch({ pings: [answered("deleted-subject-01", { items: [item("yes", { subjectId: "gone", key: "gone@09:00" })] })], subjects: [subject()] })
  await until(async () => (await statusOf(noClass.page, "deleted-subject-01")) === "processed")
  m = await mateOf(noClass.page)
  s = await subjectOf(noClass.page)
  check("a class that no longer exists creates no favour (and the Ping still completes)", m.covered === 0 && s.attended === 3, `${m.covered}`)
  await noClass.ctx.close()

  const helped = await launch({ pings: [answered("real-help-0001")], subjects: [subject()] })
  await until(async () => (await statusOf(helped.page, "real-help-0001")) === "processed")
  m = await mateOf(helped.page)
  s = await subjectOf(helped.page)
  check("a class that was not marked becomes Present and counts as one favour", m.covered === 1 && s.attended === 4 && s.log.find((e) => e.d === YESTERDAY)?.by === "Rahul", `${m.covered}`)
  await helped.ctx.close()

  const no = await launch({ pings: [answered("said-no-0000001", { items: [item("no")] })], subjects: [subject()] })
  await until(async () => (await statusOf(no.page, "said-no-0000001")) === "processed")
  check("a no creates nothing", (await mateOf(no.page)).covered === 0 && (await subjectOf(no.page)).attended === 3)
  await no.ctx.close()
}

// ============ D. a double tap sends one Ping ============
{
  const { ctx, page } = await launch({ pings: [] })
  await page.evaluate(() => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().endsWith("Mates"))?.click())
  await wait(700)
  await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Ping")?.click())
  await wait(700)
  const label = await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.textContent.trim().startsWith("Ask Rahul"))?.textContent.trim())
  check("the Ping sheet is open for a connected mate", /^Ask Rahul about 1 class$/.test(label ?? ""), label)
  // two taps in the same instant, before the screen can react
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => x.textContent.trim().startsWith("Ask Rahul"))
    b.click()
    b.click()
  })
  await wait(1200)
  const sent = await local(page, "mock-pings")
  check("two taps made exactly one Ping", sent.length === 1, `${sent.length}`)
  const keys = await local(page, "pingSendKeys")
  check("and the send is confirmed, so the retry key is cleared", !keys || Object.keys(keys).length === 0)
  await ctx.close()
}

// ============ E. the ledger shows who is really connected; the old bubbles are gone ============
{
  const { ctx, page } = await launch({
    pings: [
      { id: "waiting-one-0001", from: MATE, to: ME, fromName: "Rahul", toName: "Me", participants: [MATE, ME], date: YESTERDAY, items: [item(null)], status: "asking", createdAt: Date.now() },
      { id: "waiting-two-0001", from: MATE, to: ME, fromName: "Neha", toName: "Me", participants: [MATE, ME], date: YESTERDAY, items: [item(null)], status: "asking", createdAt: Date.now() },
    ],
    mates: [rahul(), { id: "m2", name: "Ghost", uid: "an-old-account-id", covered: 2, repaid: 0 }],
  })
  await wait(1200)
  const asking = await page.$('[role="alertdialog"]')
  check("waiting requests are put in front of me on opening", asking !== null)
  for (let i = 0; i < 2; i++) {
    await page.evaluate(() => [...document.querySelectorAll('[role="alertdialog"] button')].find((b) => b.textContent.trim() === "Later")?.click())
    await wait(500)
  }
  const bubble = await page.evaluate(() => document.body.innerText.match(/pinged you|replied to your ping|covered you/i)?.[0] ?? null)
  check("the old 'pinged you' bubble is gone", bubble === null, String(bubble))
  const badge = await page.evaluate(() => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().endsWith("Mates"))?.textContent.trim())
  check("the Mates tab keeps a persistent count of what is still waiting (2 put off with 'Later')", /^2Mates$/.test(badge ?? ""), badge)
  await page.evaluate(() => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().endsWith("Mates"))?.click())
  await wait(800)
  const text = await page.evaluate(() => document.body.innerText)
  check("a mate who is not connected under this account says so, instead of claiming CONNECTED", /NOT CONNECTED/.test(text), "")
  const rows = await page.evaluate(() => [...document.querySelectorAll("li")].map((l) => l.innerText.replace(/\s+/g, " ")).filter((t) => /Ghost|Rahul/.test(t) && /you owe/i.test(t)))
  check("the connected mate is marked CONNECTED and the ghost is not", rows.some((r) => /Rahul.*CONNECTED/.test(r) && !/NOT CONNECTED/.test(r.split("Rahul")[1] ?? "")) && rows.some((r) => /Ghost.*NOT CONNECTED/.test(r)), rows.join(" | ").slice(0, 160))
  await page.evaluate(() => [...document.querySelectorAll("li")].find((l) => /Ghost/.test(l.innerText))?.querySelector("button")?.click())
  await wait(300)
  await page.evaluate(() => [...document.querySelectorAll("li")].find((l) => /Ghost/.test(l.innerText) && /you owe/i.test(l.innerText))?.querySelectorAll("button")[0]?.click())
  await wait(700)
  const sheet = await page.evaluate(() => document.body.innerText)
  check("pinging a not-connected mate opens the share message, not a Ping to a dead account", /Message a mate/.test(sheet) && /share sheet/i.test(sheet), "")
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
