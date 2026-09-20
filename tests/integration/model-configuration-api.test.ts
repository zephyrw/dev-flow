/**
 * ExecutionSpecService 合同与 HTTP 路由：IT-C03～C09、C13～C17。
 */
import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setup, repository } from "../helpers.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { ModelDefaultsService } from "../../packages/core/src/model-defaults-service.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import { now } from "../../packages/core/src/util.js";
import { buildServer } from "../../apps/api/src/server.js";
import {
  FlowError,
  inheritRoleOverrides,
  type ExecutionSpec,
  type RoleOverrides,
  type Run,
  type State,
  type ToolProfile,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import type { Store } from "../../packages/store/src/store.js";

let closeStore: (() => void) | undefined;
let closeApp: (() => Promise<void>) | undefined;

const httpHeaders = {
  host: "localhost:14810",
  origin: "http://localhost:14810",
  "content-type": "application/json",
};

afterEach(async () => {
  if (closeApp) await closeApp();
  closeApp = undefined;
  closeStore?.();
  closeStore = undefined;
});

function planner(modelId = "gpt-6-astra"): ToolProfile {
  return {
    id: "planner",
    revision: 1,
    adapterId: "codex",
    modelSelection: "explicit",
    modelId,
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  };
}

function executor(modelId = "gemini-3.7-flash-high"): ToolProfile {
  return {
    id: "executor",
    revision: 1,
    adapterId: "agy",
    modelSelection: "explicit",
    modelId,
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  };
}

const inheritAll: RoleOverrides = inheritRoleOverrides();

function openSpec(workflowId: string, init?: Partial<Workflow>) {
  const env = setup();
  closeStore = () => env.store.close();
  const workflow: Workflow = {
    id: workflowId,
    project_id: "p1",
    title: "配置任务",
    request: "保存配置",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "STOPPED",
    stage: "execute",
    version: 1,
    plan_revision: 4,
    environment_revision: 0,
    created_at: now(),
    updated_at: now(),
    feedback: [],
    ...init,
  };
  env.store.put("workflow", workflowId, workflow.project_id, workflow);
  seedVerifiedAccess(env.store, planner());
  seedVerifiedAccess(env.store, executor());
  seedVerifiedAccess(env.store, planner("next-planner"));
  seedVerifiedAccess(env.store, executor("next-executor"));
  seedVerifiedAccess(env.store, planner("stable-planner"));
  seedVerifiedAccess(env.store, executor("stable-executor"));
  seedVerifiedAccess(env.store, planner("other-model"));
  seedVerifiedAccess(env.store, planner("kept-planner"));
  seedVerifiedAccess(env.store, executor("kept-executor"));
  seedVerifiedAccess(env.store, planner("old-planner"));
  seedVerifiedAccess(env.store, executor("old-executor"));
  seedVerifiedAccess(env.store, planner("new-planner"));
  seedVerifiedAccess(env.store, executor("new-executor"));
  const service = new ExecutionSpecService(env.store, env.config);
  return { ...env, workflow, service };
}

function putSpec(
  store: Store,
  workflowId: string,
  revision: number,
  plannerProfile = planner("kept-planner"),
  executorProfile = executor("kept-executor"),
) {
  const spec = {
    schema_version: 2 as const,
    id: "spec-r" + revision,
    revision,
    workflow_id: workflowId,
    plannerProfile,
    executorProfile,
    roleOverrides: inheritAll,
    template_id: "native-development",
    template_revision: 3,
    mode: "composite" as const,
    created_at: now(),
  };
  store.put("execution_spec", spec.id, workflowId, spec);
  return spec;
}

function writeBody(
  workflowId: string,
  expected: number,
  extra?: Record<string, unknown>,
) {
  return {
    request_id: randomUUID(),
    expected_spec_revision: expected,
    workflow_id: workflowId,
    planner_profile: planner("next-planner"),
    executor_profile: executor("next-executor"),
    role_overrides: inheritAll,
    accessVerified: true,
    ...extra,
  };
}

function expectCode(run: () => unknown, code: string, status: number) {
  try {
    run();
    expect.unreachable("应当抛出 " + code);
  } catch (error) {
    expect(error).toBeInstanceOf(FlowError);
    expect(error).toMatchObject({ code, status });
  }
}

it("IT-C03：无 spec 时 readView 为 persisted false revision 0，且不写库", () => {
  const workflowId = "wf-c03";
  const { service, store } = openSpec(workflowId, { version: 67 });
  const view = service.readView(workflowId);
  expect(view.persisted).toBe(false);
  expect(view.source).toBe("legacy");
  expect(view.spec.revision).toBe(0);
  expect(store.list("execution_spec", workflowId)).toHaveLength(0);
  expect(store.list("execution_spec")).toHaveLength(0);
});

it("IT-C04：expected_spec_revision=0 保存生成 r1，不改 workflow.state", () => {
  const workflowId = "wf-c04";
  const { service, store } = openSpec(workflowId, {
    state: "STOPPED",
    plan_revision: 9,
  });
  const before = store.must<Workflow>("workflow", workflowId);
  const receipt = service.updateExecutionSpec(writeBody(workflowId, 0));
  expect(receipt.status).toBe("committed");
  expect(receipt.changed).toBe(true);
  expect(receipt.entity_revision).toBe(1);
  expect(receipt.effective_from).toBe("next-run");
  const view = service.readView(workflowId);
  expect(view.persisted).toBe(true);
  expect(view.spec.revision).toBe(1);
  const after = store.must<Workflow>("workflow", workflowId);
  expect(after.state).toBe("STOPPED");
  expect(after.plan_revision).toBe(before.plan_revision);
  expect(after.version).toBe(before.version);
  expect(store.jobs()).toHaveLength(0);
});

it("IT-C05：spec r2 保存 expected_spec_revision=2 成功，不比较 workflow.version", () => {
  const workflowId = "wf-c05";
  const { service, store } = openSpec(workflowId, { version: 67 });
  putSpec(store, workflowId, 2);
  const receipt = service.updateExecutionSpec(writeBody(workflowId, 2));
  expect(receipt.entity_revision).toBe(3);
  expect(receipt.changed).toBe(true);
  expect(store.must<Workflow>("workflow", workflowId).version).toBe(67);
});

it("IT-C06：两个请求都按 r2 写入时一个成功 r3，另一个 SPEC_VERSION_CONFLICT", () => {
  const workflowId = "wf-c06";
  const { service, store } = openSpec(workflowId);
  putSpec(store, workflowId, 2);
  const first = service.updateExecutionSpec(writeBody(workflowId, 2));
  expect(first.entity_revision).toBe(3);
  expectCode(
    () => service.updateExecutionSpec(writeBody(workflowId, 2)),
    "SPEC_VERSION_CONFLICT",
    409,
  );
  expect(
    store.list<ExecutionSpec>("execution_spec", workflowId).map((s) => s.revision),
  ).toEqual(expect.arrayContaining([2, 3]));
});

it("IT-C07：相同 request_id 重试返回同一 receipt，不额外 revision", () => {
  const workflowId = "wf-c07";
  const { service, store } = openSpec(workflowId);
  const body = writeBody(workflowId, 0);
  const first = service.updateExecutionSpec(body);
  const retry = service.updateExecutionSpec(body);
  expect(retry).toEqual(first);
  expect(
    store
      .list<ExecutionSpec>("execution_spec", workflowId)
      .filter((s) => s.revision === 1),
  ).toHaveLength(1);
});

it("IT-C08：同 request_id 不同 payload 返回 IDEMPOTENCY_CONFLICT", () => {
  const workflowId = "wf-c08";
  const { service } = openSpec(workflowId);
  const requestId = randomUUID();
  service.updateExecutionSpec(
    writeBody(workflowId, 0, { request_id: requestId }),
  );
  expectCode(
    () =>
      service.updateExecutionSpec(
        writeBody(workflowId, 0, {
          request_id: requestId,
          planner_profile: planner("other-model"),
        }),
      ),
    "IDEMPOTENCY_CONFLICT",
    409,
  );
});

it("IT-C09：保存未修改配置时 changed=false 且 revision 不变", () => {
  const workflowId = "wf-c09";
  const { service, store } = openSpec(workflowId);
  const created = service.updateExecutionSpec(
    writeBody(workflowId, 0, {
      planner_profile: planner("stable-planner"),
      executor_profile: executor("stable-executor"),
    }),
  );
  expect(created.entity_revision).toBe(1);
  const noop = service.updateExecutionSpec(
    writeBody(workflowId, 1, {
      planner_profile: planner("stable-planner"),
      executor_profile: executor("stable-executor"),
    }),
  );
  expect(noop.changed).toBe(false);
  expect(noop.entity_revision).toBe(1);
  expect(store.list("execution_spec", workflowId)).toHaveLength(1);
});

it("IT-C13：终态任务保存返回 TASK_TERMINAL", () => {
  const terminals: State[] = ["COMMITTED", "COMPLETED", "COMMIT_PARTIAL"];
  for (const state of terminals) {
    const workflowId = "wf-c13-" + state.toLowerCase();
    const { service } = openSpec(workflowId, { state });
    expectCode(
      () => service.updateExecutionSpec(writeBody(workflowId, 0)),
      "TASK_TERMINAL",
      422,
    );
    closeStore?.();
    closeStore = undefined;
  }
});

it("IT-C15：传 expected_version 返回 AMBIGUOUS_VERSION_FIELD", () => {
  const workflowId = "wf-c15";
  const { service } = openSpec(workflowId, { version: 67 });
  expectCode(
    () =>
      service.updateExecutionSpec(
        writeBody(workflowId, 0, { expected_version: 67 }),
      ),
    "AMBIGUOUS_VERSION_FIELD",
    422,
  );
});

async function openHttp(workflowId: string, init?: Partial<Workflow>) {
  const env = openSpec(workflowId, init);
  const app = await buildServer(env.engine);
  closeApp = () => app.close();
  return { ...env, app };
}

it("IT-C03 HTTP：GET 旧任务无 spec 返回 200 revision=0 且不写库", async () => {
  const workflowId = "wf-c03-http";
  const { app, store } = await openHttp(workflowId, { version: 67 });
  const res = await app.inject({
    method: "GET",
    url: "/api/workflows/" + workflowId + "/execution-spec",
    headers: httpHeaders,
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json();
  expect(body.spec_revision).toBe(0);
  expect(body.workflow_version).toBe(67);
  expect(body.source).toBe("legacy");
  expect(body.spec.revision).toBe(0);
  expect(body.can_edit).toBe(true);
  expect(store.list("execution_spec", workflowId)).toHaveLength(0);
});

it("IT-C04 HTTP：服务保存 r1 后 GET 仍 STOPPED 且 revision=1", async () => {
  const workflowId = "wf-c04-http";
  const { app, store, service } = await openHttp(workflowId, { state: "STOPPED" });
  const receipt = service.updateExecutionSpec(writeBody(workflowId, 0));
  expect(receipt.entity_revision).toBe(1);
  const res = await app.inject({
    method: "GET",
    url: "/api/workflows/" + workflowId + "/execution-spec",
    headers: httpHeaders,
  });
  expect(res.statusCode, res.body).toBe(200);
  expect(res.json().spec_revision).toBe(1);
  expect(store.must<Workflow>("workflow", workflowId).state).toBe("STOPPED");
});

it("IT-C10 HTTP：当前 active Run 保持原绑定，pending 显示后续角色", async () => {
  const workflowId = "wf-c10-http";
  const { app, store, service } = await openHttp(workflowId, {
    state: "EXECUTING",
    run_id: "run-c10",
  });
  putSpec(store, workflowId, 1, planner("kept-planner"), executor("kept-executor"));
  store.put("run", "run-c10", workflowId, {
    id: "run-c10",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    routing_role: "executor",
    execution_spec_revision: 1,
    profile: executor("kept-executor"),
    stage: "execute",
    status: "running",
    started_at: now(),
    package_hash: "pkg",
  } satisfies Run);
  service.updateExecutionSpec(writeBody(workflowId, 1));
  const view = await app.inject({
    method: "GET",
    url: "/api/workflows/" + workflowId + "/execution-spec",
    headers: httpHeaders,
  });
  const body = view.json();
  expect(body.active_run.run_id).toBe("run-c10");
  expect(body.active_run.profile.modelId).toBe("kept-executor");
  expect(body.pending_roles).toContain("executor");
  expect(body.spec.plannerProfile.modelId).toBe("next-planner");
  expect(store.must<Run>("run", "run-c10").profile?.modelId).toBe("kept-executor");
});

it("IT-C14：planner token 不能调用 human 配置 API", async () => {
  const workflowId = "wf-c14-http";
  const { app, engine, store } = await openHttp(workflowId);
  const token = engine.auth.issue({ role: "planner" });
  const res = await app.inject({
    method: "POST",
    url: "/api/workflows/" + workflowId + "/execution-spec",
    headers: { ...httpHeaders, authorization: "Bearer " + token },
    payload: writeBody(workflowId, 0),
  });
  expect(res.statusCode).toBe(403);
  expect(res.json().error.code).toBe("FORBIDDEN");
  expect(store.list("execution_spec", workflowId)).toHaveLength(0);
});

it("IT-C15 HTTP：接口传 expected_version 返回 AMBIGUOUS_VERSION_FIELD", async () => {
  const workflowId = "wf-c15-http";
  const { app } = await openHttp(workflowId, { version: 67 });
  const res = await app.inject({
    method: "POST",
    url: "/api/workflows/" + workflowId + "/execution-spec",
    headers: httpHeaders,
    payload: writeBody(workflowId, 0, { expected_version: 67 }),
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe("AMBIGUOUS_VERSION_FIELD");
});

it("IT-C16：创建前访问验证失败不留下 workflow 或工作树", async () => {
  const env = setup();
  closeStore = () => env.store.close();
  const repo = await repository(env.root);
  const app = await buildServer(env.engine);
  closeApp = () => app.close();
  const res = await app.inject({
    method: "POST",
    url: "/api/workflows",
    headers: httpHeaders,
    payload: {
      request_id: "create-c16",
      workspace_root: repo.repo,
      request_text: "完整需求用于验证失败",
      workspace_mode: "new_worktree",
      planner_profile: planner(),
      executor_profile: executor(),
      role_overrides: inheritAll,
    },
  });
  expect(res.statusCode, res.body).toBe(422);
  expect(["MODEL_ACCESS_REQUIRED", "MODEL_NOT_LISTED"]).toContain(
    res.json().error.code,
  );
  expect(env.store.list("workflow")).toHaveLength(0);
  expect(env.store.list("workspace")).toHaveLength(0);
  expect(env.store.list("workspace_creation")).toHaveLength(0);
});

it("IT-C17：修改配置后历史 Run 仍显示旧绑定", async () => {
  const workflowId = "wf-c17-http";
  const { app, store, service } = await openHttp(workflowId, {
    state: "STOPPED",
    run_id: "run-c17",
  });
  putSpec(store, workflowId, 1, planner("old-planner"), executor("old-executor"));
  store.put("run", "run-c17", workflowId, {
    id: "run-c17",
    workflow_id: workflowId,
    plan_revision: 1,
    adapter: "agy",
    purpose: "implement",
    routing_role: "executor",
    execution_spec_revision: 1,
    profile: executor("old-executor"),
    stage: "execute",
    status: "completed",
    started_at: now(),
    package_hash: "pkg",
  } satisfies Run);
  const receipt = service.updateExecutionSpec(
    writeBody(workflowId, 1, {
      planner_profile: planner("new-planner"),
      executor_profile: executor("new-executor"),
    }),
  );
  expect(receipt.entity_revision).toBe(2);
  const view = await app.inject({
    method: "GET",
    url: "/api/workflows/" + workflowId + "/execution-spec",
    headers: httpHeaders,
  });
  const body = view.json();
  expect(body.spec.executorProfile.modelId).toBe("new-executor");
  expect(body.active_run.profile.modelId).toBe("old-executor");
  expect(store.must<Run>("run", "run-c17").profile?.modelId).toBe("old-executor");
});

it("R16：旧任务 revision=0 视图不受新全局默认影响，GET 不写 r1", () => {
  const workflowId = "wf-r16";
  const { service, store, config } = openSpec(workflowId);
  const before = service.readView(workflowId);
  expect(before.persisted).toBe(false);
  expect(before.spec.revision).toBe(0);
  const yamlPlanner = before.spec.plannerProfile.modelId;
  const defaults = new ModelDefaultsService(store);
  const imported = defaults.getOrImport(config);
  seedVerifiedAccess(store, {
    ...imported.plannerProfile,
    modelId: "global-new-planner",
  });
  seedVerifiedAccess(store, imported.executorProfile);
  defaults.save({
    request_id: randomUUID(),
    expected_defaults_revision: imported.revision,
    plannerProfile: {
      ...imported.plannerProfile,
      modelId: "global-new-planner",
    },
    executorProfile: imported.executorProfile,
  });
  const after = service.readView(workflowId);
  expect(after.persisted).toBe(false);
  expect(after.spec.revision).toBe(0);
  expect(after.spec.plannerProfile.modelId).toBe(yamlPlanner);
  expect(after.spec.plannerProfile.modelId).not.toBe("global-new-planner");
  expect(store.list("execution_spec", workflowId)).toHaveLength(0);
});

it("R07：未验证 profile 不能保存任务配置", () => {
  const workflowId = "wf-r07-unverified";
  const { service } = openSpec(workflowId);
  expectCode(
    () =>
      service.updateExecutionSpec(
        writeBody(workflowId, 0, {
          planner_profile: planner("never-verified"),
        }),
      ),
    "MODEL_ACCESS_REQUIRED",
    422,
  );
});

it("R07：未验证 profile 不能经 HTTP 保存全局默认", async () => {
  const workflowId = "wf-r07-defaults-http";
  const { app, store, config } = await openHttp(workflowId);
  const imported = new ModelDefaultsService(store).getOrImport(config);
  const res = await app.inject({
    method: "PUT",
    url: "/api/settings/model-defaults",
    headers: httpHeaders,
    payload: {
      request_id: randomUUID(),
      expected_defaults_revision: imported.revision,
      planner_profile: planner("never-verified"),
      executor_profile: imported.executorProfile,
    },
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe("MODEL_ACCESS_REQUIRED");
});
