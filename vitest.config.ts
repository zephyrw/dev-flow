import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.{ts,tsx}",
      "tests/integration/**/*.test.{ts,tsx}",
    ],
    coverage: {
      provider: "v8",
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
