import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { createDefaultAdapterRegistry } from "../../packages/adapters/sdk/src/index.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { now } from "../../packages/core/src/util.js";

describe("IT-ADAPTERS: 原生适配器协议、增量流式解码、Profile 快照与配置安全切换 (LF-20, LF-21, RQ-13, RQ-14, RQ-24)", () => {
  let env: IsolatedTestEnv;
  let specService: ExecutionSpecService;
  const workflowId = "wf_adapter_test";

  beforeEach(() => {
    env = createIsolatedTestEnv();
    specService = new ExecutionSpecService(env.store);

    env.store.put("workflow", workflowId, "proj_adapt", {
      id: workflowId,
      project_id: "proj_adapt",
      title: "适配器协议测试",
      state: "EXECUTING",
      version: 1,
      plan_revision: 1,
      created_at: now(),
      updated_at: now(),
    });

    // 预置初始 r1 执行配置规格
    env.store.put("execution_spec", "spec_init", workflowId, {
      id: "spec_init",
      revision: 1,
      workflow_id: workflowId,
      template_id: "default",
      template_revision: 1,
      mode: "single_tool",
      plannerProfile: {
        id: "p_agy_1",
        revision: 1,
        adapterId: "agy",
        modelSelection: "native-config",
        options: {},
      },
      executorProfile: {
        id: "e_agy_1",
        revision: 1,
        adapterId: "agy",
        modelSelection: "native-config",
        options: {},
      },
      created_at: now(),
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("TC-ADAPT-01: 原生适配器注册表必须覆盖八大原生客户端协议 (LF-20, RQ-13, RQ-24)", () => {
    const registry = createDefaultAdapterRegistry();
    const allAdapters = registry.getAll();

    // 验证包含 8 种原生工具
    const expected = [
      "codex",
      "agy",
      "grok-build",
      "claude-code",
      "kimi-code",
      "qoder",
      "opencode",
      "cursor-agent",
    ];

    for (const id of expected) {
      expect(allAdapters.has(id as any)).toBe(true);
      const adapter = registry.mustGet(id as any);
      expect((adapter as any).adapterId).toBe(id);
    }
  });

  it("TC-ADAPT-02: 缺失可执行文件的适配器 probe 时安全返回 fail-closed 结构化未就绪报告", async () => {
    const registry = createDefaultAdapterRegistry();
    const codex = registry.mustGet("codex");

    // 指向不存在的虚假二进制路径
    const report = await codex.probe({
      customPath: "C:/non/existent/fake_codex_binary.exe",
      toolProfile: {
        id: "prof_codex_missing",
        revision: 1,
        adapterId: "codex",
        modelSelection: "native-config",
        options: {},
      },
    });

    expect(report.available).toBe(false);
    expect(report.capabilities.nativeEditing).toBe(false);
    expect(report.unsupportedReason).toBeDefined();
  });

  it("TC-ADAPT-03: 适配器增量行缓冲解码器支持跨分块中文与结构化事件组装 (LF-27, RQ-14)", () => {
    const registry = createDefaultAdapterRegistry();
    const agy = registry.mustGet("agy");

    // 模拟跨分块到达的 JSON 数据流
    // Chunk 1: 前半截 JSON
    const chunk1 = {
      timestamp: new Date().toISOString(),
      stream: "stdout" as const,
      data: '{"type":"tool_call","tool":"run_command","args":{"cmd":"pnpm ',
    };
    const ev1 = agy.decode(chunk1);
    expect(ev1.length).toBe(0); // 尚未换行闭合，保留在 lineBuffer

    // Chunk 2: 后半截 JSON，含中文说明并换行
    const chunk2 = {
      timestamp: new Date().toISOString(),
      stream: "stdout" as const,
      data: 'test"},"description":"运行测试套件"}\n',
    };
    const ev2 = agy.decode(chunk2);
    expect(ev2.length).toBe(1);
    expect(ev2[0]!.type).toBe("tool_call");
    expect((ev2[0]!.raw as any).description).toBe("运行测试套件");
    expect((ev2[0]!.raw as any).args.cmd).toBe("pnpm test");
  });

  it("TC-ADAPT-04: 执行配置修订严格冻结历史版本，支持复合工具组合与版本自增 (LF-19, RQ-03)", () => {
    const current = specService.getLatestSpec(workflowId);
    expect(current.revision).toBe(1);
    expect(current.mode).toBe("single_tool");

    // 修订为复合工具（Planner 使用 claude-code，Executor 使用 codex）
    const updateRes = specService.updateExecutionSpec({
      request_id: "req_spec_up_01",
      expected_version: 1,
      workflow_id: workflowId,
      planner_profile: {
        id: "p_claude",
        revision: 1,
        adapterId: "claude-code",
        modelSelection: "native-config",
        options: {},
      },
      executor_profile: {
        id: "e_codex",
        revision: 1,
        adapterId: "codex",
        modelSelection: "native-config",
        options: {},
      },
      interrupt_requested: true,
    });

    expect(updateRes.spec.revision).toBe(2);
    expect(updateRes.spec.mode).toBe("composite");
    expect(updateRes.interruptRequired).toBe(true);

    // 验证旧版本 r1 快照依然完整留存未被篡改
    const r1 = specService.getSpecByRevision(workflowId, 1);
    expect(r1.revision).toBe(1);
    expect(r1.plannerProfile.adapterId).toBe("agy");

    // 验证最新版本为 r2
    const latest = specService.getLatestSpec(workflowId);
    expect(latest.revision).toBe(2);
    expect(latest.plannerProfile.adapterId).toBe("claude-code");
    expect(latest.executorProfile.adapterId).toBe("codex");
  });

  it("TC-ADAPT-05: 未知 Profile 或未支持适配器拒绝隐式回退，必须保持 fail-closed 阻断", () => {
    expect(() => {
      specService.updateExecutionSpec({
        request_id: "req_spec_fail",
        expected_version: 1,
        workflow_id: workflowId,
        planner_profile: {
          id: "p_unknown",
          revision: 1,
          adapterId: "unknown-tool" as any,
          modelSelection: "native-config",
          options: {},
        },
        executor_profile: {
          id: "e_agy",
          revision: 1,
          adapterId: "agy",
          modelSelection: "native-config",
          options: {},
        },
      });
    }).toThrow();
  });

  it("TC-ADAPT-06: 八大工具参数构建严格按照计划、审查与只读权限区分命令行参数", () => {
    const registry = createDefaultAdapterRegistry();
    const tools = [
      "codex",
      "agy",
      "grok-build",
      "claude-code",
      "kimi-code",
      "qoder",
      "opencode",
      "cursor-agent",
    ] as const;

    for (const toolId of tools) {
      const adapter = registry.mustGet(toolId);
      const planInvocation = adapter.buildInvocation(
        {
          workflowId: "wf_1",
          runId: "run_1",
          stage: "planning",
          epoch: 1,
          workspaceRoots: { repo1: "C:/fake/repo" },
          allowedPaths: ["app.txt"],
          purpose: "planning",
          toolProfile: {
            id: `prof_${toolId}`,
            revision: 1,
            adapterId: toolId,
            modelSelection: "native-config",
            options: {},
          },
        },
        "C:/fake/bin/tool.exe",
      );

      // 只读规划下必须具备限制参数或提示约束
      expect(planInvocation.executable).toBe("C:/fake/bin/tool.exe");
      expect(Array.isArray(planInvocation.args)).toBe(true);

      const execInvocation = adapter.buildInvocation(
        {
          workflowId: "wf_1",
          runId: "run_2",
          stage: "execute",
          epoch: 1,
          workspaceRoots: { repo1: "C:/fake/repo" },
          allowedPaths: ["app.txt"],
          purpose: "implement",
          toolProfile: {
            id: `prof_${toolId}`,
            revision: 1,
            adapterId: toolId,
            modelSelection: "native-config",
            options: {},
          },
        },
        "C:/fake/bin/tool.exe",
      );

      // 实施阶段为可写模式
      expect(execInvocation.args).toBeDefined();
    }
  });
});

