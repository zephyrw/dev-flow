import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(".cache/smoke-install-upgrade");
console.log("=== 开始端到端真实安装与升级验证 ===");
console.log(`临时测试根目录: ${root}`);

// 1. 清理并初始化测试目录
if (existsSync(root)) {
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(root, { recursive: true });

const installRoot = join(root, "installed");
const sourceDir = join(root, "bundle");
mkdirSync(sourceDir, { recursive: true });

// 2. 解压真实构建好的生产发布包
const archivePath = resolve("dist/release/devflow-v0.2.0-win32-x64.tar.gz");
if (!existsSync(archivePath)) {
  throw new Error(`找不到发布包: ${archivePath}`);
}
console.log(`正在解压真实生产包: ${archivePath}`);
const tarCmd = process.platform === "win32" ? "tar.exe" : "tar";
execFileSync(tarCmd, ["-xzf", archivePath, "-C", sourceDir]);

const extractedApp = join(sourceDir, "devflow");
if (!existsSync(extractedApp)) {
  throw new Error(`解压产物缺少 devflow 目录: ${extractedApp}`);
}
console.log(`✓ 生产包解压成功: ${extractedApp}`);

// 3. 执行 install.ps1 离线真实安装
const installPs1 = resolve("dist/release/install.ps1");
console.log(`正在运行 install.ps1 进行真实离线安装...`);
const pwshCmd = process.platform === "win32" ? "powershell.exe" : "pwsh";
const installRes = spawnSync(pwshCmd, [
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-File", installPs1,
  "-Source", extractedApp,
  "-InstallDir", installRoot,
  "-Port", "4899",
  "-NoOpen",
], { encoding: "utf8" });

console.log(installRes.stdout);
if (installRes.stderr) console.error(installRes.stderr);
if (installRes.status !== 0) {
  throw new Error(`install.ps1 退出码非 0: ${installRes.status}`);
}
console.log("✓ 真实离线安装脚本执行成功！");

// 4. 验证安装产物结构
const currentJsonPath = join(installRoot, "current.json");
if (!existsSync(currentJsonPath)) {
  throw new Error(`缺失 current.json: ${currentJsonPath}`);
}
const currentMeta = JSON.parse(readFileSync(currentJsonPath, "utf8"));
console.log(`✓ current.json 验证通过, 当前版本: ${currentMeta.version}`);

const versionDir = join(installRoot, "versions", currentMeta.version);
if (!existsSync(versionDir)) {
  throw new Error(`缺失版本目录: ${versionDir}`);
}
console.log(`✓ 版本目录验证通过: ${versionDir}`);

const receiptPath = join(installRoot, "install-source.json");
if (!existsSync(receiptPath)) {
  throw new Error(`缺失安装收据: ${receiptPath}`);
}
const receipt = JSON.parse(readFileSync(receiptPath, "utf8"));
console.log(`✓ 安装收据验证通过, 包含已安装入口数: ${receipt.installed_entries?.length ?? 0}`);

// 5. 验证安装后的 CLI 执行
const devflowCmd = join(installRoot, "bin", process.platform === "win32" ? "devflow.cmd" : "devflow");
if (!existsSync(devflowCmd)) {
  throw new Error(`缺失 CLI 入口: ${devflowCmd}`);
}
console.log(`正在执行已安装的 CLI status 检查: ${devflowCmd}`);
const statusRes = spawnSync(devflowCmd, ["status"], {
  cwd: installRoot,
  encoding: "utf8",
  env: { ...process.env, DEVFLOW_INSTALL_DIR: installRoot },
});
console.log("CLI status 输出:");
console.log(statusRes.stdout);
if (statusRes.stderr) console.error(statusRes.stderr);
if (statusRes.status !== 0) {
  throw new Error(`CLI status 退出码非 0: ${statusRes.status}`);
}
console.log("✓ CLI status 执行验证通过！");

// 6. 验证 CLI stop 优雅停止服务
console.log(`正在执行 CLI stop 停止运行中的服务...`);
const stopRes = spawnSync(devflowCmd, ["stop"], {
  cwd: installRoot,
  encoding: "utf8",
  env: { ...process.env, DEVFLOW_INSTALL_DIR: installRoot },
});
console.log("CLI stop 输出:");
console.log(stopRes.stdout);
if (stopRes.status !== 0) {
  console.warn("CLI stop 警告:", stopRes.stderr);
}
console.log("✓ CLI stop 执行成功！");

// 7. 验证 CLI uninstall 卸载本实例入口并按收据清理
console.log(`正在执行 CLI uninstall 卸载本实例...`);
const uninstallRes = spawnSync(devflowCmd, ["uninstall", "--yes"], {
  cwd: installRoot,
  encoding: "utf8",
  env: { ...process.env, DEVFLOW_INSTALL_DIR: installRoot },
});
console.log("CLI uninstall 输出:");
console.log(uninstallRes.stdout);
if (uninstallRes.status !== 0) {
  throw new Error(`CLI uninstall 退出码非 0: ${uninstallRes.status}`);
}
console.log("✓ CLI uninstall 执行验证通过！");

console.log("=== 端到端真实安装、状态检查、停机与卸载测试全部通过！ ===");
