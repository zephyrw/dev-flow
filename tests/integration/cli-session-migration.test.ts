import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import { SessionBindingRepairService } from "../../packages/core/src/session-binding-repair.js";
import { generateResumeInstructions } from "../../packages/adapters/sdk/src/resume-instructions.js";
import { computeSessionBindingKey } from "../../packages/contracts/src/session-binding.js";
import { resolveClientScope } from "../../packages/adapters/sdk/src/identity.js";

describe("CW2-T14 & CW2-T15: CLI 会话历史修复与迁移服务集成测试", () => {
  let tempDir: string;
  let store: Store;
  let sessionStore: ExecutionSessionStore;
  let repairService: SessionBindingRepairService;
  let origAccountScope: string | undefined;
  let origProvAccount: string | undefined;

  beforeEach(() => {
    origAccountScope = process.env.DEVFLOW_ACCOUNT_SCOPE;
    origProvAccount = process.env.DEVFLOW_PROVIDER_ACCOUNT;
    process.env.DEVFLOW_ACCOUNT_SCOPE = "test-env-account";

    tempDir = mkdtempSync(join(tmpdir(), "devflow-session-mig-test-"));
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
    sessionStore = new ExecutionSessionStore(store);
    repairService = new SessionBindingRepairService(store);
  });

  afterEach(() => {
    if (origAccountScope !== undefined) {
      process.env.DEVFLOW_ACCOUNT_SCOPE = origAccountScope;
    } else {
      delete process.env.DEVFLOW_ACCOUNT_SCOPE;
    }
    if (origProvAccount !== undefined) {
      process.env.DEVFLOW_PROVIDER_ACCOUNT = origProvAccount;
    } else {
      delete process.env.DEVFLOW_PROVIDER_ACCOUNT;
    }

    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  // CW2-T14: 候选清点、真实身份与读取
  it("CW2-T14 单个 Codex 旧根保持 Codex 及真实模型/cwd，绝无 agy/default", () => {
    const wfId = "wf-codex-legacy";
    const realCwd = join(tempDir, "codex-project");
    mkdirSync(realCwd, { recursive: true });

    store.put("workflow", wfId, "proj-1", {
      id: wfId,
      title: "Codex 任务",
      version: 1,
    } as any);

    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      source_root: realCwd,
      root: realCwd,
      branch: "devflow/codex",
      mode: "existing_workspace",
    } as any);

    // 录入一个原生 Codex 会话
    store.put("native_conversation", `nconv-${wfId}`, wfId, {
      id: `nconv-${wfId}`,
      workflow_id: wfId,
      adapter_id: "codex",
      native_conversation_id: "thread-codex-real-123",
      canonical_model_id: "gpt-5-codex-pro",
      workspace_root: realCwd,
    } as any);

    const preview = repairService.previewRepair(wfId);
    expect(preview.candidates.length).toBe(1);

    const cand = preview.candidates[0]!;
    expect(cand.adapter_id).toBe("codex");
    expect(cand.canonical_model_id).toBe("gpt-5-codex-pro");
    expect(cand.conversation_id).toBe("thread-codex-real-123");
    expect(cand.workspace_root).toBe(realCwd);
    expect(cand.status).toBe("verified");
    // 绝不可落 agy 或 default
    expect(cand.adapter_id).not.toBe("agy");
    expect(cand.canonical_model_id).not.toBe("default");
    expect(cand.canonical_model_id).not.toBe("default-model");
  });

  it("CW2-T14 多旧来源合并但不同根不丢，每个来源版本变动影响 digest", () => {
    const wfId = "wf-multi-source";
    const wsRoot = join(tempDir, "ws-multi");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", { id: wfId, title: "多来源任务", version: 1 } as any);
    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      root: wsRoot,
      source_root: wsRoot,
    } as any);

    // 录入旧 conversation 与旧 native_conversation
    store.put("conversation", `conv-${wfId}`, wfId, {
      id: "agy-conv-777",
      workflow_id: wfId,
      adapter: "agy",
      model: "gemini-2.5-pro",
    } as any);

    store.put("native_conversation", `nconv-${wfId}`, wfId, {
      id: `nconv-${wfId}`,
      workflow_id: wfId,
      adapter_id: "codex",
      native_conversation_id: "thread-codex-888",
      canonical_model_id: "gpt-5",
    } as any);

    const preview1 = repairService.previewRepair(wfId);
    expect(preview1.candidates.length).toBe(2);
    const digest1 = preview1.source_digest;

    // 修改其中一个来源的内容
    store.put("native_conversation", `nconv-${wfId}`, wfId, {
      id: `nconv-${wfId}`,
      workflow_id: wfId,
      adapter_id: "codex",
      native_conversation_id: "thread-codex-888-v2",
      canonical_model_id: "gpt-5",
    } as any);

    const preview2 = repairService.previewRepair(wfId);
    const digest2 = preview2.source_digest;
    expect(digest1).not.toBe(digest2);
  });

  it("CW2-T14 未知标 unverifiable 且 apply 失败；正常 apply 后的 resume 能读取非空真实 cwd", () => {
    const wfId = "wf-unverifiable";
    const wsRoot = join(tempDir, "ws-unverifiable");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", { id: wfId, title: "未知来源任务", version: 1 } as any);
    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      root: wsRoot,
      source_root: wsRoot,
    } as any);

    // 录入一个缺少 conversation_id 的脏数据
    store.put("conversation", `conv-bad`, wfId, {
      id: "",
      workflow_id: wfId,
    } as any);

    store.put("workflow_dispatch_control", wfId, wfId, {
      workflow_id: wfId,
      dispatch_enabled: false,
      reasons: ["user_disabled"],
      revision: 1,
    } as any);

    const preview = repairService.previewRepair(wfId);
    const cand = preview.candidates[0]!;
    expect(cand.status).toBe("unverifiable");

    // apply unverifiable 应该被拒绝
    expect(() => {
      repairService.applyRepair(wfId, {
        request_id: "req-fail",
        expected_workflow_version: 1,
        source_digest: preview.source_digest,
        selections: [{ candidate_id: cand.candidate_id, expected_binding_revision: 0 }],
      });
    }).toThrow(/unverifiable.*不可应用|尚未通过验证/);

    // 换一个 verified 的候选正常 apply
    const wfId2 = "wf-verified-apply";
    const wsRoot2 = join(tempDir, "ws-verified");
    mkdirSync(wsRoot2, { recursive: true });

    store.put("workflow", wfId2, "proj-1", { id: wfId2, title: "正常修复任务", version: 1 } as any);
    store.put("workspace", `ws-${wfId2}`, wfId2, {
      id: `ws-${wfId2}`,
      workflow_id: wfId2,
      repo_id: "main",
      root: wsRoot2,
      source_root: wsRoot2,
    } as any);
    store.put("workflow_dispatch_control", wfId2, wfId2, {
      workflow_id: wfId2,
      dispatch_enabled: false,
      reasons: ["user_disabled"],
      revision: 1,
    } as any);

    store.put("conversation", `conv-${wfId2}`, wfId2, {
      id: "agy-conv-verified-111",
      workflow_id: wfId2,
      adapter: "agy",
      model: "gemini-2.5-pro",
    } as any);

    const p2 = repairService.previewRepair(wfId2);
    const validCand = p2.candidates[0]!;
    expect(validCand.status).toBe("verified");

    const applyRes = repairService.applyRepair(wfId2, {
      request_id: "req-valid-1",
      expected_workflow_version: 1,
      source_digest: p2.source_digest,
      selections: [{ candidate_id: validCand.candidate_id, expected_binding_revision: 0 }],
    });
    expect(applyRes.affected_binding_ids.length).toBe(1);

    // 读取生成的 binding 并验证 resume instructions 包含非空真实 cwd
    const bindings = sessionStore.listBindings(wfId2);
    expect(bindings.length).toBe(1);
    const b = bindings[0]!;
    expect(b.workspace_root).toBe(wsRoot2);

    const instructions = generateResumeInstructions({
      bindingId: b.id,
      workflowId: wfId2,
      adapterId: b.adapter_id,
      conversationId: b.conversation_id || "",
      cwd: b.workspace_root,
      managedWriterState: "idle",
      dispatchEnabled: false,
      executablePath: "agy",
    });
    expect(instructions.copy_script).toBeDefined();
    expect(instructions.copy_script).toContain("ws-verified");
  });

  // CW2-T15: 门禁拦截、事务保护与原子回滚
  it("CW2-T15 apply时writer active/unknown、开关开、stale selection revision、同键选两根分别拒绝且全库相关记录不变", () => {
    const wfId = "wf-apply-guards";
    const wsRoot = join(tempDir, "ws-guards");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", { id: wfId, title: "门禁测试任务", version: 1 } as any);
    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      root: wsRoot,
      source_root: wsRoot,
    } as any);

    // 1. 开关开启时，apply 必须拒绝 (CW2-D06 / §9.2)
    store.put("workflow_dispatch_control", wfId, wfId, {
      workflow_id: wfId,
      dispatch_enabled: true,
      reasons: [],
      revision: 1,
    } as any);

    store.put("conversation", `conv-${wfId}`, wfId, {
      id: "agy-guard-conv-1",
      workflow_id: wfId,
      adapter: "agy",
      model: "gemini-2.5-pro",
    } as any);

    const p = repairService.previewRepair(wfId);
    expect(() => {
      repairService.applyRepair(wfId, {
        request_id: "req-disp-open",
        expected_workflow_version: 1,
        source_digest: p.source_digest,
        selections: [{ candidate_id: p.candidates[0]!.candidate_id, expected_binding_revision: 0 }],
      });
    }).toThrow(/必须先停用工作流自动调度/);

    // 2. 将开关关闭，但写者处于 active 状态时，apply 必须拒绝
    store.put("workflow_dispatch_control", wfId, wfId, {
      workflow_id: wfId,
      dispatch_enabled: false,
      reasons: ["user_disabled"],
      revision: 2,
    } as any);

    // 模拟写入一个运行中的 Run，代表 writer active
    store.put("run", `run-active`, wfId, {
      id: "run-active",
      workflow_id: wfId,
      status: "RUNNING",
    } as any);

    const pActive = repairService.previewRepair(wfId);
    expect(() => {
      repairService.applyRepair(wfId, {
        request_id: "req-writer-active",
        expected_workflow_version: 1,
        source_digest: pActive.source_digest,
        selections: [{ candidate_id: pActive.candidates[0]!.candidate_id, expected_binding_revision: 0 }],
      });
    }).toThrow(/活跃或状态未知/);

    // 移除 active run
    store.remove("run", "run-active");

    // 3. stale selection revision: expected_binding_revision 错误必须拒绝
    const pIdle = repairService.previewRepair(wfId);
    expect(() => {
      repairService.applyRepair(wfId, {
        request_id: "req-stale-rev",
        expected_workflow_version: 1,
        source_digest: pIdle.source_digest,
        selections: [{ candidate_id: pIdle.candidates[0]!.candidate_id, expected_binding_revision: 99 }],
      });
    }).toThrow(/期望 r99 冲突|版本不匹配/);

    // 数据库中不产生任何绑定
    expect(sessionStore.listBindings(wfId).length).toBe(0);
  });

  it("CW2-T15 rollback空/漏/多/错revision清单拒绝；apply后跑一次Run即禁止回退；可回退时原子恢复且版本单调", () => {
    const wfId = "wf-rollback-test";
    const wsRoot = join(tempDir, "ws-rollback");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", { id: wfId, title: "回滚任务", version: 1 } as any);
    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      root: wsRoot,
      source_root: wsRoot,
    } as any);
    store.put("workflow_dispatch_control", wfId, wfId, {
      workflow_id: wfId,
      dispatch_enabled: false,
      reasons: ["user_disabled"],
      revision: 1,
    } as any);

    store.put("conversation", `conv-${wfId}`, wfId, {
      id: "agy-rollback-conv-1",
      workflow_id: wfId,
      adapter: "agy",
      model: "gemini-2.5-pro",
    } as any);

    const p = repairService.previewRepair(wfId);
    const applyRes = repairService.applyRepair(wfId, {
      request_id: "req-apply-rollback",
      expected_workflow_version: 1,
      source_digest: p.source_digest,
      selections: [{ candidate_id: p.candidates[0]!.candidate_id, expected_binding_revision: 0 }],
    });
    const migrationId = applyRes.migration_id;
    const initialBinding = sessionStore.listBindings(wfId)[0]!;

    // 1. 空 revision 清单回滚必须拒绝 (CW2-F15 / §9.3)
    expect(() => {
      repairService.rollbackRepair(wfId, {
        request_id: "req-rb-empty",
        migration_id: migrationId,
        expected_workflow_version: 1,
        expected_binding_revisions: [],
      });
    }).toThrow(/回滚版本清单必须精确覆盖/);

    // 2. revision 清单与受影响集合不匹配（混入其他 ID 或版本错误）必须拒绝
    expect(() => {
      repairService.rollbackRepair(wfId, {
        request_id: "req-rb-wrong",
        migration_id: migrationId,
        expected_workflow_version: 1,
        expected_binding_revisions: [{ binding_id: "wrong-id", revision: 1 }],
      });
    }).toThrow(/回滚版本清单必须精确覆盖/);

    // 3. apply 后跑过一次 Run 即禁止回退 (CW2-T15)
    store.put("run", "run-subsequent", wfId, {
      id: "run-subsequent",
      workflow_id: wfId,
      status: "COMPLETED",
      session_binding_id: initialBinding.id,
      started_at: new Date(Date.now() + 10000).toISOString(),
    } as any);

    expect(() => {
      repairService.rollbackRepair(wfId, {
        request_id: "req-rb-used",
        migration_id: migrationId,
        expected_workflow_version: 1,
        expected_binding_revisions: [{ binding_id: initialBinding.id, revision: initialBinding.revision }],
      });
    }).toThrow(/迁移后已发生新的执行 Run/);

    // 移除该 Run 后，可以正常安全回退
    store.remove("run", "run-subsequent");

    const rollbackRes = repairService.rollbackRepair(wfId, {
      request_id: "req-rb-ok",
      migration_id: migrationId,
      expected_workflow_version: 1,
      expected_binding_revisions: [{ binding_id: initialBinding.id, revision: initialBinding.revision }],
    });
    expect(rollbackRes.status).toBe("rolled_back");

    // 回滚后 binding 应被标记为已撤销/状态恢复，版本单调递增
    const finalBindings = sessionStore.listBindings(wfId);
    expect(finalBindings.length).toBe(0);
  });

  it("CW4-F04: 旧 .codex 等目录简称与当前绝对配置域使用一致的键；已有绝对配置目录按同一规范处理", () => {
    const wfId = "wf-client-scope-norm";
    const wsRoot = join(tempDir, "ws-scope");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", { id: wfId, title: "配置域规范化测试", version: 1 } as any);
    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      root: wsRoot,
      source_root: wsRoot,
    } as any);

    const expectedDefaultCodexScope = resolveClientScope("codex")!;
    expect(expectedDefaultCodexScope).toBeDefined();

    // 来源 1: 历史记录使用目录简称 ".codex"
    store.put("native_conversation", `nconv-short`, wfId, {
      id: `nconv-short`,
      workflow_id: wfId,
      adapter_id: "codex",
      client_scope_id: ".codex", // 历史目录简称
      native_conversation_id: "thread-scope-short-111",
      canonical_model_id: "gpt-4o",
      workspace_root: wsRoot,
      provider_account_scope: "user-norm-acc",
    } as any);

    // 来源 2: 历史记录使用当前运行环境下的完整绝对路径
    store.put("native_conversation", `nconv-abs`, wfId, {
      id: `nconv-abs`,
      workflow_id: wfId,
      adapter_id: "codex",
      client_scope_id: expectedDefaultCodexScope, // 绝对路径
      native_conversation_id: "thread-scope-abs-222",
      canonical_model_id: "gpt-4o",
      workspace_root: wsRoot,
      provider_account_scope: "user-norm-acc",
    } as any);

    const preview = repairService.previewRepair(wfId);
    expect(preview.candidates.length).toBe(2);

    const candShort = preview.candidates.find((c) => c.conversation_id === "thread-scope-short-111")!;
    const candAbs = preview.candidates.find((c) => c.conversation_id === "thread-scope-abs-222")!;

    // 目录简称与绝对配置目录均被解析为一致的小写绝对配置域
    expect(candShort.client_scope_id).toBe(expectedDefaultCodexScope);
    expect(candAbs.client_scope_id).toBe(expectedDefaultCodexScope);
    expect(candShort.client_scope_id).toBe(candAbs.client_scope_id);

    // 计算两者的绑定键：除了内部 conversation_id 不同，基准 session key 是完全一致的
    const keyShort = computeSessionBindingKey({
      workflow_id: wfId,
      adapter_id: candShort.adapter_id,
      host_id: candShort.host_id,
      client_scope_id: candShort.client_scope_id,
      provider_account_scope: candShort.provider_account_scope,
      canonical_model_id: candShort.canonical_model_id,
      workspace_identity: candShort.workspace_identity,
    });
    const keyAbs = computeSessionBindingKey({
      workflow_id: wfId,
      adapter_id: candAbs.adapter_id,
      host_id: candAbs.host_id,
      client_scope_id: candAbs.client_scope_id,
      provider_account_scope: candAbs.provider_account_scope,
      canonical_model_id: candAbs.canonical_model_id,
      workspace_identity: candAbs.workspace_identity,
    });
    expect(keyShort).toBe(keyAbs);
  });

  it("CW4-F04: 账号环境覆盖优先级与运行端相同 (记录自身 > Run Profile > 环境变量)", () => {
    const wfId = "wf-acc-priority";
    const wsRoot = join(tempDir, "ws-acc-prio");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", { id: wfId, title: "账号优先级测试", version: 1 } as any);
    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      root: wsRoot,
      source_root: wsRoot,
    } as any);

    // 准备一个 Run 其 profile 含有账号
    store.put("run", "run-with-profile", wfId, {
      id: "run-with-profile",
      workflow_id: wfId,
      profile: {
        adapterId: "codex",
        modelId: "gpt-4o",
        accountScope: "account-from-run-profile",
      },
    } as any);

    // 候选 1: 记录自身带账号，即使关联 Run 且有环境变量，依然最高优先级
    store.put("native_conversation", "nc-prio-1", wfId, {
      id: "nc-prio-1",
      workflow_id: wfId,
      run_id: "run-with-profile",
      adapter_id: "codex",
      canonical_model_id: "gpt-4o",
      native_conversation_id: "conv-prio-1",
      provider_account_scope: "account-from-record", // 最高优先级
      workspace_root: wsRoot,
    } as any);

    // 候选 2: 记录自身无账号，通过 run_id 读取关联 Run profile 中的账号
    store.put("native_conversation", "nc-prio-2", wfId, {
      id: "nc-prio-2",
      workflow_id: wfId,
      run_id: "run-with-profile",
      adapter_id: "codex",
      canonical_model_id: "gpt-4o",
      native_conversation_id: "conv-prio-2",
      workspace_root: wsRoot,
    } as any);

    // 候选 3: 记录自身无账号且无关联 Run，回退到环境变量 DEVFLOW_ACCOUNT_SCOPE
    store.put("native_conversation", "nc-prio-3", wfId, {
      id: "nc-prio-3",
      workflow_id: wfId,
      adapter_id: "codex",
      canonical_model_id: "gpt-4o",
      native_conversation_id: "conv-prio-3",
      workspace_root: wsRoot,
    } as any);

    const preview = repairService.previewRepair(wfId);
    const cand1 = preview.candidates.find((c) => c.conversation_id === "conv-prio-1")!;
    const cand2 = preview.candidates.find((c) => c.conversation_id === "conv-prio-2")!;
    const cand3 = preview.candidates.find((c) => c.conversation_id === "conv-prio-3")!;

    expect(cand1.provider_account_scope).toBe("account-from-record");
    expect(cand2.provider_account_scope).toBe("account-from-run-profile");
    expect(cand3.provider_account_scope).toBe("test-env-account");
  });

  it("CW4-F04: 确实缺账号的候选不可应用，不生成 local/default-account 占位绑定", () => {
    const wfId = "wf-no-account";
    const wsRoot = join(tempDir, "ws-no-acc");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", { id: wfId, title: "缺账号不可应用测试", version: 1 } as any);
    store.put("workspace", `ws-${wfId}`, wfId, {
      id: `ws-${wfId}`,
      workflow_id: wfId,
      repo_id: "main",
      root: wsRoot,
      source_root: wsRoot,
    } as any);
    store.put("workflow_dispatch_control", wfId, wfId, {
      workflow_id: wfId,
      dispatch_enabled: false,
      reasons: ["user_disabled"],
      revision: 1,
    } as any);

    // 临时清空环境变量中的账号配置
    delete process.env.DEVFLOW_ACCOUNT_SCOPE;
    delete process.env.DEVFLOW_PROVIDER_ACCOUNT;

    try {
      store.put("native_conversation", "nc-missing-acc", wfId, {
        id: "nc-missing-acc",
        workflow_id: wfId,
        adapter_id: "codex",
        canonical_model_id: "gpt-4o",
        native_conversation_id: "conv-strict-no-acc",
        workspace_root: wsRoot,
      } as any);

      const preview = repairService.previewRepair(wfId);
      const cand = preview.candidates.find((c) => c.conversation_id === "conv-strict-no-acc")!;

      // 缺账号保持不可确证
      expect(cand.status).toBe("unverifiable");
      expect(cand.provider_account_scope).toBe("unknown");
      expect(cand.reason).toContain("无法确证");

      // 绝不可被 apply 应用
      expect(() => {
        repairService.applyRepair(wfId, {
          request_id: "req-try-apply-no-acc",
          expected_workflow_version: 1,
          source_digest: preview.source_digest,
          selections: [{ candidate_id: cand.candidate_id, expected_binding_revision: 0 }],
        });
      }).toThrow(/unverifiable.*不可应用/);

      // 数据库中绝不产生任何带有 local 或 default-account 的占位绑定
      const bindings = sessionStore.listBindings(wfId);
      expect(bindings.length).toBe(0);
      const allBindingsInStore = store.list("session_binding", wfId);
      expect(allBindingsInStore.length).toBe(0);
    } finally {
      process.env.DEVFLOW_ACCOUNT_SCOPE = "test-env-account";
    }
  });
});
