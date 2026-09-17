import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { CurrentDeliveryReader } from "../../packages/evidence/src/current-delivery.js";
import { WorkspaceFingerprintService } from "../../packages/workspace/src/fingerprint.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hash, now } from "../../packages/core/src/util.js";

describe("IT-DELIVERY: 当前证据 fail-closed 门槛、测试报告防篡改与全场景覆盖核验 (LF-22~26, RQ-06, RQ-15, RQ-19)", () => {
  let env: IsolatedTestEnv;
  let reader: CurrentDeliveryReader;
  const workflowId = "wf_delivery_test";
  let wsRoot: string;
  let reportPath: string;
  let reportHash: string;
  let currentFp: string;

  beforeEach(() => {
    env = createIsolatedTestEnv();
    reader = new CurrentDeliveryReader(env.store);

    wsRoot = join(env.root, "repo_main");
    mkdirSync(wsRoot, { recursive: true });
    writeFileSync(join(wsRoot, "index.ts"), "export const a = 1;");
    currentFp = WorkspaceFingerprintService.compute(wsRoot).fingerprint;

    mkdirSync(join(env.root, "reports"), { recursive: true });
    reportPath = join(env.root, "reports", "report.json");
    const reportContent = JSON.stringify({ passed: 10, failed: 0 });
    writeFileSync(reportPath, reportContent);
    reportHash = hash(reportContent);

    // 预置 Plan
    env.store.put("plan", `${workflowId}-1`, workflowId, {
      plan: {
        task_model: "native-v2",
        schema_version: "2.0",
        summary: "交付核验计划",
        tests: [{ id: "UT01", layer: "unit", expected_case_ids: ["sc_1"] }],
      },
    });

    // 预置 Workflow
    env.store.put("workflow", workflowId, "proj_deliv", {
      id: workflowId,
      project_id: "proj_deliv",
      title: "交付测试任务",
      state: "VERIFYING",
      version: 1,
      plan_revision: 1,
      plan_hash: "plan_hash_1",
      created_at: now(),
      updated_at: now(),
    });

    // 预置 Workspace
    env.store.put("workspace", "ws_main", workflowId, {
      id: "ws_main",
      workflow_id: workflowId,
      repo_id: "main",
      root: wsRoot,
    });

    // 预置 Run
    env.store.put("run", "run_deliv_1", workflowId, {
      id: "run_deliv_1",
      workflow_id: workflowId,
      plan_revision: 1,
      status: "completed",
      exit_code: 0,
      package_hash: "pkg_1",
      started_at: now(),
    });

    // 预置 Delivery
    env.store.put("delivery", "del_1", workflowId, {
      id: "del_1",
      workflow_id: workflowId,
      status: "passed",
      run_id: "run_deliv_1",
      archive_root: env.root,
      report_hashes: {
        "report.json": reportHash,
      },
      created_at: now(),
    });

    // 预置 DeliveryRevision
    env.store.put("delivery_revision", "drev_1", workflowId, {
      id: "drev_1",
      workflow_id: workflowId,
      delivery_id: "del_1",
      plan_revision: 1,
      plan_hash: "plan_hash_1",
      run_id: "run_deliv_1",
      execution_finished: true,
      input_fingerprints: {
        main: currentFp,
      },
      invalidated: false,
      created_at: now(),
    });

    // 预置 AcceptanceResult
    env.store.put("acceptance_result", "ar_1", workflowId, {
      id: "ar_1",
      workflow_id: workflowId,
      delivery_id: "del_1",
      requirement_id: "UT01",
      scene_id: "sc_1",
      status: "passed",
      executed_at: now(),
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("TC-DELIV-01: 所有证据完整、报告 Hash 匹配且指纹一致时通过核验 (LF-21, RQ-15)", () => {
    const inspection = reader.inspectCurrentDelivery(workflowId);
    expect(inspection.valid).toBe(true);
    expect(inspection.revision?.id).toBe("drev_1");
    expect(inspection.delivery?.id).toBe("del_1");
  });

  it("TC-DELIV-02: 报告文件被外部篡改或被修改时，立即触发防篡改拦截 (LF-23, RQ-15)", () => {
    // 模拟篡改报告内容
    writeFileSync(
      reportPath,
      JSON.stringify({ passed: 10, failed: 0, tampered: true }),
    );

    const inspection = reader.inspectCurrentDelivery(workflowId);
    expect(inspection.valid).toBe(false);
    expect(inspection.reason).toContain("已被外部篡改");
  });

  it("TC-DELIV-03: 代码工作区在交付后发生漂移时，指纹校验阻断 (LF-22, RQ-15)", () => {
    // 模拟工作区在测试完成后被意外修改
    writeFileSync(join(wsRoot, "index.ts"), "export const a = 2; // modified");

    const inspection = reader.inspectCurrentDelivery(workflowId);
    expect(inspection.valid).toBe(false);
    expect(inspection.reason).toContain("输入指纹发生漂移");
  });

  it("TC-DELIV-04: 多仓开发中缺少任一子仓指纹记录时坚决拦截 (LF-26, RQ-19)", () => {
    // 注册第二个子仓
    const subWsRoot = join(env.root, "repo_sub");
    mkdirSync(subWsRoot, { recursive: true });
    env.store.put("workspace", "ws_sub", workflowId, {
      id: "ws_sub",
      workflow_id: workflowId,
      repo_id: "sub",
      root: subWsRoot,
    });

    const inspection = reader.inspectCurrentDelivery(workflowId);
    expect(inspection.valid).toBe(false);
    expect(inspection.reason).toContain("缺少仓库 'sub' 的输入指纹");
  });

  it("TC-DELIV-05: 执行未完成或轮次未成功结束时拒绝对外放行 (LF-24, LF-25)", () => {
    // 将执行状态改回 running
    const run = env.store.get<any>("run", "run_deliv_1");
    run.status = "running";
    env.store.put("run", "run_deliv_1", workflowId, run);

    const inspection = reader.inspectCurrentDelivery(workflowId);
    expect(inspection.valid).toBe(false);
    expect(inspection.reason).toContain("非完成状态");
  });
});
