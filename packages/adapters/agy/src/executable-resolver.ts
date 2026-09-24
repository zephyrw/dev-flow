import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultAdapterFallbackDirs,
  resolveAdapterExecutable,
} from "../../sdk/src/registry.js";

export interface AgyExecutableResolution {
  resolvedPath?: string;
  source: "explicit_file" | "env_var" | "path_lookup" | "fallback_dir" | "none";
  error?: string;
  fingerprint?: string;
}

/**
 * 统一 AGY 可执行文件解析器 (D01)
 * 优先级：
 * 1. 用户显式指定的文件路径（含路径分隔符或绝对路径）：必须存在，否则报错，绝不隐式替换为其他程序。
 * 2. 环境变量 AGY_CLI_PATH：若配置且存在则优先使用。
 * 3. 自定义非默认命令名 / 默认命令名：通过 PATH 及标准 fallback 目录解析。
 */
export function resolveAgyExecutable(
  customInput?: string,
): AgyExecutableResolution {
  // 1. 用户显式指定了包含路径分隔符的路径
  if (customInput && (customInput.includes("/") || customInput.includes("\\"))) {
    const abs = resolve(customInput);
    if (existsSync(abs)) {
      try {
        const fp = createHash("sha256").update(readFileSync(abs)).digest("hex");
        return { resolvedPath: abs, source: "explicit_file", fingerprint: fp };
      } catch (err: any) {
        return {
          source: "explicit_file",
          error: `读取指定 AGY 路径失败: ${err.message}`,
        };
      }
    }
    return {
      source: "explicit_file",
      error: `指定的 AGY 可执行文件路径不存在: ${customInput}`,
    };
  }

  // 2. 检查环境变量 AGY_CLI_PATH
  const envPath = process.env.AGY_CLI_PATH;
  if (envPath) {
    const abs = resolve(envPath);
    if (existsSync(abs)) {
      try {
        const fp = createHash("sha256").update(readFileSync(abs)).digest("hex");
        return { resolvedPath: abs, source: "env_var", fingerprint: fp };
      } catch (err: any) {
        return {
          source: "env_var",
          error: `读取 AGY_CLI_PATH 指定的文件失败: ${err.message}`,
        };
      }
    }
    return {
      source: "env_var",
      error: `环境变量 AGY_CLI_PATH 指定的文件不存在: ${envPath}`,
    };
  }

  // 3. 用户显式传入了除 "agy" 之外的单独命令名
  const commandName =
    customInput && customInput !== "agy" ? customInput : undefined;

  // 4. 在 PATH 及 fallbackDirs 中查找
  const found = resolveAdapterExecutable("agy", commandName);
  if (found && existsSync(found)) {
    try {
      const fp = createHash("sha256").update(readFileSync(found)).digest("hex");
      const isFallback = defaultAdapterFallbackDirs().some((dir) =>
        found.startsWith(dir),
      );
      return {
        resolvedPath: found,
        source: isFallback ? "fallback_dir" : "path_lookup",
        fingerprint: fp,
      };
    } catch (err: any) {
      return {
        source: "path_lookup",
        error: `读取找到的 AGY 可执行文件失败: ${err.message}`,
      };
    }
  }

  return {
    source: "none",
    error: "未在 PATH 或标准安装目录找到 AGY CLI 可执行文件",
  };
}
