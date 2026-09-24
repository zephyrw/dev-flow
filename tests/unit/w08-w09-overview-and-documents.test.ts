import { describe, expect, it, beforeEach } from "vitest";
import { setup, repository, project } from "../helpers.js";
import {
  projectWorkflowOverview,
  extractMarkdownSection,
} from "../../packages/core/src/workflow-overview.js";
import { createApprovedExecutionInstructions } from "../../packages/core/src/execution-instructions.js";
import { buildServer } from "../../apps/api/src/server.js";

describe("W08 & W09: 概览业务摘要投影与文档下载修复测试 (D07/D08)", () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  it("extractMarkdownSection 按标准标题提取内容与列表，不伪造语义", () => {
    const md = [
      "# 总体设计",
      "## 背景与目标",
      "解决订单导出超时问题，提升大列表导出稳定性。",
      "- 支持流式 CSV 输出",
      "- 限制单次导出上限为 10 万条",
      "## 调研结论",
      "- 现有接口一次性将全表读入内存导致 OOM",
      "- 采用游标分页可降低 90% 内存占用",
      "## 主要实施任务",
      "1. 改造查询游标",
    ].join("\n");

    const goalSec = extractMarkdownSection(md, ["背景与目标"]);
    expect(goalSec).not.toBeNull();
    expect(goalSec?.heading).toBe("背景与目标");
    expect(goalSec?.bullets).toEqual([
      "支持流式 CSV 输出",
      "限制单次导出上限为 10 万条",
    ]);

    const researchSec = extractMarkdownSection(md, ["调研结论"]);
    expect(researchSec).not.toBeNull();
    expect(researchSec?.bullets).toHaveLength(2);

    const missingSec = extractMarkdownSection(md, ["不存在的章节"]);
    expect(missingSec).toBeNull();
  });

  it("无计划时：progress.tasks 与 progress.tests 均为 null（不制造 0% 假进度）", () => {
    const detail = {
      workflow: {
        id: "wf-empty",
        version: 1,
        plan_revision: 0,
        plan_hash: null,
        title: "初始化需求",
        request: "请帮我检查登录页面的样式错位问题。",
      },
      plan: null,
      tasks: [],
      evidence: [],
    };

    const overview = projectWorkflowOverview(detail, env.store);
    expect(overview.workflow_id).toBe("wf-empty");
    expect(overview.goal.status).toBe("unstructured");
    expect(overview.goal.summary).toContain("登录页面的样式错位");
    expect(overview.tasks).toHaveLength(0);
    expect(overview.tests).toHaveLength(0);
    expect(overview.progress.tasks).toBeNull();
    expect(overview.progress.tests).toBeNull();
    expect(overview.execution_constraints).toBeNull();
  });

  it("有计划、证据与同版审批指令时：准确投影排序、区分已设计/已通过测试并绑定执行约束", () => {
    const instructions = createApprovedExecutionInstructions(
      "禁止修改公共认证中间件；仅在 orders 模块内改动。",
    )!;

    env.store.put("plan_approval", "wf-1:2", "wf-1", {
      schema_version: 2,
      workflow_id: "wf-1",
      plan_revision: 2,
      revision: 2,
      plan_hash: "hash-r2",
      approved_at: new Date().toISOString(),
      execution_instructions: instructions,
    });

    const detail = {
      workflow: {
        id: "wf-1",
        version: 5,
        plan_revision: 2,
        plan_hash: "hash-r2",
        title: "订单导出改造",
        request: "原始长需求",
      },
      plan: {
        plan: {
          task_model: "native-v2",
          design_ref: {
            summary: "通过流式游标重构订单导出接口，消除内存溢出。",
          },
          scope: {
            allowed_paths: ["packages/orders/src"],
            allow_dependency_changes: false,
            allow_public_api_changes: false,
          },
          decisions: [
            {
              decision: "使用 Node Readable Stream 边查边推",
              rationale: "避免大数组驻留 V8 堆",
            },
          ],
          unresolved_decisions: ["是否需要同时支持 Excel .xlsx 格式"],
          work_items: [
            { id: "wi-1", title: "已完成的基础任务", status: "completed" },
            { id: "wi-2", title: "受阻的关键任务", status: "blocked" },
            { id: "wi-3", title: "正在进行的任务", status: "in_progress" },
          ],
          acceptance_items: [
            {
              id: "acc-1",
              scenario: "导出 5 万条记录内存平稳",
              expected: "内存增幅 < 50MB",
            },
            {
              id: "acc-2",
              scenario: "无权限用户拒绝导出",
              expected: "返回 403",
            },
          ],
        },
      },
      tasks: [
        { id: "wi-1", title: "已完成的基础任务", status: "completed" },
        { id: "wi-2", title: "受阻的关键任务", status: "blocked" },
        { id: "wi-3", title: "正在进行的任务", status: "in_progress" },
      ],
      evidence: [
        // acc-1 在同版本 (plan_revision=2) 通过
        {
          acceptance_item_id: "acc-1",
          plan_revision: 2,
          passed: true,
          status: "passed",
        },
        // acc-2 仅有旧版本 (plan_revision=1) 通过记录 -> 应识别为 stale (待复测)
        {
          acceptance_item_id: "acc-2",
          plan_revision: 1,
          passed: true,
          status: "passed",
        },
      ],
    };

    const overview = projectWorkflowOverview(detail, env.store);

    // 1. 目标与背景
    expect(overview.goal.status).toBe("available");
    expect(overview.goal.summary).toBe(
      "通过流式游标重构订单导出接口，消除内存溢出。",
    );
    expect(overview.background.items).toContain("约束：不允许变更外部依赖包");

    // 2. 调研结论与待决问题严格分离
    expect(overview.findings).toHaveLength(1);
    expect(overview.findings[0]?.title).toContain("Node Readable Stream");
    expect(overview.unresolved).toEqual([
      "是否需要同时支持 Excel .xlsx 格式",
    ]);

    // 3. 任务排序：blocked -> in_progress -> completed
    expect(overview.tasks.map((t) => t.id)).toEqual(["wi-2", "wi-3", "wi-1"]);
    expect(overview.progress.tasks).toEqual({
      total: 3,
      completed: 1,
      in_progress: 1,
      failed_or_blocked: 1,
      percentage: 33,
    });

    // 4. 测试状态：acc-2 为 stale 排在 passed (acc-1) 前面，且不计入当前通过数
    expect(overview.tests.map((t) => `${t.id}:${t.status}`)).toEqual([
      "acc-2:stale",
      "acc-1:passed",
    ]);
    expect(overview.progress.tests).toEqual({
      total: 2,
      completed: 1,
      failed_or_blocked: 0,
      percentage: 50,
    });

    // 5. 审批附加执行约束
    expect(overview.execution_constraints).not.toBeNull();
    expect(overview.execution_constraints?.text).toContain("禁止修改公共认证中间件");
  });

  it("D07 & D08: /api/workflows/:id/documents/plan 支持回退读取 ${id}-${rev} 主键并支持真实 Markdown 下载", async () => {
    const repo = await repository(env.root);
    const p = project(repo.repo);
    await env.engine.registerProject(p);
    const created = env.engine.create(
      {
        project_id: p.id,
        title: "测试文档下载",
        request: "验证计划文档下载与回退读取",
        complexity: "simple",
        workspace_mode: "existing_workspace",
      },
      "doc-test-1",
    );
    const wfId = created.id;

    // 模拟 submitPlan 写入的 "${key}-${revision}" 主键格式（无 project_document 记录）
    const wf = env.engine.get(wfId);
    wf.plan_revision = 1;
    wf.plan_hash = "plan-hash-v1";
    wf.state = "PLAN_PENDING";
    env.store.put("workflow", wfId, p.id, wf);

    const realMarkdown = [
      "# 订单导出优化开发计划",
      "",
      "## 背景与目标",
      "实现高性能流式导出。",
      "",
      "## 主要实施任务",
      "- 实现流式读取器",
    ].join("\n");

    // 仅存入 `${wfId}-1` 主键（复现 D08 场景）
    env.store.put("plan", `${wfId}-1`, wfId, {
      id: `${wfId}-1`,
      workflow_id: wfId,
      revision: 1,
      hash: "plan-hash-v1",
      approved_by_human: false,
      plan: {
        title: "订单导出优化开发计划",
        summary: "实现高性能流式导出。",
        markdown: realMarkdown,
      },
    });

    const app = await buildServer(env.engine);

    // 1. JSON 读取接口 (验证 D08 回退读取 `${wfId}-1` 成功)
    const jsonRes = await app.inject({
      method: "GET",
      url: `/api/workflows/${wfId}/documents/plan`,
      headers: { host: "localhost:14810", origin: "http://localhost:14810" },
    });
    expect(jsonRes.statusCode).toBe(200);
    const jsonBody = JSON.parse(jsonRes.body);
    expect(jsonBody.ok).toBe(true);
    expect(jsonBody.document.content).toContain("# 订单导出优化开发计划");

    // 2. Markdown 下载接口 (?format=markdown&download=1，验证 D07)
    const dlRes = await app.inject({
      method: "GET",
      url: `/api/workflows/${wfId}/documents/plan?format=markdown&download=1`,
      headers: { host: "localhost:14810", origin: "http://localhost:14810" },
    });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers["content-type"]).toContain("text/markdown");
    expect(dlRes.headers["content-disposition"]).toContain("attachment");
    expect(dlRes.headers["content-disposition"]).toContain(".md");
    expect(dlRes.body.startsWith("# 订单导出优化开发计划")).toBe(true);
    expect(dlRes.body).not.toContain('"document_type"');

    // 3. 验证 /api/workflows/:id/overview 路由返回结构化投影
    const ovRes = await app.inject({
      method: "GET",
      url: `/api/workflows/${wfId}/overview`,
      headers: { host: "localhost:14810", origin: "http://localhost:14810" },
    });
    expect(ovRes.statusCode).toBe(200);
    const ovData = JSON.parse(ovRes.body);
    expect(ovData.workflow_id).toBe(wfId);
    expect(ovData.goal.summary).toBe("实现高性能流式导出。");

    await app.close();
  });
});
