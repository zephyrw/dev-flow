import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync("dist/host", { recursive: true });

const isWin = process.platform === "win32";
const binaryName = isWin ? "devflow-host.exe" : "devflow-host";
const targetPath = resolve("dist/host", binaryName);

console.log("[build-host] Building cross-platform Go Host...");
const goResult = spawnSync("go", ["build", "-o", targetPath, "."], {
  cwd: resolve("host/devflow-host"),
  stdio: "inherit",
  windowsHide: true,
});

if (goResult.status !== 0) {
  console.error(
    "[build-host] Failed to build Go Host with exit code:",
    goResult.status,
  );
  process.exit(goResult.status ?? 1);
}

// 写入锁定工具链信息
const toolchainsLock = {
  host_toolchain: "go",
  go_version: "1.24",
  target_os: process.platform,
  target_arch: process.arch,
  built_at: new Date().toISOString(),
  binary: binaryName,
};
writeFileSync("dist/host/build.json", JSON.stringify(toolchainsLock, null, 2));

console.log("[build-host] Go Host successfully built at:", targetPath);
process.exit(0);
