import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: [
      "tests/unit/**/*.test.{ts,tsx}",
      "tests/integration/**/*.test.{ts,tsx}",
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: "forks",
    maxWorkers: 2,
  },
});
