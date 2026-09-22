import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  writeProjectMaterial,
  readProjectMaterial,
  getPlanMaterialPath,
  getReviewMaterialPath,
  getEvidenceMaterialPath,
} from "../../packages/core/src/project-materials.js";
import { Store } from "../../packages/store/src/store.js";
import { readPlanMaterial } from "../../packages/core/src/plan-review.js";
import { hash } from "../../packages/core/src/util.js";
import type {
  ProjectMaterial,
  Workspace,
  Run,
} from "../../packages/contracts/src/index.js";
import type { PlanRecord } from "../../packages/core/src/engine.js";

describe("NV-I14 & NV-U09: 正式项目材料归属与优先读取机制集成测试", () => {
  let tempDir: string;
  let workspaceRoot: string;
  let cacheRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-material-ownership-"));
    workspaceRoot = join(tempDir, "workspace");
    cacheRoot = join(tempDir, "cache");
    mkdirSync(workspaceRoot, { recursive: true });
    mkdirSync(cacheRoot, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("正式计划原件写入项目规范目录并返回正确的相对与绝对路径", () => {
    const wfId = "wf-material-001";
    const planContent = "# 项目正式计划正文\n\n本任务必须在项目内保存。";

    const loc = writeProjectMaterial({
      workspaceRoot,
      workflowId: wfId,
      category: "plan",
      filename: "plan.md",
      content: planContent,
    });

    expect(loc.relativePath).toBe(`docs/plan/${wfId}/plan.md`);
    expect(existsSync(loc.absolutePath)).toBe(true);
    expect(readFileSync(loc.absolutePath, "utf8")).toBe(planContent);
  });

  it("优先读取项目内原件，即使缓存存在不同内容也以项目原件为准", () => {
    const wfId = "wf-material-002";
    const planLoc = getPlanMaterialPath(workspaceRoot, wfId);
    
    // 写入项目原件
    writeProjectMaterial({
      workspaceRoot,
      workflowId: wfId,
      category: "plan",
      filename: "plan.md",
      content: "# 权威项目原件",
    });

    // 写入过时的缓存副本
    const staleCacheDir = join(cacheRoot, wfId);
    mkdirSync(staleCacheDir, { recursive: true });
    const cacheFile = join(staleCacheDir, "plan.md");
    writeFileSync(cacheFile, "# 过时的平台缓存");

    const readRes = readProjectMaterial({
      workspaceRoot,
      relativePath: planLoc.relativePath,
      cachePath: cacheFile,
    });

    expect(readRes.exists).toBe(true);
    expect(readRes.isFromProject).toBe(true);
    expect(readRes.isFromCache).toBe(false);
    expect(readRes.content).toBe("# 权威项目原件");
  });

  it("当项目原件不存在但有缓存时回退读取缓存；缓存故障时不阻塞调度", () => {
    const wfId = "wf-material-003";
    const planLoc = getPlanMaterialPath(workspaceRoot, wfId);
    
    // 缓存文件存在
    const cacheFile = join(cacheRoot, wfId, "cached-plan.md");
    mkdirSync(join(cacheRoot, wfId), { recursive: true });
    writeFileSync(cacheFile, "# 历史缓存计划");

    const readRes = readProjectMaterial({
      workspaceRoot,
      relativePath: planLoc.relativePath,
      cachePath: cacheFile,
    });

    expect(readRes.exists).toBe(true);
    expect(readRes.isFromProject).toBe(false);
    expect(readRes.isFromCache).toBe(true);
    expect(readRes.content).toBe("# 历史缓存计划");

    // 缓存不存在或损坏时，安全返回 exists: false，绝不抛出异常阻塞调度
    const missingRes = readProjectMaterial({
      workspaceRoot,
      relativePath: "docs/plan/not-exist/plan.md",
      cachePath: join(cacheRoot, "not-exist", "non-existent.md"),
    });

    expect(missingRes.exists).toBe(false);
    expect(missingRes.content).toBe("");
  });

  it("审查结论与长期测试证据分别归属项目内 docs/plan 与 docs/test/evidence", () => {
    const wfId = "wf-material-004";

    // 审查结论
    const reviewLoc = writeProjectMaterial({
      workspaceRoot,
      workflowId: wfId,
      category: "review",
      filename: "review-r1.md",
      round: 1,
      content: "# 第一道代码复核结论：通过",
    });
    expect(reviewLoc.relativePath).toBe(`docs/plan/${wfId}/review-r1.md`);

    // 测试证据
    const evidenceLoc = writeProjectMaterial({
      workspaceRoot,
      workflowId: wfId,
      category: "test_evidence",
      filename: "test-evidence.json",
      round: 1,
      content: JSON.stringify({ passed: true, exitCode: 0 }),
    });
    expect(evidenceLoc.relativePath).toBe(`docs/test/evidence/${wfId}/1/test-evidence.json`);
    expect(existsSync(evidenceLoc.absolutePath)).toBe(true);
  });
});

describe("CW4-F03: readPlanMaterial 计划材料归属、版本关联与原件防掩盖集成测试", () => {
  let tempDir: string;
  let store: Store;
  let workspaceRoot: string;
  const wfId = "wf-mat-ownership-test";
  const wsId = "ws-mat-1";

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-plan-material-"));
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
    workspaceRoot = join(tempDir, "workspace");
    mkdirSync(workspaceRoot, { recursive: true });

    store.put("workspace", wsId, wfId, {
      id: wsId,
      workflow_id: wfId,
      repo_id: "main",
      source_root: workspaceRoot,
      root: workspaceRoot,
    } as any);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("新计划按 material_id 优先精确读取；关联材料丢失时不掩盖", () => {
    const planText = "# 新计划正文\n第一行需求说明\n";
    const planPath = join(workspaceRoot, "docs", "plan", "plan-v1.md");
    mkdirSync(join(workspaceRoot, "docs", "plan"), { recursive: true });
    writeFileSync(planPath, planText);

    const matId = "mat-plan-v1-uuid";
    const mat: ProjectMaterial = {
      id: matId,
      workflow_id: wfId,
      workspace_id: wsId,
      path: "docs/plan/plan-v1.md",
      kind: "plan",
      revision: 1,
      source_hash: hash(planText),
      status: "verified",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.put("project_material", matId, wfId, mat);

    const planRecord: PlanRecord = {
      id: "plan-rec-1",
      workflow_id: wfId,
      revision: 1,
      hash: hash(planText),
      material_id: matId,
      created_at: new Date().toISOString(),
      plan: {
        title: "新计划",
        tasks: [],
      } as any,
    };
    store.put("plan", planRecord.id, wfId, planRecord);

    // 1. 成功读取
    const res = readPlanMaterial(store, wfId, 1);
    expect(res.source_type).toBe("project");
    expect(res.markdown).toBe(planText);
    expect(res.material_id).toBe(matId);

    // 2. 若 material_id 对应材料记录丢失，绝不掩盖，抛出 409 PLAN_MATERIAL_LOST
    store.remove("project_material", matId);
    expect(() => {
      readPlanMaterial(store, wfId, 1);
    }).toThrow(/计划关联的项目材料记录已丢失/);
  });

  it("旧数据无 material_id 时，输入版本 N 的已完成规划 Run 对应第 N+1 版材料", () => {
    const planTextV2 = "# 第二版计划产物\n基于第1版规划Run生成\n";
    const planPathV2 = join(workspaceRoot, "docs", "plan", "plan-v2.md");
    mkdirSync(join(workspaceRoot, "docs", "plan"), { recursive: true });
    writeFileSync(planPathV2, planTextV2);

    const runId = "run-planning-step-1";
    // 输入版本 N = 1 的已完成规划 Run，产物对应 N + 1 = 2
    const planningRun: Run = {
      id: runId,
      workflow_id: wfId,
      plan_revision: 1,
      status: "completed",
      purpose: "planning",
    } as any;
    store.put("run", runId, wfId, planningRun);

    const matId = `mat_${wfId}_plan_r2_run_${runId}`;
    const mat: ProjectMaterial = {
      id: matId,
      workflow_id: wfId,
      workspace_id: wsId,
      path: "docs/plan/plan-v2.md",
      kind: "plan",
      revision: 2,
      source_hash: hash(planTextV2),
      status: "verified",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.put("project_material", matId, wfId, mat);

    // 旧格式计划，无 material_id
    const planRecordV2: PlanRecord = {
      id: "plan-rec-2",
      workflow_id: wfId,
      revision: 2,
      hash: hash(planTextV2),
      created_at: new Date().toISOString(),
      plan: {
        title: "第2版计划",
        tasks: [],
      } as any,
    };
    store.put("plan", planRecordV2.id, wfId, planRecordV2);

    const res = readPlanMaterial(store, wfId, 2);
    expect(res.source_type).toBe("project");
    expect(res.markdown).toBe(planTextV2);
  });

  it("不同 Run 的同版本材料不能靠首条顺序选取，存在歧义时抛出 409 PLAN_MATERIAL_AMBIGUOUS", () => {
    const run1 = "run-plan-alpha";
    const run2 = "run-plan-beta";

    store.put("run", run1, wfId, {
      id: run1,
      workflow_id: wfId,
      plan_revision: 0,
      status: "completed",
      purpose: "planning",
    } as any);

    store.put("run", run2, wfId, {
      id: run2,
      workflow_id: wfId,
      plan_revision: 0,
      status: "completed",
      purpose: "planning",
    } as any);

    // 同一版本下存在由两个规划 Run 生成的两份材料
    const mat1: ProjectMaterial = {
      id: `mat_${wfId}_plan_r1_run_${run1}`,
      workflow_id: wfId,
      workspace_id: wsId,
      path: "docs/plan/plan-alpha.md",
      kind: "plan",
      revision: 1,
      source_hash: "hash-alpha",
      status: "verified",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const mat2: ProjectMaterial = {
      id: `mat_${wfId}_plan_r1_run_${run2}`,
      workflow_id: wfId,
      workspace_id: wsId,
      path: "docs/plan/plan-beta.md",
      kind: "plan",
      revision: 1,
      source_hash: "hash-beta",
      status: "verified",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.put("project_material", mat1.id, wfId, mat1);
    store.put("project_material", mat2.id, wfId, mat2);

    const planRecord: PlanRecord = {
      id: "plan-ambiguous",
      workflow_id: wfId,
      revision: 1,
      hash: "some-hash",
      created_at: new Date().toISOString(),
      plan: { title: "歧义计划", tasks: [] } as any,
    };
    store.put("plan", planRecord.id, wfId, planRecord);

    // 绝不按首条选取，必须抛出歧义拦截
    expect(() => {
      readPlanMaterial(store, wfId, 1);
    }).toThrow(/存在多个材料来源，不能自动选择/);
  });

  it("已发布材料原件丢失或被修改不得显示旧缓存，无 design_ref 时也按 material.source_hash 校验", () => {
    const originalText = "原始计划正文\n";
    const planPath = join(workspaceRoot, "docs", "plan", "plan-tamper.md");
    mkdirSync(join(workspaceRoot, "docs", "plan"), { recursive: true });
    writeFileSync(planPath, originalText);

    const originalHash = hash(originalText);
    const matId = "mat-tamper-test";
    const mat: ProjectMaterial = {
      id: matId,
      workflow_id: wfId,
      workspace_id: wsId,
      path: "docs/plan/plan-tamper.md",
      kind: "plan",
      revision: 1,
      source_hash: originalHash,
      status: "verified",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.put("project_material", matId, wfId, mat);

    // 准备一份旧的平台缓存
    store.put("project_document", "doc-tamper", wfId, {
      id: "doc-tamper",
      workflow_id: wfId,
      revision: 1,
      document_type: "plan",
      content: "# 旧平台缓存内容",
    } as any);

    // 计划无 design_ref
    const planRecord: PlanRecord = {
      id: "plan-tamper",
      workflow_id: wfId,
      revision: 1,
      hash: originalHash,
      material_id: matId,
      created_at: new Date().toISOString(),
      plan: { title: "无design_ref计划", tasks: [] } as any,
    };
    store.put("plan", planRecord.id, wfId, planRecord);

    // 1. 原件被篡改修改，即使无 design_ref，也通过 material.source_hash 检查并报 409
    writeFileSync(planPath, "篡改后的计划正文\n");
    expect(() => {
      readPlanMaterial(store, wfId, 1);
    }).toThrow(/项目中的计划原件已被修改.*发生原件冲突/);

    // 2. 原件文件丢失，禁止以平台缓存掩盖，抛出 409 PLAN_MATERIAL_LOST
    rmSync(planPath, { force: true });
    expect(() => {
      readPlanMaterial(store, wfId, 1);
    }).toThrow(/已发布的项目计划原件已丢失.*禁止以平台缓存掩盖/);
  });

  it("真正没有项目材料记录的历史计划保留 platform_legacy 兼容；pending 状态保留 result_pending 逻辑", () => {
    // 1. 历史旧计划：无任何 project_material 记录
    const legacyDoc = {
      id: "doc-legacy-1",
      workflow_id: wfId,
      revision: 1,
      document_type: "plan",
      content: "# 历史旧任务缓存内容",
    };
    store.put("project_document", legacyDoc.id, wfId, legacyDoc as any);

    const legacyPlanRecord: PlanRecord = {
      id: "plan-legacy-1",
      workflow_id: wfId,
      revision: 1,
      hash: "hash-legacy",
      created_at: new Date().toISOString(),
      plan: { title: "纯历史任务", tasks: [] } as any,
    };
    store.put("plan", legacyPlanRecord.id, wfId, legacyPlanRecord);

    const resLegacy = readPlanMaterial(store, wfId, 1);
    expect(resLegacy.source_type).toBe("platform_legacy");
    expect(resLegacy.markdown).toBe("# 历史旧任务缓存内容");

    // 2. pending 状态：材料未落盘但属于本轮生成 (result_pending)
    const pendingMatId = "mat-pending-v2";
    const pendingMat: ProjectMaterial = {
      id: pendingMatId,
      workflow_id: wfId,
      workspace_id: wsId,
      path: "docs/plan/plan-v2-pending.md",
      kind: "plan",
      revision: 2,
      source_hash: "hash-pending",
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    store.put("project_material", pendingMatId, wfId, pendingMat);

    const pendingDoc = {
      id: "doc-pending-2",
      workflow_id: wfId,
      revision: 2,
      document_type: "plan",
      content: "# Pending 生成中的正文",
    };
    store.put("project_document", pendingDoc.id, wfId, pendingDoc as any);

    const pendingPlanRecord: PlanRecord = {
      id: "plan-pending-2",
      workflow_id: wfId,
      revision: 2,
      hash: "hash-pending",
      material_id: pendingMatId,
      created_at: new Date().toISOString(),
      plan: { title: "生成中任务", tasks: [] } as any,
    };
    store.put("plan", pendingPlanRecord.id, wfId, pendingPlanRecord);

    const resPending = readPlanMaterial(store, wfId, 2);
    expect(resPending.source_type).toBe("result_pending");
    expect(resPending.markdown).toBe("# Pending 生成中的正文");
  });
});
