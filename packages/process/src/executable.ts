import { existsSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
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

  const safeWhere = (pattern: string): string[] => {
    try {
      return execFileSync("where.exe", [pattern], {
        windowsHide: true,
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim()
        .split(/\r?\n/)
        .map((p) => p.trim())
        .filter((p) => isAbsolute(p) && existsSync(p));
    } catch {
      return [];
    }
  };

  // 1. 直接查询原生 .exe
  const exeTarget = value.toLowerCase().endsWith(".exe") ? value : value + ".exe";
  const exeMatches = safeWhere(exeTarget);
  const foundExe = exeMatches.find(
    (p) => p.toLowerCase().endsWith(".exe") && existsSync(p),
  );
  if (foundExe) return foundExe;

  // 2. 如果查找的是 codex，解析 npm 全局包内置的原生可执行二进制
  if (value.toLowerCase() === "codex" || value.toLowerCase() === "codex.exe") {
    const appData = process.env.APPDATA;
    const candidates: string[] = [];
    if (appData) {
      candidates.push(
        join(
          appData,
          "npm",
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          "vendor",
          "x86_64-pc-windows-msvc",
          "bin",
          "codex.exe",
        ),
        join(
          appData,
          "npm",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          "vendor",
          "x86_64-pc-windows-msvc",
          "bin",
          "codex.exe",
        ),
      );
    }
    const allMatches = safeWhere(value);
    for (const match of allMatches) {
      const dir = dirname(match);
      candidates.push(
        join(
          dir,
          "node_modules",
          "@openai",
          "codex",
          "node_modules",
          "@openai",
          "codex-win32-x64",
          "vendor",
          "x86_64-pc-windows-msvc",
          "bin",
          "codex.exe",
        ),
      );
    }
    const foundCodex = candidates.find((c) => existsSync(c));
    if (foundCodex) return foundCodex;
  }

  // 3. 通用检查：检查 safeWhere(value) 返回的文件中是否有 .exe
  const generalMatches = safeWhere(value);
  const foundGeneral = generalMatches.find(
    (p) => p.toLowerCase().endsWith(".exe") && existsSync(p),
  );
  if (foundGeneral) return foundGeneral;

  requireCondition(
    false,
    "EXECUTABLE_MISSING",
    `找不到 ${value} 的原生 exe；请在配置中指定实际可执行文件`,
  );
  return "";
}
