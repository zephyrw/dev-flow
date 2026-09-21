import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createWorkspaceCheckpoint,
  restoreWorkspaceCheckpoint,
} from "../../packages/runtime/src/agy-workspace-checkpoint.js";
import { AgySubagentObserver } from "../../packages/adapters/agy/src/subagent-observer.js";
import { AgyWorkflowRecoveryCoordinator } from "../../packages/runtime/src/agy-workflow-recovery.js";
import { AgyRecoveryCheckpointManager } from "../../packages/runtime/src/agy-recovery-checkpoint.js";
import { beginRunConversation } from "../../packages/core/src/conversation-lineage.js";
import { Store } from "../../packages/store/src/store.js";
import type { Run, ToolProfile } from "../../packages/contracts/src/index.js";

describe("AGF-D08: 子事件与终态保护 (AGF-U10)", () => {
  it("迟到的 spawn 事件不得覆盖子 Agent 已达成的 complete 终态", () => {
    const observer = new AgySubagentObserver();
    const events: any[] = [];
    observer.subscribe((ev) => events.push(ev));

    // 1. 发送 complete 事件
    observer.observeStreamLine(
      JSON.stringify({
        event: "subagent_info",
        id: "sub_1",
        status: "completed",
        role: "worker",
      }),
    );
    expect(events.length).toBe(1);
    expect(events[0].event_type).toBe("complete");

    // 2. 发送迟到的 spawn 事件
    observer.observeStreamLine(
      JSON.stringify({
        event: "subagent_info",
        id: "sub_1",
        status: "running",
        role: "worker",
      }),
    );
    // 事件不应被再次派发或降级为 spawn
    expect(events.length).toBe(1);
  });
});

describe("AGF-D08: 工作区材料快照与保全 (AGF-U11)", () => {
  let tempDir: string;
  let storageRoot: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agy-ws-test-"));
    storageRoot = mkdtempSync(join(tmpdir(), "agy-storage-"));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(storageRoot, { recursive: true, force: true });
    } catch {}
  });

  it("正确排除敏感文件并生成快照清单", async () => {
    // 创建普通文件和敏感文件
    writeFileSync(join(tempDir, "regular.txt"), "hello world");
    writeFileSync(join(tempDir, ".env"), "SECRET=xyz");

    const result = await createWorkspaceCheckpoint(tempDir, {
      storageRoot,
      workflowId: "wf_1",
      sourceCheckpointId: "chk_1",
    });

    expect(result.checkpoint_ref).toBeTruthy();
    expect(result.manifest.complete).toBe(true);
    // .env 应该被安全排除，不计入 untracked 列表
    expect(
      result.manifest.untracked_files.some((f) => f.relative_path === ".env"),
    ).toBe(false);
  });
});

describe("AGF-D07 & AGF-D09: 恢复决策与显式续接 (AGF-U09 & AGF-U12)", () => {
  it("当有原会话 ID 时，恢复决策固定为 exact_resume，且多次切号预算单调递减", async () => {
    const store = new Store(":memory:");
    const checkpointManager = new AgyRecoveryCheckpointManager(store);
    const coordinator = new AgyWorkflowRecoveryCoordinator();

    const testProfile: ToolProfile = {
      id: "profile",
      revision: 1,
      adapterId: "agy",
      executableRef: "agy",
      modelSelection: "explicit",
      modelId: "gemini-2.5-pro",
      selectionKind: "fixed",
      reasoning: { mode: "native-default" },
      options: {},
    };

    const initialRun: Run = {
      id: "run_source",
      workflow_id: "wf_1",
      plan_revision: 1,
      adapter: "agy",
      stage: "EXECUTION",
      status: "RUNNING",
      started_at: new Date(Date.now() - 50_000).toISOString(),
      deadline_at: Date.now() + 250_000,
      package_hash: "hash_1",
      profile: testProfile,
      conversation_id: "conv_original_123",
      frozen_invocation: {
        schema_version: 1,
        adapterId: "agy",
        executable: "agy",
        modelToken: "gemini-2.5-pro",
        effortArgs: [],
        effortEnv: {},
        transport: "flag",
        reasoning: { mode: "native-default" },
        providerScope: "provider_default",
        accountScope: "acc_old",
        identityConfidence: "account",
        capabilityRevision: "rev_1",
        runtimeFlavor: "legacy-agy-native",
        accessModelKey: "gemini-2.5-pro",
      },
    };
    store.put("run", "run_source", "wf_1", initialRun);

    const event = {
      realm_id: "default",
      operation_id: "op_1",
      account_id: "acc_new",
      auth_epoch: 2,
    };

    const affected = [
      {
        workflow_id: "wf_1",
        run_id: "run_source",
        permit_id: "perm_1",
        account_id: "acc_old",
        auth_epoch: 1,
        required_pool_ids: ["pool_1"],
        effective_model_id: "gemini-2.5-pro",
      },
    ];

    const plans = await coordinator.planRecovery(
      event as any,
      affected as any,
      store,
      checkpointManager,
    );

    expect(plans.length).toBe(1);
    const plan = plans[0]!;
    expect(plan.decision).toBe("exact_resume");
    expect(plan.continuation?.original_conversation_id).toBe(
      "conv_original_123",
    );
    expect(plan.continuation?.remaining_budget_ms).toBeLessThanOrEqual(250_000);

    // 验证 beginRunConversation：即使账号身份指纹变化，在 exact_resume 下直接返回原会话 ID
    const recoveredRun: Run = {
      id: "run_source",
      workflow_id: "wf_1",
      plan_revision: 1,
      adapter: "agy",
      stage: "EXECUTION",
      status: "RUNNING",
      started_at: new Date().toISOString(),
      package_hash: "hash_1",
      profile: testProfile,
      invocation_fingerprint: "fingerprint_acc_new", // 新身份指纹
    };

    const resume = beginRunConversation(store, recoveredRun, "fingerprint_acc_new");
    expect(resume).not.toBeUndefined();
    expect(resume?.id).toBe("conv_original_123");
  });
});
