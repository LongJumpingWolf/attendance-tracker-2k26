/* eslint-disable @typescript-eslint/ban-ts-comment -- Deno-only glue: npm: specifiers and the Deno global cannot be typechecked by the Next.js tsconfig */
// @ts-nocheck  Deno-only glue (npm: specifiers and the Deno global). The logic lives in handler.ts and is tested under Node.
//
// PROPOSED, NOT DEPLOYED. Lives in supabase/proposed/ on purpose so `supabase functions deploy` cannot pick it up by accident.
// At an approved deployment it is copied to supabase/functions/auth-role-bootstrap/ (see PHASE6D_PRODUCTION_BRIDGE_READINESS.md).
//
// Secrets / configuration (set by the owner in the Supabase dashboard or `supabase secrets set`, never in git or chat):
//   FIREBASE_SERVICE_ACCOUNT_JSON   the Firebase service-account key (JSON). Read here and nowhere else.
//   FIREBASE_PROJECT_ID             the production Firebase project id; must equal the key's project_id
//   ALLOWED_ORIGINS                 comma separated exact https origins of the deployed web app (owner-supplied)
//
// verify_jwt = false is required (the bearer token is signed by Firebase, not Supabase), so this function verifies the
// Firebase token itself in handler.ts. config.toml entry for the deployment:  [functions.auth-role-bootstrap] verify_jwt = false
import { initializeApp, cert, getApps } from "npm:firebase-admin@13/app"
import { getAuth } from "npm:firebase-admin@13/auth"
import { createHandler, createRateLimiter, parseConfig } from "./handler.ts"

const configResult = parseConfig({
  ALLOWED_ORIGINS: Deno.env.get("ALLOWED_ORIGINS") ?? "",
  FIREBASE_PROJECT_ID: Deno.env.get("FIREBASE_PROJECT_ID") ?? "",
})

function admin() {
  if (!getApps().length) {
    const raw = Deno.env.get("FIREBASE_SERVICE_ACCOUNT_JSON")
    if (!raw) throw Object.assign(new Error("x"), { code: "secret-missing" })
    const sa = JSON.parse(raw)
    if (!configResult.ok || sa.project_id !== configResult.config.projectId) throw Object.assign(new Error("x"), { code: "secret-wrong-project" })
    initializeApp({ credential: cert(sa), projectId: sa.project_id })
  }
  return getAuth()
}

const handle = createHandler(configResult, {
  ipLimiter: createRateLimiter({ windowMs: 60_000, max: 30 }),
  uidLimiter: createRateLimiter({ windowMs: 60_000, max: 6 }),
  log: (code) => console.error("auth-role-bootstrap", code), // a fixed code only; never a token, uid, key or message
  async verifyIdToken(token) {
    const d = await admin().verifyIdToken(token) // Google signature, exp, iss, aud
    return { uid: d.uid, sub: d.sub, iss: d.iss, aud: d.aud, iat: d.iat, role: d.role }
  },
  async getUser(uid) {
    const u = await admin().getUser(uid)
    return { disabled: u.disabled, tokensValidAfterTime: u.tokensValidAfterTime, customClaims: u.customClaims ?? null }
  },
  async setCustomClaims(uid, claims) {
    await admin().setCustomUserClaims(uid, claims)
  },
})

Deno.serve(handle)
