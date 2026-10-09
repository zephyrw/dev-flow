import { describe, expect, it } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { writeStableEntry } from "../../packages/installer/src/launchers.js";
import { writeAccountsLauncher } from "../../packages/installer/src/upgrade.js";
import { hash } from "../../packages/core/src/util.js";
describe.skipIf(process.platform !== "darwin")(
  "macOS application launchers",
  () => {
    it("launches the stable workbench and account commands and preserves a modified app", () => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), "mac-app-"));
      const home = join(root, "home");
      mkdirSync(home);
      try {
        const first = writeStableEntry(root, { homeDir: home });
        expect(first.menuPaths).toHaveLength(2);
        const executable = join(
          home,
          "Applications/DevFlow.app/Contents/MacOS/DevFlow",
        );
        execFileSync("/usr/bin/plutil", [
          "-lint",
          join(home, "Applications/DevFlow.app/Contents/Info.plist"),
        ]);
        expect(readFileSync(executable, "utf8")).toContain("bootstrap");
        writeFileSync(
          join(root, "entry-receipt.json"),
          JSON.stringify({
            installed_entries: first.menuPaths.map((path) => ({
              path,
              hash: hash(readFileSync(path)),
            })),
          }),
        );
        const accounts = writeAccountsLauncher(root, "darwin")!;
        execFileSync("/usr/bin/plutil", [
          "-lint",
          accounts.find((path) => path.endsWith("Info.plist"))!,
        ]);
        const captured = join(root, "account-args");
        const original = readFileSync(join(root, "bin/devflow"));
        writeFileSync(
          join(root, "bin/devflow"),
          '#!/bin/sh\nprintf "%s" "$1" > ' + "'" + captured + "'" + "\n",
        );
        chmodSync(join(root, "bin/devflow"), 0o755);
        execFileSync(
          accounts.find((path) => path.endsWith("DevFlowAccounts"))!,
        );
        expect(readFileSync(captured, "utf8")).toBe("accounts");
        writeFileSync(join(root, "bin/devflow"), original);
        const accountExecutable = accounts.find((path) =>
          path.endsWith("DevFlowAccounts"),
        )!;
        writeFileSync(accountExecutable, "user edited account app");
        expect(() => writeAccountsLauncher(root, "darwin")).toThrow(
          "ACCOUNT_LAUNCHER_CONFLICT",
        );
        expect(readFileSync(accountExecutable, "utf8")).toBe(
          "user edited account app",
        );
        writeFileSync(executable, "user edited app");
        expect(writeStableEntry(root, { homeDir: home }).conflicts).toContain(
          executable,
        );
        expect(readFileSync(executable, "utf8")).toBe("user edited app");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
    it("does not replace an unrelated existing DevFlow application", () => {
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), "mac-app-conflict-"),
      );
      const home = join(root, "home");
      const bundle = join(home, "Applications/DevFlow.app");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "user.txt"), "keep");
      try {
        expect(writeStableEntry(root, { homeDir: home }).conflicts).toContain(
          bundle,
        );
        expect(existsSync(join(bundle, "Contents"))).toBe(false);
        expect(readFileSync(join(bundle, "user.txt"), "utf8")).toBe("keep");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
