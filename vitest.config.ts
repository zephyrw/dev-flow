import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    disableConsoleIntercept: true,
    include: [
      "tests/unit/**/*.test.{ts,tsx}",
      "tests/integration/**/*.test.{ts,tsx}",
    ],
    coverage: {
      provider: "v8",
      processingConcurrency: 1,
      include: ["apps/**/*.{ts,tsx}", "packages/**/*.{ts,tsx}"],
      exclude: ["**/*.d.ts", "**/*.test.{ts,tsx}", "**/generated/**"],
      reporter: ["text", "json", "html"],
    },
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: "forks",
    maxWorkers: 2,
  },
});
