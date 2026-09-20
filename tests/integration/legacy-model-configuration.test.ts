import { afterEach, expect, it } from "vitest";
import { setup } from "../helpers.js";
import { now } from "../../packages/core/src/util.js";
import {
  inheritRoleOverrides,
  type Run,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import {
  protocolForFlavor,
  resolveRuntimeFlavor,
  runLauncherSelection,
  frozenInvocationFromProfile,
} from "../../packages/core/src/run-profile.js";

let closeStore: (() => void) | undefined;

afterEach(() => {
  closeStore?.();
  closeStore = undefined;
});

function agyProfile(): ToolProfile {
  return {
    id: "legacy-agy",
    revision: 1,
    adapterId: "agy",
    modelSelection: "explicit",
    modelId: "gemini-3.7-flash-high",
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  };
}

it("IT-R22：旧 native-v2 任务补存 spec 后继续轻量 ProfileRuntime", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const workflowId = "wf-legacy-native";
  const workflow: Workflow = {
    id: workflowId,
    project_id: "p1",
    title: "旧 native-v2",
    request: "兼容",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "QUEUED",
    stage: "execute",
    version: 67,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  env.store.put("workflow", workflowId, "p1", workflow);
  env.store.put("plan", workflowId + "-1", workflowId, {
    id: workflowId + "-1",
    workflow_id: workflowId,
    revision: 1,
    hash: "h1",
    plan: { task_model: "native-v2" },
    created_at: now(),
  });
  const historic: Run = {
    id: "run-old",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    profile: agyProfile(),
    stage: "execute",
    status: "completed",
    started_at: now(),
    package_hash: "pkg",
  };
  env.store.put("run", historic.id, workflowId, historic);
  env.store.put("execution_spec", "spec-r1", workflowId, {
    schema_version: 2,
    id: "spec-r1",
    revision: 1,
    workflow_id: workflowId,
    plannerProfile: agyProfile(),
    executorProfile: agyProfile(),
    roleOverrides: inheritRoleOverrides(),
    template_id: "native-development",
    template_revision: 3,
    mode: "single_tool",
    created_at: now(),
  });
  const flavor = resolveRuntimeFlavor(
    env.store,
    workflowId,
    "agy",
    "implement",
  );
  expect(flavor).toBe("profile-native");
  expect(protocolForFlavor(flavor)).toBe("lightweight");
  const nextRun: Run = {
    ...historic,
    id: "run-new",
    execution_spec_id: "spec-r1",
    runtime_flavor: flavor,
    protocol: protocolForFlavor(flavor),
  };
  expect(nextRun.execution_spec_id).toBe("spec-r1");
  expect(nextRun.runtime_flavor).toBe("profile-native");
  expect(nextRun.protocol).toBe("lightweight");
  expect(
    resolveRuntimeFlavor(env.store, workflowId, "agy", "implement"),
  ).toBe("profile-native");
});

it("IT-R22：旧 leaf-v1 补 spec 后新轮次使用主分支的轻量协议", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const workflowId = "wf-legacy-leaf";
  const workflow: Workflow = {
    id: workflowId,
    project_id: "p1",
    title: "旧 leaf-v1",
    request: "兼容",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "QUEUED",
    stage: "execute",
    version: 3,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  };
  env.store.put("workflow", workflowId, "p1", workflow);
  env.store.put("plan", workflowId + "-1", workflowId, {
    id: workflowId + "-1",
    workflow_id: workflowId,
    revision: 1,
    hash: "h1",
    plan: { task_model: "leaf-v1" },
    created_at: now(),
  });
  env.store.put("run", "run-old", workflowId, {
    id: "run-old",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    profile: agyProfile(),
    stage: "execute",
    status: "completed",
    started_at: now(),
    package_hash: "pkg",
  } satisfies Run);
  env.store.put("execution_spec", "spec-r1", workflowId, {
    schema_version: 2,
    id: "spec-r1",
    revision: 1,
    workflow_id: workflowId,
    plannerProfile: agyProfile(),
    executorProfile: agyProfile(),
    roleOverrides: inheritRoleOverrides(),
    created_at: now(),
  });
  const flavor = resolveRuntimeFlavor(
    env.store,
    workflowId,
    "agy",
    "implement",
  );
  expect(flavor).toBe("profile-native");
  expect(protocolForFlavor(flavor)).toBe("lightweight");
  expect(
    resolveRuntimeFlavor(env.store, workflowId, "agy", "implement"),
  ).toBe("profile-native");
});

it("leaf-v1 的新轻量轮次支持按选择派发审查和执行工具", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const workflowId = "wf-leaf-review";
  env.store.put("workflow", workflowId, "p1", {
    id: workflowId,
    project_id: "p1",
    title: "leaf 审查",
    request: "兼容",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "REVIEW_QUEUED",
    stage: "review",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  } satisfies Workflow);
  env.store.put("plan", workflowId + "-1", workflowId, {
    id: workflowId + "-1",
    workflow_id: workflowId,
    revision: 1,
    hash: "h1",
    plan: { task_model: "leaf-v1" },
    created_at: now(),
  });
  env.store.put("run", "run-old", workflowId, {
    id: "run-old",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    profile: agyProfile(),
    stage: "execute",
    status: "completed",
    started_at: now(),
    package_hash: "pkg",
  } satisfies Run);
  expect(
    resolveRuntimeFlavor(env.store, workflowId, "codex", "quality_review"),
  ).toBe("profile-native");
  expect(
    resolveRuntimeFlavor(env.store, workflowId, "agy", "implement"),
  ).toBe("profile-native");
  expect(
    resolveRuntimeFlavor(env.store, workflowId, "cursor-agent", "implement"),
  ).toBe("profile-native");
});

it("旧 agy 换模型或强度时 launcher 使用冻结配置而不是 YAML", () => {
  const env = setup();
  closeStore = () => env.store.close();
  env.config.models.agy_executable = "yaml-agy";
  env.config.models.executor = "yaml-model";
  const profile: ToolProfile = {
    ...agyProfile(),
    executableRef: "C:\\\\tools\\\\agy.exe",
    modelId: "gemini-switched",
    reasoning: { mode: "explicit", value: "xhigh" },
  };
  const frozen = frozenInvocationFromProfile(profile, "legacy-agy-native");
  const run: Run = {
    id: "run-switched",
    workflow_id: "wf-legacy-launch",
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    profile,
    frozen_invocation: frozen,
    invocation_fingerprint: "fp-b",
    stage: "execute",
    status: "running",
    started_at: now(),
    package_hash: "pkg",
  };
  const launcher = runLauncherSelection(run);
  expect(launcher.executable).toBe("C:\\\\tools\\\\agy.exe");
  expect(launcher.modelToken).toBe("gemini-switched");
  expect(launcher.effortArgs).toEqual(["--effort", "xhigh"]);
  expect(launcher.executable).not.toBe(env.config.models.agy_executable);
  expect(launcher.modelToken).not.toBe(env.config.models.executor);
});

it("leaf-v1 审查暂停后按 Codex 轻量审查继续", () => {
  const env = setup();
  closeStore = () => env.store.close();
  const workflowId = "wf-leaf-review-resume";
  env.store.put("workflow", workflowId, "p1", {
    id: workflowId,
    project_id: "p1",
    title: "leaf 审查恢复",
    request: "兼容",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "STOPPED",
    stage: "stopped",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
  } satisfies Workflow);
  env.store.put("plan", workflowId + "-1", workflowId, {
    id: workflowId + "-1",
    workflow_id: workflowId,
    revision: 1,
    hash: "h1",
    plan: { task_model: "leaf-v1" },
    created_at: now(),
  });
  env.store.put("run", "run-review", workflowId, {
    id: "run-review",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "codex",
    purpose: "quality_review",
    profile: {
      id: "legacy-reviewer",
      revision: 1,
      adapterId: "codex",
      modelSelection: "explicit",
      modelId: "gpt-5.4",
      reasoning: { mode: "explicit", value: "high" },
      selectionKind: "fixed",
      options: {},
    },
    stage: "review",
    status: "stopped",
    started_at: now(),
    package_hash: "pkg",
  } satisfies Run);
  env.store.put("interruption", workflowId, workflowId, {
    prior_state: "REVIEWING",
    prior_stage: "review",
    prior_purpose: "quality_review",
    prior_run_id: "run-review",
  });
  expect(
    resolveRuntimeFlavor(env.store, workflowId, "codex", "quality_review"),
  ).toBe("profile-native");
});
