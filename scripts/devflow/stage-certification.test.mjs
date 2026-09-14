import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "../..");

test("DF-STAGE-C01 typecheck and whitespace pass", () => {
  const isWin = process.platform === "win32";
  const npmCmd = isWin ? "npm.cmd" : "npm";
  const gitCmd = isWin ? "git.exe" : "git";

  const typecheck = spawnSync(npmCmd, ["run", "typecheck"], {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
  });
  assert.equal(typecheck.status, 0, "npm run typecheck must exit with 0");

  const diffCheck = spawnSync(gitCmd, ["diff", "--check"], {
    cwd: root,
    stdio: "inherit",
    shell: isWin,
  });
  assert.equal(diffCheck.status, 0, "git diff --check must exit with 0");
});
