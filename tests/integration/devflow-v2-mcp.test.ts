import { it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { inheritRoleOverrides } from "../../packages/contracts/src/index.js";
import { setup, repository } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
it("规划工具通过真实 MCP 入口创建原生任务并拒绝未知配置", async () => {
  const s = setup(),
    repo = await repository(s.root),
    app = await buildServer(s.engine),
    token = s.engine.auth.issue({ role: "planner" });
  const profile = {
    id: "profile-codex",
    revision: 1,
    adapterId: "codex" as const,
    executableRef: process.execPath,
    modelSelection: "explicit" as const,
    modelId: "fixture-only",
    options: {},
  };
  s.store.put("tool_profile", profile.id, "global", profile);
  seedVerifiedAccess(s.store, profile);
  const headers = {
    authorization: "Bearer " + token,
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  const args = {
    request_id: "mcp-native-create",
    workspace_root: repo.repo,
    request_text: "完整需求：修改文本",
    workspace_mode: "new_worktree",
    planner_profile_id: "profile-codex",
    executor_profile_id: "profile-codex",
    refs: [],
  };
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  s.engine.config.server.port = Number(new URL(address).port);
  const call = async (a: unknown, name = "devflow_create_native_task") => {
    const response = await fetch(address + "/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: a },
      }),
    });
    const body = await response.text();
    expect(response.status, body).toBe(200);
    const line = body.split("\n").find((x) => x.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : body).result;
  };
  try {
    const profiles = await call({}, "devflow_list_tool_profiles");
    expect(JSON.parse(profiles.content[0].text).profiles).toHaveLength(8);
    const result = await call(args);
    expect(result.isError).not.toBe(true);
    const w = s.store.list<any>("workflow")[0];
    expect(w.state).toBe("PLANNING");
    expect(w.request).toBe(args.request_text);
    expect(s.store.list("workspace", w.id)).toHaveLength(1);
    expect(s.store.list("run", w.id)).toHaveLength(0);
    await call(args);
    expect(s.store.list("workflow")).toHaveLength(1);
    const invalid = await call({
      ...args,
      request_id: "unknown",
      planner_profile_id: "unknown",
    });
    expect(invalid.isError).toBe(true);
    expect(s.store.list("workflow")).toHaveLength(1);
    const change = {
      workflow_id: w.id,
      request_id: randomUUID(),
      expected_spec_revision: 1,
      planner_profile: profile,
      executor_profile: profile,
      role_overrides: inheritRoleOverrides(),
    };
    const saved = await call(change, "devflow_update_execution_spec");
    expect(saved.isError).not.toBe(true);
    for (const record of s.store.list<{ key: string }>("model_access")) {
      s.store.remove("model_access", record.key);
    }
    expect(s.store.list("model_access")).toHaveLength(0);
    const replayed = await call(change, "devflow_update_execution_spec");
    expect(replayed.isError).not.toBe(true);
    expect(replayed.content).toEqual(saved.content);
    const fresh = await call(
      {
        ...change,
        request_id: randomUUID(),
        expected_spec_revision: JSON.parse(saved.content[0].text).entity_revision,
      },
      "devflow_update_execution_spec",
    );
    expect(fresh.isError).toBe(true);
    expect(JSON.parse(fresh.content[0].text).code).toBe("MODEL_ACCESS_REQUIRED");
  } finally {
    await app.close();
    s.store.close();
  }
});
