import { beforeEach, expect, it, vi } from "vitest";
import type { Store } from "../../packages/store/src/store.js";
import type { ProcessManager, ManagedProcess } from "../../packages/process/src/manager.js";
import type { ProcessIdentity } from "../../packages/process/src/process-protocol.js";
import { AgyAccountProcessHost } from "../../packages/process/src/agy-account-processes.js";

const native = vi.hoisted(() => ({
  createJob: vi.fn(), openJob: vi.fn(() => 1n), queryJobActiveCount: vi.fn(() => 1),
  closeHandle: vi.fn(), isProcessInJob: vi.fn((_pid: number, _job: bigint) => true),
}));
vi.mock("../../packages/process/src/native/index.js", () => ({
  getNative: () => native, getNativeAsync: async () => native,
}));

beforeEach(() => vi.clearAllMocks());

const attempt = "80766c70-8e32-4e3c-9cf9-3203cf6ea5f4";
const otherAttempt = "06db9c33-9411-4771-acd6-1f573af22b48";
const realm = "default-agy-realm";
function fixture(hasJob = false) {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const ready = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
  // A manager owns the ready rejection independently of admission waiters.
  void ready.catch(() => {});
  const identity: ProcessIdentity = { backend: "node-v1", id: "run-1", attempt_id: attempt,
    ...(hasJob ? { job_name: `Local\\DevFlow.${attempt}` } : {}) };
  let record: { id: string; status: string; confirmed: boolean; pid?: number; identity: ProcessIdentity;
    agy_account: { realm_id: string; account_id: string; auth_epoch: number; permit_id: string } } | undefined = {
    id: "run-1", status: "starting", confirmed: false, identity: { ...identity },
    agy_account: { realm_id: realm, account_id: "account-a", auth_epoch: 1, permit_id: "permit-a" },
  };
  const original = { identity, ready } as ManagedProcess;
  let managed: ManagedProcess | undefined = original;
  const host = new AgyAccountProcessHost({
    store: { list: () => record ? [record] : [] } as unknown as Store,
    agyExecutable: "agy.exe", processManager: { get: () => managed } as unknown as ProcessManager,
  });
  vi.spyOn(host as any, "inventory").mockResolvedValue([
    { pid: 123, parent: 12, name: "agy.exe", exe_path: "C:/fixture/agy.exe", sid: "fixture-user" },
  ]);
  return { host, original, resolve, reject,
    get record() { return record!; }, set record(value) { record = value; },
    setManaged(value: ManagedProcess | undefined) { managed = value; },
    removeRecord() { record = undefined; },
    start() {
      Object.assign(identity, { pid: 123, job_name: `Local\\DevFlow.${attempt}` });
      record = { ...record!, status: "running", pid: 123, identity: { ...identity } };
      resolve();
    },
  };
}

it.each([false, true])("managed admission waits for owned startup (Job present: %s) and uses the fresh PID", async (hasJob) => {
  const f = fixture(hasJob);
  let settled = false;
  const result = f.host.listManagedProcesses(realm).finally(() => { settled = true; });
  void result.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  f.start();
  expect(await result).toEqual([{ pid: 123, ...f.record.agy_account }]);
});

it("external-process inventory waits for owned startup before checking Job ownership", async () => {
  const f = fixture();
  let settled = false;
  const result = f.host.findExternalAgyProcesses().finally(() => { settled = true; });
  void result.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  f.start();
  expect(await result).toEqual([]);
  expect(native.isProcessInJob).toHaveBeenCalledWith(123, 1n);
});

it("external inventory includes an unrelated AGY process appearing while owned startup is pending", async () => {
  const f = fixture();
  let externalAppeared = false;
  vi.spyOn(f.host as any, "inventory").mockImplementation(async () => [
    { pid: 123, parent: 12, name: "agy.exe", exe_path: "C:/fixture/agy.exe", sid: "fixture-user" },
    ...(externalAppeared ? [
      { pid: 456, parent: 45, name: "agy.exe", exe_path: "C:/fixture/agy.exe", sid: "fixture-user" },
    ] : []),
  ]);
  native.isProcessInJob.mockImplementation((pid: number) => pid === 123);
  try {
    const result = f.host.findExternalAgyProcesses();
    await new Promise((resolve) => setImmediate(resolve));
    externalAppeared = true;
    f.start();
    expect(await result).toEqual([expect.objectContaining({ pid: 456, sid: "fixture-user" })]);
  } finally { native.isProcessInJob.mockImplementation(() => true); }
});

for (const kind of ["managed", "external"] as const) {
  const inspect = (f: ReturnType<typeof fixture>) => kind === "managed"
    ? f.host.listManagedProcesses(realm) : f.host.findExternalAgyProcesses();

  it.each(["attempt", "manager", "realm", "missing", "unconfirmed"] as const)(`${kind} rejects startup whose %s changes while waiting`, async (change) => {
    const f = fixture();
    const result = inspect(f);
    const rejected = expect(result).rejects.toThrow("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
    await new Promise((resolve) => setImmediate(resolve));
    f.start();
    if (change === "attempt") f.record = { ...f.record, identity: { ...f.record.identity, attempt_id: otherAttempt } };
    if (change === "manager") f.setManaged({ ...f.original } as ManagedProcess);
    if (change === "realm") f.record = { ...f.record, agy_account: { ...f.record.agy_account, realm_id: "another-realm" } };
    if (change === "missing") f.removeRecord();
    if (change === "unconfirmed") f.setManaged(undefined);
    await rejected;
  });

  it(`${kind} still rejects failed readiness without a confirmed exit`, async () => {
    const f = fixture();
    const result = inspect(f);
    const rejected = expect(result).rejects.toThrow("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
    await new Promise((resolve) => setImmediate(resolve));
    f.record = { ...f.record, status: "failed", confirmed: false };
    f.reject(new Error("startup failed"));
    await rejected;
  });

  it(`${kind} retains a confirmed exit when readiness rejects`, async () => {
    const f = fixture();
    vi.spyOn(f.host as any, "inventory").mockResolvedValue([]);
    const result = inspect(f);
    await new Promise((resolve) => setImmediate(resolve));
    f.record = { ...f.record, status: "exited", confirmed: true };
    f.setManaged(undefined);
    f.reject(new Error("startup cancelled"));
    expect(await result).toEqual([]);
  });

  it(`${kind} never waits for another attempt's readiness`, async () => {
    const f = fixture();
    f.setManaged({ ...f.original, identity: { ...f.original.identity!, attempt_id: otherAttempt } } as ManagedProcess);
    await expect(inspect(f)).rejects.toThrow("AGY_MANAGED_PROCESS_IDENTITY_UNKNOWN");
  });
}
