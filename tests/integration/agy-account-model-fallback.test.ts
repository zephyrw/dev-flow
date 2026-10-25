import { afterEach, expect, it, vi } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { parseAgyUsageOutput } from "../../packages/adapters/agy/src/quota-parser.js";
import { evaluateAccountForDemand } from "../../packages/agy-accounts/src/selector.js";
import { formatSnapshotQuotaWindow } from "../../packages/presentation/src/agy-accounts.js";

const realm = "default-agy-realm", argon = "gemini-4-argon-high", flash = "gemini-3.8-flash-high";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanups.splice(0)) await fn(); vi.restoreAllMocks(); });
async function setup(lists: Record<string, string[]>, quotas: Record<string, { argon?: number; flash: number }>) {
  const store = new Store(":memory:"), f = accountFixture(store, argon); f.seedAccounts();
  cleanups.push(async () => { await f.service.close(); store.close(); });
  const catalog = (id: string) => ({ native_ids: lists[id]!, executable_fingerprint: "fixture", observed_at: new Date().toISOString(), cli_version: "fixture" });
  const observed = (id: string) => {
    const reset = new Date(Date.now() + 86400000).toISOString();
    const result = parseAgyUsageOutput([
      `Gemini Models\tWeekly Limit Remaining\t${quotas[id]!.flash}%\t${reset}`,
      `Gemini Models\tFive Hour Limit Remaining\t100%\t${reset}`,
      ...(quotas[id]!.argon === undefined ? [] : [`Gemini 4 Argon\tGemini 4 Argon Weekly Limit\t${quotas[id]!.argon}%\t${reset}`]),
    ].join("\n"));
    return result.pools.map(p => ({ pool_id: p.pool_id, model_ids: p.models, windows: p.windows, capability_verified: true }));
  };
  for (const id of ["a", "b", "c"]) {
    const account = f.repository.getAccount(realm, id)!;
    f.repository.saveAccount({ ...account, models: catalog(id) });
    f.repository.retainQuotaPools(realm, id, []);
    for (const pool of observed(id)) f.repository.saveQuotaSnapshot({ ...pool, id: crypto.randomUUID(), realm_id: realm,
      account_id: id, auth_epoch: 1, source: "official_cli_usage", cli_version: "fixture", executable_fingerprint: "fixture",
      parser_revision: 1, observed_at: pool.windows[0]!.observed_at });
  }
  vi.spyOn(f.authHost, "inspectActive").mockImplementation(async () => ({ exists: true,
    auth: { email: `${f.active()}@example.com`, has_refresh_credential: true } }));
  f.probe.probeModels = vi.fn(async () => catalog(f.active()));
  vi.spyOn(f.probe, "probeUsage").mockImplementation(async () => ({ email: `${f.active()}@example.com`,
    cli_version: "fixture", windows: [], raw_output: "", pools: observed(f.active()), executable_fingerprint: "fixture", capability_verified: true }));
  const inference = vi.spyOn(f.probe, "probeModelAccess").mockImplementation(async model => lists[f.active()]!.includes(model));
  const committed = vi.fn(async () => {}), stop = vi.spyOn(f.processHost, "stopProcess");
  f.service.registerConsumer({ listOccupancy: async () => [], prepareSwitch: async () => ({ savedRef: { runs: [{ run_id: "failed" }] } }),
    quiesce: async () => { throw new Error("healthy tasks must not stop"); }, confirmStopped: async () => false, onAccountCommitted: committed });
  await f.service.start({ realmId: realm, requestId: "start" });
  const request = async () => {
    const result = await f.service.requestWorkflowOperation({ realm_id: realm, kind: "switch", request_id: crypto.randomUUID(),
      selection: { mode: "auto" }, trigger: "workflow_quota", source_event_key: crypto.randomUUID(), workflow_id: "wf", source_run_id: "run",
      model_id: argon, required_model_ids: [argon], required_pool_ids: ["Gemini 4 Argon"], quota_window: "weekly", expected_epoch: 1 });
    await f.service.tick(Date.now());
    return f.repository.getOperation(result.operation_id)!;
  };
  return { ...f, request, inference, committed, stop };
}

it("chooses an account supporting the exact model before a higher quota incompatible account", async () => {
  const f = await setup({ a: [argon], b: [flash], c: [argon] }, { a: { argon: 0, flash: 20 }, b: { flash: 100 }, c: { argon: 70, flash: 10 } });
  const result = await f.request();
  expect(result).toMatchObject({ phase: "completed", result: { active_account_id: "c", model_selection_required: false } });
  expect(f.inference).toHaveBeenCalledWith(argon, expect.objectContaining({ account_id: "c" }));
  expect(f.stop).not.toHaveBeenCalled();
});
it("falls back to the highest usable pool and requires a model choice when the original model is absent", async () => {
  const f = await setup({ a: [argon], b: [flash], c: [flash] }, { a: { argon: 0, flash: 20 }, b: { flash: 95 }, c: { flash: 60 } });
  const result = await f.request();
  expect(result).toMatchObject({ phase: "completed", result: { active_account_id: "b", model_selection_required: true } });
  expect(f.committed).toHaveBeenCalledWith(expect.objectContaining({ account_id: "b", model_selection_required: true }));
  expect(f.repository.getAccount(realm, "b")?.models?.native_ids).toEqual([flash]);
  expect(f.repository.getFinalAccountCommit(result.operation_id)?.model_selection_required).toBe(true);
  expect(f.inference).not.toHaveBeenCalled();
  expect(f.stop).not.toHaveBeenCalled();
});
it("uses an alternative model pool when all accounts supporting the original model have exhausted it", async () => {
  const f = await setup({ a: [argon, flash], b: [argon, flash], c: [flash] },
    { a: { argon: 0, flash: 20 }, b: { argon: 0, flash: 90 }, c: { flash: 60 } });
  expect(await f.request()).toMatchObject({ phase: "completed", result: { active_account_id: "b", model_selection_required: true } });
});
it("retains the best verified fallback if the final candidate needs login", async () => {
  const f = await setup({ a: [argon], b: [flash], c: [flash] }, { a: { argon: 0, flash: 20 }, b: { flash: 95 }, c: { flash: 60 } });
  const usage = vi.mocked(f.probe.probeUsage).getMockImplementation()!;
  vi.mocked(f.probe.probeUsage).mockImplementation(async (...args) => {
    if (f.active() === "a") throw new Error("authentication_required");
    return usage(...args);
  });
  expect(await f.request()).toMatchObject({ phase: "completed", result: { active_account_id: "b", model_selection_required: true } });
  expect(f.stop).not.toHaveBeenCalled();
});
it("uses only Argon's weekly pool and keeps a malformed ordinary Gemini pool ineligible", async () => {
  const f = await setup({ a: [argon], b: [argon], c: [flash] }, { a: { argon: 0, flash: 20 }, b: { argon: 80, flash: 0 }, c: { flash: 80 } });
  const account = f.repository.getAccount(realm, "b")!, snapshots = f.repository.listQuotaSnapshots(realm, "b");
  const result = evaluateAccountForDemand({ account, snapshots, evaluationTime: Date.now(),
    policy: { required_pool_ids: ["Gemini 4 Argon"], required_model_ids: [argon] } });
  expect(result).toMatchObject({ eligible_for_permit: true, min_five_hour: null, projected_weekly: .8 });
  const pool = snapshots.find(s => s.pool_id === "Gemini 4 Argon")!;
  expect(formatSnapshotQuotaWindow(pool, "weekly").percentageText).toBe("80%");
  expect(parseAgyUsageOutput("Gemini Models\tWeekly Limit Remaining\t80%\t1d").pools[0]!.windows[0]!.remaining_fraction).toBeNull();
});
it("manually selects a saved identity without any remote quota or model request", async () => {
  const f = await setup({ a: [argon], b: [flash], c: [flash] }, { a: { argon: 0, flash: 20 }, b: { flash: 100 }, c: { flash: 70 } });
  vi.mocked(f.probe.probeUsage).mockClear(); vi.mocked(f.probe.probeModels!).mockClear();
  const r = await f.service.requestOperation({ realm_id: realm, request_id: "manual", kind: "switch", selection: { mode: "explicit", account_id: "b" } });
  await f.service.tick(Date.now());
  expect(f.repository.getOperation(r.operation_id)?.phase).toBe("completed");
  expect(f.probe.probeUsage).not.toHaveBeenCalled(); expect(f.probe.probeModels).not.toHaveBeenCalled(); expect(f.inference).not.toHaveBeenCalled();
});
