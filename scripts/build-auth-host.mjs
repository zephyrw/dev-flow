import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync("dist/host", { recursive: true });

const isWin = process.platform === "win32";
const binaryName = isWin ? "devflow-auth-host.exe" : "devflow-auth-host";
const targetPath = resolve("dist/host", binaryName);

console.log("[build-auth-host] Building devflow-auth-host...");
const goResult = spawnSync("go", ["build", "-o", targetPath, "."], {
  cwd: resolve("host/devflow-auth-host"),
  stdio: "inherit",
  windowsHide: true,
});

if (goResult.status !== 0) {
  console.error(
    "[build-auth-host] Failed to build devflow-auth-host with exit code:",
    goResult.status,
  );
  process.exit(goResult.status ?? 1);
}

const authBuildInfo = {
  name: "devflow-auth-host",
  target_os: process.platform,
  target_arch: process.arch,
  built_at: new Date().toISOString(),
  binary: binaryName,
  verification: "build_only_not_credential_or_cli_certification",
};
writeFileSync(
  "dist/host/auth-host-build.json",
  JSON.stringify(authBuildInfo, null, 2),
);

console.log(
  "[build-auth-host] devflow-auth-host successfully built at:",
  targetPath,
);
process.exit(0);
