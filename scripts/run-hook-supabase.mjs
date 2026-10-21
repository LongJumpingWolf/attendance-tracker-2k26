/**
 * Runs scripts/e2e-hook-supabase.mjs: the real app + real useCloudSync hook against the Firebase Auth EMULATOR and the LOCAL Supabase stack.
 *
 *   node scripts/run-hook-supabase.mjs
 *
 * Needs (all local, none installed or reconfigured by this script): Docker with the local Supabase stack already running
 * (`npx supabase start`), Java and the firebase CLI (for the emulators, as the rules tests use), and Chrome + puppeteer-core (as the other
 * browser suites). It reads the local stack's development keys from `supabase status`, refuses anything that is not loopback, starts the
 * Auth and Firestore emulators for a demo project, runs the suite, and stops what it started. Nothing is deployed or written to any
 * hosted service; the only database rows touched are those of accounts the run itself creates (removed at the end).
 */
import { spawn, execFileSync } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const raw = execFileSync("npx", ["supabase", "status", "-o", "json"], { shell: true, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: ROOT })
const status = JSON.parse(raw.slice(raw.indexOf("{")))
const host = new URL(status.API_URL).hostname
if (!["127.0.0.1", "localhost"].includes(host)) {
  console.error("refusing to run: the Supabase API URL is not loopback")
  process.exit(2)
}
if (!status.PUBLISHABLE_KEY || !status.JWT_SECRET) {
  console.error("the local Supabase stack is not running (npx supabase start)")
  process.exit(2)
}

const child = spawn('npx firebase emulators:exec --only auth,firestore --project demo-hook "node scripts/e2e-hook-supabase.mjs"', {
  cwd: ROOT,
  shell: true,
  stdio: "inherit",
  env: {
    ...process.env,
    LOCAL_SUPABASE_API_URL: status.API_URL,
    LOCAL_SUPABASE_JWT_SECRET: status.JWT_SECRET,
    LOCAL_SUPABASE_PUBLISHABLE_KEY: status.PUBLISHABLE_KEY,
    FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099",
    FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080",
  },
})
child.on("exit", (code) => process.exit(code ?? 1))
