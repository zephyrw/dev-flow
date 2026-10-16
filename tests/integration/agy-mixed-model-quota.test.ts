import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { AgyAccountRepository } from "../../packages/agy-accounts/src/repository.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import type { AccountConsumerPort } from "../../packages/agy-accounts/src/ports.js";
import type { WindowKind, AgyQuotaTrigger } from "../../packages/contracts/src/agy-account.js";
import { selectCandidates } from "../../packages/agy-accounts/src/selector.js";

const realmId = "default-agy-realm";
const gemini = "Gemini Models", claude = "Claude and GPT models";
const models: Record<string, string> = { [gemini]: "gemini-3.8-flash", [claude]: "claude-sonnet-4-6" };
type Balances = Record<string, Record<string, { weekly: number; five_hour: number }>>;
let store: Store;
let f: ReturnType<typeof accountFixture>;
let balances: Balances;
let consumer: AccountConsumerPort;

function pools(account: string) {
  const observed_at = new Date().toISOString();
  return [gemini, claude].map(pool_id => ({ pool_id, model_ids: [models[pool_id]!],
    windows: (["weekly", "five_hour"] as const).map(kind => ({
      kind, duration_minutes: kind === "weekly" ? 10080 as const : 300 as const,
      remaining_fraction: balances[account]![pool_id]![kind], observed_at, status: "observed" as const,
      reset_at: new Date(Date.now() + 3600_000).toISOString(),
    })),
  }));
}

function save(account: string) {
  for (const pool of pools(account)) f.repository.saveQuotaSnapshot({
    ...pool, realm_id: realmId, account_id: account, auth_epoch: f.repository.getRealm(realmId)?.auth_epoch ?? 1,
    id: crypto.randomUUID(), source: "official_cli_usage", cli_version: "fixture", parser_revision: 1,
    executable_fingerprint: "fixture", capability_verified: true, observed_at: pool.windows[0]!.observed_at,
  });
}

async function request(pool = claude, window: WindowKind = "weekly", id = crypto.randomUUID()) {
  return f.service.requestWorkflowOperation({ realm_id: realmId, kind: "switch", request_id: id,
    selection: { mode: "auto" }, trigger: "workflow_quota", source_event_key: id,
    workflow_id: "wf-claude", source_run_id: "run-claude", model_id: models[pool],
    required_model_ids: [models[pool]!], required_pool_ids: [pool], quota_window: window,
    expected_epoch: f.repository.getRealm(realmId)!.auth_epoch });
}

beforeEach(async () => {
  store = new Store(":memory:"); f = accountFixture(store); f.seedAccounts();
  balances = {
    a: { [gemini]: { weekly: .8, five_hour: .8 }, [claude]: { weekly: .8, five_hour: .8 } },
    b: { [gemini]: { weekly: .2, five_hour: .9 }, [claude]: { weekly: .9, five_hour: .2 } },
    c: { [gemini]: { weekly: .9, five_hour: .3 }, [claude]: { weekly: .6, five_hour: .8 } },
  };
  vi.spyOn(f.probe, "probeUsage").mockImplementation(async () => ({
    email: `${f.active()}@example.com`, cli_version: "fixture", raw_output: "", executable_fingerprint: "fixture",
    capability_verified: true, pools: pools(f.active()), windows: pools(f.active())[0]!.windows,
  }));
  for (const id of ["a", "b", "c"]) { f.repository.retainQuotaPools(realmId, id, []); save(id); }
  consumer = {
    listOccupancy: vi.fn(async () => [gemini, claude].map(pool => ({ consumer_id: `run-${pool}`,
      permit_ids: [], required_pool_ids: [pool], required_model_ids: [models[pool]!], allowed_account_ids: null, can_pause: true }))),
    prepareSwitch: vi.fn(async () => ({ savedRef: { conversations: ["gemini-conversation", "claude-conversation"] } })),
    quiesce: vi.fn(async () => {}), confirmStopped: vi.fn(async () => true), onAccountCommitted: vi.fn(async () => {}),
  };
  f.service.registerConsumer(consumer);
  await f.service.start({ realmId, requestId: "start" });
});

afterEach(async () => { await f.service.close(); store.close(); vi.restoreAllMocks(); });

it.each([
  [claude, "weekly", "b"], [claude, "five_hour", "c"],
  [gemini, "weekly", "c"], [gemini, "five_hour", "b"],
] as const)("%s %s exhaustion ranks by that window and resumes both models on %s", async (pool, window, expected) => {
  balances.a![pool]![window] = 0; save("a");
  const receipt = await request(pool, window);
  const trigger = f.repository.getOperation(receipt.operation_id)!.quota_trigger;
  expect(trigger).toMatchObject({ pool_id: pool, window, account_id: "a" });
  await f.service.tick(Date.now());
  expect(f.active()).toBe(expected);
  const operation = f.repository.getOperation(receipt.operation_id)!;
  expect(operation.phase).toBe("completed");
  expect(operation.quota_trigger).toEqual(trigger);
  expect(operation.required_model_ids.sort()).toEqual(Object.values(models).sort());
  expect(operation.consumer_refs[0]!.saved_ref).toEqual({ conversations: ["gemini-conversation", "claude-conversation"] });
  expect(consumer.onAccountCommitted).toHaveBeenCalledTimes(1);
});

it("does not let a second zero replace the first trigger, including after repository recreation", async () => {
  balances.a![claude]!.weekly = 0; save("a");
  const first = await request();
  const frozen = f.repository.getOperation(first.operation_id)!.quota_trigger;
  balances.a![gemini]!.five_hour = 0; save("a");
  const second = await request(gemini, "five_hour");
  expect(second.operation_id).toBe(first.operation_id);
  expect(new AgyAccountRepository(store).getOperation(first.operation_id)!.quota_trigger).toEqual(frozen);
  await f.service.tick(Date.now());
  expect(f.active()).toBe("b");
  expect(consumer.quiesce).toHaveBeenCalledTimes(1);
});

it.each(["zero", "missing"])("skips the highest Claude account when its Gemini quota is %s", async state => {
  if (state === "zero") balances.b![gemini]!.five_hour = 0;
  save("b");
  if (state === "missing") {
    const original = vi.mocked(f.probe.probeUsage).getMockImplementation()!;
    vi.mocked(f.probe.probeUsage).mockImplementation(async options => {
      const result = await original(options);
      if (f.active() === "b") result.pools = result.pools.filter(pool => pool.pool_id !== gemini);
      return result;
    });
    f.repository.retainQuotaPools(realmId, "b", [claude]);
  }
  const receipt = await request();
  await f.service.tick(Date.now());
  expect(f.active()).toBe("c");
  expect(f.repository.getOperation(receipt.operation_id)!.phase).toBe("completed");
});

it("reselects a previously verified candidate using the triggering five-hour score", async () => {
  // B wins the initial bound. Its actual short window has fallen below C's
  // cached bound, but remains above C's newly verified value. Return to B.
  balances.b![claude]!.five_hour = .95; balances.c![claude]!.five_hour = .9; save("b"); save("c");
  balances.b![claude]!.five_hour = .8; balances.c![claude]!.five_hour = .6;
  balances.b![claude]!.weekly = .2; balances.c![claude]!.weekly = .9;
  const activate = vi.spyOn(f.authHost, "activateSaved");
  const receipt = await request(claude, "five_hour");
  await f.service.tick(Date.now());
  expect(activate.mock.calls.map(call => call[1])).toEqual(["b", "c", "b"]);
  expect(f.active()).toBe("b");
  expect(f.repository.getOperation(receipt.operation_id)!.quota_trigger?.window).toBe("five_hour");
});

it("waits without losing models or the trigger when no account has both pools available", async () => {
  balances.b![gemini]!.five_hour = 0; balances.c![gemini]!.weekly = 0; save("b"); save("c");
  const receipt = await request();
  await f.service.tick(Date.now());
  const operation = f.repository.getOperation(receipt.operation_id)!;
  expect(operation.phase).toBe("waiting");
  expect(operation.required_model_ids.sort()).toEqual(Object.values(models).sort());
  expect(f.repository.getDomainWait(realmId)?.quota_trigger).toEqual(operation.quota_trigger);
  expect(f.active()).toBe("a");
  expect(consumer.onAccountCommitted).not.toHaveBeenCalled();
});

it("never switches from an unknown legacy trigger and preserves its waiting state", async () => {
  const receipt = await f.service.requestWorkflowOperation({ realm_id: realmId, kind: "switch", request_id: "legacy",
    selection: { mode: "auto" }, trigger: "workflow_quota", source_event_key: "legacy",
    workflow_id: "wf-claude", source_run_id: "run-claude", model_id: models[claude],
    required_model_ids: [models[claude]!], required_pool_ids: [claude], expected_epoch: 1 });
  await f.service.tick(Date.now());
  expect(f.repository.getOperation(receipt.operation_id)).toMatchObject({ phase: "waiting", error: "quota_trigger_unconfirmed" });
  expect(f.active()).toBe("a");
  expect(consumer.quiesce).not.toHaveBeenCalled();
});

it("keeps projection and missing quota as probe candidates, never as execution permits", () => {
  const trigger: AgyQuotaTrigger = { account_id: "a", auth_epoch: 1, pool_id: claude,
    window: "weekly", observed_at: new Date().toISOString(), event_seq: 1, source: "current_turn" };
  f.repository.retainQuotaPools(realmId, "b", [claude]);
  const selection = selectCandidates(f.repository.listAccounts(realmId), f.repository.listQuotaSnapshots(realmId),
    [gemini, claude], Date.now(), { quota_trigger: trigger, required_model_ids: Object.values(models) });
  expect(selection.ranked_candidates.map(candidate => candidate.account_id)).toContain("b");
  expect(selection.ranked_candidates.find(candidate => candidate.account_id === "b")!.projected_weekly).toBe(1);
});
