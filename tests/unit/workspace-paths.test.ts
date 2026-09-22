import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  resolveWorktreePath,
  validateWorktreeSafety,
  ensureWorktreeGitExcluded,
  isSubWorktreePath,
  previewWorktreePath,
  findRealSourceRoot,
} from "../../packages/git/src/workspace-paths.js";
import { FlowError } from "../../packages/contracts/src/index.js";

describe("工作区共享路径解析器 (NV-U01, NV-U08)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-ws-path-test-"));
    // 初始化临时 git 仓库
    execFileSync("git", ["init"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "TestUser"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tempDir, stdio: "ignore" });
    writeFileSync(join(tempDir, "README.md"), "# Test\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tempDir, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tempDir, stdio: "ignore" });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("NV-U08: 缺省情况下按约定生成 <source_root>/.worktrees/<workflow_id>/<repo_id>", () => {
    const target = resolveWorktreePath({
      sourceRoot: tempDir,
      workflowId: "wf-123",
      repoId: "main",
    });
    expect(target).toContain(".worktrees");
    expect(target).toContain("wf-123");
    expect(target).toContain("main");
  });

  it("NV-U08: 优先级覆盖：显式指定路径优先于缺省路径", () => {
    const custom = join(tempDir, "custom-worktrees", "wf-999");
    const target = resolveWorktreePath({
      sourceRoot: tempDir,
      workflowId: "wf-123",
      repoId: "main",
      explicitPath: custom,
    });
    expect(target).toBe(custom);
  });

  it("NV-U08: 优先级覆盖：项目登记约定优先于缺省路径", () => {
    const configured = join(tempDir, "project-worktrees");
    const target = resolveWorktreePath({
      sourceRoot: tempDir,
      workflowId: "wf-123",
      repoId: "main",
      projectConfiguredPath: configured,
    });
    expect(target).toContain("project-worktrees");
    expect(target).toContain("wf-123");
  });

  it("NV-U08: 递归防护：当当前目录已经位于 .worktrees 时，准确定位上层真实源根目录", () => {
    const nested = join(tempDir, ".worktrees", "wf-prior", "main");
    mkdirSync(nested, { recursive: true });
    const detected = findRealSourceRoot(nested);
    expect(detected.toLowerCase()).toBe(tempDir.toLowerCase());
  });

  it("NV-U08: 安全性校验：拒绝相同目录或 .git 内部目录作为工作树目标", () => {
    expect(() => validateWorktreeSafety(tempDir, tempDir)).toThrow(FlowError);
    expect(() => validateWorktreeSafety(join(tempDir, ".git", "wt"), tempDir)).toThrow(FlowError);
  });

  it("NV-U08: Git 本地 exclude 写入：幂等向 info/exclude 追加 .worktrees/ 且不改写 .gitignore", () => {
    ensureWorktreeGitExcluded(tempDir);
    const excludeFile = join(tempDir, ".git", "info", "exclude");
    expect(existsSync(excludeFile)).toBe(true);
    const content = readFileSync(excludeFile, "utf8");
    expect(content).toContain(".worktrees/");

    // 再次调用，保证幂等，不重复追加
    ensureWorktreeGitExcluded(tempDir);
    const secondContent = readFileSync(excludeFile, "utf8");
    const matches = secondContent.match(/\.worktrees\//g);
    expect(matches?.length).toBe(1);

    // 确认 .gitignore 没有被创建或篡改
    expect(existsSync(join(tempDir, ".gitignore"))).toBe(false);
  });

  it("NV-U08: isSubWorktreePath 正确识别工作树路径", () => {
    const sub = join(tempDir, ".worktrees", "wf-1", "primary");
    const normal = join(tempDir, "src", "index.ts");
    expect(isSubWorktreePath(sub, tempDir)).toBe(true);
    expect(isSubWorktreePath(normal, tempDir)).toBe(false);
  });

  it("NV-U01: previewWorktreePath 只读计算且返回预览数据", () => {
    const preview = previewWorktreePath({
      sourceRoot: tempDir,
      workflowId: "wf-preview",
      repoId: "main",
      mode: "new_worktree",
    });
    expect(preview.mode).toBe("new_worktree");
    expect(preview.is_worktree).toBe(true);
    expect(preview.target_path).toContain(".worktrees");
    expect(preview.task_branch).toBe("devflow/wf-preview/main");

    const existingPreview = previewWorktreePath({
      sourceRoot: tempDir,
      workflowId: "wf-preview",
      mode: "existing_workspace",
    });
    expect(existingPreview.mode).toBe("existing_workspace");
    expect(existingPreview.is_worktree).toBe(false);
    expect(existingPreview.target_path.toLowerCase()).toBe(tempDir.toLowerCase());
  });
});
