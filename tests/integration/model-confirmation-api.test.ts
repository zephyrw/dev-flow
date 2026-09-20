import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setup, project, plan } from "../helpers.js";
import { buildServer } from "../../apps/api/src/server.js";
import { now, objectHash } from "../../packages/core/src/util.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { FunctionalIssueService } from "../../packages/core/src/functional-issues.js";
import { ModelDefaultsService } from "../../packages/core/src/model-defaults-service.js";
import {
  RepairModelService,
  ensureQualityRepairBatch,
} from "../../packages/core/src/repair-model-service.js";
import {
  FlowError,
  inheritRoleOverrides,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";

const headers = {
  host: "localhost:14810",
  origin: "http://localhost:14810",
  "content-type": "application/json",
};
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
});

function profile(
  id: string,
  adapterId: ToolProfile["adapterId"],
  modelId: string,
): ToolProfile {
  return {
    id,
    revision: 1,
    adapterId,
    modelSelection: "explicit",
    selectionKind: "fixed",
    modelId,
    reasoning: { mode: "explicit", value: "high" },
    options: {},
  };
}
const planner = profile("planner", "codex", "gpt-6-astra");
const executor = profile("executor", "agy", "gemini-3.7-flash-high");
const originalFixer = profile(
  "original-fixer",
  "cursor-agent",
  "cursor-grok-4.6-high",
);
const nextFixer = profile("next-fixer", "codex", "gpt-5.6-sol");

async function fixture() {
  const env = setup();
  const workflowId = "wf-confirmation";
  const p = project(env.root);
  env.store.put("project", p.id, p.id, p);
  env.store.put("plan", `${workflowId}-1`, workflowId, {
    plan: plan(objectHash(p), "baseline"),
    revision: 1,
  });
  const workflow: Workflow = {
    id: workflowId,
    project_id: p.id,
    title: "人工复测",
    request: "修复已反馈的问题",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "HUMAN_PENDING",
    stage: "functional_retest",
    version: 1,
    plan_revision: 1,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
    snapshot_id: "snapshot-current",
  };
  env.store.put("workflow", workflowId, p.id, workflow);
  env.store.put("execution_spec", "spec-r1", workflowId, {
    schema_version: 2,
    id: "spec-r1",
    revision: 1,
    workflow_id: workflowId,
    plannerProfile: planner,
    executorProfile: executor,
    roleOverrides: inheritRoleOverrides(),
    template_id: "native-development",
    template_revision: 3,
    mode: "composite",
    created_at: now(),
  });
  for (const item of [planner, executor, originalFixer, nextFixer])
    seedVerifiedAccess(env.store, item);
  const specs = new ExecutionSpecService(env.store, env.config);
  const repairs = new RepairModelService(env.store, specs);
  const issues = new FunctionalIssueService(env.store);
  const created = repairs.submitFunctionalRepair({
    workflow_id: workflowId,
    request_id: randomUUID(),
    descriptions: [{ description: "筛选后数据未更新" }],
    selection: { mode: "custom", profile: originalFixer },
    expected_spec_revision: 1,
  });
  const issueId = created.issue_ids[0]!;
  const completionId = "completion-fix-1";
  env.store.put("execution_completion", completionId, workflowId, {
    id: completionId,
    workflow_id: workflowId,
    run_id: "run-fix-1",
    status: "completed",
  });
  issues.markFixing(workflowId, issueId);
  issues.markReadyForRetest(workflowId, issueId, completionId);
  const app = await buildServer(env.engine);
  dispose = async () => {
    await app.close();
    env.store.close();
  };
  return {
    ...env,
    app,
    workflowId,
    issueId,
    completionId,
    created,
    specs,
    repairs,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function body(
  env: Fixture,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    request_id: randomUUID(),
    expected_version: env.engine.get(env.workflowId).version,
    delivery_revision_id: env.completionId,
    passed: false,
    feedback: "仍未更新",
    ...extra,
  };
}
function replacement(env: Fixture, extra: Record<string, unknown> = {}) {
  return body(env, {
    repair_model: { mode: "custom", profile: nextFixer },
    remember_for_task: true,
    batch_id: env.created.batch.id,
    expected_assignment_revision: env.created.assignment!.revision,
    expected_spec_revision: 1,
    ...extra,
  });
}
function confirm(env: Fixture, payload: Record<string, unknown>) {
  return env.app.inject({
    method: "POST",
    url: `/api/workflows/${env.workflowId}/functional-issues/${env.issueId}/confirm`,
    headers,
    payload,
  });
}
function snapshot(env: Fixture) {
  return {
    entities: env.store.db
      .prepare("SELECT * FROM entities ORDER BY kind,id")
      .all(),
    events: env.store.db
      .prepare("SELECT * FROM events ORDER BY workflow_id,seq")
      .all(),
    jobs: env.store.jobs(),
  };
}

it("HTTP 失败复测未选择模型保留已有指派，轻量完成不需要 delivery_revision", async () => {
  const env = await fixture();
  expect(env.store.list("delivery_revision", env.workflowId)).toHaveLength(0);
  const response = await confirm(env, body(env));
  expect(response.statusCode, response.body).toBe(200);
  expect(response.json().status).toBe("open");
  expect(env.repairs.listOpenBatches(env.workflowId)[0]?.assignment).toEqual(
    env.created.assignment,
  );
  expect(env.specs.readView(env.workflowId).spec.revision).toBe(1);
  expect(env.store.get("functional_fix_intent", env.workflowId)).toMatchObject({
    batch_id: env.created.batch.id,
    source_snapshot: "snapshot-current",
  });
  expect(env.engine.get(env.workflowId).state).toBe("QUEUED");
  expect(env.store.jobs()).toHaveLength(1);
});

it("HTTP 明确 task-default 只清除一次性覆盖", async () => {
  const env = await fixture();
  const response = await confirm(
    env,
    replacement(env, {
      repair_model: { mode: "task-default" },
      remember_for_task: false,
    }),
  );
  expect(response.statusCode, response.body).toBe(200);
  expect(env.repairs.listOpenBatches(env.workflowId)[0]?.assignment).toBeNull();
  expect(
    env.specs.readView(env.workflowId).spec.roleOverrides.functional_fixer,
  ).toEqual({ mode: "inherit" });
  expect(
    env.store.list<any>("repair_model_assignment", env.workflowId)[0]?.status,
  ).toBe("superseded");
});

it("HTTP 失败复测替换处理者并记为任务默认一起成功", async () => {
  const env = await fixture();
  const response = await confirm(env, replacement(env));
  expect(response.statusCode, response.body).toBe(200);
  expect(
    env.repairs.listOpenBatches(env.workflowId)[0]?.assignment?.profile.modelId,
  ).toBe(nextFixer.modelId);
  const spec = env.specs.readView(env.workflowId).spec;
  expect(spec.revision).toBe(2);
  expect(spec.roleOverrides.functional_fixer).toMatchObject({
    mode: "explicit",
    profile: nextFixer,
  });
  expect(spec.roleOverrides.review_fixer).toEqual({ mode: "inherit" });
  expect(
    env.store.list("functional_confirmation", env.workflowId),
  ).toHaveLength(1);
  expect(env.store.list("feedback_message", env.workflowId)).toHaveLength(1);
  expect(env.store.jobs()).toHaveLength(1);
});

it("HTTP 仅记住现有处理者但省略 repair_model 时不替换指派", async () => {
  const env = await fixture();
  const payload = replacement(env);
  delete payload.repair_model;
  const response = await confirm(env, payload);
  expect(response.statusCode, response.body).toBe(200);
  expect(env.repairs.listOpenBatches(env.workflowId)[0]?.assignment).toEqual(
    env.created.assignment,
  );
  expect(
    env.specs.readView(env.workflowId).spec.roleOverrides.functional_fixer,
  ).toMatchObject({ mode: "explicit", profile: originalFixer });
});

it.each([
  ["expected_assignment_revision", 0, "REPAIR_BATCH_MISMATCH"],
  ["expected_spec_revision", 0, "SPEC_VERSION_CONFLICT"],
  ["expected_version", 0, "VERSION_CONFLICT"],
])("HTTP 陈旧 %s 不留下任何部分更新", async (field, value, code) => {
  const env = await fixture();
  const before = snapshot(env);
  const response = await confirm(
    env,
    replacement(env, { [field as string]: value }),
  );
  expect(response.statusCode, response.body).toBe(409);
  expect(response.json().error.code).toBe(code);
  expect(snapshot(env)).toEqual(before);
});

it("HTTP 后续入队失败时回滚 issue/spec/assignment/receipt/queue", async () => {
  const env = await fixture();
  const enqueue = env.engine.queueFormalFeedback.bind(env.engine);
  vi.spyOn(env.engine, "queueFormalFeedback").mockImplementation(
    (workflowId, messageId) => {
      enqueue(workflowId, messageId);
      throw new FlowError("QUEUE_FAILED", "模拟入队末尾失败", 503);
    },
  );
  const dispatch = vi.spyOn(env.engine, "dispatch");
  const before = snapshot(env);
  const response = await confirm(env, replacement(env));
  expect(response.statusCode, response.body).toBe(503);
  expect(snapshot(env)).toEqual(before);
  expect(dispatch).not.toHaveBeenCalled();
});

it("HTTP 同请求重放不重复确认/指派/入队，同 ID 改内容冲突", async () => {
  const env = await fixture();
  const payload = replacement(env);
  const first = await confirm(env, payload);
  expect(first.statusCode, first.body).toBe(200);
  const after = snapshot(env);
  const second = await confirm(env, payload);
  expect(second.statusCode, second.body).toBe(200);
  expect(second.json()).toEqual(first.json());
  expect(snapshot(env)).toEqual(after);
  const changed = await confirm(env, { ...payload, feedback: "另一问题" });
  expect(changed.statusCode, changed.body).toBe(409);
  expect(changed.json().error.code).toBe("IDEMPOTENCY_CONFLICT");
  expect(snapshot(env)).toEqual(after);
});

it("HTTP 复测通过不能夹带处理者修改，拒绝且保持全部状态", async () => {
  const env = await fixture();
  const before = snapshot(env);
  const invalid = await confirm(env, replacement(env, { passed: true }));
  expect(invalid.statusCode, invalid.body).toBe(422);
  expect(invalid.json().error.code).toBe("INVALID_REQUEST");
  expect(snapshot(env)).toEqual(before);
  const valid = await confirm(env, body(env, { passed: true }));
  expect(valid.statusCode, valid.body).toBe(200);
  expect(valid.json().status).toBe("confirmed");
  expect(env.store.jobs()).toHaveLength(0);
});

it("HTTP 新建人工问题保留自动生成的批次标识", async () => {
  const env = await fixture();
  const response = await env.app.inject({
    method: "POST",
    url: `/api/workflows/${env.workflowId}/functional-issues`,
    headers,
    payload: { request_id: randomUUID(), text: "另外一个待修复问题" },
  });
  expect(response.statusCode, response.body).toBe(200);
  const issueId = response.json().issue_id;
  const view = env.repairs
    .issueViews(env.workflowId)
    .find((item) => item.issue.issue_id === issueId);
  expect(view?.batch_id).toBeTruthy();
  expect(env.store.get("functional_fix_intent", env.workflowId)).toMatchObject({
    batch_id: view!.batch_id,
    source_snapshot: "snapshot-current",
  });
});

it("HTTP 独立质量指派记入 review_fixer 且重放不增加版本", async () => {
  const env = await fixture();
  const batch = ensureQualityRepairBatch(
    env.store,
    env.workflowId,
    "before_human",
  );
  const payload = {
    request_id: randomUUID(),
    batch_id: batch.id,
    expected_assignment_revision: 0,
    expected_spec_revision: 1,
    selection: { mode: "custom", profile: nextFixer },
    remember_for_task: true,
  };
  const first = await env.app.inject({
    method: "POST",
    url: `/api/workflows/${env.workflowId}/repair-model-assignment`,
    headers,
    payload,
  });
  expect(first.statusCode, first.body).toBe(200);
  const spec = env.specs.readView(env.workflowId).spec;
  expect(spec.roleOverrides.review_fixer).toMatchObject({
    mode: "explicit",
    profile: nextFixer,
  });
  expect(spec.roleOverrides.functional_fixer).toEqual({ mode: "inherit" });
  const after = snapshot(env);
  const retry = await env.app.inject({
    method: "POST",
    url: `/api/workflows/${env.workflowId}/repair-model-assignment`,
    headers,
    payload,
  });
  expect(retry.statusCode, retry.body).toBe(200);
  expect(retry.json()).toEqual(first.json());
  expect(snapshot(env)).toEqual(after);
});

it("HTTP 安装草稿只在版本仍有效时展示，保存默认后原子删除", async () => {
  const env = await fixture();
  const defaults = new ModelDefaultsService(env.store).getOrImport(env.config);
  const draft = {
    schema_version: 1,
    expected_defaults_revision: defaults.revision,
    plannerProfile: nextFixer,
    executorProfile: executor,
    updated_at: now(),
  };
  env.store.put("model_defaults_draft", "global", "global", draft);
  const current = await env.app.inject({
    method: "GET",
    url: "/api/settings/model-defaults",
    headers,
  });
  expect(current.statusCode, current.body).toBe(200);
  expect(current.json().pending_draft).toEqual(draft);
  expect(current.json().defaults).toEqual(defaults);
  env.store.put("model_defaults_draft", "global", "global", {
    ...draft,
    expected_defaults_revision: defaults.revision - 1,
  });
  const stale = await env.app.inject({
    method: "GET",
    url: "/api/settings/model-defaults",
    headers,
  });
  expect(stale.json().pending_draft).toBeNull();
  env.store.put("model_defaults_draft", "global", "global", draft);
  const saved = await env.app.inject({
    method: "PUT",
    url: "/api/settings/model-defaults",
    headers,
    payload: {
      request_id: randomUUID(),
      expected_defaults_revision: defaults.revision,
      planner_profile: nextFixer,
      executor_profile: executor,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);
  expect(env.store.get("model_defaults_draft", "global")).toBeUndefined();
  const next = await env.app.inject({
    method: "GET",
    url: "/api/settings/model-defaults",
    headers,
  });
  expect(next.json().pending_draft).toBeNull();
  expect(next.json().defaults.plannerProfile.modelId).toBe(nextFixer.modelId);
});

function clearVerifiedAccess(env: Fixture) {
  for (const record of env.store.list<{ id: string }>("model_access"))
    env.store.remove("model_access", record.id);
  expect(env.store.list("model_access")).toHaveLength(0);
}

it("HTTP 默认保存成功后授权失效仍可重放同收据，新请求仍需授权", async () => {
  const env = await fixture();
  const defaults = new ModelDefaultsService(env.store).getOrImport(env.config);
  const payload = {
    request_id: randomUUID(),
    expected_defaults_revision: defaults.revision,
    planner_profile: nextFixer,
    executor_profile: executor,
  };
  const url = "/api/settings/model-defaults";
  const first = await env.app.inject({ method: "PUT", url, headers, payload });
  expect(first.statusCode, first.body).toBe(200);
  clearVerifiedAccess(env);
  const before = snapshot(env);
  const replay = await env.app.inject({ method: "PUT", url, headers, payload });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json()).toEqual(first.json());
  expect(snapshot(env)).toEqual(before);
  const fresh = await env.app.inject({
    method: "PUT",
    url,
    headers,
    payload: {
      ...payload,
      request_id: randomUUID(),
      expected_defaults_revision: first.json().entity_revision,
    },
  });
  expect(fresh.statusCode, fresh.body).toBe(422);
  expect(fresh.json().error.code).toBe("MODEL_ACCESS_REQUIRED");
  expect(snapshot(env)).toEqual(before);
});

it("HTTP 任务配置成功后授权失效仍可重放同收据，新请求仍需授权", async () => {
  const env = await fixture();
  const payload = {
    request_id: randomUUID(),
    expected_spec_revision: 1,
    planner_profile: nextFixer,
    executor_profile: executor,
    role_overrides: inheritRoleOverrides(),
  };
  const url = `/api/workflows/${env.workflowId}/execution-spec`;
  const first = await env.app.inject({ method: "POST", url, headers, payload });
  expect(first.statusCode, first.body).toBe(200);
  clearVerifiedAccess(env);
  const before = snapshot(env);
  const replay = await env.app.inject({
    method: "POST",
    url,
    headers,
    payload,
  });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json()).toEqual(first.json());
  expect(snapshot(env)).toEqual(before);
  const fresh = await env.app.inject({
    method: "POST",
    url,
    headers,
    payload: {
      ...payload,
      request_id: randomUUID(),
      expected_spec_revision: first.json().entity_revision,
    },
  });
  expect(fresh.statusCode, fresh.body).toBe(422);
  expect(fresh.json().error.code).toBe("MODEL_ACCESS_REQUIRED");
  expect(snapshot(env)).toEqual(before);
});

it("HTTP 修复指派成功后授权失效仍可重放同收据，新请求仍需授权", async () => {
  const env = await fixture();
  const payload = {
    request_id: randomUUID(),
    batch_id: env.created.batch.id,
    expected_assignment_revision: env.created.assignment!.revision,
    expected_spec_revision: 1,
    selection: { mode: "custom", profile: nextFixer },
    remember_for_task: true,
  };
  const url = `/api/workflows/${env.workflowId}/repair-model-assignment`;
  const first = await env.app.inject({ method: "POST", url, headers, payload });
  expect(first.statusCode, first.body).toBe(200);
  clearVerifiedAccess(env);
  const before = snapshot(env);
  const replay = await env.app.inject({
    method: "POST",
    url,
    headers,
    payload,
  });
  expect(replay.statusCode, replay.body).toBe(200);
  expect(replay.json()).toEqual(first.json());
  expect(snapshot(env)).toEqual(before);
  const fresh = await env.app.inject({
    method: "POST",
    url,
    headers,
    payload: {
      ...payload,
      request_id: randomUUID(),
      expected_assignment_revision: first.json().entity_revision,
      expected_spec_revision: env.specs.readView(env.workflowId).spec.revision,
    },
  });
  expect(fresh.statusCode, fresh.body).toBe(422);
  expect(fresh.json().error.code).toBe("MODEL_ACCESS_REQUIRED");
  expect(snapshot(env)).toEqual(before);
});
