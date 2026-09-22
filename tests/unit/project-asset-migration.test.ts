import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { Store } from "../../packages/store/src/store.js";
import {
  previewProjectAssetMigration,
  applyProjectAssetMigration,
} from "../../scripts/migrate-project-assets.js";

describe("NV-U10 & NV-R14: 历史项目资产与工作树迁移单元测试", () => {
  let tempDir: string;
  let store: Store;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-asset-mig-test-"));
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("正确识别工作区并生成预览报告", () => {
    const fakePlatformWs = join(tempDir, ".devflow", "worktrees", "wf-legacy-1", "main");
    const sourceProjectDir = join(tempDir, "my-project");
    mkdirSync(fakePlatformWs, { recursive: true });
    mkdirSync(sourceProjectDir, { recursive: true });

    // 录入旧工作区记录
    store.put("workspace", "ws-1", "wf-legacy-1", {
      id: "ws-1",
      workflow_id: "wf-legacy-1",
      repo_id: "main",
      source_root: sourceProjectDir,
      root: fakePlatformWs,
      branch: "devflow/wf-legacy-1",
      mode: "new_worktree",
      created_at: Date.now(),
      updated_at: Date.now(),
    });

    const report = previewProjectAssetMigration(store as any, join(tempDir, "storage"));
    expect(report.totalWorkspaces).toBe(1);
    expect(report.workspaces[0]!.id).toBe("ws-1");
  });

  it("执行迁移防旁路保护：调用旧 applyProjectAssetMigration 抛错，禁止直接改库", () => {
    expect(() => {
      applyProjectAssetMigration(store, join(tempDir, "storage"));
    }).toThrow(/禁止直接改库/);
  });
});
