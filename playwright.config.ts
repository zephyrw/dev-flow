import { defineConfig } from "@playwright/test";
import {
  ensureTestInstanceDirs,
  loadTestInstanceConfig,
  playwrightWebServerEnv,
} from "./tests/helpers/test-isolation.js";

const instance = loadTestInstanceConfig();
ensureTestInstanceDirs(instance);

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "*.spec.ts",
  outputDir: instance.outputDir,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  reporter: [
    ["list"],
    ["json", { outputFile: instance.reportJson }],
    ["html", { outputFolder: instance.htmlReport, open: "never" }],
  ],
  use: {
    baseURL: instance.humanOrigin,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      downloadsPath: instance.downloadsDir,
      ...(process.platform === "win32" && !process.env.CI
        ? { channel: "msedge" }
        : {}),
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node --import tsx tests/e2e/fixture-server.ts",
    url: `${instance.humanOrigin}/api/health`,
    reuseExistingServer: process.env.DEVFLOW_REUSE_SERVER === "1",
    timeout: 300000,
    env: playwrightWebServerEnv(instance),
  },
});
