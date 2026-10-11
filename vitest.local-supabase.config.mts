import { defineConfig } from "vitest/config"
import path from "node:path"

/**
 * Tests that need the LOCAL Supabase stack (npx supabase start): the real transport and adapter against real PostgREST.
 * Run with: npm run test:local-supabase    Excluded from `npm test`; they refuse any non-loopback URL.
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: { include: ["tests/local-supabase/**/*.test.ts"], environment: "node", fileParallelism: false, testTimeout: 30_000, hookTimeout: 60_000 },
})
