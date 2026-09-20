import { defineConfig } from "@playwright/test";
const port = Number(process.env.DEVFLOW_ACCOUNTS_E2E_PORT ?? 14839);
const output =
  process.env.DEVFLOW_ACCOUNTS_E2E_OUTPUT ?? `.cache/agy-accounts-e2e-${port}`;
const baseURL = `http://127.0.0.1:${port}`;
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "agy-accounts-browser.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45000,
  outputDir: `${output}/results`,
  reporter: [["list"], ["json", { outputFile: `${output}/report.json` }]],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions:
      process.platform === "win32" && !process.env.CI
        ? { channel: "msedge" }
        : {},
  },
  webServer: {
    command: "node --import tsx tests/e2e/agy-accounts-fixture-server.ts",
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60000,
  },
});
