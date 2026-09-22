import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { CliDispatchManager } from "../../packages/runtime/src/cli-dispatch.js";
import { generateResumeInstructions } from "../../packages/adapters/sdk/src/resume-instructions.js";
import { FlowError } from "../../packages/contracts/src/index.js";

describe("CLI 调度控制与手动续接指令 (NV-U05, NV-U11)", () => {
  let tempDir: string;
  let store: Store;
  let dispatchManager: CliDispatchManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "devflow-dispatch-test-"));
    store = new Store(join(tempDir, "state.db"));
    dispatchManager = new CliDispatchManager(store);
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("NV-U11: 调度开关默认为 true，手动关闭后持久化并阻止后续派发", () => {
    const wfId = "wf-dispatch-1";
    const initial = dispatchManager.getDispatchControl(wfId);
    expect(initial.dispatch_enabled).toBe(true);

    dispatchManager.setDispatchControl(wfId, false, "用户手动停用自动调度");
    const updated = dispatchManager.getDispatchControl(wfId);
    expect(updated.dispatch_enabled).toBe(false);
    expect(updated.paused_reason).toBe("用户手动停用自动调度");

    const check = dispatchManager.canDispatch(wfId);
    expect(check.allowed).toBe(false);

    expect(() =>
      dispatchManager.prepareDispatch({
        dispatchId: "disp-1",
        workflowId: wfId,
        runId: "run-1",
        bindingId: "bind-1",
      }),
    ).toThrow(FlowError);
  });

  it("NV-U05: 调度生命周期变迁：prepared -> running -> completed", () => {
    const wfId = "wf-dispatch-2";
    const disp = dispatchManager.prepareDispatch({
      dispatchId: "disp-100",
      workflowId: wfId,
      runId: "run-100",
      bindingId: "bind-100",
    });
    expect(disp.state).toBe("prepared");

    const starting = dispatchManager.markStarting("disp-100", 9988);
    expect(starting.state).toBe("starting");
    expect(starting.process_identity?.pid).toBe(9988);

    expect(dispatchManager.hasActiveRunner(wfId)).toBe(true);

    const completed = dispatchManager.markCompleted("disp-100", 0);
    expect(completed.state).toBe("completed");
    expect(completed.exit_code).toBe(0);

    expect(dispatchManager.hasActiveRunner(wfId)).toBe(false);
  });

  it("NV-U11: generateResumeInstructions 正确生成 AGY 与 Codex 手动续接指令且不含内部 token", () => {
    const agyInstructions = generateResumeInstructions({
      bindingId: "bind-agy",
      workflowId: "wf-agy",
      adapterId: "agy",
      conversationId: "cdd946fb-0000-0000-0000-000000000000",
      cwd: "C:/Code/project",
      managedWriterState: "idle",
      dispatchEnabled: false,
      modelId: "gemini-2.5-pro",
      executablePath: "agy",
    });

    expect(agyInstructions.copy_script).toBeDefined();
    expect(agyInstructions.copy_script).toContain("agy");
    expect(agyInstructions.copy_script).toContain("cdd946fb-0000-0000-0000-000000000000");
    expect(agyInstructions.copy_script).toContain("EnvironmentVariables.Remove('DEVFLOW_RUN_TOKEN')");
    expect(agyInstructions.reason).toBeUndefined();

    const codexInstructions = generateResumeInstructions({
      bindingId: "bind-codex",
      workflowId: "wf-codex",
      adapterId: "codex",
      conversationId: "thread-xyz-789",
      cwd: "C:/Code/project",
      managedWriterState: "active",
      dispatchEnabled: false,
      modelId: "gpt-5-pro",
      executablePath: "codex",
    });

    // CW2-F17 / CW2-F18: 占用非 idle 时禁止提供 copy_script
    expect(codexInstructions.copy_script).toBeUndefined();
    expect(codexInstructions.reason).toContain("受管调用写者");
  });
});
