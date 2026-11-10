import { it, expect, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, project, testConsoleHeaders } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { readToolQuota } from "../../packages/runtime/src/tool-quota.js";
import { ToolProfileSchema } from "../../packages/contracts/src/execution-spec.js";
import { setAdapterExecutableResolver } from "../../packages/adapters/sdk/src/registry.js";

it("serves shared CodeBuddy credits for a configured role without a model turn", async () => {
  const s = setup();
  const p = project(s.root);
  s.store.put("project", p.id, p.id, p);
  s.store.put("workflow", "wf-codebuddy-quota", p.id, {
    id: "wf-codebuddy-quota", project_id: p.id, state: "EXECUTING", stage: "execute", run_id: "other-run", version: 1,
  });
  s.store.put("run", "codebuddy-planner-run", "wf-codebuddy-quota", {
    id: "codebuddy-planner-run", workflow_id: "wf-codebuddy-quota", purpose: "planning", started_at: new Date().toISOString(),
    profile: ToolProfileSchema.parse({ id: "codebuddy", adapterId: "codebuddy-code", modelId: "auto" }),
  });
  const app = await buildServer(s.engine);
  const restore = setAdapterExecutableResolver(adapter => adapter === "codebuddy-code" ? resolve("tests/fixtures/codebuddy-cli.mjs") : undefined);
  vi.stubEnv("CODEBUDDY_TEST_ACCOUNT", "signed-in");
  vi.stubEnv("CODEBUDDY_INTERNET_ENVIRONMENT", "internal");
  vi.stubEnv("CODEBUDDY_CONFIG_DIR", s.root);
  const available = () => new Response(JSON.stringify({ code: 0, data: { Packages: [
    { PackageCode: "monthly", CycleRemainCapacity: "13.50", CycleTotalCapacity: 20 },
  ] } }));
  const request = vi.fn(async () => available());
  const time = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(time);
  vi.stubGlobal("fetch", request);
  try {
    const options = { url: "/api/workflows/wf-codebuddy-quota/quota?role=planner", headers: testConsoleHeaders() };
    const results = await Promise.all([app.inject(options), app.inject(options)]);
    for (const result of results) {
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({ adapter: "codebuddy-code", credit_status: "available",
        quota: { source: "account_api", buckets: [], credits: { remaining: 13.5, total: 20 } } });
      expect(result.body).not.toContain("test-token");
    }
    expect(request).toHaveBeenCalledTimes(1);
    const original = results[0]!.json().quota;

    clock.mockReturnValue(time + 61_000);
    request.mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "120" } }));
    expect((await app.inject(options)).json()).toMatchObject({ credit_status: "stale", quota: original });
    clock.mockReturnValue(time + 180_000);
    expect((await app.inject(options)).json()).toMatchObject({ credit_status: "stale", quota: original });
    expect(request).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(time + 181_000);
    expect((await app.inject(options)).json()).toMatchObject({ credit_status: "available" });
    expect(request).toHaveBeenCalledTimes(3);

    vi.stubEnv("CODEBUDDY_CONFIG_DIR", join(s.root, "changed-scope"));
    vi.stubEnv("CODEBUDDY_TEST_ACCOUNT", "signed-out");
    expect((await app.inject(options)).json()).toMatchObject({ credit_status: "auth-required", quota: null });
    expect(request).toHaveBeenCalledTimes(3);
  } finally {
    clock.mockRestore();
    restore();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    await app.close();
    s.store.close();
  }
});

it("reads Codex account quota without a running Codex task and rejects invalid role/workflow", async () => {
  const s = setup();
  const cli = join(s.root, "quota.cjs");
  writeFileSync(cli, `require('node:readline').createInterface({input:process.stdin}).on('line', l => {
    const v=JSON.parse(l);
    if(v.method==='initialize') console.log(JSON.stringify({id:v.id,result:{}}));
    if(v.method==='account/rateLimits/read') console.log(JSON.stringify({id:v.id,result:{rateLimits:{primary:{usedPercent:30,windowDurationMins:10080}}}}));
  });`);
  s.config.models.codex_executable = process.execPath;
  const p = project(s.root);
  s.store.put("project", p.id, p.id, p);
  s.store.put("workflow", "wf-quota", p.id, { id: "wf-quota", project_id: p.id, state: "EXECUTING", stage: "execute", run_id: "agy-run", version: 1 });
  s.store.put("run", "planner-run", "wf-quota", { id: "planner-run", workflow_id: "wf-quota", purpose: "planning", started_at: new Date().toISOString(),
    profile: ToolProfileSchema.parse({ id: "codex", adapterId: "codex", executableRef: process.execPath, options: { prefixArgs: [cli] } }) });
  const app = await buildServer(s.engine);
  try {
    const headers = testConsoleHeaders();
    const result = await app.inject({ url: "/api/workflows/wf-quota/quota?role=planner", headers });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ adapter: "codex", quota: { source: "account_api", buckets: [{ id: "codex", windows: [{ used_percent: 30 }] }] } });
    expect((await app.inject({ url: "/api/workflows/wf-quota/quota?role=invalid", headers })).statusCode).toBe(422);
    expect((await app.inject({ url: "/api/workflows/missing/quota?role=planner", headers })).statusCode).toBe(404);
  } finally { await app.close(); s.store.close(); }
});

it("reads AGY quotas only for the current account, auth epoch and requested model, preserving observed values", async () => {
  const s = setup();
  const f = accountFixture(s.store);
  f.seedAccounts();
  await f.service.start({ realmId: "default-agy-realm", requestId: "start" });
  const refresh = vi.spyOn(f.service, "requestQuotaRefresh").mockReturnValue(null);
  try {
    const profile = ToolProfileSchema.parse({ id: "agy", adapterId: "agy", modelId: "gemini-3.8-flash-high" });
    const realm = f.repository.getRealm("default-agy-realm")!;
    const base = f.repository.listQuotaSnapshots("default-agy-realm")[0]!;
    const now = new Date().toISOString();
    f.repository.retainQuotaPools("default-agy-realm", realm.active_account_id!, []);
    f.repository.saveQuotaSnapshot({ ...base, id: "valid", account_id: realm.active_account_id!, auth_epoch: realm.auth_epoch,
      pool_id: "Gemini Models", model_ids: [profile.modelId!], observed_at: now, capability_verified: true,
      windows: [{ kind: "weekly", duration_minutes: 10080, remaining_fraction: .4, reset_at: null, observed_at: now, status: "observed" }] });
    const quota = await readToolQuota(profile, s.root, f.service);
    expect(quota?.buckets).toHaveLength(1);
    expect(quota?.buckets[0]?.windows[0]?.used_percent).toBe(60);
    expect(await readToolQuota({ ...profile, modelId: "claude-sonnet-4-6" }, s.root, f.service)).toBeNull();
    f.repository.saveRealm({ ...realm, auth_epoch: realm.auth_epoch + 1 });
    expect(await readToolQuota(profile, s.root, f.service)).toBeNull();
    expect(refresh).toHaveBeenCalled();
  } finally { refresh.mockRestore(); await f.service.close(); s.store.close(); }
});
