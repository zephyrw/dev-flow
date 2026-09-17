import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: "forks",
    maxWorkers: 2,
  },
});
