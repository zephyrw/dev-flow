import { defineConfig } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  testDir: resolve(__dirname, "../../tests/e2e"),
  testMatch: "run-deadline.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45000,
  reporter: [
    ["list"],
    ["json", { outputFile: process.env.DEVFLOW_REPORT_PATH || resolve(process.cwd(), ".reports/e2e.json") }],
  ],
  use: {
    baseURL: process.env.DEVFLOW_BASE_URL || "http://127.0.0.1:14811",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: {
      executablePath:
        process.env.EDGE_PATH ||
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
