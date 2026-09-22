import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { FlowError } from "../../contracts/src/index.js";

export interface ResolveWorktreePathOptions {
  sourceRoot: string;
  workflowId: string;
  repoId?: string;
  explicitPath?: string;
  projectConfiguredPath?: string;
}

export interface WorktreePreviewResult {
  source_root: string;
  target_path: string;
  repo_id: string;
  mode: "existing_workspace" | "new_worktree";
  task_branch: string;
  is_worktree: boolean;
  is_nested_in_source: boolean;
}

/**
 * 判断候选路径是否为指定源目录下的子 worktree 路径（例如 .worktrees/...）
 */
export function isSubWorktreePath(candidatePath: string, sourceRoot: string): boolean {
  try {
    const normSource = normalize(resolve(sourceRoot)).toLowerCase();
    const normCandidate = normalize(resolve(candidatePath)).toLowerCase();
    const dotWorktrees = resolve(normSource, ".worktrees").toLowerCase();
    return normCandidate.startsWith(dotWorktrees);
  } catch {
    return false;
  }
}

/**
 * 依据 CW-D11 规范：findRealSourceRoot 不再截取 .worktrees 字符串。
 * 优先 Workspace 已确认 source_root，再用已登记 Project repo 对应 Git common-dir 和 git worktree list --porcelain 核对。
 * 无法确定返回明确规范路径，不猜祖先。
 */
export function findRealSourceRoot(
  candidateRoot: string,
  knownWorkspaces?: Array<{ root: string; source_root: string }>,
): string {
  const norm = normalize(resolve(candidateRoot));
  if (knownWorkspaces && knownWorkspaces.length > 0) {
    const match = knownWorkspaces.find(
      (ws) => normalize(resolve(ws.root)).toLowerCase() === norm.toLowerCase(),
    );
    if (match?.source_root) {
      return normalize(resolve(match.source_root));
    }
  }
  try {
    const listOutput = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: norm,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const firstLine = listOutput.split(/\r?\n/).find((line) => line.startsWith("worktree "));
    if (firstLine) {
      const mainWorktree = firstLine.replace(/^worktree\s+/, "").trim();
      if (existsSync(mainWorktree)) {
        return normalize(resolve(mainWorktree));
      }
    }
  } catch {
    // 无法执行 git 或无返回时保持当前规范路径
  }
  return norm;
}

/**
 * 统一路径解析器（优先级：explicitPath -> projectConfiguredPath -> <source_root>/.worktrees/<workflow_id>/<repo_id>）
 */
export function resolveWorktreePath(options: ResolveWorktreePathOptions): string {
  const { sourceRoot, workflowId, repoId = "main", explicitPath, projectConfiguredPath } = options;
  const realSource = findRealSourceRoot(sourceRoot);

  let target: string;
  if (explicitPath && explicitPath.trim()) {
    target = isAbsolute(explicitPath)
      ? normalize(resolve(explicitPath))
      : normalize(resolve(realSource, explicitPath));
  } else if (projectConfiguredPath && projectConfiguredPath.trim()) {
    target = isAbsolute(projectConfiguredPath)
      ? normalize(resolve(projectConfiguredPath, workflowId, repoId))
      : normalize(resolve(realSource, projectConfiguredPath, workflowId, repoId));
  } else {
    target = normalize(resolve(realSource, ".worktrees", workflowId, repoId));
  }

  validateWorktreeSafety(target, realSource);
  return target;
}

/**
 * 验证工作树目标路径安全性，防止越界、覆盖或位于禁用目录
 */
export function validateWorktreeSafety(targetPath: string, sourceRoot: string): void {
  const normTarget = normalize(resolve(targetPath)).toLowerCase();
  const normSource = normalize(resolve(sourceRoot)).toLowerCase();

  if (normTarget === normSource) {
    throw new FlowError(
      "WORKTREE_PATH_CONFLICT",
      "工作树目标路径不能与源仓库根目录相同",
      409,
    );
  }

  const dotGit = resolve(sourceRoot, ".git").toLowerCase();
  if (normTarget.startsWith(dotGit)) {
    throw new FlowError(
      "WORKTREE_PATH_FORBIDDEN",
      "工作树目标路径不能位于 .git 目录内部",
      422,
    );
  }

  // 严禁将系统根目录作为工作树
  const rootDir = normalize(resolve("/")).toLowerCase();
  if (normTarget === rootDir || normTarget === "c:\\" || normTarget === "c:/") {
    throw new FlowError(
      "WORKTREE_PATH_FORBIDDEN",
      "不能将驱动器或文件系统根目录作为工作树目标",
      422,
    );
  }
}

/**
 * 通过 Git 本地 exclude 忽略 .worktrees/，不得修改 .gitignore 或暂存区
 */
export function ensureWorktreeGitExcluded(sourceRoot: string): void {
  try {
    const gitPath = execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], {
      cwd: sourceRoot,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

    const excludeFile = isAbsolute(gitPath) ? gitPath : resolve(sourceRoot, gitPath);
    const excludeDir = dirname(excludeFile);
    if (!existsSync(excludeDir)) {
      mkdirSync(excludeDir, { recursive: true });
    }

    let content = "";
    if (existsSync(excludeFile)) {
      content = readFileSync(excludeFile, "utf8");
    }

    const lines = content.split(/\r?\n/);
    const hasRule = lines.some((line) => {
      const trimmed = line.trim();
      return trimmed === ".worktrees/" || trimmed === ".worktrees" || trimmed === ".worktrees/*";
    });

    if (!hasRule) {
      const newLine = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
      writeFileSync(excludeFile, `${content}${newLine}.worktrees/\n`, "utf8");
    }
  } catch {
    // 允许在非 Git 目录降级
  }
}

/**
 * 预览工作树创建路径（只读，无副作用，CW2-F05）
 */
export function previewWorktreePath(options: {
  sourceRoot: string;
  workflowId: string;
  repoId?: string;
  mode?: "existing_workspace" | "new_worktree";
  explicitPath?: string;
  projectConfiguredPath?: string;
  branch?: string;
}): WorktreePreviewResult {
  const {
    sourceRoot,
    workflowId,
    repoId = "main",
    mode = "existing_workspace",
    explicitPath,
    projectConfiguredPath,
    branch,
  } = options;

  const normalizedInput = normalize(resolve(sourceRoot));
  const realSource = findRealSourceRoot(sourceRoot);
  const isWorktree = mode === "new_worktree";

  // CW2-F05: existing_workspace 保持用户所选 linked root，不篡改为 realSource
  const targetPath = isWorktree
    ? resolveWorktreePath({
        sourceRoot: realSource,
        workflowId,
        repoId,
        explicitPath,
        projectConfiguredPath,
      })
    : normalizedInput;

  let currentBranch = branch;
  if (!currentBranch) {
    if (isWorktree) {
      currentBranch = `devflow/${workflowId}/${repoId}`;
    } else {
      try {
        currentBranch = execFileSync(
          "git",
          ["symbolic-ref", "--short", "HEAD"],
          { cwd: normalizedInput, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        ).trim();
      } catch {
        currentBranch = "main";
      }
    }
  }

  const rel = relative(realSource, targetPath);
  const isNestedInSource = !rel.startsWith("..") && !isAbsolute(rel);

  return {
    source_root: realSource,
    target_path: targetPath,
    repo_id: repoId,
    mode,
    task_branch: currentBranch,
    is_worktree: isWorktree,
    is_nested_in_source: isNestedInSource,
  };
}
