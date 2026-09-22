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

export interface FingerprintComputeOptions {
  includes?: string[]; // 相对路径列表，为空时扫描整个工作区
  excludes?: string[]; // 额外的排除目录或文件（如报告文件等）
  registeredWorktrees?: string[]; // 依据 CW-D12 注入的已登记工作树集合（项目相对路径）
  backupSubtrees?: string[]; // 依据 CW-D12 注入的已登记备份子树集合（项目相对路径）
}

function isUnderBoundary(relPath: string, boundaryDir: string): boolean {
  const normRel = relPath.replaceAll("\\", "/").toLowerCase();
  const normBound = boundaryDir.replaceAll("\\", "/").toLowerCase().replace(/\/+$/, "");
  return normRel === normBound || normRel.startsWith(normBound + "/");
}

export interface ScanContext {
  scanRoot: string;
  registeredWorktrees: string[];
  backupSubtrees: string[];
}

/**
 * 依据 CW3-F14 规范：建立全局 ScanContext
 * 结合全局已确认 Workspace 映射与实际 Git 登记/common-dir，
 * 当前扫描根不排除，失效登记不排普通代码，备份独立持久登记
 */
export function resolveScanContext(
  scanRoot: string,
  options?: {
    store?: any;
    knownWorkspaces?: Array<{ root: string; id?: string }>;
    currentWorkspaceRoot?: string;
    backupRoots?: string[];
  },
): ScanContext {
  const normScanRoot = resolve(scanRoot).replaceAll("\\", "/").toLowerCase();
  const normCurrent = options?.currentWorkspaceRoot
    ? resolve(options.currentWorkspaceRoot).replaceAll("\\", "/").toLowerCase()
    : undefined;

  let workspacesToInspect = options?.knownWorkspaces ?? [];
  if (options?.store) {
    try {
      const allWs = options.store.list("workspace");
      if (Array.isArray(allWs) && allWs.length > 0) {
        workspacesToInspect = allWs;
      }
    } catch {}
  }

  const registeredWorktrees: string[] = [];
  for (const ws of workspacesToInspect) {
    if (!ws?.root) continue;
    const wsRoot = resolve(ws.root).replaceAll("\\", "/");
    const normWsRoot = wsRoot.toLowerCase();
    if (normCurrent && normWsRoot === normCurrent) continue;
    if (normWsRoot === normScanRoot) continue;
    if (normWsRoot.startsWith(normScanRoot + "/")) {
      // CW3-F14: 核验实际 Git 登记，失效登记变成普通目录后不得误排真实代码
      const dotGitPath = join(ws.root, ".git");
      let isValidWorktree = false;
      if (existsSync(dotGitPath)) {
        try {
          const stat = statSync(dotGitPath);
          if (stat.isFile()) {
            const dotGitContent = readFileSync(dotGitPath, "utf8");
            if (dotGitContent.includes("gitdir:")) {
              isValidWorktree = true;
            }
          }
        } catch {}
      }

      if (isValidWorktree) {
        const rel = relative(scanRoot, ws.root).replaceAll("\\", "/");
        if (rel && !rel.startsWith("..") && !registeredWorktrees.includes(rel)) {
          registeredWorktrees.push(rel);
        }
      }
    }
  }

  const backupSubtrees: string[] = [];
  let backupsToInspect = options?.backupRoots ?? [];
  if (options?.store) {
    try {
      const allBackups = options.store.list("backup_registration");
      if (Array.isArray(allBackups)) {
        backupsToInspect = [
          ...backupsToInspect,
          ...allBackups.map((b: any) => b.path || b.root).filter(Boolean),
        ];
      }
    } catch {}
  }

  for (const bk of backupsToInspect) {
    const bkRoot = resolve(bk).replaceAll("\\", "/");
    const normBkRoot = bkRoot.toLowerCase();
    if (normBkRoot.startsWith(normScanRoot + "/")) {
      const rel = relative(scanRoot, bk).replaceAll("\\", "/");
      if (rel && !rel.startsWith("..") && !backupSubtrees.includes(rel)) {
        backupSubtrees.push(rel);
      }
    }
  }

  return { scanRoot, registeredWorktrees, backupSubtrees };
}

export function resolveExcludedRelativePaths(
  scanRoot: string,
  options?: {
    store?: any;
    knownWorkspaces?: Array<{ root: string; id?: string }>;
    currentWorkspaceRoot?: string;
    backupRoots?: string[];
  },
): { registeredWorktrees: string[]; backupSubtrees: string[] } {
  const ctx = resolveScanContext(scanRoot, options);
  return { registeredWorktrees: ctx.registeredWorktrees, backupSubtrees: ctx.backupSubtrees };
}

export class WorkspaceFingerprintService {
  private static cache = new Map<string, { version: string; hash: string }>();
  /**
   * 递归收集工作区内有效输入文件的指纹
   */
  static compute(
    workspaceRoot: string,
    options?: FingerprintComputeOptions,
  ): FingerprintResult {
    const root = resolve(workspaceRoot);
    if (!existsSync(root) || !statSync(root).isDirectory())
      throw new Error("Input workspace does not exist");
    const files: FileFingerprint[] = [];
    const extraExcludes = new Set(
      (options?.excludes ?? []).map((e) => e.replaceAll("\\", "/")),
    );
    const registeredWorktrees = options?.registeredWorktrees ?? [];
    const backupSubtrees = options?.backupSubtrees ?? [];

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
          // 目录边界排除核查 (CW-D12)
          const isRegisteredTree = registeredWorktrees.some((b) => isUnderBoundary(relPath, b));
          const isBackupSubtree = backupSubtrees.some((b) => isUnderBoundary(relPath, b));
          if (
            DEFAULT_EXCLUDE_DIRS.has(entry.name) ||
            extraExcludes.has(relPath) ||
            extraExcludes.has(entry.name) ||
            isRegisteredTree ||
            isBackupSubtree
          ) {
            continue;
          }
          walk(fullPath);
        } else if (entry.isFile()) {
          // 排除已登记的工作树或备份子树中的文件
          if (
            registeredWorktrees.some((b) => isUnderBoundary(relPath, b)) ||
            backupSubtrees.some((b) => isUnderBoundary(relPath, b))
          ) {
            continue;
          }
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
