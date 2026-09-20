import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setup } from "../helpers.js";
import { ModelDefaultsService } from "../../packages/core/src/model-defaults-service.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import { now } from "../../packages/core/src/util.js";
import {
  inheritRoleOverrides,
  type ExecutionSpec,
  type ModelDefaults,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { Store } from "../../packages/store/src/store.js";

let closeStore: (() => void) | undefined;

afterEach(() => {
  closeStore?.();
  closeStore = undefined;
});

function openDefaults() {
  const env = setup();
  closeStore = () => env.store.close();
  env.config.models.reviewer = "codex-planner-import";
  env.config.models.executor = "agy-executor-import";
  env.config.models.codex_executable = "codex";
  env.config.models.agy_executable = "agy";
  const service = new ModelDefaultsService(env.store);
  return { ...env, service };
}

function putWorkflow(store: Store, workflowId: string): Workflow {
  const workflow: Workflow = {
    id: workflowId,
    project_id: "p1",
    title: "旧任务",
    request: "保持原 spec",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "STOPPED",
    stage: "execute",
    version: 3,
    plan_revision: 2,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  store.put("workflow", workflowId, workflow.project_id, workflow);
  return workflow;
}

function putSpec(store: Store, workflowId: string): ExecutionSpec {
  const spec = {
    id: "spec-old-r1",
    revision: 1,
    workflow_id: workflowId,
    plannerProfile: {
      id: "planner",
      revision: 1,
      adapterId: "codex" as const,
      modelSelection: "explicit" as const,
      modelId: "old-planner-model",
      reasoning: { mode: "explicit" as const, value: "high" },
      selectionKind: "fixed" as const,
      options: {},
    },
    executorProfile: {
      id: "executor",
      revision: 1,
      adapterId: "agy" as const,
      modelSelection: "explicit" as const,
      modelId: "old-executor-model",
      reasoning: { mode: "explicit" as const, value: "high" },
      selectionKind: "fixed" as const,
      options: {},
    },
    roleOverrides: inheritRoleOverrides(),
    template_id: "native-development",
    template_revision: 3,
    mode: "composite" as const,
    created_at: now(),
  };
  store.put("execution_spec", spec.id, workflowId, spec);
  return spec as ExecutionSpec;
}

it("IT-C01：无 defaults 时从 config 导入一次，第二次 getOrImport 不覆盖", () => {
  const { service, config, store } = openDefaults();
  const first = service.getOrImport(config);
  expect(first.source).toBe("legacy-import");
  expect(first.revision).toBe(1);
  expect(first.plannerProfile.adapterId).toBe("codex");
  expect(first.plannerProfile.modelId).toBe("codex-planner-import");
  expect(first.plannerProfile.reasoning).toEqual({
    mode: "explicit",
    value: "high",
  });
  expect(first.executorProfile.adapterId).toBe("agy");
  expect(first.executorProfile.modelId).toBe("agy-executor-import");
  config.models.reviewer = "should-not-overwrite";
  config.models.executor = "should-not-overwrite-executor";
  const second = service.getOrImport(config);
  expect(second.revision).toBe(first.revision);
  expect(second.plannerProfile.modelId).toBe("codex-planner-import");
  expect(second.executorProfile.modelId).toBe("agy-executor-import");
  expect(store.list<ModelDefaults>("model_defaults")).toHaveLength(1);
});

it("IT-C02：defaults r1→r2 后已有 workflow 的 spec 不变", () => {
  const { service, config, store } = openDefaults();
  const workflowId = "wf-c02";
  putWorkflow(store, workflowId);
  const original = putSpec(store, workflowId);
  const imported = service.getOrImport(config);
  expect(imported.revision).toBe(1);
  seedVerifiedAccess(store, {
    ...imported.plannerProfile,
    modelId: "planner-r2",
  });
  seedVerifiedAccess(store, {
    ...imported.executorProfile,
    modelId: "executor-r2",
  });
  const saved = service.save({
    request_id: randomUUID(),
    expected_defaults_revision: 1,
    plannerProfile: {
      ...imported.plannerProfile,
      modelId: "planner-r2",
    },
    executorProfile: {
      ...imported.executorProfile,
      modelId: "executor-r2",
    },
  });
  expect(saved.entity_revision).toBe(2);
  expect(saved.effective_from).toBe("new-workflows");
  const specs = store.list<ExecutionSpec>("execution_spec", workflowId);
  expect(specs).toHaveLength(1);
  expect(specs[0]?.id).toBe(original.id);
  expect(specs[0]?.revision).toBe(1);
  expect(specs[0]?.plannerProfile.modelId).toBe("old-planner-model");
  expect(specs[0]?.executorProfile.modelId).toBe("old-executor-model");
});

it("R07：未验证 profile 不能保存全局默认", () => {
  const { service, config } = openDefaults();
  const imported = service.getOrImport(config);
  try {
    service.save({
      request_id: randomUUID(),
      expected_defaults_revision: imported.revision,
      plannerProfile: {
        ...imported.plannerProfile,
        modelId: "never-verified-planner",
      },
      executorProfile: imported.executorProfile,
    });
    expect.unreachable("应当拒绝未验证默认");
  } catch (error) {
    expect(error).toMatchObject({ code: "MODEL_ACCESS_REQUIRED" });
  }
  expect(service.getOrImport(config).plannerProfile.modelId).toBe(
    imported.plannerProfile.modelId,
  );
});

it("validated save clears the installation draft and replays its receipt", () => {
  const { service, config, store } = openDefaults();
  const imported = service.getOrImport(config);
  seedVerifiedAccess(store, imported.plannerProfile);
  seedVerifiedAccess(store, imported.executorProfile);
  store.put("model_defaults_draft", "global", "global", {
    schema_version: 1,
    expected_defaults_revision: imported.revision,
    plannerProfile: imported.plannerProfile,
    executorProfile: imported.executorProfile,
    updated_at: now(),
  });
  const request = {
    request_id: randomUUID(),
    expected_defaults_revision: imported.revision,
    plannerProfile: imported.plannerProfile,
    executorProfile: imported.executorProfile,
  };
  const receipt = service.save(request);
  expect(store.get("model_defaults_draft", "global")).toBeUndefined();
  for (const row of store.list<{ key: string }>("model_access"))
    store.remove("model_access", row.key);
  expect(service.save(request)).toEqual(receipt);
  expect(service.getOrImport(config).revision).toBe(imported.revision + 1);
});


it.each(["providerConfigRef", "toolsetRef"] as const)("unsupported %s cannot be added to previously verified defaults", (field) => {
  const { service, config, store } = openDefaults();
  const imported = service.getOrImport(config);
  seedVerifiedAccess(store, imported.plannerProfile);
  seedVerifiedAccess(store, imported.executorProfile);
  expect(() => service.save({
    request_id: randomUUID(),
    expected_defaults_revision: imported.revision,
    plannerProfile: { ...imported.plannerProfile, [field]: "unsupported-reference" },
    executorProfile: imported.executorProfile,
  })).toThrow("当前工具不支持");
  expect(service.getOrImport(config)).toEqual(imported);
  expect(store.list("run")).toHaveLength(0);
});
