import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import { CliDispatchManager } from "../../packages/runtime/src/cli-dispatch.js";
import { buildServer } from "../../apps/api/src/server.js";
import { setup } from "../helpers.js";
import {
  type SessionBindingAdoptInput,
  SessionBindingAdoptInputSchema,
} from "../../packages/contracts/src/session-binding.js";

describe("CW2-T13: CLI 会话接管 (Adopt) 契约与安全保护集成测试", () => {
  let tempDir: string;
  let store: Store;
  let sessionStore: ExecutionSessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-adopt-test-"));
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
    sessionStore = new ExecutionSessionStore(store);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("CW2-T13 加入伪造 adapter/account/root 字段被 strict DTO 模式拒绝 (400)", () => {
    const fakePayload = {
      request_id: "req-fake-1",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-1", revision: 1 },
      workspace_id: "ws-1",
      conversation_id: "conv-fake-123",
      adapter_id: "fake-adapter", // 伪造字段
      provider_account_scope: "attacker-account", // 伪造字段
      workspace_root: "C:/Malicious/Path", // 伪造字段
    };

    expect(() => {
      SessionBindingAdoptInputSchema.parse(fakePayload);
    }).toThrow();
  });

  it("CW2-T13 用新最小 DTO 成功核验真实工作区并持久化绑定", () => {
    const wfId = "wf-adopt-1";
    const wsRoot = join(tempDir, "crm-project");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workflow", wfId, "proj-1", {
      id: wfId,
      title: "合法接管任务",
      version: 1,
    } as any);

    store.put("workspace", "ws-1", wfId, {
      id: "ws-1",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
      branch: "main",
      mode: "existing_workspace",
    } as any);

    store.put("execution_spec", "spec-1", wfId, {
      id: "spec-1",
      workflow_id: wfId,
      revision: 1,
      plannerProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    const input: SessionBindingAdoptInput = {
      request_id: "req-adopt-1",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-1", revision: 1 },
      workspace_id: "ws-1",
      conversation_id: "conv-existing-cli-12345",
    };

    const defaultOptions = {
      adapter_id: "codex",
      host_id: "testhost-01",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-user-123",
      canonical_model_id: "gpt-4o",
      workspace_identity: wsRoot.toLowerCase(),
      workspace_root: wsRoot,
      source_root: wsRoot,
      repo_id: "main",
    };

    const binding = sessionStore.adoptExistingSession(wfId, input, defaultOptions);
    expect(binding.state).toBe("bound");
    expect(binding.conversation_id).toBe("conv-existing-cli-12345");
    expect(binding.workspace_root).toBe(wsRoot);

    // 反查验证
    const found = sessionStore.getBindingById(binding.id);
    expect(found).toBeDefined();
    expect(found?.conversation_id).toBe("conv-existing-cli-12345");
  });

  it("CW2-T13 底层直接调用缺少完整服务端身份时抛出 400 IDENTITY_UNVERIFIED", () => {
    const wfId = "wf-adopt-no-ident";
    const wsRoot = join(tempDir, "crm-no-ident");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workspace", "ws-no-ident", wfId, {
      id: "ws-no-ident",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    const input: SessionBindingAdoptInput = {
      request_id: "req-adopt-no-ident",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-1", revision: 1 },
      workspace_id: "ws-no-ident",
      conversation_id: "conv-no-ident-123",
    };

    // 缺少 options 必抛 IDENTITY_UNVERIFIED
    expect(() => {
      sessionStore.adoptExistingSession(wfId, input);
    }).toThrow(/会话身份缺少真实工具、模型、主机、配置域、账号或工作区/);

    // options 中含有假 default 也必抛 IDENTITY_UNVERIFIED
    expect(() => {
      sessionStore.adoptExistingSession(wfId, input, {
        adapter_id: "codex",
        host_id: "testhost-01",
        client_scope_id: "c:/users/test/.codex",
        provider_account_scope: "default",
        canonical_model_id: "gpt-4o",
        workspace_identity: wsRoot.toLowerCase(),
      });
    }).toThrow(/会话身份缺少真实工具、模型、主机、配置域、账号或工作区/);
  });

  it("CW2-T13 expected_binding_revision=0 遇已有 binding 报 409 冲突", () => {
    const wfId = "wf-adopt-2";
    const wsRoot = join(tempDir, "repo-2");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workspace", "ws-2", wfId, {
      id: "ws-2",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    store.put("execution_spec", "spec-2", wfId, {
      id: "spec-2",
      workflow_id: wfId,
      revision: 1,
      plannerProfile: {
        id: "profile-2",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "profile-2",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    const inputA: SessionBindingAdoptInput = {
      request_id: "req-adopt-2a",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-2", revision: 1 },
      workspace_id: "ws-2",
      conversation_id: "thread-original-001",
    };

    const optionsA = {
      adapter_id: "codex",
      host_id: "testhost-01",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-user-123",
      canonical_model_id: "gpt-4o",
      workspace_identity: wsRoot.toLowerCase(),
      workspace_root: wsRoot,
      source_root: wsRoot,
      repo_id: "main",
    };

    sessionStore.adoptExistingSession(wfId, inputA, optionsA);

    // 再次以 expected_binding_revision = 0 进行 adopt 必须报错
    const inputB: SessionBindingAdoptInput = {
      request_id: "req-adopt-2b",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-2", revision: 1 },
      workspace_id: "ws-2",
      conversation_id: "thread-original-001",
    };

    expect(() => {
      sessionStore.adoptExistingSession(wfId, inputB, optionsA);
    }).toThrow(/期望 revision 为 0 冲突|BINDING_ALREADY_EXISTS/);
  });

  it("CW2-T13 换已有根或跨任务认领同一原生会话时抛出 409", () => {
    const wsRoot = join(tempDir, "repo-shared");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workspace", "ws-task-1", "wf-task-1", {
      id: "ws-task-1",
      workflow_id: "wf-task-1",
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    store.put("workspace", "ws-task-2", "wf-task-2", {
      id: "ws-task-2",
      workflow_id: "wf-task-2",
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    store.put("execution_spec", "spec-task-1", "wf-task-1", {
      id: "spec-task-1",
      workflow_id: "wf-task-1",
      revision: 1,
      plannerProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    store.put("execution_spec", "spec-task-2", "wf-task-2", {
      id: "spec-task-2",
      workflow_id: "wf-task-2",
      revision: 1,
      plannerProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    const input1: SessionBindingAdoptInput = {
      request_id: "req-adopt-cross-1",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-1", revision: 1 },
      workspace_id: "ws-task-1",
      conversation_id: "conv-shared-123",
    };

    const optionsCross = {
      adapter_id: "codex",
      host_id: "testhost-01",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-user-123",
      canonical_model_id: "gpt-4o",
      workspace_identity: wsRoot.toLowerCase(),
      workspace_root: wsRoot,
      source_root: wsRoot,
      repo_id: "main",
    };

    sessionStore.adoptExistingSession("wf-task-1", input1, optionsCross);

    const input2: SessionBindingAdoptInput = {
      request_id: "req-adopt-cross-2",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-1", revision: 1 },
      workspace_id: "ws-task-2",
      conversation_id: "conv-shared-123", // 相同原生会话
    };

    expect(() => {
      sessionStore.adoptExistingSession("wf-task-2", input2, optionsCross);
    }).toThrow(/已由任务 wf-task-1 认领/);
  });

  it("CW2-T13 同请求回放返回同结果，异正文复用 request_id 抛 409", () => {
    const wfId = "wf-idempotent";
    const wsRoot = join(tempDir, "ws-idem");
    mkdirSync(wsRoot, { recursive: true });

    store.put("workspace", "ws-idem", wfId, {
      id: "ws-idem",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    store.put("execution_spec", "spec-idem", wfId, {
      id: "spec-idem",
      workflow_id: wfId,
      revision: 1,
      plannerProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "profile-1",
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    const input: SessionBindingAdoptInput = {
      request_id: "req-idem-1",
      expected_workflow_version: 1,
      expected_control_revision: 1,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-1", revision: 1 },
      workspace_id: "ws-idem",
      conversation_id: "conv-replay-1",
    };

    const optionsIdem = {
      adapter_id: "codex",
      host_id: "testhost-01",
      client_scope_id: "c:/users/test/.codex",
      provider_account_scope: "acc-user-123",
      canonical_model_id: "gpt-4o",
      workspace_identity: wsRoot.toLowerCase(),
      workspace_root: wsRoot,
      source_root: wsRoot,
      repo_id: "main",
    };

    const firstResult = sessionStore.adoptExistingSession(wfId, input, optionsIdem);

    // 回放相同请求
    const replayResult = sessionStore.adoptExistingSession(wfId, input, optionsIdem);
    expect(replayResult.id).toBe(firstResult.id);

    // 异正文复用相同 request_id
    const conflictingInput: SessionBindingAdoptInput = {
      ...input,
      conversation_id: "conv-different-target",
    };

    expect(() => {
      sessionStore.adoptExistingSession(wfId, conflictingInput, optionsIdem);
    }).toThrow(/请求正文不一致|IDEMPOTENCY_CONFLICT/);
  });
});

describe("CW4-F05: Adopt API 路由端到端行为验证", () => {
  let s: ReturnType<typeof setup>;
  let app: any;
  let dispatchManager: CliDispatchManager;
  const headers = { host: "localhost:14810", origin: "http://localhost:14810" };

  beforeEach(async () => {
    s = setup();
    dispatchManager = new CliDispatchManager(s.store);
    app = await buildServer(s.engine);
  });

  afterEach(async () => {
    try {
      await app.close();
    } catch {}
    try {
      s.store.close();
    } catch {}
  });

  it("ExecutionSpec.revision 与 ToolProfile.revision 不同时，传入正确 profile_ref 仍能成功接管", async () => {
    const wfId = "wf-api-adopt-1";
    const wsRoot = join(s.root, "ws-1");
    mkdirSync(wsRoot, { recursive: true });

    s.store.put("workflow", wfId, "proj-1", {
      id: wfId,
      title: "API接管测试-版本独立",
      version: 1,
    } as any);

    s.store.put("workspace", "ws-api-1", wfId, {
      id: "ws-api-1",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    s.store.put("execution_spec", "spec-api-1", wfId, {
      id: "spec-api-1",
      workflow_id: wfId,
      revision: 8, // ExecutionSpec 版本为 8
      plannerProfile: {
        id: "profile-planner-1",
        revision: 2, // PlannerProfile 版本为 2
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "profile-executor-1",
        revision: 3, // ExecutorProfile 版本为 3
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    // 停用调度以允许接管
    const ctrl = dispatchManager.addControlReason(wfId, {
      reason: "user_disabled",
      message: "测试停用调度",
    });

    const payload = {
      request_id: "req-adopt-api-1",
      expected_workflow_version: 1,
      expected_control_revision: ctrl.revision,
      expected_binding_revision: 0,
      profile_ref: { id: "profile-executor-1", revision: 3 }, // 精确匹配 executor profile 版本 3
      workspace_id: "ws-api-1",
      conversation_id: "conv-api-exec-123",
    };

    const res = await app.inject({
      method: "POST",
      url: `/api/workflows/${wfId}/session-bindings/adopt`,
      headers,
      payload,
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.binding).toBeDefined();
    expect(body.binding.conversation_id).toBe("conv-api-exec-123");
    expect(body.binding.state).toBe("bound");
    expect(body.replayed).toBe(false);
  });

  it("当任务分别配置 plannerProfile 与 executorProfile 时，两者的 id / revision 都能被精确匹配与选择", async () => {
    const wfId = "wf-api-adopt-2";
    const wsRoot = join(s.root, "ws-2");
    mkdirSync(wsRoot, { recursive: true });

    s.store.put("workflow", wfId, "proj-1", {
      id: wfId,
      title: "API接管测试-双Profile精确选择",
      version: 1,
    } as any);

    s.store.put("workspace", "ws-api-2", wfId, {
      id: "ws-api-2",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    s.store.put("execution_spec", "spec-api-2", wfId, {
      id: "spec-api-2",
      workflow_id: wfId,
      revision: 10,
      plannerProfile: {
        id: "plan-prof-custom",
        revision: 4,
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "exec-prof-custom",
        revision: 5,
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    const ctrl = dispatchManager.addControlReason(wfId, {
      reason: "user_disabled",
      message: "测试停用调度",
    });

    // 1. 精确选择 planner profile
    const plannerRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${wfId}/session-bindings/adopt`,
      headers,
      payload: {
        request_id: "req-adopt-planner",
        expected_workflow_version: 1,
        expected_control_revision: ctrl.revision,
        expected_binding_revision: 0,
        profile_ref: { id: "plan-prof-custom", revision: 4 },
        workspace_id: "ws-api-2",
        conversation_id: "conv-planner-456",
      },
    });
    expect(plannerRes.statusCode).toBe(200);
    const plannerBody = JSON.parse(plannerRes.body);
    expect(plannerBody.binding.conversation_id).toBe("conv-planner-456");

    // 2. 精确选择 executor profile（在不同 workspace/conversation）
    s.store.put("workspace", "ws-api-2-exec", wfId, {
      id: "ws-api-2-exec",
      workflow_id: wfId,
      repo_id: "secondary",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    const executorRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${wfId}/session-bindings/adopt`,
      headers,
      payload: {
        request_id: "req-adopt-executor",
        expected_workflow_version: 1,
        expected_control_revision: ctrl.revision,
        expected_binding_revision: 0,
        profile_ref: { id: "exec-prof-custom", revision: 5 },
        workspace_id: "ws-api-2-exec",
        conversation_id: "conv-executor-789",
      },
    });
    expect(executorRes.statusCode).toBe(200);
    const execBody = JSON.parse(executorRes.body);
    expect(execBody.binding.conversation_id).toBe("conv-executor-789");
  });

  it("传入未知 profile ID (404) 与错误 profile revision (409) 会被立即拦截，不得自动降级", async () => {
    const wfId = "wf-api-adopt-3";
    const wsRoot = join(s.root, "ws-3");
    mkdirSync(wsRoot, { recursive: true });

    s.store.put("workflow", wfId, "proj-1", {
      id: wfId,
      title: "API接管测试-错误拦截",
      version: 1,
    } as any);

    s.store.put("workspace", "ws-api-3", wfId, {
      id: "ws-api-3",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    s.store.put("execution_spec", "spec-api-3", wfId, {
      id: "spec-api-3",
      workflow_id: wfId,
      revision: 1,
      plannerProfile: {
        id: "profile-p",
        revision: 2,
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      executorProfile: {
        id: "profile-e",
        revision: 3,
        adapterId: "codex",
        modelId: "gpt-4o",
        modelSelection: "explicit",
        options: {},
      },
      created_at: new Date().toISOString(),
    } as any);

    const ctrl = dispatchManager.addControlReason(wfId, {
      reason: "user_disabled",
      message: "测试停用调度",
    });

    // 1. 未知 profile ID (404 PROFILE_NOT_FOUND)
    const notFoundRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${wfId}/session-bindings/adopt`,
      headers,
      payload: {
        request_id: "req-err-404",
        expected_workflow_version: 1,
        expected_control_revision: ctrl.revision,
        expected_binding_revision: 0,
        profile_ref: { id: "non-existent-profile", revision: 1 },
        workspace_id: "ws-api-3",
        conversation_id: "conv-err-1",
      },
    });
    expect(notFoundRes.statusCode).toBe(404);
    const notFoundBody = JSON.parse(notFoundRes.body);
    expect(notFoundBody.error.code).toBe("PROFILE_NOT_FOUND");

    // 2. 错误 profile revision (409 PROFILE_REVISION_MISMATCH)
    const mismatchRes = await app.inject({
      method: "POST",
      url: `/api/workflows/${wfId}/session-bindings/adopt`,
      headers,
      payload: {
        request_id: "req-err-409",
        expected_workflow_version: 1,
        expected_control_revision: ctrl.revision,
        expected_binding_revision: 0,
        profile_ref: { id: "profile-p", revision: 999 }, // 存在 profile-p，但 revision 不匹配
        workspace_id: "ws-api-3",
        conversation_id: "conv-err-2",
      },
    });
    expect(mismatchRes.statusCode).toBe(409);
    const mismatchBody = JSON.parse(mismatchRes.body);
    expect(mismatchBody.error.code).toBe("PROFILE_REVISION_MISMATCH");
  });

  it("resolveSessionIdentity 返回 resolved: false 时，接口抛出 400 (IDENTITY_UNVERIFIED)", async () => {
    const wfId = "wf-api-adopt-4";
    const wsRoot = join(s.root, "ws-4");
    mkdirSync(wsRoot, { recursive: true });

    s.store.put("workflow", wfId, "proj-1", {
      id: wfId,
      title: "API接管测试-身份未核验拦截",
      version: 1,
    } as any);

    s.store.put("workspace", "ws-api-4", wfId, {
      id: "ws-api-4",
      workflow_id: wfId,
      repo_id: "main",
      source_root: wsRoot,
      root: wsRoot,
    } as any);

    const prevAccount = process.env.DEVFLOW_ACCOUNT_SCOPE;
    const prevProvAccount = process.env.DEVFLOW_PROVIDER_ACCOUNT;
    delete process.env.DEVFLOW_ACCOUNT_SCOPE;
    delete process.env.DEVFLOW_PROVIDER_ACCOUNT;

    try {
      s.store.put("execution_spec", "spec-api-4", wfId, {
        id: "spec-api-4",
        workflow_id: wfId,
        revision: 1,
        plannerProfile: {
          id: "profile-unresolved",
          revision: 1,
          adapterId: "codex",
          modelId: "default", // 假 default 导致 canonical_model_id 判定缺失
          modelSelection: "explicit",
          options: {},
        },
        executorProfile: {
          id: "profile-unresolved",
          revision: 1,
          adapterId: "codex",
          modelId: "default",
          modelSelection: "explicit",
          options: {},
        },
        created_at: new Date().toISOString(),
      } as any);

      const ctrl = dispatchManager.addControlReason(wfId, {
        reason: "user_disabled",
        message: "测试停用调度",
      });

      const res = await app.inject({
        method: "POST",
        url: `/api/workflows/${wfId}/session-bindings/adopt`,
        headers,
        payload: {
          request_id: "req-unverified-1",
          expected_workflow_version: 1,
          expected_control_revision: ctrl.revision,
          expected_binding_revision: 0,
          profile_ref: { id: "profile-unresolved", revision: 1 },
          workspace_id: "ws-api-4",
          conversation_id: "conv-unverified-123",
        },
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error.code).toBe("IDENTITY_UNVERIFIED");
    } finally {
      if (prevAccount !== undefined) {
        process.env.DEVFLOW_ACCOUNT_SCOPE = prevAccount;
      }
      if (prevProvAccount !== undefined) {
        process.env.DEVFLOW_PROVIDER_ACCOUNT = prevProvAccount;
      }
    }
  });
});
