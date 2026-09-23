import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse } from "yaml";
import {
  migrateAccountConfiguration,
  writeAccountsLauncher,
} from "../../packages/installer/src/upgrade.js";
import { loadConfig } from "../../packages/contracts/src/config.js";

describe("account installation migration", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devflow-account-install-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it("removes built-in helpers, preserves comments and model choices, and is idempotent", () => {
    const file = join(root, "devflow.yaml");
    const original =
      "# keep my model choices\nschema_version: 1\nhost:\n  executable: dist/host/devflow-host.exe\nmodels:\n  executor: chosen-model\nscheduler:\n  executors: 7\n";
    writeFileSync(file, original);
    const result = migrateAccountConfiguration(file);
    expect(result.changed).toBe(true);
    expect(readFileSync(result.backup!, "utf8")).toBe(original);
    const text = readFileSync(file, "utf8"),
      config = parse(text);
    expect(text).toContain("# keep my model choices");
    expect(config).not.toHaveProperty("host");
    expect(config.schema_version).toBe(2);
    expect(config.models.executor).toBe("chosen-model");
    expect(config.scheduler.executors).toBe(7);
    expect(loadConfig(file).agy_accounts.enabled).toBe(false);
    expect(migrateAccountConfiguration(file).changed).toBe(false);
  });
  it("removes an absolute managed helper but retains explicit enabled state and model", () => {
    const file = join(root, "devflow.yaml");
    writeFileSync(
      file,
      JSON.stringify({
        schema_version: 1,
        agy_accounts: {
          enabled: true,
          auth_host_executable: join(
            root,
            "versions",
            "old",
            "dist",
            "host",
            "devflow-auth-host.exe",
          ),
          standalone_model_id: "chosen",
        },
      }),
    );
    migrateAccountConfiguration(file);
    const config = parse(readFileSync(file, "utf8"));
    expect(config.agy_accounts).toEqual({
      enabled: true,
      standalone_model_id: "chosen",
    });
  });
  it.each([
    { host: { executable: "custom-host.exe" } },
    {
      agy_accounts: {
        enabled: false,
        auth_host_executable: "my-private-host.exe",
      },
    },
  ])(
    "rejects custom helpers without changing the original configuration",
    (settings) => {
      const file = join(root, "devflow.yaml");
      const original = JSON.stringify({ schema_version: 1, ...settings });
      writeFileSync(file, original);
      expect(() => migrateAccountConfiguration(file)).toThrow(
        "LEGACY_CUSTOM_HOST_UNSUPPORTED",
      );
      expect(readFileSync(file, "utf8")).toBe(original);
    },
  );
  it("installs a stable account shortcut that resolves the selected version at click time", () => {
    writeAccountsLauncher(root, "win32");
    const script = readFileSync(join(root, "open-accounts.ps1"), "utf8");
    expect(script).toContain("current.json");
    expect(script).toContain("$devflowCurrent.root");
    expect(script).toContain("$devflowCurrent.node");
    expect(script).toContain("--accounts");
    expect(script).not.toContain("versions/0.2.0");
    expect(readFileSync(join(root, "打开 AGY 账号管理.vbs"), "utf8")).toContain(
      "-WindowStyle Hidden",
    );
    const unsupported = join(root, "other");
    writeAccountsLauncher(unsupported, "linux");
    expect(existsSync(unsupported)).toBe(false);
  });
});
