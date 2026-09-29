import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import type { AccountConsumerPort } from "../../packages/agy-accounts/src/ports.js";
import type { WorkflowAccountOperationRequest } from "../../packages/agy-accounts/src/service.js";

const realmId = "default-agy-realm";
let store: Store;
let f: ReturnType<typeof accountFixture>;
let consumer: AccountConsumerPort;

function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open };
}

beforeEach(async () => {
  // No real credential, process, CLI or workflow state is involved.
  store = new Store(":memory:");
  f = accountFixture(store);
  f.seedAccounts();
  consumer = {
    listOccupancy: vi.fn(async () => []),
    prepareSwitch: vi.fn(async () => ({ savedRef: "fixture-consumer" })),
    quiesce: vi.fn(async () => {}),
    confirmStopped: vi.fn(async () => true),
    onAccountCommitted: vi.fn(async () => {}),
  };
  f.service.registerConsumer(consumer);
  await f.service.start({ realmId, requestId: "start" });
});

afterEach(async () => {
  for (const permit of f.repository.listPermits(realmId))
    await f.service.releaseUsagePermit(permit.permit_id, { permit_id: permit.permit_id, success: false });
  await f.service.close();
  vi.restoreAllMocks();
  store.close();
});

function demand(id: string, overrides: Partial<WorkflowAccountOperationRequest> = {}): WorkflowAccountOperationRequest {
  return {
    realm_id: realmId, request_id: id, kind: "switch", selection: { mode: "auto" },
    trigger: "workflow_quota", source_event_key: `quota-${id}`,
    workflow_id: `wf-${id}`, source_run_id: `run-${id}`,
    expected_epoch: f.repository.getRealm(realmId)!.auth_epoch,
    model_id: "fixture-model", required_model_ids: ["fixture-model"],
    required_pool_ids: ["fixture-pool"], allowed_account_ids: null, ...overrides,
  };
}

function usage(id: string) {
  return { realm_id: realmId, consumer_id: id, usage_kind: "execution" as const,
    required_pool_ids: ["fixture-pool"], required_model_ids: ["fixture-model"] };
}

it("merges a second queued demand before selection, including model, pool and allowed-account intersection", async () => {
  // B has more quota, but only C meets the second request's account restriction.
  // No occupancy entry supplies its requirements: acceptOperation must persist them.
  const extraPool = "second-pool", extraModel = "second-model";
  for (const snapshot of f.repository.listQuotaSnapshots(realmId))
    f.repository.saveQuotaSnapshot({ ...snapshot, id: `${snapshot.id}-extra`, pool_id: extraPool, model_ids: [extraModel] });
  const originalUsage = f.probe.probeUsage.bind(f.probe);
  vi.spyOn(f.probe, "probeUsage").mockImplementation(async (...args) => {
    const result = await originalUsage(...args);
    result.pools.push({ pool_id: extraPool, model_ids: [extraModel], windows: result.windows });
    return result;
  });
  const models = vi.spyOn(f.probe, "probeModelAccess");
  const entered = gate(), release = gate();
  vi.spyOn(f.processHost, "findExternalAgyProcesses").mockImplementationOnce(async () => {
    entered.open(); await release.promise; return [];
  });
  const first = await f.service.requestWorkflowOperation(demand("one", { allowed_account_ids: ["b", "c"] }));
  const ticking = f.service.tick(Date.now());
  await entered.promise;
  try {
    expect(f.repository.getOperation(first.operation_id)?.phase).toBe("queued");
    const second = await f.service.requestWorkflowOperation(demand("two", {
      model_id: extraModel, required_model_ids: [extraModel], required_pool_ids: [extraPool], allowed_account_ids: ["a", "c"],
    }));
    expect(second.operation_id).toBe(first.operation_id);
    expect(f.repository.getOperation(first.operation_id)).toMatchObject({
      required_model_ids: ["fixture-model", extraModel], required_pool_ids: ["fixture-pool", extraPool], allowed_account_ids: ["c"],
    });
  } finally { release.open(); await ticking; }
  expect(f.repository.getOperation(first.operation_id)?.phase).toBe("completed");
  expect(f.active()).toBe("c");
  expect(models.mock.calls.map(([model]) => model).sort()).toEqual(["fixture-model", extraModel].sort());
  expect(consumer.onAccountCommitted).toHaveBeenCalledTimes(1);
});

it("closes queued joining before awaiting occupancy and admits a late run only after switching", async () => {
  const entered = gate(), release = gate();
  vi.mocked(consumer.listOccupancy).mockImplementationOnce(async () => {
    entered.open(); await release.promise; return [];
  });
  const operation = await f.service.requestWorkflowOperation(demand("snapshot"));
  const originalEpoch = f.repository.getRealm(realmId)!.auth_epoch;
  const ticking = f.service.tick(Date.now());
  await entered.promise;
  let settled = false;
  // Attach rejection handling immediately: the old queued phase rejects here.
  const late = f.service.acquireUsagePermit(usage("late-run")).then(
    (permit) => { settled = true; return { permit }; },
    (error: unknown) => { settled = true; return { error }; },
  );
  try {
    await Promise.resolve(); await Promise.resolve();
    expect(f.repository.getOperation(operation.operation_id)?.phase).toBe("quiescing");
    expect(settled).toBe(false);
    expect(f.repository.listPermits(realmId)).toHaveLength(0);
  } finally { release.open(); await ticking; }
  const result = await late;
  expect(result).toMatchObject({ permit: { account_id: "b", auth_epoch: originalEpoch + 1 } });
  expect(f.repository.listOperations(realmId).filter((entry) => entry.kind === "switch")).toHaveLength(1);
  expect(f.repository.getOperation(operation.operation_id)?.required_model_ids).toEqual(["fixture-model"]);
});

it("returns a joinable queued-switch rejection when a switch is accepted during admission's external check", async () => {
  const entered = gate(), release = gate();
  vi.spyOn(f.processHost, "findExternalAgyProcesses").mockImplementationOnce(async () => {
    entered.open(); await release.promise; return [];
  });
  const admission = f.service.acquireUsagePermit(usage("racing-run")).then(
    (permit) => ({ permit }), (error: unknown) => ({ error }),
  );
  await entered.promise;
  const operation = await f.service.requestWorkflowOperation(demand("during-admission"));
  release.open();
  expect(await admission).toMatchObject({ error: { code: "account_switch_pending", operation_id: operation.operation_id } });
  expect(f.repository.listPermits(realmId)).toHaveLength(0);
});
