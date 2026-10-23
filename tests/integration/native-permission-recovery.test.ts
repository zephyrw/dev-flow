import { afterEach, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, project } from "../helpers.js";
import type { Run } from "../../packages/contracts/src/index.js";
import { NATIVE_PERMISSION_ENTITY } from "../../packages/core/src/native-permission.js";
import { recoverNativePermission } from "../../packages/runtime/src/native-permission-recovery.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const session = "unavailable-native-record-for-recovery-test";

function blockedRun(adapter: Run["adapter"], events: unknown[]) {
  const s = setup();
  cleanups.push(() => { s.store.close(); rmSync(s.root, { recursive: true, force: true }); });
  const p = project(s.root);
  s.store.put("project", p.id, p.id, p);
  const created = s.engine.create({ project_id: p.id, title: "权限恢复", request: "恢复当前操作", complexity: "simple", workspace_mode: "existing_workspace" }, "recovery-permission");
  const run: Run = {
    id: "run-recovery-permission", workflow_id: created.id, adapter, purpose: "implement", stage: "execute",
    plan_revision: 1, status: "failed", started_at: new Date().toISOString(), package_hash: "permission-recovery",
    conversation_id: session,
  };
  s.store.put("run", run.id, created.id, run);
  s.engine.transition(created.id, [created.state], "BLOCKED", "execute", {
    run_id: run.id, plan_revision: 1, plan_hash: "permission-plan",
    blocker: { code: "EXECUTION_FAILED", message: "运行失败" },
  });
  const dir = join(s.config.storage_root, "native-runs", run.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "stdout.jsonl"), events.map(event => JSON.stringify(event)).join("\n"));
  return { ...s, run };
}

it("recovers a confirmed AGY denial without complete parameters as a non-authorizing interaction", () => {
  const s = blockedRun("agy", [
    { event: "step_update", step_update: { step_index: 10, step_type: "user_input", state: "DONE" } },
    { event: "step_update", step_update: { step_index: 11, conversation_id: session, step_type: "tool", state: "ERROR", tool_info: {
      name: "run_command", error: { type: "TOOL_ERROR", message: "permission check failed for command: user denied permission for command" },
    } } },
  ]);
  const interaction = recoverNativePermission(s.engine, s.run.workflow_id, s.engine.get(s.run.workflow_id).version)!;
  expect(interaction.request.kind).toBe("action_required");
  expect(s.store.get(NATIVE_PERMISSION_ENTITY, interaction.id)).toBeUndefined();
  expect(s.engine.get(s.run.workflow_id)).toMatchObject({ state: "WAITING_INPUT", run_id: s.run.id });
});

it("does not convert an ordinary OpenCode EACCES failure into authorization", () => {
  const s = blockedRun("opencode", [{
    type: "tool_use", sessionID: session,
    part: { type: "tool", sessionID: session, callID: "call-1", tool: "bash",
      state: { status: "error", input: { command: "cat /protected/file" }, error: "EACCES: permission denied" } },
  }]);
  expect(() => recoverNativePermission(s.engine, s.run.workflow_id, s.engine.get(s.run.workflow_id).version))
    .toThrow("本轮日志未确认原生工具权限拒绝");
  expect(s.engine.get(s.run.workflow_id).state).toBe("BLOCKED");
});
