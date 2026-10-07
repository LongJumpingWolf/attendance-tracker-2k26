/**
 * End-to-end checks of the Ping experience in a real browser: the full-screen request and answer, finding them on
 * opening the app, opening one from a notification link, never showing one twice, and the real service worker showing
 * (or holding back) a notification for a push. Same setup as scripts/e2e-today.mjs.
 *
 * Uses the app's local social mode (no Firebase keys), where Pings live in localStorage, and the developer
 * simulators, which feed the same live list a Firestore listener feeds. Real Firestore delivery is NOT covered here.
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
const daysAgo = (n) => ymd(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - n))
const ME = "mock-e2e-me"
const MATE = "mock-e2e-mate"
const SUBJECT = { id: "s", name: "DBMS", attended: 3, missed: 1, requirement: 75, glowColor: "#3a86ff", tags: [], slots: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, start: "09:00", end: "10:00", kind: "Lecture" })) }
const item = (answer = null) => ({ key: "s@09:00", subjectId: "s", name: "DBMS", t: "09:00", answer })
const incomingPing = (id, fromName, date = daysAgo(0), over = {}) => ({ id, from: MATE, to: ME, fromName, toName: "Me", participants: [MATE, ME], date, items: [item()], status: "asking", ...over })
const sentPing = (id, over = {}) => ({ id, from: ME, to: MATE, fromName: "Me", toName: "Rahul", participants: [ME, MATE], date: daysAgo(1), items: [item("yes")], status: "answered", respondedAt: Date.now(), ...over })

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--window-size=420,900"] })

/** A fresh browser profile holding some Pings, as if they had arrived while the app was closed */
async function launch(pings, { extra = {}, url = "/", permissions = false } = {}) {
  const ctx = await browser.createBrowserContext()
  if (permissions) await ctx.overridePermissions(BASE, ["notifications"])
  const page = await ctx.newPage()
  await page.setViewport({ width: 420, height: 900, isMobile: true })
  await page.goto(BASE + "/manifest.json")
  await page.evaluate(
    (ME, pings, subject, extra) => new Promise((resolve) => {
      localStorage.setItem("onboardingDone", "1")
      localStorage.setItem("mock-social-store", JSON.stringify({ uid: ME, name: "Me", requests: [], invites: {} }))
      localStorage.setItem("mock-pings", JSON.stringify(pings))
      const open = indexedDB.open("college-tracker", 1)
      open.onupgradeneeded = () => open.result.createObjectStore("kv")
      open.onsuccess = () => {
        const tx = open.result.transaction("kv", "readwrite")
        const kv = tx.objectStore("kv")
        kv.put([subject], "subjects")
        kv.put([], "tasks")
        kv.put([], "tags")
        kv.put(extra.mates ?? [], "mates")
        tx.oncomplete = resolve
      }
    }),
    ME, pings, SUBJECT, extra,
  )
  await page.goto(BASE + url, { waitUntil: "networkidle0" })
  return { ctx, page }
}
const dialog = async (page) => page.evaluate(() => document.querySelector('[role="alertdialog"]')?.innerText.replace(/\s+/g, " ").trim() ?? null)
const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key)
const clickIn = async (page, label) => {
  for (const b of await page.$$('[role="alertdialog"] button')) {
    if ((await b.evaluate((e) => e.textContent.trim())) === label) return (await b.click(), true)
  }
  return false
}
const waitDialog = async (page, ms = 6000) => {
  for (let t = 0; t < ms; t += 200) {
    const d = await dialog(page)
    if (d) return d
    await wait(200)
  }
  return null
}
const waitGone = async (page, ms = 5000) => {
  for (let t = 0; t < ms; t += 200) {
    if (!(await dialog(page))) return true
    await wait(200)
  }
  return false
}

// ============ A. a request that arrived while the app was closed ============
{
  const { ctx, page } = await launch([incomingPing("p-new", "Neha", daysAgo(0)), incomingPing("p-old", "Asha", daysAgo(2))])
  let d = await waitDialog(page)
  check("opening the app puts the waiting Ping on screen by itself (no trip to Mates)", d !== null && /is asking for attendance help/.test(d), d?.slice(0, 80))
  check("the oldest request comes first, deterministically", /Asha is asking/.test(d ?? ""))
  check("it shows who, the day, the class and a clear YES / NO", /PING/i.test(d) && /DBMS/.test(d) && /9:00 AM/.test(d) && /YES/.test(d) && /NO/.test(d) && /Later/.test(d), d)
  check("it is a real full-screen dialog", await page.evaluate(() => { const e = document.querySelector('[role="alertdialog"]'); const r = e.getBoundingClientRect(); return r.width >= innerWidth && r.height >= innerHeight && e.getAttribute("aria-modal") === "true" }))
  check("the page behind can't be scrolled while it is up", await page.evaluate(() => document.body.style.overflow === "hidden"))
  check("the YES button has keyboard focus", await page.evaluate(() => document.activeElement?.textContent.trim() === "YES"))

  await clickIn(page, "YES")
  await wait(450)
  d = await dialog(page)
  check("answering shows a confirmation", /Sent to Asha/.test(d ?? ""), d)
  await wait(2000)
  d = await dialog(page)
  check("then it moves straight on to the next waiting Ping (Neha)", /Neha is asking/.test(d ?? ""), d)
  const pings = await stored(page, "mock-pings")
  const p = pings.find((x) => x.id === "p-old")
  check("the answer was recorded on the Ping (business state: answered, with a yes)", p.status === "answered" && p.items[0].answer === "yes")
  check("and remembered as handled on this device", Object.keys((await stored(page, "pingPresented")).incoming).includes("p-old"))

  await clickIn(page, "Later")
  check("'Later' closes the request without answering it", await waitGone(page))
  check("so it is still pending", (await stored(page, "mock-pings")).find((x) => x.id === "p-new").status === "asking")
  await page.reload({ waitUntil: "networkidle0" })
  d = await waitDialog(page)
  check("and it comes back the next time the app opens", /Neha is asking/.test(d ?? ""))
  check("but the one already answered does not", !/Asha/.test(d ?? ""))
  await ctx.close()
}

// ============ B. opening a Ping from a notification link ============
{
  const pings = [incomingPing("p-a", "Asha", daysAgo(2)), incomingPing("p-b", "Neha", daysAgo(0))]
  const { ctx, page } = await launch(pings, { url: "/?ping=p-b" })
  const d = await waitDialog(page)
  check("a notification link opens exactly that Ping, ahead of an older waiting one", /Neha is asking/.test(d ?? ""), d?.slice(0, 60))
  check("the link is tidied out of the address bar", !page.url().includes("ping="))
  await clickIn(page, "YES")
  await wait(2200)
  check("afterwards the other waiting Ping is offered, not the same one again", /Asha is asking/.test((await dialog(page)) ?? ""))
  await ctx.close()
}
for (const [label, url, pings, expected, graceMs] of [
  ["a Ping that doesn't exist", "/?ping=ghost", [], /isn't available/, 8500],
  ["someone else's Ping", "/?ping=theirs", [{ ...incomingPing("theirs", "Zed"), participants: ["x", "y"], from: "x", to: "y" }], /isn't available/, 8500],
  ["an expired Ping", "/?ping=old", [incomingPing("old", "Asha", daysAgo(6))], /expired/, 2500],
  ["a Ping already answered", "/?ping=done", [incomingPing("done", "Asha", daysAgo(0), { status: "processed" })], /already been answered/, 2500],
]) {
  const { ctx, page } = await launch(pings, { url })
  await wait(graceMs)
  const toast = await page.evaluate(() => document.querySelector('[role="status"]')?.textContent ?? "")
  check(`a link to ${label} is refused with a message, and nothing opens`, expected.test(toast) && (await dialog(page)) === null, toast)
  await ctx.close()
}

// ============ C. the answer to a Ping I sent ============
{
  const { ctx, page } = await launch([sentPing("r1", { status: "processed" })])
  let d = await waitDialog(page)
  check("an answer that arrived while I was away is announced when I open the app", /PING ANSWERED/i.test(d ?? "") && /Rahul marked you PRESENT/.test(d ?? ""), d?.slice(0, 90))
  check("even though the Ping was already processed by the app in the background", (await stored(page, "mock-pings"))[0].status === "processed")
  check("it shows the class, the day and the result", /DBMS/.test(d) && /Present/.test(d) && /Yesterday/.test(d), d)
  await clickIn(page, "Done")
  check("Done takes it away", await waitGone(page))
  check("and it is remembered as seen", Object.keys((await stored(page, "pingPresented")).result).includes("r1"))
  await page.reload({ waitUntil: "networkidle0" })
  await wait(1500)
  check("the same answer is not shown again after reopening", (await dialog(page)) === null)
  await ctx.close()
}
{
  const no = sentPing("r2", { items: [item("no")] })
  const { ctx, page } = await launch([no])
  const d = await waitDialog(page)
  check("a 'no' is worded as a no", /Rahul did not cover you/.test(d ?? "") && /Not covered/.test(d ?? ""), d?.slice(0, 80))
  await page.keyboard.press("Escape")
  check("Escape closes an answer (keyboard)", await waitGone(page))
  await ctx.close()
}

// ============ D. while the app is already open (the same live list a Firestore listener feeds) ============
{
  const { ctx, page } = await launch([], { extra: { mates: [{ id: "m1", name: "Rahul", covered: 0, repaid: 0 }] } })
  check("nothing is shown when nothing is waiting", (await dialog(page)) === null)
  const simulate = async (label) => {
    await page.click('button[aria-label="Settings"]')
    await wait(400)
    const dev = await page.$$("button")
    for (const b of dev) if ((await b.evaluate((e) => e.textContent.trim())).startsWith("Show developer tools")) { await b.click(); break } // only when still hidden
    await wait(300)
    for (const b of await page.$$("button")) if ((await b.evaluate((e) => e.textContent.trim())).includes(label)) { await b.click(); break }
  }
  await simulate("Simulate a mate pinging you")
  let d = await waitDialog(page)
  check("a request arriving while the app is open appears full-screen where I am", /is asking for attendance help/.test(d ?? ""), d?.slice(0, 70))
  await clickIn(page, "NO")
  await wait(2300)
  check("answering it clears it", (await dialog(page)) === null)
  await simulate("Simulate a mate replying")
  d = await waitDialog(page)
  check("an answer arriving while the app is open appears full-screen too", /PING ANSWERED/i.test(d ?? ""), d?.slice(0, 70))
  await clickIn(page, "Done")
  await waitGone(page)
  await ctx.close()
}

// ============ E. the Mates screen no longer has manual favour buttons ============
{
  const { ctx, page } = await launch([], { extra: { mates: [{ id: "m1", name: "Rahul", covered: 3, repaid: 1 }, { id: "m2", name: "Neha", covered: 2, repaid: 2 }] } })
  await page.evaluate(() => [...document.querySelectorAll("nav button")].find((b) => b.textContent.trim().endsWith("Mates"))?.click())
  await wait(700)
  const t = await page.evaluate(() => document.body.innerText)
  const buttons = await page.$$eval("button", (bs) => bs.map((b) => b.textContent.trim()))
  check("no 'Covered me' button", !buttons.includes("Covered me") && !/tap .?Covered me/i.test(t))
  check("no 'Repaid' button", !buttons.includes("Repaid"))
  check("the useful mate information is still there (who, favours owed, Ping)", /Rahul/.test(t) && /you owe/i.test(t) && buttons.includes("Ping"))
  await ctx.close()
}

// ============ F. the real service worker and a real push ============
{
  const ctx = await browser.createBrowserContext()
  await ctx.overridePermissions(BASE, ["notifications"])
  const page = await ctx.newPage()
  await page.goto(BASE + "/manifest.json")
  await page.evaluate(() => localStorage.setItem("onboardingDone", "1"))
  await page.goto(BASE + "/", { waitUntil: "networkidle0" })
  await wait(1500)
  const cdp = await page.createCDPSession()
  const regs = []
  cdp.on("ServiceWorker.workerRegistrationUpdated", (e) => regs.push(...e.registrations))
  await cdp.send("ServiceWorker.enable")
  await wait(800)
  const reg = regs.find((r) => r.scopeURL.startsWith(BASE))
  check("the service worker is registered", !!reg)
  const payload = { data: { type: "ping", event: "incoming", pingId: "px", tag: "ping-px", title: "Ping", body: "Asha is asking about your attendance", url: "/?ping=px" } }
  const notes = async (p) => p.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data?.url })))
  if (reg) {
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: BASE, registrationId: reg.registrationId, data: JSON.stringify(payload) })
    await wait(1200)
    check("a push while the app is open in front of me shows no system notification (the app shows the Ping itself)", (await notes(page)).length === 0)

    await page.goto("about:blank") // the app is no longer open
    await wait(500)
    await cdp.send("ServiceWorker.deliverPushMessage", { origin: BASE, registrationId: reg.registrationId, data: JSON.stringify(payload) }).catch(() => {})
    await wait(1500)
    const reader = await ctx.newPage()
    await reader.goto(BASE + "/manifest.json")
    const list = await notes(reader).catch(() => [])
    check("a push while the app is closed shows a notification with no class details", list.length === 1 && list[0].title === "Ping" && list[0].body === "Asha is asking about your attendance" && !/DBMS/.test(JSON.stringify(list)), JSON.stringify(list))
    check("it links to that Ping and is tagged by the Ping's id", list[0]?.url === "/?ping=px" && list[0]?.tag === "ping-px")
  }
  await ctx.close()
}

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length ? 1 : 0)
