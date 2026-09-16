import { readdirSync, statSync, readFileSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { InputManifest } from "../../contracts/src/index.js";

export interface FileFingerprint {
  path: string;
  hash: string;
}

export interface FingerprintResult {
  fingerprint: string;
  files: FileFingerprint[];
  timestamp: string;
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".git",
  ".agents",
  ".codex",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  "reports",
  ".reports",
  ".devflow",
  ".gemini",
  ".idea",
  ".vscode",
]);

const DEFAULT_EXCLUDE_FILE_PATTERNS = [
  /\.log$/,
  /\.tmp$/,
  /(?:^|[\\/])report\.json$/,
  /(?:^|[\\/])junit.*\.xml$/,
];

export class WorkspaceFingerprintService {
  private static cache = new Map<string, { version: string; hash: string }>();
  /**
   * 递归收集工作区内有效输入文件的指纹
   */
  static compute(
    workspaceRoot: string,
    options?: {
      includes?: string[]; // 相对路径列表，为空时扫描整个工作区
      excludes?: string[]; // 额外的排除目录或文件（如报告文件等）
    },
  ): FingerprintResult {
    const root = resolve(workspaceRoot);
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new Error("Input workspace does not exist");
    const files: FileFingerprint[] = [];
    const extraExcludes = new Set(
      (options?.excludes ?? []).map((e) => e.replaceAll("\\", "/")),
    );

    const walk = (currentDir: string) => {
      if (!existsSync(currentDir)) return;
      const entries = readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const relPath = relative(root, fullPath).replaceAll("\\", "/");

        if (entry.isSymbolicLink())
          throw new Error(
            "Input links require an explicit supported policy: " + relPath,
          );
        if (entry.isDirectory()) {
          if (
            DEFAULT_EXCLUDE_DIRS.has(entry.name) ||
            extraExcludes.has(relPath) ||
            extraExcludes.has(entry.name)
          ) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile()) {
          // 排除额外指定的报告或临时文件
          if (extraExcludes.has(relPath)) {
            continue;
          }

          // 排除日志与常规产物
          if (
            DEFAULT_EXCLUDE_FILE_PATTERNS.some((pattern) =>
              pattern.test(entry.name),
            )
          ) {
            continue;
          }

          // 如果指定了特定 include 范围
          if (options?.includes && options.includes.length > 0) {
            const matched = options.includes.some((inc) => {
              const cleanInc = inc.replaceAll("\\", "/");
              return (
                relPath === cleanInc ||
                relPath.startsWith(cleanInc.replace(/\/$/, "") + "/")
              );
            });
            if (!matched) continue;
          }

          try {
            const before = statSync(fullPath, { bigint: true });
            const versionOf = (v: typeof before) =>
              [v.size, v.mtimeNs, v.ctimeNs, v.ino].join(":");
            const version = versionOf(before);
            const cached = this.cache.get(fullPath);
            const hash =
              cached?.version === version
                ? cached.hash
                : createHash("sha256")
                    .update(readFileSync(fullPath))
                    .digest("hex");
            if (versionOf(statSync(fullPath, { bigint: true })) !== version)
              throw new Error("Input changed during read");
            if (this.cache.size > 50000) this.cache.clear();
            this.cache.set(fullPath, { version, hash });
            files.push({ path: relPath, hash });
          } catch (err) {
            throw new Error(`输入文件 '${relPath}' 读取失败: ${String(err)}`);
          }
        }
      }
    };

    walk(root);

    // 路径排序保证确定性
    files.sort((a, b) => a.path.localeCompare(b.path));

    const totalHasher = createHash("sha256");
    for (const f of files) {
      totalHasher.update(`${f.path}:${f.hash};`);
    }
    const totalFingerprint = totalHasher.digest("hex");

    return {
      fingerprint: totalFingerprint,
      files,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * 检查当前工作区输入指纹与既有 manifest 是否一致
   */
  static verifyFingerprint(
    workspaceRoot: string,
    existingManifest: InputManifest,
    scopePaths?: string[],
  ): { matches: boolean; changedFiles: string[] } {
    const current = WorkspaceFingerprintService.compute(workspaceRoot, {
      includes: scopePaths,
    });

    const existingFileMap = new Map(
      existingManifest.files.map((f) => [f.path, f.hash]),
    );
    const changedFiles: string[] = [];

    // 检查修改或新增的文件
    for (const file of current.files) {
      const oldHash = existingFileMap.get(file.path);
      if (oldHash !== file.hash) {
        changedFiles.push(file.path);
      }
    }

    // 检查删除的文件
    const currentFilePaths = new Set(current.files.map((f) => f.path));
    for (const oldFile of existingManifest.files) {
      if (!currentFilePaths.has(oldFile.path)) {
        changedFiles.push(oldFile.path);
      }
    }

    return {
      matches: changedFiles.length === 0,
      changedFiles,
    };
  }
}
