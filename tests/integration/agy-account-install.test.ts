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

describe("account installation migration", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "devflow-account-install-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));
  it("adds disabled account defaults with an absolute helper without replacing user configuration", () => {
    const file = join(root, "devflow.yaml");
    const original =
      "# keep my host and models\nhost:\n  executable: custom-host.exe\nmodels:\n  executor: chosen-model\nscheduler:\n  executors: 7\n";
    writeFileSync(file, original);
    const helper = join(
      root,
      "versions",
      "next",
      "dist",
      "host",
      "devflow-auth-host.exe",
    );
    const result = migrateAccountConfiguration(file, helper);
    expect(result.changed).toBe(true);
    expect(readFileSync(result.backup!, "utf8")).toBe(original);
    const text = readFileSync(file, "utf8"),
      config = parse(text);
    expect(text).toContain("# keep my host and models");
    expect(config.host.executable).toBe("custom-host.exe");
    expect(config.models.executor).toBe("chosen-model");
    expect(config.scheduler.executors).toBe(7);
    expect(config.agy_accounts).toMatchObject({
      enabled: false,
      auth_host_executable: helper,
    });
    expect(migrateAccountConfiguration(file, helper).changed).toBe(false);
  });
  it("moves only a previous managed helper path and preserves custom helper and explicit enabled state", () => {
    const file = join(root, "devflow.yaml"),
      old = join(
        root,
        "versions",
        "old",
        "dist",
        "host",
        "devflow-auth-host.exe",
      ),
      next = join(
        root,
        "versions",
        "next",
        "dist",
        "host",
        "devflow-auth-host.exe",
      );
    writeFileSync(
      file,
      JSON.stringify({
        agy_accounts: {
          enabled: true,
          auth_host_executable: old,
          standalone_model_id: "chosen",
        },
      }),
    );
    migrateAccountConfiguration(file, next, old);
    expect(parse(readFileSync(file, "utf8")).agy_accounts).toMatchObject({
      enabled: true,
      auth_host_executable: next,
      standalone_model_id: "chosen",
    });
    writeFileSync(
      file,
      JSON.stringify({
        agy_accounts: {
          enabled: false,
          auth_host_executable: "my-private-host.exe",
        },
      }),
    );
    expect(migrateAccountConfiguration(file, next, old).changed).toBe(false);
    expect(
      parse(readFileSync(file, "utf8")).agy_accounts.auth_host_executable,
    ).toBe("my-private-host.exe");
  });
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
