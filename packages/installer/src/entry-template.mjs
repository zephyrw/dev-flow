/**
 * DevFlow bootstrap entry (stable launcher core).
 *
 * Runs on the installation's bootstrap Node only. No third-party imports.
 * Parses and validates current.json under the trusted install root, then
 * dispatches to the current version's user CLI. Never loads business
 * database, native modules, or model configuration here.
 */
import { readFileSync, existsSync, statSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

const installRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(code, message) {
  console.error("[DevFlow 入口] " + message);
  process.exit(code);
}

function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(".." + sep) && rel !== ".." && !isAbsolute(rel));
}

function resolveTrusted(label, raw, allowedRoots) {
  if (typeof raw !== "string" || !raw.trim()) {
    fail(30, "current.json 字段 " + label + " 无效：不是受信任的安装位置路径");
  }
  if (raw.includes("\0")) {
    fail(30, "current.json 字段 " + label + " 无效：路径包含非法字符");
  }
  const absolute = resolve(raw);
  for (const root of allowedRoots) {
    if (isInside(root, absolute)) return absolute;
  }
  fail(
    30,
    "current.json 字段 " + label + " 超出安装根目录，拒绝执行不可信路径：" + raw,
  );
}

function readCurrentPointer() {
  const pointerPath = join(installRoot, "current.json");
  if (!existsSync(pointerPath)) {
    fail(30, "缺少 current.json，安装未完成或已被删除。请重新安装 DevFlow。");
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(pointerPath, "utf8"));
  } catch {
    fail(30, "current.json 已损坏，无法解析。请重新安装或从 backup/ 恢复指针。");
  }
  if (!parsed || typeof parsed !== "object") {
    fail(30, "current.json 内容无效。");
  }
  return parsed;
}

function main() {
  let realRoot = installRoot;
  try {
    realRoot = realpathSync(installRoot);
  } catch {
    /* keep lexical root */
  }
  const versionsRoot = join(realRoot, "versions");
  const bootstrapRoot = join(realRoot, "bootstrap");
  const pointer = readCurrentPointer();

  const versionRoot = resolveTrusted("root", pointer.root, [versionsRoot]);
  const nodePath = resolveTrusted("node", pointer.node, [
    join(bootstrapRoot, "runtime"),
    join(versionRoot, "runtime"),
  ]);
  const configPath = resolveTrusted("config", pointer.config, [realRoot]);

  if (!existsSync(nodePath)) {
    fail(50, "引导运行时缺失（" + nodePath + "）。安装包不完整，请重新安装。");
  }
  if (!existsSync(configPath)) {
    fail(30, "配置文件不存在：" + configPath);
  }
  // Fixed relative entry: never follow an arbitrary program from current.json.
  const cliEntry = join(versionRoot, "dist", "packages", "cli", "src", "main.js");
  if (!existsSync(cliEntry)) {
    fail(
      50,
      "当前版本缺少用户 CLI（" + cliEntry + "）。请重新安装 DevFlow，不要手动改写 current.json。",
    );
  }

  const forwarded = process.argv.slice(2);
  const child = spawn(nodePath, [cliEntry, ...forwarded], {
    stdio: "inherit",
    cwd: versionRoot,
    env: {
      ...process.env,
      DEVFLOW_CONFIG: configPath,
      DEVFLOW_INSTALL_ROOT: realRoot,
      DEVFLOW_VERSION_ROOT: versionRoot,
    },
    windowsHide: false,
  });
  child.on("error", (error) => {
    fail(50, "无法启动当前版本：" + String(error));
  });
  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

try {
  main();
} catch (error) {
  fail(1, error && error.message ? error.message : String(error));
}
