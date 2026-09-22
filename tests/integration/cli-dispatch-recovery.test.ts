import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { CliDispatchManager } from "../../packages/runtime/src/cli-dispatch.js";

describe("NV-I06 & NV-I08 & NV-U11: CLI自动调度开关、手动接管与恢复集成测试", () => {
  let tempDir: string;
  let store: Store;
  let dispatchManager: CliDispatchManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-dispatch-test-"));
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

  it("默认状态允许调度，手动停用后持久化保存且拒绝派发", () => {
    const wfId = "wf-dispatch-1";
    // 默认允许派发
    const defaultCheck = dispatchManager.canDispatch(wfId);
    expect(defaultCheck.allowed).toBe(true);

    // 手动停用自动调度
    dispatchManager.setDispatchControl(wfId, false, "用户手动在终端接管开发");
    const disabledCheck = dispatchManager.canDispatch(wfId);
    expect(disabledCheck.allowed).toBe(false);
    expect(disabledCheck.reason).toContain("用户手动在终端接管开发");

    // 重启/重建 Manager 模拟平台重启，持久化状态依然保持为禁用
    const freshManager = new CliDispatchManager(store);
    const persistedCheck = freshManager.canDispatch(wfId);
    expect(persistedCheck.allowed).toBe(false);
  });

  it("用户显式恢复自动调度后重新允许派发", () => {
    const wfId = "wf-dispatch-2";
    dispatchManager.setDispatchControl(wfId, false, "暂停排查");
    expect(dispatchManager.canDispatch(wfId).allowed).toBe(false);

    // 显式恢复
    dispatchManager.setDispatchControl(wfId, true);
    expect(dispatchManager.canDispatch(wfId).allowed).toBe(true);
  });

  it("调用生命周期完整追踪：prepare -> running -> completed", () => {
    const wfId = "wf-dispatch-3";
    const dispatchId = "disp-001";
    const runId = "run-001";
    const bindingId = "bind-001";

    // 准备启动
    const prepared = dispatchManager.prepareDispatch({
      dispatchId,
      workflowId: wfId,
      runId,
      bindingId,
    });
    expect(prepared.state).toBe("prepared");

    // 标记启动成功并记录 pid
    dispatchManager.markStarting(dispatchId, 12345);
    expect(dispatchManager.hasActiveRunner(wfId)).toBe(true);

    // 标记完成
    dispatchManager.markCompleted(dispatchId, 0);
    expect(dispatchManager.hasActiveRunner(wfId)).toBe(false);
  });
});
