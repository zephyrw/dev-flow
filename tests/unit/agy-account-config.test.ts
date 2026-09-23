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
  it("normalizes built-in v1 settings without retaining an executable override", () => {
    const root = mkdtempSync(join(tmpdir(), "devflow-account-config-"));
    try {
      const file = join(root, "devflow.yaml");
      writeFileSync(
        file,
        "schema_version: 1\nagy_accounts:\n  auth_host_executable: dist/host/devflow-auth-host.exe\n  standalone_model_id: fixture-model\n  workflow_auto_switch: false\n",
      );
      const config = loadConfig(file);
      expect(config.agy_accounts).not.toHaveProperty("auth_host_executable");
      expect(config.schema_version).toBe(2);
      expect(config.storage_root).toBe(join(root, ".devflow"));
      expect(config.agy_accounts.standalone_model_id).toBe("fixture-model");
      expect(config.agy_accounts.workflow_auto_switch).toBe(false);
      writeFileSync(
        file,
        "schema_version: 1\nagy_accounts:\n  auth_host_executable: helpers/auth.exe\n",
      );
      expect(() => loadConfig(file)).toThrow("LEGACY_CUSTOM_HOST_UNSUPPORTED");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
