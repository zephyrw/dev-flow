import { it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, project, plan, repository } from "../helpers.js";
import { ProfileRuntime } from "../../packages/runtime/src/profile-runtime.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import type { Run } from "../../packages/contracts/src/index.js";

it("the profile-based production runtime rejects a successful CLI footer containing denied actions", async () => {
  const s = setup();
  const repo = await repository(s.root);
  const p = project(repo.repo);
  s.store.put("project", p.id, p.id, p);
  const created = s.engine.create({ project_id: p.id, title: "权限拒绝", request: "检查未知操作的权限拒绝", complexity: "simple", workspace_mode: "existing_workspace" }, "permission-footer");
  const workflow = s.engine.transition(created.id, [created.state], "EXECUTING", "execute", { run_id: "run-denied-footer", plan_revision: 1 });
  s.store.put("plan", `${workflow.id}-1`, workflow.id, { id: `${workflow.id}-1`, revision: 1, plan: { ...plan("a".repeat(64), repo.baseline), task_model: "native-v2" } });
  s.store.put("workspace", `${workflow.id}-main`, workflow.id, { id: `${workflow.id}-main`, repo_id: "main", root: repo.repo, source_root: repo.repo });
  const cli = join(s.root, "denied-cli.mjs");
  writeFileSync(
    cli,
    `console.log(JSON.stringify({event:"init",conversation_id:"denied-session"})); console.log(JSON.stringify({event:"result",result:{status:"SUCCESS",response:"{}",denied_actions:[{action:"write_file",display_name:"WriteToFile"}]}}));`,
  );
  const run: Run = {
    started_at: new Date().toISOString(),
    package_hash: "isolated-permission-fixture",
    id: workflow.run_id!,
    workflow_id: workflow.id,
    stage: "execute",
    purpose: "implement",
    adapter: "agy",
    execution_spec_id: "isolated-spec",
    status: "running",
    plan_revision: 1,
    profile: {
      id: "test-agy",
      adapterId: "agy",
      revision: 1,
      executableRef: process.execPath,
      modelSelection: "explicit",
      modelId: "fixture-only",
      options: { prefixArgs: [cli] },
    },
  };
  s.store.put("execution_spec", "isolated-spec", workflow.id, {
    workflow_id: workflow.id,
  });
  s.store.put("run", run.id, workflow.id, run);
  const processes = new ProcessManager();
  const runtime = new ProfileRuntime(s.engine, processes);
  try {
    await expect(
      (runtime as any).invoke(s.engine.get(workflow.id), run, { instructions: "permission footer fixture" }, {}, "fixture-token"),
    ).rejects.toMatchObject({ code: "NATIVE_PERMISSION_DENIED" });
    expect(s.store.list("delivery", workflow.id)).toEqual([]);
    expect(s.store.get("conversation", workflow.id)).toMatchObject({
      id: "denied-session",
    });
    // A denial becomes a visible human interaction, rather than a generic block.
    expect(s.engine.get(workflow.id).state).toBe("WAITING_INPUT");
    expect(s.store.list<any>("user_interaction", workflow.id).at(-1)?.request.kind).toBe("action_required");
  } finally {
    await processes.close();
    s.store.close();
  }
});
