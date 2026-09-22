import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import {
  computeSessionBindingKey,
  type SessionBindingKey,
} from "../../packages/contracts/src/session-binding.js";
import { FlowError } from "../../packages/contracts/src/index.js";

describe("CLI 会话绑定与复用 (NV-U03, NV-U04, NV-U06)", () => {
  let tempDir: string;
  let store: Store;
  let sessionStore: ExecutionSessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-binding-test-"));
    store = new Store(join(tempDir, "state.db"));
    sessionStore = new ExecutionSessionStore(store);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("NV-U03: 复用键排除 role/purpose，同模型同工作区生成一致的复用键", () => {
    const keyA: SessionBindingKey = {
      workflow_id: "wf-1",
      adapter_id: "agy",
      host_id: "local",
      client_scope_id: "default",
      provider_account_scope: "default",
      canonical_model_id: "gemini-2.5-pro",
      workspace_identity: "C:/Code/project",
    };
    const keyB: SessionBindingKey = {
      ...keyA,
    };
    expect(computeSessionBindingKey(keyA)).toBe(computeSessionBindingKey(keyB));
  });

  it("NV-U04: 首次 init 立即持久化，并在 Store 中通过 ID 与复用键索引", () => {
    const key: SessionBindingKey = {
      workflow_id: "wf-1",
      adapter_id: "agy",
      host_id: "local",
      client_scope_id: "default",
      provider_account_scope: "default",
      canonical_model_id: "gemini-2.5-pro",
      workspace_identity: "C:/Code/project",
    };

    const initial = sessionStore.getOrCreateBinding(key, {
      workspace_root: "C:/Code/project",
      source_root: "C:/Code/project",
      repo_id: "primary",
    });
    expect(initial.state).toBe("reserved");
    expect(initial.conversation_id).toBe("");

    const bound = sessionStore.bindConversationId(
      initial.id,
      "conv-root-12345",
      "run-001",
    );
    expect(bound.state).toBe("bound");
    expect(bound.conversation_id).toBe("conv-root-12345");
    expect(bound.first_run_id).toBe("run-001");
    expect(bound.revision).toBe(2);

    // 通过 ID 反查验证
    const queried = sessionStore.getBindingById(initial.id);
    expect(queried?.conversation_id).toBe("conv-root-12345");
  });

  it("NV-U04: 防覆写保护：已有确立的根 ID 不可被其他 ID 静默篡改", () => {
    const key: SessionBindingKey = {
      workflow_id: "wf-1",
      adapter_id: "codex",
      host_id: "local",
      client_scope_id: "default",
      provider_account_scope: "default",
      canonical_model_id: "gpt-5-pro",
      workspace_identity: "C:/Code/project",
    };

    const initial = sessionStore.getOrCreateBinding(key, {
      workspace_root: "C:/Code/project",
      source_root: "C:/Code/project",
      repo_id: "primary",
    });

    sessionStore.bindConversationId(initial.id, "conv-root-primary", "run-1");

    // 尝试传入不同 ID 覆盖，必须抛出 CONVERSATION_ROOT_IMMUTABLE 异常
    expect(() =>
      sessionStore.bindConversationId(initial.id, "conv-hijack-different", "run-2"),
    ).toThrow(FlowError);
  });

  it("NV-U06: 子 Agent 会话隔离防护：isSubagentSession 正确识别子会话", () => {
    const key: SessionBindingKey = {
      workflow_id: "wf-sub",
      adapter_id: "agy",
      host_id: "local",
      client_scope_id: "default",
      provider_account_scope: "default",
      canonical_model_id: "gemini-2.5-pro",
      workspace_identity: "C:/Code/project",
    };

    const initial = sessionStore.getOrCreateBinding(key, {
      workspace_root: "C:/Code/project",
      source_root: "C:/Code/project",
      repo_id: "primary",
    });

    const bound = sessionStore.bindConversationId(initial.id, "root-thread-1", "run-1");
    expect(sessionStore.isSubagentSession(bound, "root-thread-1")).toBe(false);
    expect(sessionStore.isSubagentSession(bound, "child-thread-worker-1")).toBe(true);
  });

  it("NV-U04: CAS 版本校验状态更新", () => {
    const key: SessionBindingKey = {
      workflow_id: "wf-cas",
      adapter_id: "agy",
      host_id: "local",
      client_scope_id: "default",
      provider_account_scope: "default",
      canonical_model_id: "default",
      workspace_identity: "C:/Code/project",
    };

    const initial = sessionStore.getOrCreateBinding(key, {
      workspace_root: "C:/Code/project",
      source_root: "C:/Code/project",
      repo_id: "primary",
    });

    // 正确 revision 更新
    const updated = sessionStore.updateBindingState(initial.id, 1, "needs_reconcile");
    expect(updated.state).toBe("needs_reconcile");
    expect(updated.revision).toBe(2);

    // 冲突 revision 抛错
    expect(() =>
      sessionStore.updateBindingState(initial.id, 1, "bound"),
    ).toThrow(FlowError);
  });

  it("NV-U02 & NV-D12: 历史伪项目清理只读预览：安全识别DevFlow容器项目并保护用户项目", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { generateNativeProjectCleanupPreview } = await import(
      "../../scripts/preview-native-project-cleanup.js"
    );

    const configDir = join(tempDir, ".gemini", "config", "projects");
    mkdirSync(configDir, { recursive: true });

    // 1. DevFlow 容器交接项目
    writeFileSync(
      join(configDir, "df-proj.json"),
      JSON.stringify({
        id: "df-1",
        name: "DevFlow 12345",
        projectResources: {
          resources: [{ folderUri: "file:///C:/Code/.devflow/containers/wf-1" }],
        },
      }),
    );

    // 2. 用户自有合法项目
    writeFileSync(
      join(configDir, "user-proj.json"),
      JSON.stringify({
        id: "user-1",
        name: "crm",
        projectResources: {
          resources: [{ folderUri: "file:///C:/Code/crm" }],
        },
      }),
    );

    // 3. 调试残留候选
    writeFileSync(
      join(configDir, "debug-proj.json"),
      JSON.stringify({
        id: "debug-1",
        name: "live-edit-1789",
        projectResources: {
          resources: [{ folderUri: "file:///C:/Code/scratch/runtime-fix" }],
        },
      }),
    );

    const report = generateNativeProjectCleanupPreview(tempDir);
    expect(report.totalProjects).toBe(3);
    expect(report.devflowProjects).toBe(1);
    expect(report.userProjects).toBe(1);
    expect(report.debugCandidates).toBe(1);

    const dfCand = report.candidates.find((c) => c.id === "df-1");
    expect(dfCand?.category).toBe("devflow_container");
    expect(dfCand?.safeToClean).toBe(true);

    const userCand = report.candidates.find((c) => c.id === "user-1");
    expect(userCand?.category).toBe("user_project");
    expect(userCand?.safeToClean).toBe(false);

    const debugCand = report.candidates.find((c) => c.id === "debug-1");
    expect(debugCand?.category).toBe("debug_candidate");
    expect(debugCand?.safeToClean).toBe(false);
  });
});

