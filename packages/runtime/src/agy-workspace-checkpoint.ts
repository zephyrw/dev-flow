import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, join, relative, isAbsolute } from "node:path";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  lstatSync,
  readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

export interface WorkspaceCheckpointOptions {
  storageRoot: string;
  workflowId: string;
  sourceCheckpointId: string;
  maxSingleFileBytes?: number; // 默认 64 MiB
  maxTotalBytes?: number; // 默认 512 MiB
}

export interface WorkspaceFileEntry {
  relative_path: string;
  size_bytes: number;
  sha256: string;
  is_binary: boolean;
}

export interface WorkspaceCheckpointManifest {
  checkpoint_id: string;
  workflow_id: string;
  repo_root: string;
  base_commit?: string;
  index_diff_rel_path?: string;
  worktree_diff_rel_path?: string;
  git_diff_rel_path?: string; // 兼容旧读取
  untracked_files: WorkspaceFileEntry[];
  unpreserved_paths: string[];
  total_bytes: number;
  complete: boolean;
  created_at: string;
}

export interface WorkspaceCheckpointResult {
  checkpoint_ref: string;
  manifest: WorkspaceCheckpointManifest;
}

const SENSITIVE_OR_IGNORED_PATTERNS = [
  /node_modules/,
  /^\.git(\/|\\|$)/,
  /dist(\/|\\|$)/,
  /build(\/|\\|$)/,
  /\.env(\.|$)/i,
  /id_rsa/i,
  /\.pem$/i,
  /\.key$/i,
];

function isIgnoredPath(relPath: string): boolean {
  return SENSITIVE_OR_IGNORED_PATTERNS.some((p) => p.test(relPath));
}

function safeHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export async function createWorkspaceCheckpoint(
  workspaceDir: string,
  options: WorkspaceCheckpointOptions,
): Promise<WorkspaceCheckpointResult> {
  const maxSingle = options.maxSingleFileBytes ?? 64 * 1024 * 1024;
  const maxTotal = options.maxTotalBytes ?? 512 * 1024 * 1024;

  const safeWf = options.workflowId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const hashedCheckpoint = safeHash(options.sourceCheckpointId);
  const targetDir = resolve(
    options.storageRoot,
    "agy-recovery",
    safeWf,
    hashedCheckpoint,
  );
  mkdirSync(targetDir, { recursive: true });

  let repoRoot = workspaceDir;
  let baseCommit: string | undefined;
  const unpreserved: string[] = [];

  try {
    const { stdout: topLevel } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd: workspaceDir },
    );
    repoRoot = topLevel.trim();
    const { stdout: headCommit } = await execFileAsync(
      "git",
      ["rev-parse", "HEAD"],
      { cwd: workspaceDir },
    );
    baseCommit = headCommit.trim();
  } catch {
    // Non-git workspace: CR24 允许实际枚举
  }

  let indexDiffRelPath: string | undefined;
  let worktreeDiffRelPath: string | undefined;
  let totalBytes = 0;
  const untrackedEntries: WorkspaceFileEntry[] = [];

  if (!baseCommit) {
    // 非 Git 目录实际枚举 (CR24)
    try {
      const filesDir = join(targetDir, "untracked");
      const scan = (dir: string) => {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = join(dir, entry.name);
          const relPath = relative(workspaceDir, fullPath).replace(/\\/g, "/");
          if (!relPath || isIgnoredPath(relPath)) continue;
          if (entry.isSymbolicLink()) {
            unpreserved.push(`symlink_skipped:${relPath}`);
            continue;
          }
          if (entry.isDirectory()) {
            scan(fullPath);
          } else if (entry.isFile()) {
            try {
              const stat = statSync(fullPath);
              if (stat.size > maxSingle || totalBytes + stat.size > maxTotal) {
                unpreserved.push(relPath);
                continue;
              }
              const buf = readFileSync(fullPath);
              const sha = createHash("sha256").update(buf).digest("hex");
              const safeDest = join(filesDir, sha);
              mkdirSync(filesDir, { recursive: true });
              writeFileSync(safeDest, buf);
              totalBytes += stat.size;
              untrackedEntries.push({
                relative_path: relPath,
                size_bytes: stat.size,
                sha256: sha,
                is_binary: buf.includes(0),
              });
            } catch {
              unpreserved.push(relPath);
            }
          }
        }
      };
      scan(workspaceDir);
    } catch {
      unpreserved.push("non_git_scan_failed");
    }
  } else {
    // 1. 分开保存 index 和 worktree 两层 diff (CR24)
    try {
      const { stdout: indexDiff } = await execFileAsync(
        "git",
        ["diff", "--cached", "--binary"],
        { cwd: workspaceDir, maxBuffer: maxSingle },
      );
      if (indexDiff && indexDiff.length > 0) {
        const fileName = "index.diff";
        writeFileSync(join(targetDir, fileName), indexDiff, "utf8");
        indexDiffRelPath = fileName;
        totalBytes += Buffer.byteLength(indexDiff);
      }
    } catch {
      unpreserved.push("git_index_diff_failed");
    }

    try {
      const { stdout: worktreeDiff } = await execFileAsync(
        "git",
        ["diff", "--binary"],
        { cwd: workspaceDir, maxBuffer: maxSingle },
      );
      if (worktreeDiff && worktreeDiff.length > 0) {
        const fileName = "worktree.diff";
        writeFileSync(join(targetDir, fileName), worktreeDiff, "utf8");
        worktreeDiffRelPath = fileName;
        totalBytes += Buffer.byteLength(worktreeDiff);
      }
    } catch {
      unpreserved.push("git_worktree_diff_failed");
    }

    // 2. 收集 untracked 文件，使用 -z (NUL 分隔) 避免中文和转义字符丢失 (CR24)
    try {
      const { stdout: statusOut } = await execFileAsync(
        "git",
        ["status", "--porcelain=v1", "-z", "-uall"],
        { cwd: workspaceDir, maxBuffer: maxSingle },
      );
      const parts = statusOut.split("\0");
      const filesDir = join(targetDir, "untracked");

      for (const part of parts) {
        if (!part || !part.startsWith("?? ")) continue;
        const relPath = part.substring(3).trim();
        if (!relPath || isIgnoredPath(relPath)) continue;

        const fullSrc = resolve(workspaceDir, relPath);
        if (!existsSync(fullSrc)) {
          unpreserved.push(relPath);
          continue;
        }

        try {
          // 不跟随符号链接 (CR25)
          const lstat = lstatSync(fullSrc);
          if (lstat.isSymbolicLink()) {
            unpreserved.push(`symlink_skipped:${relPath}`);
            continue;
          }
          const stat = statSync(fullSrc);
          if (!stat.isFile()) continue;

          if (stat.size > maxSingle || totalBytes + stat.size > maxTotal) {
            unpreserved.push(relPath);
            continue;
          }

          const buf = readFileSync(fullSrc);
          const sha = createHash("sha256").update(buf).digest("hex");
          const safeDest = join(filesDir, sha);
          mkdirSync(filesDir, { recursive: true });
          writeFileSync(safeDest, buf);

          totalBytes += stat.size;
          untrackedEntries.push({
            relative_path: relPath,
            size_bytes: stat.size,
            sha256: sha,
            is_binary: buf.includes(0),
          });
        } catch {
          unpreserved.push(relPath);
        }
      }
    } catch {
      unpreserved.push("untracked_scan_failed");
    }
  }

  const complete = unpreserved.length === 0;

  const manifest: WorkspaceCheckpointManifest = {
    checkpoint_id: options.sourceCheckpointId,
    workflow_id: options.workflowId,
    repo_root: repoRoot,
    base_commit: baseCommit,
    index_diff_rel_path: indexDiffRelPath,
    worktree_diff_rel_path: worktreeDiffRelPath,
    git_diff_rel_path: worktreeDiffRelPath ?? indexDiffRelPath,
    untracked_files: untrackedEntries,
    unpreserved_paths: unpreserved,
    total_bytes: totalBytes,
    complete,
    created_at: new Date().toISOString(),
  };

  const manifestPath = join(targetDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    checkpoint_ref: manifestPath,
    manifest,
  };
}

export interface RestoreWorkspaceResult {
  success: boolean;
  complete: boolean;
  conflicts: string[];
  workspaceRef?: string;
  error?: string;
}

export async function restoreWorkspaceCheckpoint(
  manifestPath: string,
  targetWorkspaceDir: string,
): Promise<RestoreWorkspaceResult> {
  if (!existsSync(manifestPath)) {
    return {
      success: false,
      complete: false,
      conflicts: [],
      error: "checkpoint_manifest_not_found",
    };
  }

  const manifest: WorkspaceCheckpointManifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  );

  if (!manifest.complete) {
    return {
      success: false,
      complete: false,
      conflicts: [],
      error: "checkpoint_incomplete_manual_required",
    };
  }

  const manifestDir = resolve(manifestPath, "..");
  const resolvedTarget = resolve(targetWorkspaceDir);
  const conflicts: string[] = [];

  // === 阶段 1: 严格预检 (CR25) ===
  // 1. 预检所有 untracked 文件 artifact 是否存在、sha256 是否完全吻合
  for (const entry of manifest.untracked_files) {
    const srcFile = join(manifestDir, "untracked", entry.sha256);
    if (!existsSync(srcFile)) {
      return {
        success: false,
        complete: false,
        conflicts: [],
        error: `missing_file_artifact_${entry.sha256}`,
      };
    }
    const buf = readFileSync(srcFile);
    const calculatedSha = createHash("sha256").update(buf).digest("hex");
    if (calculatedSha !== entry.sha256) {
      return {
        success: false,
        complete: false,
        conflicts: [],
        error: `artifact_sha_mismatch_${entry.sha256}`,
      };
    }

    // 路径安全性检查：防止目录遍历逃逸 (CR25)
    const destFile = resolve(resolvedTarget, entry.relative_path);
    const rel = relative(resolvedTarget, destFile);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return {
        success: false,
        complete: false,
        conflicts: [],
        error: `path_traversal_forbidden_${entry.relative_path}`,
      };
    }

    // 冲突检查：目标文件若已存在且内容不同，不允许直接覆盖，收集为冲突 (CR25)
    if (existsSync(destFile)) {
      const existingBuf = readFileSync(destFile);
      const existingSha = createHash("sha256").update(existingBuf).digest("hex");
      if (existingSha !== entry.sha256) {
        conflicts.push(entry.relative_path);
      }
    }
  }

  if (conflicts.length > 0) {
    return {
      success: false,
      complete: false,
      conflicts,
      error: `target_conflict_exists: ${conflicts.join(", ")}`,
    };
  }

  // 2. 预检 diff 文件是否存在 (CR25)
  if (manifest.index_diff_rel_path) {
    const diffFile = join(manifestDir, manifest.index_diff_rel_path);
    if (!existsSync(diffFile)) {
      return {
        success: false,
        complete: false,
        conflicts: [],
        error: "missing_index_diff_artifact",
      };
    }
  }
  if (manifest.worktree_diff_rel_path) {
    const diffFile = join(manifestDir, manifest.worktree_diff_rel_path);
    if (!existsSync(diffFile)) {
      return {
        success: false,
        complete: false,
        conflicts: [],
        error: "missing_worktree_diff_artifact",
      };
    }
  }

  // === 阶段 2: 严格按顺序原子恢复 (N08 修复) ===
  mkdirSync(resolvedTarget, { recursive: true });

  // 1. 先应用 index.diff：在干净 base 上使用 git apply --index，使 index 和工作树同时达到源 index
  if (manifest.index_diff_rel_path) {
    const diffFile = join(manifestDir, manifest.index_diff_rel_path);
    try {
      await execFileAsync("git", ["apply", "--index", diffFile], {
        cwd: resolvedTarget,
      });
    } catch (err) {
      return {
        success: false,
        complete: false,
        conflicts: [],
        error: `git_apply_index_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 2. 再应用 worktree.diff：使工作树更新到目标状态
  if (manifest.worktree_diff_rel_path) {
    const diffFile = join(manifestDir, manifest.worktree_diff_rel_path);
    try {
      await execFileAsync("git", ["apply", diffFile], {
        cwd: resolvedTarget,
      });
    } catch (err) {
      return {
        success: false,
        complete: false,
        conflicts: [],
        error: `git_apply_worktree_failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // 3. 最后安全写入 untracked 文件
  for (const entry of manifest.untracked_files) {
    const srcFile = join(manifestDir, "untracked", entry.sha256);
    const destFile = resolve(resolvedTarget, entry.relative_path);
    mkdirSync(resolve(destFile, ".."), { recursive: true });
    writeFileSync(destFile, readFileSync(srcFile));
  }

  return {
    success: true,
    complete: true,
    conflicts: [],
    workspaceRef: resolvedTarget,
  };
}
