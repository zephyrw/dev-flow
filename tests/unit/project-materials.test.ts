import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getPlanMaterialPath,
  getReviewMaterialPath,
  getProcessMaterialPath,
  getEvidenceMaterialPath,
  readProjectMaterial,
  writeProjectMaterial,
  resolveProjectMaterialPath,
} from "../../packages/core/src/project-materials.js";

describe("项目材料与证据原件管理 (NV-U09)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-material-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("NV-U09: 正式计划路径约定为 docs/plan/<任务ID>/plan-r<版本>.md", () => {
    const res = getPlanMaterialPath(tempDir, "wf-001", 2);
    expect(res.relativePath).toBe("docs/plan/wf-001/plan-r2.md");
    expect(res.absolutePath).toContain("docs");
  });

  it("NV-U09: 审查结论路径约定为 docs/plan/<任务ID>/review-r<轮次>.md", () => {
    const res = getReviewMaterialPath(tempDir, "wf-001", 1);
    expect(res.relativePath).toBe("docs/plan/wf-001/review-r1.md");
  });

  it("NV-U09: 过程接续说明路径约定为 docs/process/<任务ID>/handover.md", () => {
    const res = getProcessMaterialPath(tempDir, "wf-001");
    expect(res.relativePath).toBe("docs/process/wf-001/handover.md");
  });

  it("NV-U09: 长期测试证据路径约定为 docs/test/evidence/<任务ID>/<轮次>/evidence.json", () => {
    const res = getEvidenceMaterialPath(tempDir, "wf-001", 1, "test-report.json");
    expect(res.relativePath).toBe("docs/test/evidence/wf-001/1/test-report.json");
  });

  it("NV-U09: 原件优先读取：当项目原件存在时优先读取项目原件，忽略旧缓存", () => {
    const rel = "docs/plan/wf-test/plan.md";
    writeProjectMaterial({
      workspaceRoot: tempDir,
      workflowId: "wf-test",
      category: "plan",
      filename: "plan.md",
      content: "# 项目原件正文",
      customRelPath: rel,
    });

    const cacheFile = join(tempDir, "cache.md");
    writeFileSync(cacheFile, "# 平台旧缓存", "utf8");

    const readRes = readProjectMaterial({
      workspaceRoot: tempDir,
      relativePath: rel,
      cachePath: cacheFile,
    });

    expect(readRes.exists).toBe(true);
    expect(readRes.isFromProject).toBe(true);
    expect(readRes.isFromCache).toBe(false);
    expect(readRes.content).toBe("# 项目原件正文");
  });

  it("NV-U09: 缓存回退读取：项目原件缺失时允许从平台缓存读取", () => {
    const rel = "docs/plan/wf-missing/plan.md";
    const cacheFile = join(tempDir, "cache.md");
    writeFileSync(cacheFile, "# 平台备用缓存", "utf8");

    const readRes = readProjectMaterial({
      workspaceRoot: tempDir,
      relativePath: rel,
      cachePath: cacheFile,
    });

    expect(readRes.exists).toBe(true);
    expect(readRes.isFromProject).toBe(false);
    expect(readRes.isFromCache).toBe(true);
    expect(readRes.content).toBe("# 平台备用缓存");
  });
});
