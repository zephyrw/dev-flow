import { afterEach, expect, it } from "vitest";
import { setup, project } from "../helpers.js";
import { ModelDefaultsService } from "../../packages/core/src/model-defaults-service.js";
import { latestSpec, readEffectiveSpec, resolveRoutingPreview } from "../../packages/core/src/run-profile.js";
import { projectRoleRuntime } from "../../packages/presentation/src/role-runtime.js";
import { FlowError } from "../../packages/contracts/src/index.js";
import { repairFailure } from "../../packages/core/src/repair.js";

let env: ReturnType<typeof setup>;
afterEach(() => env?.store.close());

it("project/MCP creation snapshots global models and idempotent replay preserves them", () => {
  env = setup();
  env.store.put("project", "p1", "p1", project(env.root));
  const defaults = new ModelDefaultsService(env.store).getOrImport(env.config);
  const cursor = { ...defaults.executorProfile, adapterId: "cursor-agent" as const, modelId: "grok-4.7", reasoning: { mode: "native-default" as const } };
  env.store.put("model_defaults", "global", "global", { ...defaults, executorProfile: cursor, revision: 3 });
  const input = { project_id: "p1", title: "inherit", request: "inherit", complexity: "simple" as const, workspace_mode: "existing_workspace" as const };
  const w = env.engine.create(input, "create-inherit");
  const spec = latestSpec(env.store, w.id)!;
  expect(spec.executorProfile).toEqual(cursor);
  expect(spec.source_defaults_revision).toBe(3);
  const routed = resolveRoutingPreview(env.store, env.config, w.id, { purpose: "implement" });
  expect(routed.profile).toEqual(cursor);
  expect(routed.routing_source).toBe("task-base");
  const display = projectRoleRuntime({ workflow: w, execution_spec: readEffectiveSpec(env.store, env.config, w.id).spec });
  expect(display.executorRow.displayText).toContain("Grok 4.7");
  env.store.put("model_defaults", "global", "global", { ...defaults, revision: 4 });
  expect(env.engine.create(input, "create-inherit").id).toBe(w.id);
  expect(latestSpec(env.store, w.id)).toEqual(spec);
});

it("session identity failures never schedule code repair or consume recovery attempts", async () => {
  env = setup();
  env.store.put("project", "p1", "p1", project(env.root));
  const w = env.engine.create({ project_id: "p1", title: "identity", request: "identity", complexity: "simple", workspace_mode: "existing_workspace" }, "create-identity");
  env.store.put("workflow", w.id, "p1", { ...w, state: "EXECUTING", run_id: "run-identity" });
  expect(await repairFailure(env.engine, w.id, new FlowError("SESSION_IDENTITY_UNRESOLVED", "missing account"), "run-identity")).toBeNull();
  expect(env.store.get("repair_state", w.id)).toBeUndefined();
  expect(env.store.events(w.id).some(e => e.type === "RepairScheduled")).toBe(false);
});
