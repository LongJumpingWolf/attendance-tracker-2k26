#!/usr/bin/env node
/**
 * Migration health check: runs every baseline check and reports each one. See MIGRATION_CHECKPOINT.md.
 *
 *   npm run migration:health                  everything (unit, rules, typecheck, lint, e2e, build)
 *   npm run migration:health -- --only unit,lint
 *   npm run migration:health -- --json report.json
 *
 * It never stops at the first failure and never leaves a suite out silently: a suite that cannot run (no Java, no Chrome,
 * a busy port...) is reported as BLOCKED and counts as a failure. Counts are compared with scripts/migration-baseline.json:
 * FEWER tests than the baseline means a test was removed or skipped, which is a failure too.
 *
 * The end-to-end suites need Chrome (CHROME env var, default is the Windows path) and port 3458 (BASE / E2E_PORT to change).
 * They run against `next dev` started here with every Firebase key blanked, i.e. the app's local mode, exactly as the
 * suites were written. The rules suite needs Java and the `firebase` CLI on the PATH (JAVA_HOME is honoured).
 */
import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import http from "node:http"
import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const baseline = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts", "migration-baseline.json"), "utf8"))
const require = createRequire(path.join(ROOT, "package.json"))
const isWin = process.platform === "win32"

const argv = process.argv.slice(2)
const flag = (name) => {
  const i = argv.indexOf(name)
  return i === -1 ? null : (argv[i + 1] ?? "")
}
const ALL = ["unit", "rules", "typecheck", "lint", "e2e", "build"]
const only = flag("--only") ? flag("--only").split(",").map((s) => s.trim()).filter(Boolean) : null
if (only && only.some((n) => !ALL.includes(n))) {
  console.error(`Unknown check in --only. Choose from: ${ALL.join(", ")}`)
  process.exit(2)
}
const jsonOut = flag("--json")

const PORT = Number(process.env.E2E_PORT ?? 3458)
const BASE = process.env.BASE ?? `http://localhost:${PORT}`
const CHROME = process.env.CHROME ?? "C:/Program Files/Google/Chrome/Application/chrome.exe"
const FIREBASE_KEYS = ["API_KEY", "APP_ID", "AUTH_DOMAIN", "MEASUREMENT_ID", "MESSAGING_SENDER_ID", "PROJECT_ID", "STORAGE_BUCKET", "VAPID_KEY"]
const blankFirebase = () => Object.fromEntries(FIREBASE_KEYS.map((k) => [`NEXT_PUBLIC_FIREBASE_${k}`, ""]))

const strip = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
const bin = (...p) => path.join(ROOT, "node_modules", ...p)

/** Runs a command, collecting all output. Never throws. */
function run(cmd, args, { env = {}, timeoutMs = 10 * 60_000, shell = false } = {}) {
  return new Promise((resolve) => {
    let out = ""
    const opts = { cwd: ROOT, env: { ...process.env, ...env }, windowsHide: true }
    const child = shell ? spawn(cmd, { ...opts, shell: true }) : spawn(cmd, args, opts) // a shell is given one command string, never an args array
    const timer = setTimeout(() => {
      out += `\n[migration-health] timed out after ${Math.round(timeoutMs / 1000)}s\n`
      killTree(child)
    }, timeoutMs)
    child.stdout.on("data", (d) => (out += d))
    child.stderr.on("data", (d) => (out += d))
    child.on("error", (e) => {
      clearTimeout(timer)
      resolve({ code: -1, out: out + String(e) })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out: strip(out) })
    })
  })
}
function killTree(child) {
  if (!child.pid) return
  try {
    if (isWin) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true })
    else process.kill(-child.pid, "SIGKILL")
  } catch {
    try { child.kill("SIGKILL") } catch {}
  }
}
const node = (script, args, opts) => run(process.execPath, [script, ...args], opts)

const result = (status, detail, extra = {}) => ({ status, detail, ...extra })
const pass = (detail, extra) => result("PASS", detail, extra)
const fail = (detail, extra) => result("FAIL", detail, extra)
const blocked = (detail) => result("BLOCKED", detail)

/** "Tests  177 passed (177)" / "Tests  1 failed | 8 passed | 2 skipped (11)" */
function vitestCounts(out) {
  const grab = (label) => {
    const line = out.split("\n").find((l) => l.trim().startsWith(label))
    const n = (word) => Number(line?.match(new RegExp(`(\\d+) ${word}`))?.[1] ?? 0)
    return line ? { failed: n("failed"), passed: n("passed"), skipped: n("skipped") + n("todo") } : null
  }
  return { files: grab("Test Files"), tests: grab("Tests") }
}
function judgeVitest(label, { code, out }, expected) {
  const c = vitestCounts(out)
  if (!c.tests) return fail(`${label}: no test summary in the output (exit ${code})`, { tail: out.split("\n").slice(-25).join("\n") })
  const problems = []
  if (code !== 0) problems.push(`exit code ${code}`)
  if (c.tests.failed) problems.push(`${c.tests.failed} failed`)
  if (c.tests.skipped) problems.push(`${c.tests.skipped} skipped (a skipped test is not a passing test)`)
  if (c.tests.passed < expected.tests) problems.push(`only ${c.tests.passed} passed, baseline is ${expected.tests}: a test was removed or is not running`)
  if (c.files && c.files.passed < expected.files) problems.push(`only ${c.files.passed} test files, baseline is ${expected.files}`)
  const detail = `${c.files?.passed ?? "?"} files, ${c.tests.passed} tests passed (baseline ${expected.files} / ${expected.tests})`
  return problems.length ? fail(`${detail}; ${problems.join("; ")}`, { tail: out.split("\n").slice(-60).join("\n") }) : pass(detail)
}

// ---------------------------------------------------------------------------------------------------------------------
const checks = {
  async unit() {
    // A checkout linked to the production project (supabase/.temp/project-ref) cannot satisfy the "no remote link" invariant
    // of a clean clone. Run the SAME suite against a clean copy instead (scripts/test-unlinked.mjs); never unlink, never skip.
    const linked = fs.existsSync(path.join(ROOT, "supabase", ".temp", "project-ref"))
    const res = linked ? await node(path.join(ROOT, "scripts", "test-unlinked.mjs"), []) : await node(bin("vitest", "vitest.mjs"), ["run"])
    const verdict = judgeVitest("unit", res, baseline.unit)
    return linked ? { ...verdict, detail: `${verdict.detail} [run on a clean unlinked copy: this checkout is linked to a Supabase project]` } : verdict
  },

  async rules() {
    const java = spawnSync("java", ["-version"], { env: process.env, windowsHide: true })
    if (java.error || java.status !== 0) return blocked("Java is not on the PATH (the Firestore emulator needs it). Install a JRE or set JAVA_HOME/PATH.")
    const fb = spawnSync("firebase --version", { env: process.env, windowsHide: true, shell: true })
    if (fb.error || fb.status !== 0) return blocked("The `firebase` CLI is not on the PATH (npm i -g firebase-tools).")
    const first = await run("npm run test:rules", [], { shell: true })
    const verdict = judgeVitest("rules", first, baseline.rules)
    if (verdict.status === "PASS") return verdict
    // One known flaky test (see MIGRATION_CHECKPOINT.md): if it is the ONLY thing that failed, run once more and say so out loud.
    // Any other failure, or a second failure, is a plain FAIL.
    const failed = [...first.out.matchAll(/^ FAIL +(.+)$/gm)].map((m) => m[1].trim())
    const known = baseline.knownFlaky ?? []
    if (failed.length === 1 && known.includes(failed[0])) {
      const second = await run("npm run test:rules", [], { shell: true })
      const again = judgeVitest("rules", second, baseline.rules)
      if (again.status === "PASS") return pass(`${again.detail}. PASSED ON RETRY: the first attempt failed only in the known flaky test "${failed[0]}"`, { retried: true })
      return fail(`failed twice (first attempt: only the known flaky test); second attempt: ${again.detail}`, { tail: again.tail })
    }
    return verdict
  },

  async typecheck() {
    const r = await node(bin("typescript", "bin", "tsc"), ["--noEmit"])
    return r.code === 0 ? pass("no type errors") : fail(`tsc exit ${r.code}`, { tail: r.out.split("\n").slice(0, 40).join("\n") })
  },

  async lint() {
    const r = await node(bin("eslint", "bin", "eslint.js"), ["."])
    const m = r.out.match(/(\d+) problems? \((\d+) errors?, (\d+) warnings?\)/)
    const errors = m ? Number(m[2]) : r.code === 0 ? 0 : null
    const warnings = m ? Number(m[3]) : 0
    if (errors === null) return fail(`eslint exit ${r.code} with no summary`, { tail: r.out.split("\n").slice(-30).join("\n") })
    const problems = []
    if (errors > baseline.lint.errors) problems.push(`${errors} errors (baseline ${baseline.lint.errors})`)
    if (warnings > baseline.lint.maxWarnings) problems.push(`${warnings} warnings, more than the baseline ${baseline.lint.maxWarnings}`)
    const detail = `${errors} errors, ${warnings} warnings (baseline ${baseline.lint.errors} / ${baseline.lint.maxWarnings})`
    return problems.length ? fail(`${detail}; ${problems.join("; ")}`, { tail: r.out.split("\n").slice(-30).join("\n") }) : pass(detail)
  },

  async e2e() {
    // Preconditions: every one of these is a BLOCK, never a silent skip
    if (!fs.existsSync(CHROME)) return blocked(`Chrome not found at ${CHROME}. Install it or set CHROME=<path to chrome>.`)
    try {
      require.resolve("puppeteer-core")
    } catch {
      return blocked("puppeteer-core is not installed. Run `npm install`.")
    }
    if (await get(BASE + "/")) return blocked(`Something is already listening on ${BASE}. Stop it: this check must start its own server with every Firebase key blanked, never reuse one.`)

    // A production build and a dev server share .next; it is only build output (git-ignored)
    fs.rmSync(path.join(ROOT, ".next"), { recursive: true, force: true })
    let log = ""
    const server = spawn(process.execPath, [bin("next", "dist", "bin", "next"), "dev", "-p", String(PORT)], {
      cwd: ROOT, env: { ...process.env, ...blankFirebase() }, windowsHide: true, detached: !isWin,
    })
    server.stdout.on("data", (d) => (log += d))
    server.stderr.on("data", (d) => (log += d))
    try {
      const upBy = Date.now() + 180_000
      let up = false
      while (Date.now() < upBy) {
        if (server.exitCode !== null) break
        if (await get(BASE + "/")) { up = true; break }
        await new Promise((r) => setTimeout(r, 1000))
      }
      if (!up) return fail("the dev server did not start", { tail: strip(log).split("\n").slice(-25).join("\n") })

      const lines = []
      let bad = 0
      for (const [name, expected] of Object.entries(baseline.e2e)) {
        const r = await node(path.join(ROOT, "scripts", `e2e-${name}.mjs`), [], { env: { BASE, CHROME }, timeoutMs: 6 * 60_000 })
        const m = r.out.match(/(\d+)\/(\d+) checks passed/)
        const passed = m ? Number(m[1]) : 0
        const total = m ? Number(m[2]) : 0
        const ok = r.code === 0 && m && passed === total && total >= expected
        if (!ok) bad++
        lines.push(`${ok ? "ok  " : "FAIL"} ${name}: ${m ? `${passed}/${total}` : "no result"} (baseline ${expected})${r.code !== 0 ? ` exit ${r.code}` : ""}`)
        if (!ok) lines.push(r.out.split("\n").filter((l) => /FAIL|✗|Error/.test(l)).slice(0, 8).map((l) => "       " + l).join("\n"))
      }
      const total = Object.values(baseline.e2e).reduce((a, b) => a + b, 0)
      return bad
        ? fail(`${bad} of ${Object.keys(baseline.e2e).length} e2e suites failed (baseline ${total} checks)`, { tail: lines.join("\n") })
        : pass(`${Object.keys(baseline.e2e).length} suites, ${total} checks`, { tail: lines.join("\n") })
    } finally {
      killTree(server)
    }
  },

  async build() {
    const r = await node(bin("next", "dist", "bin", "next"), ["build"], { env: blankFirebase() })
    return r.code === 0 ? pass("next build succeeded") : fail(`next build exit ${r.code}`, { tail: r.out.split("\n").slice(-40).join("\n") })
  },
}

function get(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode >= 200 && res.statusCode < 500)
    })
    req.on("error", () => resolve(false))
    req.setTimeout(3000, () => { req.destroy(); resolve(false) })
  })
}

// ---------------------------------------------------------------------------------------------------------------------
const report = { baselineCommit: baseline.commit, at: new Date().toISOString(), checks: {} }
console.log(`Migration health check (baseline ${baseline.commit})\n`)
for (const name of ALL) {
  if (only && !only.includes(name)) {
    report.checks[name] = { status: "NOT RUN", detail: "left out with --only" }
    console.log(`  ${"NOT RUN".padEnd(8)} ${name.padEnd(10)} (left out with --only)`)
    continue
  }
  const started = Date.now()
  process.stdout.write(`  running  ${name} ...\r`)
  let r
  try {
    r = await checks[name]()
  } catch (e) {
    r = fail(`the check itself crashed: ${e?.stack ?? e}`)
  }
  r.seconds = Math.round((Date.now() - started) / 1000)
  report.checks[name] = r
  console.log(`  ${r.status.padEnd(8)} ${name.padEnd(10)} ${r.detail}  [${r.seconds}s]`)
  if (r.status !== "PASS" && r.tail) console.log(r.tail.split("\n").map((l) => "           " + l).join("\n"))
  else if (name === "e2e" && r.tail) console.log(r.tail.split("\n").map((l) => "           " + l).join("\n"))
}

const statuses = Object.values(report.checks).map((c) => c.status)
const failing = ALL.filter((n) => ["FAIL", "BLOCKED"].includes(report.checks[n].status))
const partial = statuses.includes("NOT RUN")
report.healthy = failing.length === 0 && !partial
console.log("")
if (failing.length) console.log(`UNHEALTHY: ${failing.join(", ")} did not pass.`)
else if (partial) console.log("PARTIAL RUN: everything that ran passed, but this is not a full health check.")
else console.log("HEALTHY: every baseline check passed.")
if (jsonOut) fs.writeFileSync(path.resolve(ROOT, jsonOut), JSON.stringify(report, null, 2) + "\n")
process.exit(failing.length ? 1 : partial ? 2 : 0)
