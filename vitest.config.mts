import { defineConfig } from "vitest/config"
import path from "node:path"

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: { include: ["tests/**/*.test.ts"], exclude: ["tests/rules/**", "tests/local-supabase/**", "tests/shadow-integration/**", "node_modules/**"], environment: "node" },
})
