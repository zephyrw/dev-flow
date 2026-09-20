import { expect, it, vi } from "vitest";
import { buildServer } from "../../apps/api/src/server.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import type { Run } from "../../packages/contracts/src/index.js";
import { fixture, cleanup } from "../fixtures/native-flow.js";

function executing(s: Awaited<ReturnType<typeof fixture>>, protocol: Run["protocol"] = "lightweight") {
  const current = s.engine.get(s.w.id);
  const run: Run = {
    id: "runtime-fix-run", workflow_id: s.w.id, plan_revision: current.plan_revision,
    adapter: "agy", stage: "execute", status: "running", purpose: "implement",
    protocol, started_at: new Date().toISOString(), package_hash: "fixture",
  };
  s.store.put("run", run.id, s.w.id, run);
  s.engine.transition(s.w.id, [current.state], "EXECUTING", "execute", { run_id: run.id });
  return run;
}

it("native runtime hands completed intent and incomplete optional materials to the real scheduler", async () => {
  const s = await fixture();
  try {
    const run = executing(s);
    const runtime = new ProfileRuntime(s.engine, {} as any);
    vi.spyOn(runtime as any, "invoke").mockResolvedValue({
      status: "completed",
      delivery: { test_executions: [{ report_paths: ["reports/native.json"] }] },
    });
    await runtime.execute(s.engine.get(s.w.id), run, "unused-external-model-token");
    // Native execution returns before the owning dispatcher records process exit.
    s.store.put("run", run.id, s.w.id, { ...run, status: "completed", exit_code: 0 });
    await s.engine.finalizeNativeDelivery(s.w.id, run.id);
    expect(s.engine.get(s.w.id).state).toBe("REVIEW_QUEUED");
    expect(s.store.get<any>("execution_completion", run.id)?.intent).toBe("completed");
    expect(s.store.list<any>("archive_outbox", s.w.id)[0]?.items).toContainEqual({ repo_id: "main", path: "reports/native.json" });
  } finally {
    await cleanup(s);
  }
});

it.each(["lightweight", "legacy"] as const)("worker MCP routes a historical leaf plan according to its current %s run", async (protocol) => {
  const s = await fixture();
  const record = s.engine.plan(s.w.id);
  s.store.put("plan", record.id, s.w.id, { ...record, plan: { ...record.plan, task_model: "leaf-v1" } });
  const run = executing(s, protocol);
  const token = s.engine.auth.issue({ role: "worker", workflow_id: s.w.id, run_id: run.id });
  const app = await buildServer(s.engine);
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  s.engine.config.server.port = Number(new URL(address).port);
  const request = async (method: string, params: unknown) => {
    const response = await fetch(address + "/mcp", {
      method: "POST",
      headers: { authorization: "Bearer " + token, accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const line = body.split("\n").find((entry) => entry.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : body).result;
  };
  try {
    const tools = await request("tools/list", {});
    const names = tools.tools.map((tool: any) => tool.name);
    const result = await request("tools/call", { name: "devflow_execute_context", arguments: { section: "overview" } });
    expect(result.isError).not.toBe(true);
    const overview = JSON.parse(result.content[0].text);
    if (protocol === "legacy") {
      expect(names).toContain("devflow_finish");
      expect(overview.instructions).toContain("禁止原生工具");
    } else {
      expect(names).not.toContain("devflow_finish");
      expect(names).not.toContain("devflow_run_check");
      expect(overview.instructions).toContain("原生开发模式");
      const delivered = await request("tools/call", { name: "devflow_deliver", arguments: {
        status: "completed", test_executions: [{ report_paths: ["reports/mcp.json"] }],
      } });
      expect(delivered.isError, JSON.stringify(delivered)).not.toBe(true);
      s.store.put("run", run.id, s.w.id, { ...run, status: "completed", exit_code: 0 });
      await s.engine.finalizeNativeDelivery(s.w.id, run.id);
      expect(s.engine.get(s.w.id).state).toBe("REVIEW_QUEUED");
      expect(s.store.list<any>("archive_outbox", s.w.id)[0]?.items).toContainEqual({ repo_id: "main", path: "reports/mcp.json" });
    }
  } finally {
    await app.close();
    await cleanup(s);
  }
});
