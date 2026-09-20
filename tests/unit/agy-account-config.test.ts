import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  ConfigSchema,
} from "../../packages/contracts/src/config.js";
describe("account configuration", () => {
  it("defaults to disabled and preserves existing scheduler and model choices", () => {
    const config = ConfigSchema.parse({
      models: { executor: "user-model" },
      scheduler: { executors: 3 },
    });
    expect(config.agy_accounts.enabled).toBe(false);
    expect(config.models.executor).toBe("user-model");
    expect(config.scheduler.executors).toBe(3);
  });
  it("resolves the helper relative to YAML and accepts standalone account settings", () => {
    const root = mkdtempSync(join(tmpdir(), "devflow-account-config-"));
    try {
      const file = join(root, "devflow.yaml");
      writeFileSync(
        file,
        "agy_accounts:\n  auth_host_executable: helpers/auth.exe\n  standalone_model_id: fixture-model\n  workflow_auto_switch: false\n",
      );
      const config = loadConfig(file);
      expect(config.agy_accounts.auth_host_executable).toBe(
        join(root, "helpers", "auth.exe"),
      );
      expect(config.agy_accounts.standalone_model_id).toBe("fixture-model");
      expect(config.agy_accounts.workflow_auto_switch).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
