import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  copyFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parseDocument } from "yaml";
import { installSkills } from "./install-skills.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (r.error || r.status !== 0)
    throw r.error ?? new Error(`安装步骤失败：${command}`);
}
// Build only. Setup never launches models, tests or probe scenarios.
mkdirSync(join(root, ".cache"), { recursive: true });
run(process.execPath, [
  "node_modules/typescript/bin/tsc",
  "-p",
  "tsconfig.build.json",
]);
run(process.execPath, [
  "node_modules/vite/bin/vite.js",
  "build",
  "--config",
  "apps/web/vite.config.ts",
]);
run(process.execPath, ["scripts/build-host.mjs"]);
const configPath = join(root, "devflow.yaml");
const configDocument = parseDocument(
  existsSync(configPath) ? readFileSync(configPath, "utf8") : "{}",
);
if (configDocument.errors.length) throw configDocument.errors[0];
if (existsSync(configPath))
  copyFileSync(configPath, join(root, ".cache", `devflow-${stamp}.yaml`));
if (!configDocument.getIn(["host", "executable"])) {
  configDocument.setIn(
    ["host", "executable"],
    join(
      root,
      "dist/host",
      process.platform === "win32" ? "devflow-host.exe" : "devflow-host",
    ),
  );
  configDocument.setIn(["host", "required"], true);
}
if (configDocument.getIn(["agy_accounts", "enabled"]) === undefined)
  configDocument.setIn(["agy_accounts", "enabled"], false);
if (!configDocument.getIn(["agy_accounts", "auth_host_executable"]))
  configDocument.setIn(
    ["agy_accounts", "auth_host_executable"],
    join(root, "dist/host/devflow-auth-host.exe"),
  );
if (!configDocument.get("opentabs")) {
  const existing = join(homedir(), ".opentabs/extension/auth.json");
  configDocument.set("opentabs", {
    secret_file: existsSync(existing) ? existing : "",
  });
}
writeFileSync(configPath, configDocument.toString());
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const skills = join(codexHome, "skills");
const backups = join(codexHome, "devflow-backups", stamp);
mkdirSync(backups, { recursive: true });
mkdirSync(skills, { recursive: true });
installSkills(join(root, "packages/skills"), skills, backups);
const settingsPath = join(codexHome, "config.toml");
let settings = existsSync(settingsPath)
  ? readFileSync(settingsPath, "utf8")
  : "";
if (existsSync(settingsPath))
  copyFileSync(settingsPath, join(backups, "config.toml"));
// Replace only this named server, preserving all unrelated settings.
settings = settings
  .replace(
    /^\[mcp_servers\.devflow(?:\.[^\]\r\n]+)?\][\s\S]*?(?=^\[|$(?![\s\S]))/gm,
    "",
  )
  .trimEnd();
settings += `\n\n[mcp_servers.devflow]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, "dist/packages/bridge/src/planner.js"))}]\ncwd = ${JSON.stringify(root)}\nstartup_timeout_sec = 60\ntool_timeout_sec = 180\n`;
writeFileSync(settingsPath, settings);
console.log(
  "账号模块默认关闭；构建成功不代表认证宿主、进程宿主或官方双额度已验证。Go Host 未具备 doctor/job-status/suspended_spawn 时不能切号。",
);
console.log(
  "安装完成。当前 Windows 用户运行；未创建账户、未修改 ACL、未注册开机任务。",
);
console.log(
  "重启 Codex 一次以加载新的入口；以后在业务项目说：用 DevFlow 帮我……",
);
console.log("需要控制台时双击“打开 DevFlow.vbs”。原项目、计划和日志继续保留。");
