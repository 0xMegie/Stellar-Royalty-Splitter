import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    // Playwright specs live under e2e/ and run via `npm run test:e2e` — keep
    // unit/component tests scoped to src/ so the two runners never collide.
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "json-summary", "lcov"],
      reportsDirectory: "./coverage",
      // Excluded because they're generated, config-only, or type-only files
      // that don't reflect meaningful test coverage — matches the #720
      // constraint that coverage shouldn't penalize low-value files.
      exclude: [
        "node_modules/**",
        "dist/**",
        "e2e/**",
        "src/test/**",
        "src/main.tsx",
        "**/*.d.ts",
        "**/*.config.{ts,js}",
        "**/*.{test,spec}.{ts,tsx}",
      ],
    },
  },
});
