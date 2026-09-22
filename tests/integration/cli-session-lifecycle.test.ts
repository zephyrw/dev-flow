import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { ExecutionSessionStore } from "../../packages/core/src/execution-session-store.js";
import { selectConversationToResume } from "../../packages/core/src/round-intent.js";
import type { SessionBindingKey } from "../../packages/contracts/src/session-binding.js";

describe("NV-I03 & NV-I04: 同模型会话生命周期与质检连续性集成测试", () => {
  let tempDir: string;
  let store: Store;
  let sessionStore: ExecutionSessionStore;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-lifecycle-test-"));
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

  it("规划产出主会话根后，同模型第一道代码复核优先复用该规划会话根", () => {
    const key: SessionBindingKey = {
      workflow_id: "wf-life-1",
      adapter_id: "codex",
      host_id: "local",
      client_scope_id: "default",
      provider_account_scope: "default",
      canonical_model_id: "gpt-5-codex",
      workspace_identity: "C:/Code/my-repo",
    };

    // 规划阶段建立绑定并锁定会话 ID
    const binding = sessionStore.getOrCreateBinding(key, {
      workspace_root: "C:/Code/my-repo",
      source_root: "C:/Code/my-repo",
      repo_id: "main",
    });
    sessionStore.bindConversationId(binding.id, "thread-planning-root", "run-plan-1");

    // 验证后续第一道代码复核 (quality_review) 在选择会话时复用规划会话根
    const chosen = selectConversationToResume({
      purpose: "quality_review",
      planningSession: { id: "thread-planning-root" },
      defaultSession: undefined,
    });

    expect(chosen).toBeDefined();
    expect(chosen?.id).toBe("thread-planning-root");
  });

  it("执行模型与整改/新批次保持对应执行会话根，A->B->A切换能找回原A会话", () => {
    const keyModelA: SessionBindingKey = {
      workflow_id: "wf-life-2",
      adapter_id: "agy",
      host_id: "local",
      client_scope_id: "default",
      provider_account_scope: "default",
      canonical_model_id: "gemini-2.5-pro",
      workspace_identity: "C:/Code/my-repo",
    };

    const keyModelB: SessionBindingKey = {
      ...keyModelA,
      canonical_model_id: "gemini-2.5-flash",
    };

    // 模型 A 初始化并绑定
    const bindA = sessionStore.getOrCreateBinding(keyModelA, {
      workspace_root: "C:/Code/my-repo",
      source_root: "C:/Code/my-repo",
      repo_id: "main",
    });
    sessionStore.bindConversationId(bindA.id, "conv-model-a", "run-exec-1");

    // 切换到模型 B 初始化并绑定
    const bindB = sessionStore.getOrCreateBinding(keyModelB, {
      workspace_root: "C:/Code/my-repo",
      source_root: "C:/Code/my-repo",
      repo_id: "main",
    });
    sessionStore.bindConversationId(bindB.id, "conv-model-b", "run-exec-2");

    // 切回模型 A：查询 keyModelA 时精准找回原 conv-model-a，而不是混用或被 B 覆盖
    const reloadedA = sessionStore.getBinding(keyModelA);
    expect(reloadedA?.conversation_id).toBe("conv-model-a");

    const reloadedB = sessionStore.getBinding(keyModelB);
    expect(reloadedB?.conversation_id).toBe("conv-model-b");
  });

  it("显式 aside 提问保持独立只读，绝对不复用或污染主规划会话根", () => {
    const chosenAside = selectConversationToResume({
      purpose: "aside",
      planningSession: { id: "thread-planning-root" },
      defaultSession: { id: "thread-planning-root" },
    });

    // aside 必须返回 undefined，独立开只读轮次
    expect(chosenAside).toBeUndefined();
  });
});
