import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { FlowError, Id, requireCondition, type Project } from "../../contracts/src/index.js";
import { canonicalGitPath, sameGitDirectory } from "../../git/src/git.js";
import { sameWorkspacePath } from "../../git/src/workspace-paths.js";
import type { Store } from "../../store/src/store.js";

export function gitAt(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd();
}

export function insideDirectory(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}

function inspectRepository(path: string) {
  try {
    requireCondition(sameGitDirectory(path, gitAt(path, ["rev-parse", "--show-toplevel"])),
      "WORKSPACE_ROOT_REQUIRED", "请选择 Git 仓库根目录");
    return {
      path,
      baseline: gitAt(path, ["rev-parse", "--verify", "HEAD^{commit}"]),
      branch: gitAt(path, ["symbolic-ref", "--short", "HEAD"]),
      common_dir: canonicalGitPath(resolve(path, gitAt(path, ["rev-parse", "--git-common-dir"]))),
    };
  } catch {
    throw new FlowError("REPOSITORY_NOT_READY", `仓库不可用，请检查 Git 配置、初始提交和当前分支：${path}`);
  }
}

export const PROJECT_DOCS_ID = "project-docs";

const skipped = new Set(["docs", ".git", ".worktrees", ".devflow", "node_modules", "dist", "build", "target", "vendor"]);
const maxDepth = 3;
const maxDirectories = 512;
function discover(root: string) {
  const paths: string[] = [];
  let scanned = 0;
  function visit(dir: string, depth: number) {
    requireCondition(++scanned <= maxDirectories, "DISCOVERY_LIMIT", "项目目录过多，请登记明确的仓库列表");
    if (depth && existsSync(join(dir, ".git"))) {
      paths.push(dir);
      return;
    }
    if (depth >= maxDepth) return;
    for (const child of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!child.isDirectory() || skipped.has(child.name.toLowerCase())) continue;
      const path = join(dir, child.name);
      if (!lstatSync(path).isSymbolicLink() && relative(dir, canonicalGitPath(path)) === child.name) {
        visit(path, depth + 1);
      }
    }
  }
  visit(root, 0);
  return paths;
}

export function resolveProjectLayout(store: Store, selected: string) {
  requireCondition(existsSync(selected), "WORKSPACE_MISSING", "工作区不存在");
  const root = canonicalGitPath(selected);
  requireCondition(lstatSync(root).isDirectory(), "WORKSPACE_ROOT_REQUIRED", "请选择项目目录");
  const projects = store.list<Project>("project");
  const registered = projects.find(p => p.project_root && sameWorkspacePath(p.project_root, root));
  const single = !registered && existsSync(join(root, ".git"));
  const existing = registered ?? (single
    ? projects.find(p => !p.project_root && p.repositories.some(repo => sameWorkspacePath(repo.path, root)))
    : undefined);
  const paths = registered ? registered.repositories.map(repo => canonicalGitPath(repo.path))
    : single ? [root] : discover(root);
  if (!paths.length && !registered) {
    let enclosingRepository: string | undefined;
    try {
      enclosingRepository = gitAt(root, ["rev-parse", "--show-toplevel"]);
    } catch {
      // A plain directory may have neither its own repository nor an enclosing one.
    }
    requireCondition(!enclosingRepository, "WORKSPACE_ROOT_REQUIRED", "请选择 Git 仓库根目录");
  }
  requireCondition(paths.length, "GIT_REPOSITORY_REQUIRED",
    "项目根目录及其下三层未找到 Git 仓库，请检查所选目录或登记仓库列表");
  const repositories = paths.map((path, index) => {
    const rel = relative(root, path);
    if (!single) {
      requireCondition(rel && insideDirectory(root, path), "INVALID_PROJECT_REPOSITORY",
        `仓库必须位于项目根目录下：${path}`);
    }
    const repo = registered?.repositories[index] ?? (single
      ? existing?.repositories.find(repo => sameWorkspacePath(repo.path, path))
      : undefined);
    const candidate = basename(path);
    const repoId = repo?.id ?? (single ? "main"
      : rel === candidate && Id.safeParse(candidate).success && candidate !== PROJECT_DOCS_ID
        ? candidate : "repo-" + createHash("sha256").update(rel.split(sep).join("/")).digest("hex").slice(0, 16));
    return { ...inspectRepository(path), id: repoId, relativePath: rel, worktree_base_path: repo?.worktree_base_path };
  });
  for (const [index, repo] of repositories.entries()) {
    requireCondition(repo.id !== PROJECT_DOCS_ID, "INVALID_PROJECT_REPOSITORY", "仓库编号 project-docs 保留给项目文档");
    requireCondition(!repositories.slice(0, index).some(prior =>
      sameWorkspacePath(prior.common_dir, repo.common_dir) || prior.id === repo.id),
      "DUPLICATE_PROJECT_REPOSITORY", `项目中存在同一仓库的多个检出目录或重复编号：${repo.path}`);
  }
  return { root, grouped: !single, existing, repositories };
}
