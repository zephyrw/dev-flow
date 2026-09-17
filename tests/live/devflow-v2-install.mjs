// Windows release acceptance: run after build-release.mjs; all writes use an isolated home.
import { runInstaller } from "../../dist/packages/installer/src/main.js";
import { verifyFileSha256 } from "../../dist/packages/installer/src/download.js";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
assert.equal(
  process.platform,
  "win32",
  "This smoke test validates Windows process ownership; macOS needs its own runner.",
);
const root = mkdtempSync(join(tmpdir(), "devflow-installed-smoke-")),
  home = join(root, "home"),
  install = join(root, "install"),
  source = join(root, "bundle/devflow");
mkdirSync(home, { recursive: true });
mkdirSync(join(root, "bundle"), { recursive: true });
const asset = resolve(
    "dist/release/devflow-v0.2.0-" +
      process.platform +
      "-" +
      process.arch +
      ".tar.gz",
  ),
  sha = readFileSync(asset + ".sha256", "utf8")
    .trim()
    .split(/\s+/)[0];
assert(verifyFileSha256(asset, sha).valid);
assert(!verifyFileSha256(asset, "0".repeat(64)).valid);
execFileSync("tar", ["-xzf", asset, "-C", join(root, "bundle")], {
  windowsHide: true,
});
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = join(home, ".codex");
const options = {
    sourceDir: source,
    installRoot: install,
    clientHome: home,
    targetTools: ["codex"],
    port: 14812,
  },
  record = join(install, "state/controller-process.json");
try {
  assert.equal(
    await runInstaller({
      ...options,
      sourceDir: join(root, "missing"),
      installRoot: join(root, "missing-install"),
    }),
    20,
  );
  const code = await runInstaller(options);
  assert([0, 10].includes(code), "Installer exit " + code);
  assert.equal(
    (await (await fetch("http://127.0.0.1:14812/api/health")).json()).service,
    "devflow",
  );
  assert(
    (await (await fetch("http://127.0.0.1:14812/")).text()).includes(
      'id="root"',
    ),
  );
  const before = JSON.parse(readFileSync(record, "utf8"));
  for (const name of [
    "devflow",
    "devflow-project-onboard",
    "devflow-plan",
    "devflow-execute",
    "devflow-test",
    "devflow-review",
  ])
    assert(existsSync(join(home, ".codex/skills", name, "SKILL.md")));
  assert(
    existsSync(
      join(
        home,
        ".codex/skills/devflow-review/references/repair-document-contract.md",
      ),
    ),
  );
  assert(
    readFileSync(join(home, ".codex/config.toml"), "utf8").includes(
      "[mcp_servers.devflow]",
    ),
  );
  assert.equal(await runInstaller(options), code);
  assert.equal(JSON.parse(readFileSync(record, "utf8")).pid, before.pid);
  const result = {
    root,
    code,
    missing_source_rejected: true,
    hash_mismatch_rejected: true,
    real_service_healthy: true,
    ui_served: true,
    six_skills_and_references: true,
    mcp_configured: true,
    retry_same_process: true,
  };
  writeFileSync(".cache/installer-smoke.json", JSON.stringify(result, null, 2));
  console.log("INSTALL_SMOKE_PASSED", JSON.stringify(result));
} finally {
  if (existsSync(record)) {
    const r = JSON.parse(readFileSync(record, "utf8"));
    if (
      resolve(r.entry) ===
      join(install, "versions/0.2.0/dist/apps/api/src/main.js")
    )
      try {
        process.kill(r.pid);
      } catch {}
  }
}
