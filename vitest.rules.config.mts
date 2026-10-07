import { defineConfig } from "vitest/config"
import path from "node:path"

/**
 * Tests that need the Firebase emulators (Firestore security rules, and the Ping server operations run against them).
 * Run with: npm run test:rules   (needs Java on the PATH for the emulator)
 */
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["tests/rules/**/*.test.ts"],
    environment: "node",
    fileParallelism: false, // one emulator, shared by every file
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
})
