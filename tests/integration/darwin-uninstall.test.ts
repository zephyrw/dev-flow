import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import { hash } from "../../packages/core/src/util.js";
import { writeStableEntry } from "../../packages/installer/src/launchers.js";
import { writeAccountsLauncher } from "../../packages/installer/src/upgrade.js";

describe.skipIf(process.platform !== "darwin")(
  "macOS application uninstall ownership",
  () => {
    it.each([false, true])(
      "removes owned app entries, retains task/vault data and preserves modified=%s",
      (modified) => {
        const root = mkdtempSync(
          join(realpathSync(tmpdir()), "mac-uninstall-"),
        );
        const home = join(root, "home");
        mkdirSync(home);
        const stable = writeStableEntry(root, { homeDir: home });
        const accounts = writeAccountsLauncher(root, "darwin")!;
        const paths = [...stable.binPaths, ...stable.menuPaths, ...accounts];
        writeFileSync(
          join(root, "entry-receipt.json"),
          JSON.stringify({
            install_root: root,
            installed_entries: paths.map((path) =>
              lstatSync(path).isSymbolicLink()
                ? { path, kind: "symlink", target: readlinkSync(path) }
                : { path, kind: "file", hash: hash(readFileSync(path)) },
            ),
          }),
        );
        const config = join(root, "devflow.yaml");
        const state = join(root, "state");
        mkdirSync(state, { recursive: true });
        writeFileSync(
          config,
          stringify(
            ConfigSchema.parse({
              schema_version: 2,
              storage_root: state,
              workspace_root: join(root, "workspace"),
            }),
          ),
        );
        const database = join(state, "devflow.sqlite");
        writeFileSync(database, "preserved database fixture");
        const vault = join(
          home,
          "Library/Application Support/DevFlow/agy-accounts",
        );
        mkdirSync(vault, { recursive: true });
        writeFileSync(
          join(vault, "fixture.bin"),
          "preserved encrypted fixture",
        );
        const accountExecutable = accounts.find((path) =>
          path.endsWith("DevFlowAccounts"),
        )!;
        const app = join(home, "Applications/DevFlow.app");
        const user = join(app, "user.txt");
        writeFileSync(user, "preserved custom app file");
        if (modified)
          writeFileSync(accountExecutable, "user-modified launcher");
        try {
          const result = spawnSync(
            process.execPath,
            [resolve("dist/packages/cli/src/main.js"), "uninstall"],
            {
              env: {
                ...process.env,
                HOME: home,
                DEVFLOW_CONFIG: config,
                DEVFLOW_INSTALL_ROOT: root,
              },
              encoding: "utf8",
              timeout: 15000,
            },
          );
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(modified ? 30 : 0);
          expect(existsSync(accountExecutable)).toBe(modified);
          expect(readFileSync(database, "utf8")).toBe(
            "preserved database fixture",
          );
          expect(readFileSync(join(vault, "fixture.bin"), "utf8")).toBe(
            "preserved encrypted fixture",
          );
          expect(readFileSync(user, "utf8")).toBe("preserved custom app file");
          expect(existsSync(join(app, "Contents/Info.plist"))).toBe(false);
          if (modified)
            expect(readFileSync(accountExecutable, "utf8")).toBe(
              "user-modified launcher",
            );
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  },
);
