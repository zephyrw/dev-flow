import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { parse, stringify } from "yaml";
import { installSkills } from "./install-skills.mjs";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
function run(command, args) {
  const r = spawnSync(command, args, { cwd: root, stdio: "inherit", windowsHide: true });
  if (r.error || r.status !== 0) throw r.error ?? new Error(`安装步骤失败：${command}`);
}
// Build only. Setup never launches models, tests or probe scenarios.
mkdirSync(join(root, ".cache"), { recursive: true });
run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"]);
run(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--config", "apps/web/vite.config.ts"]);
run(process.execPath, ["scripts/build-host.mjs"]);
const configPath = join(root, "devflow.yaml");
const config = existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) : {};
config.host = { executable: join(root, "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe"), required: true };
if (existsSync(configPath)) copyFileSync(configPath, join(root, ".cache", `devflow-${stamp}.yaml`));
if (!config.opentabs) {
  const existing = join(homedir(), ".opentabs/extension/auth.json");
  config.opentabs = { secret_file: existsSync(existing) ? existing : "" };
}
writeFileSync(configPath, stringify(config));
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const skills = join(codexHome, "skills");
const backups = join(codexHome, "devflow-backups", stamp);
mkdirSync(backups, { recursive: true });
mkdirSync(skills, { recursive: true });
installSkills(join(root, "packages/skills"), skills, backups);
const settingsPath = join(codexHome, "config.toml");
let settings = existsSync(settingsPath) ? readFileSync(settingsPath, "utf8") : "";
if (existsSync(settingsPath)) copyFileSync(settingsPath, join(backups, "config.toml"));
// Replace only this named server, preserving all unrelated settings.
settings = settings.replace(/^\[mcp_servers\.devflow(?:\.[^\]\r\n]+)?\][\s\S]*?(?=^\[|$(?![\s\S]))/gm, "").trimEnd();
settings += `\n\n[mcp_servers.devflow]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(join(root, "dist/packages/bridge/src/planner.js"))}]\ncwd = ${JSON.stringify(root)}\nstartup_timeout_sec = 60\ntool_timeout_sec = 180\n`;
writeFileSync(settingsPath, settings);
const installer = await import(pathToFileURL(join(root, "dist/packages/installer/src/main.js")).href);
const parsed = installer.parseInstallerCliArgs(process.argv.slice(2));
let defaultsResult;
try {
  defaultsResult = installer.applyInstallerModelDefaultsFromConfigFile(
    configPath,
    parsed.roleInputs,
    parsed.targetTools,
  );
} catch (error) {
  if (error instanceof installer.InstallerDefaultsError) {
    console.error(error.message);
    process.exitCode = 30;
  } else {
    throw error;
  }
}
if (process.exitCode === 30) {
  console.error("模型默认参数不合法，未写入新的默认配置。");
} else {
  console.log("安装完成。当前 Windows 用户运行；未创建账户、未修改 ACL、未注册开机任务。");
  console.log("重启 Codex 一次以加载新的入口；以后在业务项目说：用 DevFlow 帮我……");
  console.log("需要控制台时双击“打开 DevFlow.vbs”。原项目、计划和日志继续保留。");
  if (defaultsResult?.pending) {
    console.log("模型设置待完成");
    process.exitCode = 10;
  }
}
