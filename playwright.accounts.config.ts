import { defineConfig } from "@playwright/test";
import { ensureTestInstanceDirs, loadTestInstanceConfig, playwrightWebServerEnv } from "./tests/helpers/test-isolation.js";
const instance = loadTestInstanceConfig({
  ...process.env,
  DEVFLOW_TEST_PORT: process.env.DEVFLOW_TEST_PORT ?? process.env.DEVFLOW_ACCOUNTS_E2E_PORT ?? "14839",
  DEVFLOW_TEST_RUN_DIR: process.env.DEVFLOW_TEST_RUN_DIR ?? process.env.DEVFLOW_ACCOUNTS_E2E_OUTPUT ?? ".cache/agy-accounts-e2e",
});
ensureTestInstanceDirs(instance);
const baseURL = instance.humanOrigin;
export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "agy-accounts-browser.spec.ts",
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 45000,
  outputDir: instance.outputDir,
  reporter: [["list"], ["json", { outputFile: instance.reportJson }]],
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
    env: playwrightWebServerEnv(instance),
  },
});
