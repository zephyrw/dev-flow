import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { CliDispatchManager } from "../../packages/runtime/src/cli-dispatch.js";

describe("CW2-T12: CLI 调度暂停与明确恢复集成测试", () => {
  let tempDir: string;
  let store: Store;
  let dispatchManager: CliDispatchManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-pause-resume-test-"));
    const dbPath = join(tempDir, "test.db");
    store = new Store(dbPath);
    dispatchManager = new CliDispatchManager(store);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("CW2-T12: 暂停与恢复 - 添加 workflow_pause 原因禁用调度，明确继续移除该原因并恢复调度", () => {
    const wfId = "wf-pause-1";

    // 初始状态默认为开启
    const init = dispatchManager.getDispatchControl(wfId);
    expect(init.dispatch_enabled).toBe(true);
    expect(init.reasons.length).toBe(0);

    // 暂停：写入 workflow_pause
    const paused = dispatchManager.addControlReason(wfId, {
      reason: "workflow_pause",
      message: "工作流主动暂停",
    });
    expect(paused.dispatch_enabled).toBe(false);
    expect(paused.reasons.some((r) => r.reason === "workflow_pause")).toBe(true);

    // 用户明确继续：精准移除 workflow_pause
    const resumed = dispatchManager.removeControlReason(wfId, "workflow_pause");
    expect(resumed.dispatch_enabled).toBe(true);
    expect(resumed.reasons.length).toBe(0);
  });

  it("CW2-T12: 存在 user_disabled 时明确继续只解除 workflow_pause，保留 user_disabled", () => {
    const wfId = "wf-multi-reason";

    // 用户先主动停用调度
    dispatchManager.addControlReason(wfId, {
      reason: "user_disabled",
      message: "用户手动在控制台禁用调度",
    });

    // 随后系统发生 workflow_pause
    dispatchManager.addControlReason(wfId, {
      reason: "workflow_pause",
      message: "引擎执行暂停",
    });

    const state = dispatchManager.getDispatchControl(wfId);
    expect(state.reasons.length).toBe(2);
    expect(state.dispatch_enabled).toBe(false);

    // 点击“继续”只解除 workflow_pause
    const afterResume = dispatchManager.removeControlReason(wfId, "workflow_pause");
    expect(afterResume.reasons.length).toBe(1);
    expect(afterResume.reasons[0]!.reason).toBe("user_disabled");
    // 依然处于禁用状态（保留用户的 user_disabled 开关）
    expect(afterResume.dispatch_enabled).toBe(false);
  });

  it("CW2-T12: 调度控制 CAS 版本冲突返回 409", () => {
    const wfId = "wf-cas-test";

    const s1 = dispatchManager.getDispatchControl(wfId);
    expect(s1.revision).toBe(1);

    // 携带错误版本号添加原因必须报错 409
    expect(() => {
      dispatchManager.addControlReason(
        wfId,
        { reason: "workflow_pause" },
        99, // 错误的 expectedRevision
      );
    }).toThrow(/调度控制版本冲突/);

    // 携带错误版本号移除原因必须报错 409
    expect(() => {
      dispatchManager.removeControlReason(wfId, "workflow_pause", undefined, 99);
    }).toThrow(/调度控制版本冲突/);
  });

  it("CW2-T12: 迁移成功后明确继续只解除指定 migration_id 原因", () => {
    const wfId = "wf-mig-reason";

    // 录入两个不同迁移 ID 的原因
    dispatchManager.addControlReason(wfId, {
      reason: "migration",
      migration_id: "mig-aaa",
      message: "迁移任务 AAA 进行中",
    });
    dispatchManager.addControlReason(wfId, {
      reason: "migration",
      migration_id: "mig-bbb",
      message: "迁移任务 BBB 进行中",
    });

    const state = dispatchManager.getDispatchControl(wfId);
    expect(state.reasons.length).toBe(2);

    // 迁移 AAA 完成后，只解除 mig-aaa
    const afterA = dispatchManager.removeControlReason(wfId, "migration", {
      migration_id: "mig-aaa",
    });
    expect(afterA.reasons.length).toBe(1);
    expect(afterA.reasons[0]!.migration_id).toBe("mig-bbb");
    expect(afterA.dispatch_enabled).toBe(false);

    // 迁移 BBB 完成后，解除 mig-bbb
    const afterB = dispatchManager.removeControlReason(wfId, "migration", {
      migration_id: "mig-bbb",
    });
    expect(afterB.reasons.length).toBe(0);
    expect(afterB.dispatch_enabled).toBe(true);
  });

  it("CW2-T12: 旧记录 dispatch_enabled=false 无原因集合保守映射为 user_disabled", () => {
    const wfId = "wf-legacy-record";

    // 模拟旧数据：dispatch_enabled=false 但没有 reasons 数组
    store.put("workflow_dispatch_control", wfId, wfId, {
      workflow_id: wfId,
      dispatch_enabled: false,
      revision: 3,
      updated_at: new Date().toISOString(),
    } as any);

    const state = dispatchManager.getDispatchControl(wfId);
    expect(state.dispatch_enabled).toBe(false);
    expect(state.reasons.length).toBe(1);
    expect(state.reasons[0]!.reason).toBe("user_disabled");
  });
});
