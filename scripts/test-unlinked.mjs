#!/usr/bin/env node
/**
 * Runs the unit tests against a throwaway copy of the working tree that has NO Supabase link and NO env files.
 *
 * Why: tests/migration-invariants.test.ts asserts "no remote link" (supabase/.temp/project-ref must not exist). A checkout
 * that is linked to the production project (needed for the owner's schema checks and import) therefore fails that
 * invariant, which is correct: the invariant describes a clean clone. This runner reproduces a clean clone without
 * unlinking, touching or contacting the production project, and without weakening the test.
 *
 * The copy is made from `git ls-files --cached --others --exclude-standard`, so git-ignored files (supabase/.temp, .env*,
 * migration-output, node_modules, .next) are never copied. node_modules is shared through a junction/symlink.
 * Usage: node scripts/test-unlinked.mjs [vitest args...]      (default: run)
 */
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const git = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 })
if (git.status !== 0) {
  console.error("git ls-files failed; is this a git checkout?")
  process.exit(2)
}
const files = git.stdout.toString("utf8").split("\0").filter(Boolean)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "attendance-unlinked-"))
let code = 1
try {
  for (const f of files) {
    const src = path.join(ROOT, f)
    if (!fs.existsSync(src) || fs.statSync(src).isDirectory()) continue // tracked-but-deleted files
    fs.mkdirSync(path.dirname(path.join(tmp, f)), { recursive: true })
    fs.copyFileSync(src, path.join(tmp, f))
  }
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  if (fs.existsSync(path.join(tmp, "supabase", ".temp")) || fs.readdirSync(tmp).some((n) => n.startsWith(".env"))) throw new Error("the copy is not clean")
  const vitest = path.join(ROOT, "node_modules", "vitest", "vitest.mjs")
  const args = process.argv.slice(2)
  console.log(`[test-unlinked] ${files.length} files copied to a clean tree (no supabase/.temp, no .env*); running vitest ${args.length ? args.join(" ") : "run"}`)
  code = spawnSync(process.execPath, [vitest, ...(args.length ? args : ["run"])], { cwd: tmp, stdio: "inherit" }).status ?? 1
} finally {
  // remove the junction first so the shared node_modules is never traversed
  try { fs.unlinkSync(path.join(tmp, "node_modules")) } catch {}
  fs.rmSync(tmp, { recursive: true, force: true })
}
process.exit(code)
