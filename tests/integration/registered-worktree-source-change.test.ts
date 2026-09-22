import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { WorkspaceFingerprintService, resolveExcludedRelativePaths } from "../../packages/workspace/src/fingerprint.js";
import { Store } from "../../packages/store/src/store.js";

describe("CW2-T06: 嵌套/已登记工作树与备份子树的指纹与变更排除集成测试", () => {
  let tempDir: string;
  let repoDir: string;
  let customSubtreeDir: string;
  let store: Store;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-source-change-"));
    repoDir = join(tempDir, "sample-repo");
    customSubtreeDir = join(repoDir, "custom-nested-tree");
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);

    // 1. 初始化 Git 仓库
    execFileSync("git", ["init", repoDir]);
    execFileSync("git", ["config", "user.name", "DevFlow Test"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@devflow.local"], { cwd: repoDir });
    writeFileSync(join(repoDir, "main-file.txt"), "hello main\n");
    execFileSync("git", ["add", "main-file.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init commit"], { cwd: repoDir });

    // 2. 建立一个真实登记在 source 内部的非默认名称子 worktree
    execFileSync("git", ["worktree", "add", "-b", "sub-branch", customSubtreeDir, "HEAD"], { cwd: repoDir });
    writeFileSync(join(customSubtreeDir, "sub-file.txt"), "hello sub\n");

    // 3. 在 store 中登记该子工作区
    store.put("workspace", "ws-sub-001", "wf-sub-001", {
      id: "ws-sub-001",
      workflow_id: "wf-sub-001",
      repo_id: "main",
      source_root: repoDir,
      root: customSubtreeDir,
      branch: "sub-branch",
      mode: "new_worktree",
      owned: true,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  function getScanContext(backupRoots?: string[]) {
    const allWorkspaces = store.list<any>("workspace");
    return resolveExcludedRelativePaths(repoDir, {
      knownWorkspaces: allWorkspaces,
      currentWorkspaceRoot: repoDir,
      backupRoots,
    });
  }

  it("CW2-T06: source 内有登记子 worktree 时，未改动的主仓库指纹计算成功且排除子树内容", () => {
    const scanContext = getScanContext();
    expect(scanContext.registeredWorktrees.length).toBeGreaterThan(0);

    const fp1 = WorkspaceFingerprintService.compute(repoDir, scanContext);
    // 应当只包含主仓库文件，不包含子 worktree 内的文件
    const filePaths = fp1.files.map((f) => f.path);
    expect(filePaths).toContain("main-file.txt");
    expect(filePaths.some((p) => p.includes("custom-nested-tree"))).toBe(false);

    // 再次计算指纹，两者必须严格相等（不会产生假性 SOURCE_CHANGED）
    const fp2 = WorkspaceFingerprintService.compute(repoDir, scanContext);
    expect(fp2.fingerprint).toBe(fp1.fingerprint);
  });

  it("CW2-T06: 子 worktree 内文件单独发生变更，不影响主仓库指纹与扫描", () => {
    const scanContext = getScanContext();
    const fpInitial = WorkspaceFingerprintService.compute(repoDir, scanContext);

    // 修改子 worktree 内的文件
    writeFileSync(join(customSubtreeDir, "sub-file.txt"), "modified sub content\n");
    writeFileSync(join(customSubtreeDir, "new-sub.txt"), "new sub file\n");

    // 主仓库指纹应当保持不变
    const fpAfterSubChange = WorkspaceFingerprintService.compute(repoDir, scanContext);
    expect(fpAfterSubChange.fingerprint).toBe(fpInitial.fingerprint);
  });

  it("CW2-T06: 主仓库真实修改被准确识别", () => {
    const scanContext = getScanContext();
    const fpInitial = WorkspaceFingerprintService.compute(repoDir, scanContext);

    // 修改主仓库真实文件
    writeFileSync(join(repoDir, "main-file.txt"), "hello main updated\n");

    const fpAfterMainChange = WorkspaceFingerprintService.compute(repoDir, scanContext);
    expect(fpAfterMainChange.fingerprint).not.toBe(fpInitial.fingerprint);
  });

  it("CW2-T06: 备份子树自动被排除，但普通代码目录正常计入", () => {
    // 模拟存在备份子树 docs/process/wf-1/migration-backup
    const backupDir = join(repoDir, "docs", "process", "wf-1", "migration-backup");
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(backupDir, "backup-data.db"), "fake binary db");

    // 模拟同时存在用户普通代码目录 src/utils
    const srcDir = join(repoDir, "src", "utils");
    mkdirSync(srcDir, { recursive: true });
    writeFileSync(join(srcDir, "math.ts"), "export const add = (a, b) => a + b;");

    const scanContext = getScanContext([backupDir]);
    const fp = WorkspaceFingerprintService.compute(repoDir, scanContext);
    const paths = fp.files.map((f) => f.path);

    // 普通代码目录必须计入
    expect(paths).toContain("src/utils/math.ts");
    // 备份子树必须被排除
    expect(paths.some((p) => p.includes("migration-backup"))).toBe(false);
  });
});
