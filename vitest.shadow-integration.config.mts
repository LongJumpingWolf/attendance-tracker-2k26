import { defineConfig } from "vitest/config"
import path from "node:path"

/**
 * The read-only shadow reader against the Firestore emulator AND the local Supabase stack. LOCAL ONLY.
 * Run with: npm run test:shadow-integration   (needs Java, the firebase CLI, and `npx supabase start`)
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: { include: ["tests/shadow-integration/**/*.test.ts"], environment: "node", fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 },
})
