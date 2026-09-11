import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { execFileSync } from "node:child_process";
import { requireCondition } from "../../contracts/src/index.js";
/** Resolve an actual executable; never dispatch a shell shim through CreateProcess. */
export function executablePath(value: string) {
  if (isAbsolute(value)) {
    requireCondition(
      existsSync(value),
      "EXECUTABLE_MISSING",
      `程序不存在：${value}`,
    );
    return value;
  }
  requireCondition(
    !/[\\/\r\n]/.test(value),
    "EXECUTABLE_INVALID",
    "可执行程序须为绝对路径或简单名称",
  );
  if (process.platform !== "win32") return value;
  const matches = execFileSync(
    "where.exe",
    [value.endsWith(".exe") ? value : value + ".exe"],
    { windowsHide: true, encoding: "utf8", timeout: 10000 },
  )
    .trim()
    .split(/\r?\n/);
  const found = matches.find(
    (p) => isAbsolute(p) && p.toLowerCase().endsWith(".exe") && existsSync(p),
  );
  requireCondition(
    found,
    "EXECUTABLE_MISSING",
    `找不到 ${value} 的原生 exe；请在配置中指定实际可执行文件`,
  );
  return found;
}
