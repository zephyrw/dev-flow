import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { GroupAccountConsumer } from "../../packages/group-chat/src/account-consumer.js";
import { AccountQuotaAdmissionError, type AgyAccountService, type UsagePermit } from "../../packages/agy-accounts/src/service.js";

function fixture() {
  const events = new EventEmitter();
  const realm = { active_account_id: "account-a", auth_epoch: 1, control_generation: 1,
    service_state: "running", phase: "idle", pending_operation_id: undefined as string | undefined };
  const operation = { operation_id: "switch-1", original_operation_id: undefined as string | undefined,
    control_generation: 1, phase: "queued", error: undefined, cancel_requested: false, result: {}, deadline_at: undefined as string | undefined };
  const permitState = { status: "released" };
  const durablePermits: Array<{ consumer_id: string; status: string }> = [];
  const repo = {
    getSettings: () => ({ workflow_auto_switch: true }), getRealm: () => realm,
    getOperation: () => operation, listOperations: () => [operation], getFinalAccountCommit: () => undefined,
    getPermit: () => permitState,
    listPermits: () => durablePermits,
    onChange: (listener: () => void) => { events.on("change", listener); return () => { events.off("change", listener); }; },
  };
  const accounts = {
    isManaged: vi.fn(() => true), registerConsumer: vi.fn(() => vi.fn()), getRepository: () => repo,
    resolveModelPools: () => ["Gemini Models"], triggerOperationImmediate: vi.fn(),
    requestWorkflowOperation: vi.fn(async (_input: { consumer_id?: string; source_run_id?: string; trigger?: string }) => {
      realm.pending_operation_id = operation.operation_id; realm.phase = "queued";
      return { operation_id: operation.operation_id, phase: operation.phase, revision: 1 };
    }),
  };
  const consumer = new GroupAccountConsumer(accounts as unknown as AgyAccountService);
  const finishSwitch = () => {
    operation.phase = "completed"; realm.auth_epoch++; realm.active_account_id = "account-b";
    realm.pending_operation_id = undefined; realm.phase = "idle"; events.emit("change");
  };
  const permit: UsagePermit = { permit_id: "permit-b", realm_id: "default-agy-realm", account_id: "account-b", auth_epoch: 2, realm_revision: 3 };
  return { events, realm, operation, accounts, consumer, finishSwitch, permit, permitState, durablePermits };
}

describe("群聊公共账号等待", () => {
  it("额度入场失败会申请公共切换，提交成功后只重试一次许可申请", async () => {
    const f = fixture();
    const call = f.consumer.track("gemini-flash", new AbortController().signal);
    const acquire = vi.fn().mockRejectedValueOnce(new AccountQuotaAdmissionError("default-agy-realm", "account-a", 1)).mockResolvedValue(f.permit);
    const pending = f.consumer.acquire(call, acquire);
    await vi.waitFor(() => expect(f.accounts.requestWorkflowOperation).toHaveBeenCalledTimes(1));
    expect(f.accounts.requestWorkflowOperation.mock.calls[0]?.[0]).toMatchObject({ consumer_id: "group-chat", source_run_id: call.id, trigger: "workflow_quota" });
    expect(acquire).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    try {
      await vi.advanceTimersByTimeAsync(20_000);
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
    f.finishSwitch();
    await expect(pending).resolves.toEqual(f.permit);
    await f.consumer.onAccountCommitted({ realm_id: "default-agy-realm", operation_id: "switch-1", account_id: "account-b", auth_epoch: 2 });
    f.events.emit("change");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(f.events.listenerCount("change")).toBe(0);
    f.consumer.finish(call); f.consumer.close();
  });
  it("等待取消后迟到的切换成功不会再申请许可，源引用随即失效", async () => {
    const f = fixture(); const abort = new AbortController();
    const call = f.consumer.track("gemini-flash", abort.signal);
    const acquire = vi.fn().mockRejectedValueOnce(new AccountQuotaAdmissionError("default-agy-realm", "account-a", 1));
    const pending = f.consumer.acquire(call, acquire);
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.accounts.requestWorkflowOperation).toHaveBeenCalledTimes(1));
    abort.abort(); await rejected;
    expect(f.consumer.isWaitCurrent({ original_operation_id: "switch-1", source_run_id: call.id })).toBe(false);
    f.finishSwitch();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(f.events.listenerCount("change")).toBe(0);
    f.consumer.finish(call); f.consumer.close();
  });
  it("切换失败保留为可重试错误，启动后开启托管仍有消费者", async () => {
    const f = fixture();
    expect(f.accounts.registerConsumer).toHaveBeenCalledWith(f.consumer, "group-chat");
    const call = f.consumer.track("gemini-flash", new AbortController().signal);
    const acquire = vi.fn().mockRejectedValueOnce(new AccountQuotaAdmissionError("default-agy-realm", "account-a", 1));
    const pending = f.consumer.acquire(call, acquire);
    const rejected = expect(pending).rejects.toThrow("切换失败或已取消");
    await vi.waitFor(() => expect(f.accounts.requestWorkflowOperation).toHaveBeenCalledTimes(1));
    f.operation.phase = "failed"; f.events.emit("change"); await rejected;
    expect(acquire).toHaveBeenCalledTimes(1);
    f.consumer.finish(call); f.consumer.close();
  });
  it("关闭消费者会结束等待，迟到提交不恢复请求", async () => {
    const f = fixture();
    const call = f.consumer.track("gemini-flash", new AbortController().signal);
    const acquire = vi.fn().mockRejectedValueOnce(new AccountQuotaAdmissionError("default-agy-realm", "account-a", 1));
    const pending = f.consumer.acquire(call, acquire);
    const rejected = expect(pending).rejects.toThrow("等待已取消");
    await vi.waitFor(() => expect(f.accounts.requestWorkflowOperation).toHaveBeenCalledTimes(1));
    f.consumer.close(); await rejected; f.finishSwitch();
    expect(acquire).toHaveBeenCalledTimes(1);
    expect(f.events.listenerCount("change")).toBe(0);
  });
  it("取消调用但进程尚未确认退出时保留账号占用", async () => {
    const f = fixture(); const abort = new AbortController();
    const call = f.consumer.track("gemini-flash", abort.signal);
    call.permit = f.permit; f.permitState.status = "started";
    abort.abort(); f.consumer.finish(call);
    expect(await f.consumer.confirmStopped()).toBe(false);
    expect(await f.consumer.listOccupancy()).toHaveLength(1);
    expect(f.consumer.isWaitCurrent({ original_operation_id: "switch-1", source_run_id: call.id })).toBe(false);
    f.permitState.status = "released";
    expect(await f.consumer.confirmStopped()).toBe(true);
    f.consumer.close(); f.consumer.dispose();
  });
  it("排他凭据操作等待健康回复释放许可，不停止或重放回复", async () => {
    const f = fixture(); const abort = new AbortController();
    const call = f.consumer.track("gemini-flash", abort.signal);
    call.permit = f.permit; f.permitState.status = "started";
    await f.consumer.prepareSwitch("switch-1");
    const ready = vi.fn();
    const waiting = f.consumer.quiesce("switch-1").then(ready);
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(abort.signal.aborted).toBe(false);
    expect(f.permitState.status).toBe("started");
    f.permitState.status = "released"; f.consumer.finish(call); f.events.emit("change");
    await waiting;
    expect(await f.consumer.confirmStopped("switch-1")).toBe(true);
    expect(ready).toHaveBeenCalledTimes(1);
    expect(f.events.listenerCount("change")).toBe(0);
    f.consumer.close(); f.consumer.dispose();
  });
  it("已登记但尚未返回调用方的许可仍会阻止排他操作", async () => {
    const f = fixture(); const call = f.consumer.track("gemini-flash", new AbortController().signal);
    f.durablePermits.push({ consumer_id: call.id, status: "issued" });
    await f.consumer.prepareSwitch("switch-1");
    const ready = vi.fn(); const waiting = f.consumer.quiesce("switch-1").then(ready);
    await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
    f.durablePermits[0]!.status = "released"; f.events.emit("change");
    await waiting; expect(await f.consumer.confirmStopped("switch-1")).toBe(true);
    f.consumer.finish(call); f.consumer.close(); f.consumer.dispose();
  });
  it("正常 preserveRunning 切换不等待或打断健康调用", async () => {
    const f = fixture(); const call = f.consumer.track("gemini-flash", new AbortController().signal);
    call.permit = f.permit; f.permitState.status = "started";
    await f.consumer.prepareSwitch("switch-1", { preserveRunning: true });
    await f.consumer.quiesce("switch-1");
    expect(f.permitState.status).toBe("started");
    expect(call.signal.aborted).toBe(false);
    expect(f.events.listenerCount("change")).toBe(0);
    f.permitState.status = "released"; f.consumer.finish(call); f.consumer.close(); f.consumer.dispose();
  });
  it("排他操作取消会结束等待，不释放仍在运行的许可", async () => {
    const f = fixture(); const call = f.consumer.track("gemini-flash", new AbortController().signal);
    call.permit = f.permit; f.permitState.status = "started";
    await f.consumer.prepareSwitch("switch-1");
    const waiting = f.consumer.quiesce("switch-1");
    const rejected = expect(waiting).rejects.toThrow("operation_cancelled");
    f.operation.cancel_requested = true; f.events.emit("change"); await rejected;
    expect(f.permitState.status).toBe("started");
    expect(await f.consumer.confirmStopped("switch-1")).toBe(false);
    expect(f.events.listenerCount("change")).toBe(0);
    f.permitState.status = "released"; f.consumer.finish(call); f.consumer.close(); f.consumer.dispose();
  });
  it("群聊取消后仍等待未知进程退出，迟到提交不会恢复该调用", async () => {
    const f = fixture(); const abort = new AbortController();
    const call = f.consumer.track("gemini-flash", abort.signal);
    call.permit = f.permit; f.permitState.status = "started";
    await f.consumer.prepareSwitch("switch-1");
    const ready = vi.fn(); const waiting = f.consumer.quiesce("switch-1").then(ready);
    abort.abort(); f.consumer.finish(call); f.events.emit("change");
    await Promise.resolve(); expect(ready).not.toHaveBeenCalled();
    expect(await f.consumer.confirmStopped("switch-1")).toBe(false);
    f.permitState.status = "released"; f.events.emit("change"); await waiting;
    await f.consumer.onAccountCommitted({ realm_id: "default-agy-realm", operation_id: "switch-1", account_id: "account-b", auth_epoch: 2 });
    expect(f.consumer.isWaitCurrent({ original_operation_id: "switch-1", source_run_id: call.id })).toBe(false);
    expect(f.events.listenerCount("change")).toBe(0);
    f.consumer.close(); f.consumer.dispose();
  });
  it("账号操作超过自身期限时退出等待，保留未确认退出的许可", async () => {
    const f = fixture(); const call = f.consumer.track("gemini-flash", new AbortController().signal);
    call.permit = f.permit; f.permitState.status = "started";
    vi.useFakeTimers();
    try {
      f.operation.deadline_at = new Date(Date.now() + 20_000).toISOString();
      await f.consumer.prepareSwitch("switch-1");
      const rejected = expect(f.consumer.quiesce("switch-1")).rejects.toThrow("operation_timeout");
      await vi.advanceTimersByTimeAsync(20_000); await rejected;
      expect(await f.consumer.confirmStopped("switch-1")).toBe(false);
      expect(f.permitState.status).toBe("started");
      expect(f.events.listenerCount("change")).toBe(0);
    } finally {
      vi.useRealTimers(); f.permitState.status = "released"; f.consumer.finish(call); f.consumer.close(); f.consumer.dispose();
    }
  });
  it("尚未启动的有效调用在排他操作完成后恢复一次", async () => {
    const f = fixture(); const call = f.consumer.track("gemini-flash", new AbortController().signal);
    f.realm.pending_operation_id = "switch-1";
    const acquire = vi.fn().mockRejectedValueOnce(new Error("account operation pending")).mockResolvedValue(f.permit);
    const pending = f.consumer.acquire(call, acquire);
    await vi.waitFor(() => expect(f.events.listenerCount("change")).toBe(1));
    await f.consumer.prepareSwitch("switch-1"); await f.consumer.quiesce("switch-1");
    expect(await f.consumer.confirmStopped("switch-1")).toBe(true);
    f.finishSwitch();
    await f.consumer.onAccountCommitted({ realm_id: "default-agy-realm", operation_id: "switch-1", account_id: "account-b", auth_epoch: 2 });
    await expect(pending).resolves.toEqual(f.permit);
    f.events.emit("change");
    expect(acquire).toHaveBeenCalledTimes(2);
    expect(f.accounts.requestWorkflowOperation).not.toHaveBeenCalled();
    f.consumer.finish(call); f.consumer.close(); f.consumer.dispose();
  });
});
