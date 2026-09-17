import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  reporter: [
    ["list"],
    ["json", { outputFile: ".cache/e2e-report.json" }],
    ["html", { outputFolder: "playwright-report", open: "never" }],
  ],
  use: {
    baseURL: "http://localhost:14811",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions:
      process.platform === "win32" && !process.env.CI
        ? { channel: "msedge" }
        : {},
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node --import tsx tests/e2e/fixture-server.ts",
    url: "http://localhost:14811/api/health",
    reuseExistingServer: false,
    timeout: 180000,
  },
});
