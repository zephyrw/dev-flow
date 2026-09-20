import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDefaultAdapterRegistry } from "../packages/adapters/sdk/src/index.js";
import {
  capabilityFromAdapter,
  clientInvocation,
} from "../packages/adapters/sdk/src/invocation.js";
import { resolveModelSelection } from "../packages/adapters/sdk/src/model-selection.js";
import { visibleModelEntries } from "../packages/adapters/sdk/src/catalog-parse.js";
import type { PreparedInvocation } from "../packages/adapters/sdk/src/interface.js";
import {
  inheritRoleOverrides,
  type ModelCatalog,
  type ModelEntry,
  type SupportedAdapterId,
  type ToolProfile,
} from "../packages/contracts/src/index.js";
import { CreateWorkflowService } from "../packages/core/src/create-workflow.js";
import { ExecutionSpecService } from "../packages/core/src/execution-spec-service.js";
import {
  ACCESS_PROBE_PROMPT,
  ModelAccessService,
  prepareAccessProbe,
} from "../packages/core/src/model-access-service.js";
import { ModelCatalogService } from "../packages/core/src/model-catalog-service.js";
import { ModelSwitchService } from "../packages/core/src/model-switch-service.js";
import { RepairModelService } from "../packages/core/src/repair-model-service.js";
import { repository, setup } from "../tests/helpers.js";

const AUTHORIZED: SupportedAdapterId[] = [
  "codex",
  "agy",
  "claude-code",
  "cursor-agent",
  "grok-build",
  "opencode",
];
const SKIPPED: SupportedAdapterId[] = ["kimi-code", "qoder"];
const PREFERRED: Record<string, string[]> = {
  codex: ["gpt-6-astra", "gpt-5.6-sol"],
  agy: ["gemini-3.7-flash-high", "gemini-3.8-flash-high"],
  "claude-code": ["claude-sonnet-4-6", "claude-opus-4-6", "claude-fable-5-1"],
  "cursor-agent": ["auto"],
  "grok-build": ["grok-4.6", "grok-4.5"],
};
const FORBIDDEN = ["--force", "--always-approve", "--approve-mcps"];
const JOB_DONE = new Set(["verified", "failed", "cancelled", "temporary_error"]);

type Status = {
  catalog: string;
  params: string;
  access: string;
  business: string;
  detail: string;
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pickEntry(catalog: ModelCatalog): ModelEntry | undefined {
  const visible = visibleModelEntries(catalog.entries).filter(
    (entry) => entry.availability !== "unavailable",
  );
  const listed = visible.filter((entry) => entry.availability === "listed");
  const pool = listed.length > 0 ? listed : visible;
  const preferred = PREFERRED[catalog.adapterId] ?? [];
  for (const nativeId of preferred) {
    const matched = pool.find((entry) => entry.nativeId === nativeId);
    if (matched) return matched;
  }
  return pool.find((entry) => entry.selectionKind === "fixed") ?? pool[0];
}

function profileOf(
  adapterId: SupportedAdapterId,
  executable: string,
  entry: ModelEntry,
): ToolProfile {
  const defaultEffort = entry.effort.defaultValue;
  return {
    id: adapterId.replace(/[^a-zA-Z0-9_-]/g, "-"),
    revision: 1,
    adapterId,
    executableRef: executable,
    modelSelection: "explicit",
    modelId: entry.nativeId,
    reasoning: defaultEffort
      ? { mode: "explicit", value: defaultEffort }
      : { mode: "native-default" },
    selectionKind: entry.selectionKind === "native-router" ? "native-router" : "fixed",
    options: {},
  };
}

function describeInvocation(invocation: PreparedInvocation): string {
  return JSON.stringify({
    args: invocation.args,
    env: invocation.env,
    hasStdin: Boolean(invocation.stdin),
  });
}

function paramsOk(
  adapterId: SupportedAdapterId,
  profile: ToolProfile,
  entry: ModelEntry,
  executable: string,
  emptyDir: string,
): { ok: boolean; detail: string } {
  const selection = resolveModelSelection(
    profile,
    entry,
    capabilityFromAdapter(adapterId, profile),
  );
  const probe = prepareAccessProbe(selection, executable, emptyDir);
  const planning = clientInvocation(
    adapterId,
    {
      workflowId: "wf-smoke",
      runId: "run-smoke",
      stage: "planning",
      epoch: 1,
      purpose: "planning",
      timeoutMs: 60000,
      workspaceRoots: { main: emptyDir },
      allowedPaths: [],
      handoffDocPath: "plan.md",
      prompt: ACCESS_PROBE_PROMPT,
      toolProfile: profile,
    },
    executable,
  );
  const args = [...probe.args, ...planning.args];
  if (args.some((arg) => FORBIDDEN.includes(arg))) {
    return { ok: false, detail: "探测或规划参数含禁止标志" };
  }
  if (selection.modelToken && !probe.args.includes(selection.modelToken)) {
    return { ok: false, detail: "探测未冻结模型 token" };
  }
  if (selection.modelToken && !planning.args.includes(selection.modelToken)) {
    return { ok: false, detail: "规划调用未冻结模型 token" };
  }
  return {
    ok: true,
    detail: describeInvocation(probe),
  };
}

async function waitJob(
  access: ModelAccessService,
  jobId: string,
): Promise<ReturnType<ModelAccessService["getVerification"]>> {
  const deadline = Date.now() + 120000;
  let current = access.getVerification(jobId);
  while (!JOB_DONE.has(current.status) && Date.now() < deadline) {
    await sleep(800);
    current = access.getVerification(jobId);
  }
  return current;
}

async function smokeTool(
  adapterId: SupportedAdapterId,
  catalogService: ModelCatalogService,
  access: ModelAccessService,
  emptyDir: string,
): Promise<{
  status: Status;
  profile?: ToolProfile;
  catalog?: ModelCatalog;
}> {
  const registry = createDefaultAdapterRegistry();
  const adapter = registry.mustGet(adapterId);
  const report = await adapter.probe({
    toolProfile: {
      id: "probe",
      revision: 1,
      adapterId,
      modelSelection: "native-config",
      options: {},
    },
  });
  if (!report.available || !report.executablePath) {
    return {
      status: {
        catalog: "failed",
        params: "not-run",
        access: "not-run",
        business: "not-run",
        detail: report.unsupportedReason ?? "未检测到 CLI",
      },
    };
  }
  const catalog = await catalogService.discover({
    adapterId,
    executablePath: report.executablePath,
    nativeConfigScope: "default",
  });
  if (catalog.status === "failed" || catalog.entries.length === 0) {
    return {
      status: {
        catalog: "failed",
        params: "not-run",
        access: "not-run",
        business: "pending",
        detail: catalog.errorMessage ?? "目录为空",
      },
      catalog,
    };
  }
  const entry = pickEntry(catalog);
  if (!entry) {
    return {
      status: {
        catalog: "ok",
        params: "failed",
        access: "not-run",
        business: "pending",
        detail: "没有可调用模型条目",
      },
      catalog,
    };
  }
  const profile = profileOf(adapterId, report.executablePath, entry);
  const params = paramsOk(
    adapterId,
    profile,
    entry,
    report.executablePath,
    emptyDir,
  );
  if (!params.ok) {
    return {
      status: {
        catalog: "ok",
        params: "failed",
        access: "not-run",
        business: "pending",
        detail: params.detail,
      },
      profile,
      catalog,
    };
  }
  const started = access.verifyAccess({
    request_id: randomUUID(),
    profile,
    force: true,
    identity: { nativeConfigScope: "default" },
    catalog,
  });
  const job = started.cached
    ? started.job
    : await waitJob(access, started.job.id);
  const accessOk = job.status === "verified";
  return {
    status: {
      catalog: "ok",
      params: "ok",
      access: accessOk ? "ok" : "failed",
      business: "pending",
      detail: accessOk
        ? `${entry.nativeId} / ${catalog.entries.length} entries / ${params.detail}`
        : `${job.status}: ${job.error_code ?? ""} ${job.error_message ?? ""}`,
    },
    profile,
    catalog,
  };
}

function dummyRuntime() {
  return {
    execute: async () => {},
    stop: async () => {},
    review: async () => ({}),
    check: async () => {
      throw new Error("unused");
    },
    close: async () => {},
  };
}

async function smokeBusiness(
  results: Array<{ adapterId: SupportedAdapterId; profile?: ToolProfile }>,
) {
  const env = setup();
  const repo = await repository(env.root, "business");
  const planner =
    results.find((item) => item.adapterId === "codex")?.profile ??
    results.find((item) => item.profile)?.profile;
  const executor =
    results.find((item) => item.adapterId === "agy")?.profile ??
    results.find((item) => item.adapterId !== planner?.adapterId)?.profile ??
    planner;
  const reviewer =
    results.find((item) => item.adapterId === "claude-code")?.profile ??
    results.find((item) => item.adapterId === "cursor-agent")?.profile ??
    executor;
  if (!planner || !executor || !reviewer) {
    env.store.close();
    return { ok: false, detail: "没有已解析的规划/执行配置" };
  }
  const created = new CreateWorkflowService(env.store, env.config).execute({
    request_id: randomUUID(),
    workspace_root: repo.repo,
    request_text: "隔离烟测：只创建规划任务，不执行真实开发。",
    workspace_mode: "existing_workspace",
    planner_profile: planner,
    executor_profile: executor,
  });
  const specs = new ExecutionSpecService(env.store, env.config);
  const switches = new ModelSwitchService(env.store, specs);
  const nextEffort = {
    ...executor,
    reasoning: { mode: "explicit" as const, value: "medium" },
  };
  const saved = specs.updateExecutionSpec({
    request_id: randomUUID(),
    expected_spec_revision: 1,
    workflow_id: created.workflow.id,
    planner_profile: planner,
    executor_profile: nextEffort,
    role_overrides: inheritRoleOverrides(),
    accessVerified: true,
  });
  env.engine.runtime = dummyRuntime();
  env.store.put("workflow", created.workflow.id, created.workflow.project_id, {
    ...env.engine.get(created.workflow.id),
    state: "EXECUTING",
    stage: "execute",
    run_id: "run-implement",
    version: env.engine.get(created.workflow.id).version,
  });
  const pausedEffort = await switches.applyAfterPause(
    env.engine,
    created.workflow.id,
    {
      request_id: randomUUID(),
      expected_spec_revision: saved.entity_revision,
      planner_profile: planner,
      executor_profile: nextEffort,
      role_overrides: inheritRoleOverrides(),
      expected_workflow_version: env.engine.get(created.workflow.id).version,
      expected_run_id: "run-implement",
    },
  );
  env.store.put("workflow", created.workflow.id, created.workflow.project_id, {
    ...env.engine.get(created.workflow.id),
    state: "REVIEWING",
    stage: "review",
    run_id: "run-review",
  });
  const pausedReview = await switches.applyAfterPause(
    env.engine,
    created.workflow.id,
    {
      request_id: randomUUID(),
      expected_spec_revision: pausedEffort.entity_revision,
      planner_profile: planner,
      executor_profile: nextEffort,
      role_overrides: {
        ...inheritRoleOverrides(),
        reviewer: { mode: "explicit", profile: reviewer },
      },
      expected_workflow_version: env.engine.get(created.workflow.id).version,
      expected_run_id: "run-review",
    },
  );
  const repairs = new RepairModelService(env.store, specs);
  const assigned = repairs.submitFunctionalRepair({
    workflow_id: created.workflow.id,
    request_id: randomUUID(),
    descriptions: [{ description: "人工问题临时指派" }],
    selection: { mode: "custom", profile: reviewer },
    expected_spec_revision: pausedReview.entity_revision,
  });
  env.store.close();
  return {
    ok: true,
    detail: JSON.stringify({
      workflow_id: created.workflow.id,
      create_state: created.workflow.state,
      save_next_run: saved.effective_from,
      pause_effort: pausedEffort.effective_from,
      pause_review_tool: pausedReview.effective_from,
      assignment_id: assigned.assignment?.id,
      sqlite: env.config.storage_root,
      repo: repo.repo,
    }),
  };
}

async function main() {
  const env = setup();
  const emptyDir = join(env.root, "empty-probe");
  mkdirSync(emptyDir, { recursive: true });
  const catalogService = new ModelCatalogService(env.store, {
    workingDirectory: emptyDir,
  });
  const access = new ModelAccessService(env.store, {
    catalog: catalogService,
    probeRoot: join(env.root, "model-probe"),
    verifyTimeoutMs: 90000,
  });
  const rows: Array<{
    adapterId: SupportedAdapterId;
    status: Status;
    profile?: ToolProfile;
  }> = [];
  for (const adapterId of AUTHORIZED) {
    console.log(`\n== ${adapterId} ==`);
    const result = await smokeTool(adapterId, catalogService, access, emptyDir);
    console.log(JSON.stringify(result.status, null, 2));
    rows.push({ adapterId, ...result });
  }
  const business = await smokeBusiness(rows);
  for (const row of rows) {
    row.status.business = business.ok ? "ok" : "failed";
    if (business.ok === false) row.status.detail += ` | business: ${business.detail}`;
  }
  await access.close();
  env.store.close();
  const report = {
    isolated_root: env.root,
    sqlite: join(env.root, "state", "devflow.sqlite"),
    authorized: rows.map((row) => ({
      adapterId: row.adapterId,
      ...row.status,
    })),
    skipped: SKIPPED.map((adapterId) => ({
      adapterId,
      catalog: "not-live-verified",
      params: "not-live-verified",
      access: "not-live-verified",
      business: "not-live-verified",
      detail: "本轮未授权，未做实机调用",
    })),
    business,
  };
  const reportPath = join(env.root, "live-smoke-report.json");
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log("\n== 汇总 ==");
  console.log(JSON.stringify(report, null, 2));
  console.log(`report: ${reportPath}`);
  const failed = rows.some(
    (row) =>
      row.status.catalog !== "ok" ||
      row.status.params !== "ok" ||
      row.status.access !== "ok" ||
      row.status.business !== "ok",
  );
  if (failed || !business.ok) process.exitCode = 1;
}

await main();
