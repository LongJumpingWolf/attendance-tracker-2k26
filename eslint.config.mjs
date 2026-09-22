import nextVitals from "eslint-config-next/core-web-vitals"
import nextTs from "eslint-config-next/typescript"

const config = [
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // The app loads saved data in effects and keeps some values in refs. These React-compiler rules flag
      // that as a style concern, not a bug, so they warn rather than fail the lint.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      // Older server helpers use loose types
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    ignores: [".next/**", "node_modules/**", "public/**", "functions/**", "scripts/**", "next-env.d.ts"],
  },
]

export default config
