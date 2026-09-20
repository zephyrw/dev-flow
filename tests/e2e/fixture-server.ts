import { startTask } from "../../packages/core/src/progress.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setup, repository, project, plan } from "../helpers.js";
import { Engine, type Runtime } from "../../packages/core/src/engine.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { now, objectHash, atomicWrite } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";
import { buildServer } from "../../apps/api/src/server.js";
import type {
  MergeConflictRequest,
  ModelCatalog,
  ModelEntry,
  Run,
  SupportedAdapterId,
  ToolProfile,
  Workflow,
} from "../../packages/contracts/src/index.js";
import { inheritRoleOverrides } from "../../packages/contracts/src/index.js";
import { CATALOG_FRESH_MS } from "../../packages/contracts/src/model-catalog.js";
import { ModelAccessService } from "../../packages/core/src/model-access-service.js";
import {
  ModelCatalogService,
  type CatalogScopeInput,
} from "../../packages/core/src/model-catalog-service.js";
import { resolveModelIdentity } from "../../packages/core/src/model-identity.js";
import { setAdapterExecutableResolver } from "../../packages/adapters/sdk/src/registry.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import {
  ensureQualityRepairBatch,
  RepairModelService,
} from "../../packages/core/src/repair-model-service.js";
import { FunctionalIssueService } from "../../packages/core/src/functional-issues.js";
import { seedSourceChange } from "../fixtures/source-change.js";
import { accountFixture } from "../fixtures/agy-accounts/service-fixture.js";
import { AgyAccountSettingsSchema } from "../../packages/contracts/src/agy-account.js";
import {
  attachmentArchiveKey,
  createArchiveJobFromManifest,
  drainArchiveOutbox,
} from "../../packages/evidence/src/archive-consumer.js";

const PROBE_CLI = resolve("tests/fixtures/model-probe/cli.mjs");
// Install before setup creates any store, engine or model service. This resolver
// is authoritative in this fixture process: no discovery can reach host CLIs.
setAdapterExecutableResolver((_adapterId, customPath) => {
  const requested = customPath?.trim();
  if (!requested || !/[\\/:]/.test(requested)) return PROBE_CLI;
  if (isAbsolute(requested)) {
    const normalized = resolve(requested);
    const equalPath = (allowed: string) =>
      process.platform === "win32"
        ? normalized.toLowerCase() === allowed.toLowerCase()
        : normalized === allowed;
    if (equalPath(PROBE_CLI)) return PROBE_CLI;
    if (equalPath(process.execPath)) return process.execPath;
  }
  throw new Error(
    "E2E fixture refuses executable paths outside its controlled probe and Node runtime",
  );
});
// Only this fixture child process sees this empty configuration root.
// Model identity/catalog resolution must never depend on a real Codex account.
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), "devflow-e2e-codex-"));
const SKIP_VERIFY = new Set(["codex-login-required-model"]);

type CatalogModel = {
  id: string;
  label: string;
  values: string[];
  defaultValue?: string;
  fixedValue?: string;
  transport?: "config" | "none" | "variant-id";
  variants?: Record<string, string>;
};

const CATALOG_MODELS: Array<{
  adapterId: SupportedAdapterId;
  models: CatalogModel[];
}> = [
  {
    adapterId: "codex",
    models: [
      {
        id: "gpt-6-astra",
        label: "GPT-6 Astra",
        values: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultValue: "medium",
      },
      {
        id: "gpt-5.6-sol",
        label: "GPT-5.6 Sol",
        values: ["low", "medium", "high", "xhigh", "max", "ultra"],
        defaultValue: "low",
      },
      {
        id: "gpt-5.6-luna",
        label: "GPT-5.6 Luna",
        values: ["low", "medium", "high", "xhigh", "max"],
      },
      {
        id: "codex-login-required-model",
        label: "Login Required",
        values: ["low", "medium", "high"],
        defaultValue: "medium",
      },
    ],
  },
  {
    adapterId: "agy",
    models: [
      {
        id: "gemini-3.7-flash-high",
        label: "Gemini 3.7 Flash High",
        values: ["high"],
        defaultValue: "high",
        fixedValue: "high",
        transport: "none",
      },
      {
        id: "gemini-3.7-flash-medium",
        label: "Gemini 3.7 Flash Medium",
        values: ["medium"],
        defaultValue: "medium",
        fixedValue: "medium",
        transport: "none",
      },
    ],
  },
  {
    adapterId: "cursor-agent",
    models: [
      {
        id: "cursor-grok-4.6-high",
        label: "Grok 4.6 High",
        values: ["low", "medium", "high", "xhigh"],
        defaultValue: "high",
        fixedValue: "high",
        transport: "variant-id",
        variants: {
          low: "cursor-grok-4.6-low",
          medium: "cursor-grok-4.6-medium",
          high: "cursor-grok-4.6-high",
          xhigh: "cursor-grok-4.6-xhigh",
        },
      },
    ],
  },
];

function writeProbeControl(logDir: string, patch: Record<string, unknown>) {
  const path = join(logDir, "control.json");
  const current = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>)
    : {};
  writeFileSync(path, JSON.stringify({ ...current, ...patch }));
}

function probeCount(logDir: string): number {
  const file = join(logDir, "invocations.jsonl");
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: string })
    .filter((item) => item.kind === "probe").length;
}

function catalogEntry(
  adapterId: SupportedAdapterId,
  model: CatalogModel,
  discoveredAt: string,
): ModelEntry {
  return {
    entryId: adapterId + "/" + model.id,
    adapterId,
    nativeId: model.id,
    label: model.label,
    selectionKind: "fixed",
    effort: {
      status: "supported",
      transport: model.transport ?? "config",
      values: model.values,
      defaultValue: model.defaultValue,
      fixedValue: model.fixedValue,
      variants: model.variants,
    },
    source: "native-cache",
    discoveredAt,
    hidden: false,
    availability: "listed",
    capabilityRevision: "1",
  };
}

function fixtureCatalogScope(
  store: ReturnType<typeof setup>["store"],
  adapterId: SupportedAdapterId,
): CatalogScopeInput {
  const native = resolveModelIdentity(store, {
    adapterId,
    executableRef: PROBE_CLI,
  });
  return {
    adapterId,
    executablePath: native.executablePath,
    nativeConfigScope: native.nativeConfigScope,
    nativeConfigProfile: native.nativeConfigProfile,
    accountFingerprint: native.accountFingerprint,
    providerFingerprint: native.providerEndpointFingerprint,
  };
}

function seedCatalogs(store: ReturnType<typeof setup>["store"]) {
  const catalogs = new ModelCatalogService(store);
  const discoveredAt = now();
  const staleAfter = new Date(Date.now() + CATALOG_FRESH_MS).toISOString();
  for (const group of CATALOG_MODELS) {
    const scope = fixtureCatalogScope(store, group.adapterId);
    // Let the public service create its scoped entity and pointer, then enrich
    // that fixture entry with deterministic listed-model capabilities.
    catalogs.ensureManualCandidate(scope, group.models[0]!.id);
    const seeded = catalogs.loadForSelector(scope);
    const catalog: ModelCatalog = {
      ...seeded,
      cliVersion: "fixture-1.0",
      status: "fresh",
      discoveredAt,
      staleAfter,
      entries: group.models.map((model) =>
        catalogEntry(group.adapterId, model, discoveredAt),
      ),
    };
    store.put(
      "model_catalog",
      "catalog:" + seeded.scopeHash,
      group.adapterId,
      catalog,
    );
  }
}

function verifyProfile(
  adapterId: SupportedAdapterId,
  modelId: string,
  effort: string,
): ToolProfile {
  return {
    id: "probe-" + adapterId,
    revision: 1,
    adapterId,
    executableRef: PROBE_CLI,
    modelSelection: "explicit",
    modelId,
    reasoning: { mode: "explicit", value: effort },
    selectionKind: "fixed",
    options: {},
  };
}

async function waitVerified(
  access: ModelAccessService,
  profile: ToolProfile,
  catalog?: ModelCatalog,
) {
  const outcome = await access.verify({
    request_id: crypto.randomUUID(),
    profile,
    force: false,
    catalog,
  });
  if (outcome.statusCode === 200) return;
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const job = access.getVerification(outcome.job.id);
    if (job.status === "verified") return;
    if (
      job.status === "failed" ||
      job.status === "cancelled" ||
      job.status === "temporary_error"
    ) {
      throw new Error(
        "夹具预验证失败 " +
          profile.modelId +
          ": " +
          (job.error_code ?? "") +
          " " +
          (job.error_message ?? ""),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("夹具预验证超时 " + profile.modelId);
}

async function preVerifyCatalogs(store: ReturnType<typeof setup>["store"]) {
  const catalogs = new ModelCatalogService(store);
  const access = new ModelAccessService(store, {
    catalog: catalogs,
    extraEnv: { MODEL_PROBE_LOG_DIR: process.env.MODEL_PROBE_LOG_DIR ?? "" },
    probeRoot: join(dirnameOfStore(store), "model-probe"),
    verifyTimeoutMs: 30000,
  });
  for (const group of CATALOG_MODELS) {
    writeProbeControl(process.env.MODEL_PROBE_LOG_DIR!, {
      adapterId: group.adapterId,
      behavior: "ok",
      delayMs: 0,
    });
    for (const model of group.models) {
      if (SKIP_VERIFY.has(model.id)) continue;
      const effort = model.defaultValue ?? model.values[0] ?? "high";
      const catalog = catalogs.loadForSelector(
        fixtureCatalogScope(store, group.adapterId),
      );
      if (catalog.status !== "fresh" || !catalog.entries.length)
        throw new Error("Fixture catalog missing for " + group.adapterId);
      await waitVerified(
        access,
        verifyProfile(group.adapterId, model.id, effort),
        catalog,
      );
    }
  }
  await access.close();
}

function dirnameOfStore(store: ReturnType<typeof setup>["store"]) {
  return store.file.replace(/[\\/][^\\/]+$/, "");
}

const s = setup();
const e2ePort = Number(process.env.E2E_PORT || 14811);
s.config.server.port = e2ePort;
s.config.server.human_origin = `http://localhost:${e2ePort}`;
s.config.host.required = true;
s.config.host.executable = resolve(
  "dist/host/" +
    (process.platform === "win32" ? "devflow-host.exe" : "devflow-host"),
);
const probeLogDir = join(s.root, "probe-log");
mkdirSync(probeLogDir, { recursive: true });
process.env.MODEL_PROBE_LOG_DIR = probeLogDir;
writeProbeControl(probeLogDir, { adapterId: "codex", behavior: "ok" });
seedCatalogs(s.store);
await preVerifyCatalogs(s.store);
const engine = new Engine(s.store, s.config);
const repo = await repository(s.root);
writeFileSync(
  join(repo.repo, "verify.cjs"),
  `const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');test('updates content',()=>assert.equal(fs.readFileSync('app.txt','utf8'),'after\\n'));`,
);
await git(repo.repo, ["add", "verify.cjs"]);
await git(repo.repo, ["commit", "-m", "test fixture"]);
repo.baseline = await git(repo.repo, ["rev-parse", "HEAD"]);
const p = project(repo.repo);
p.commands[0]!.args = [
  "--test",
  "--test-reporter=junit",
  "--test-reporter-destination=${DEVFLOW_REPORT_PATH}",
  "verify.cjs",
];
p.commands[0]!.parser = "junit";
await engine.registerProject(p);
const w = engine.create(
  {
    project_id: p.id,
    title: "验证审批与交付闭环",
    request: "将文本更新为 after，保留其他行为。此任务仅用于隔离测试夹具。",
    complexity: "simple",
    workspace_mode: "existing_workspace",
  },
  "fixture",
);
const fixturePlan = plan(objectHash(p), repo.baseline);
fixturePlan.task_model = "leaf-v1";
fixturePlan.modules = [{ id: "M1", title: "文本修复" }];
fixturePlan.tasks[0]!.module_id = "M1";
fixturePlan.tasks[0]!.completion_checks = [
  { path: "app.txt", contains: "after" },
];
fixturePlan.tests[0]!.expected_case_ids = ["test updates content"];
engine.submitPlan(w.id, fixturePlan, w.version, "p1");
const runtime = new LocalRuntime(engine);
const nativeRoot = join(s.root, "native");
mkdirSync(nativeRoot, { recursive: true });
const nativeRepo = await repository(nativeRoot),
  nativeProject = {
    ...project(nativeRepo.repo),
    id: "native",
    name: "原生验收项目",
  };
await engine.registerProject(nativeProject);
s.store.put("tool_profile", "profile-codex", "global", {
  id: "profile-codex",
  revision: 1,
  adapterId: "codex",
  executableRef: process.execPath,
  modelSelection: "explicit",
  modelId: "fixture-only",
  options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
});
const stopped = new Set<string>();
let holdFixtureReviews = false;
const passReview = (flow: Workflow) => ({
  schema_version: 1,
  review_request_id: flow.review_request_id,
  workflow_id: flow.id,
  plan_revision: flow.plan_revision,
  snapshot_id: flow.snapshot_id,
  verdict: "pass" as const,
  coverage: {
    all_changed_files_reviewed: true,
    all_requirements_checked: true,
    upstream_downstream_checked: true,
    security_checked: true,
    tests_validity_checked: true,
    files: ["main:app.txt"],
  },
  findings: [],
  unresolved_questions: [],
  repair_plan: null,
  commit_message: "test: 验证确定性交付闭环",
});
const feedbackExecutions = new Map<string, () => void>();
// Only this test entrypoint injects a deterministic adapter. The production server has no switch for it.
engine.runtime = {
  plan: (flow, run) => runtime.plan(flow, run),
  aside: (flow, run, q) => runtime.aside(flow, run, q),
  async execute(flow: Workflow, run: Run, token: string) {
    if (s.store.get("feedback_fixture", flow.id)) {
      s.store.event(
        flow.id,
        flow.project_id,
        "FixtureExecutionDispatched",
        { purpose: run.purpose },
        run.id,
      );
      await new Promise<void>((done) => feedbackExecutions.set(run.id, done));
      return;
    }
    if (engine.plan(flow.id).plan.task_model === "native-v2")
      return runtime.execute(flow, run, token);
    const principal = engine.auth.verify(token);
    for (let i = 0; i < 10; i++) {
      if (stopped.has(run.id)) return;
      engine.store.event(
        flow.id,
        flow.project_id,
        "FixtureOutput",
        { text: `受控测试执行器步骤 ${i + 1}/10` },
        run.id,
      );
      await new Promise((r) => setTimeout(r, 100));
    }
    startTask(engine, principal, flow.id, "T01");
    const files = engine.files(principal, flow.id, "main", true);
    files.broker.apply(files.root, engine.plan(flow.id).plan.scope, [
      {
        path: "app.txt",
        expected_hash: files.broker.read(files.root, "app.txt").hash,
        content: "after\n",
      },
    ]);
    engine.claimTask(
      principal,
      flow.id,
      "T01",
      "测试夹具完成文本修改，真实 Node 测试验证结果",
    );
    await engine.freeze(flow.id, principal);
    await runtime.check(engine.get(flow.id), "UT01", principal);
  },
  async resolveMergeConflict(
    flow: Workflow,
    run: Run,
    request: MergeConflictRequest,
  ) {
    return runtime.resolveMergeConflict(flow, run, request);
  },
  async review(flow: Workflow, run: Run) {
    if (s.store.get("feedback_fixture", flow.id))
      throw new Error("功能反馈不应重新派发审查");
    if (engine.plan(flow.id).plan.task_model === "native-v2")
      return runtime.review(flow, run);
    while (holdFixtureReviews && !stopped.has(run.id)) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return passReview(flow);
  },
  async stop(run: string) {
    stopped.add(run);
    feedbackExecutions.get(run)?.();
    feedbackExecutions.delete(run);
    await runtime.stop(run);
  },
  check: (flow, test, principal) => runtime.check(flow, test, principal),
  close: () => runtime.close(),
} satisfies Runtime;
Object.assign(engine.runtime, {
  browser: { reconcile: async () => undefined },
  environments: { stop: async () => undefined },
});
const shutdownToken = crypto.randomUUID();
atomicWrite(
  resolve(".cache/e2e-state.json"),
  JSON.stringify({
    shutdownToken,
    workflow_id: w.id,
    root: s.root,
    repo: repo.repo,
    nativeRepo: nativeRepo.repo,
    probeCli: PROBE_CLI,
    probeLogDir,
  }),
);
// Account routes share this full server, but must never reach the host's
// credential helper or AGY client from a model-configuration browser test.
const accountEnvironment = accountFixture(engine.store);
accountEnvironment.repository.saveSettings(
  AgyAccountSettingsSchema.parse({
    ...engine.config.agy_accounts,
    realm_id: "default-agy-realm",
    revision: 1,
    updated_at: now(),
  }),
);
if (
  engine.config.agy_accounts.enabled ||
  accountEnvironment.service.isManaged()
)
  throw new Error("Model E2E fixture must keep account management disabled");
const app = await buildServer(engine, {
  webRoot: process.env.DEVFLOW_E2E_WEB_ROOT,
  accountService: accountEnvironment.service,
});
app.addHook("onClose", () => accountEnvironment.service.close());
let holdFixtureDispatch = false;
const dispatchTimer = setInterval(() => {
  if (!holdFixtureDispatch) void engine.dispatch();
}, 1000);
dispatchTimer.unref();
function assertFixtureToken(request: { body?: unknown }) {
  return (
    (request.body as { token?: string } | undefined)?.token === shutdownToken
  );
}
app.post("/__fixture/source-change", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  return seedSourceChange(engine, s.root);
});
app.post("/__fixture/probe-count", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  return { count: probeCount(probeLogDir) };
});
app.post("/__fixture/probe-control", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  const body = (request.body || {}) as Record<string, unknown>;
  writeProbeControl(probeLogDir, {
    behavior: typeof body.behavior === "string" ? body.behavior : "ok",
    adapterId: typeof body.adapterId === "string" ? body.adapterId : "codex",
    delayMs: typeof body.delayMs === "number" ? body.delayMs : 0,
    catalogStdout:
      body.catalog === true
        ? readFileSync(
            resolve("tests/fixtures/model-catalog/agy/models-success.txt"),
            "utf8",
          )
        : "",
  });
  return { ok: true };
});
app.post("/__fixture/restore-access", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  const records = engine.store.list<{
    key: string;
    adapterId: string;
    status: string;
    last_success_at?: string;
    error_code?: string;
  }>("model_access");
  for (const record of records) {
    if (record.status !== "login_required" || !record.last_success_at) continue;
    const next = { ...record, status: "verified" };
    delete next.error_code;
    engine.store.put("model_access", record.key, record.adapterId, next);
  }
  return { ok: true };
});
app.post("/__fixture/review-hold", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  holdFixtureReviews = (request.body as { hold?: boolean }).hold === true;
  return { ok: true, hold: holdFixtureReviews };
});
const LIVE_REVIEW_STATES = new Set([
  "REVIEWING",
  "REVIEW_QUEUED",
  "EXECUTING",
  "VERIFYING",
  "QUEUED",
  "PLANNING",
  "STOPPING",
]);
function fixtureReviewerProfile(): ToolProfile {
  return {
    id: "reviewer",
    revision: 1,
    adapterId: "codex",
    modelSelection: "explicit",
    modelId: "gpt-6-astra",
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  };
}
function ensureFixturePlanApproved(flow: Workflow) {
  if (!flow.plan_hash) return;
  engine.store.put("approval", `${flow.id}-${flow.plan_revision}`, flow.id, {
    plan_hash: flow.plan_hash,
    revision: flow.plan_revision,
    proof: "fixture",
    approved_at: now(),
  });
}
async function stopLiveFixtureRun() {
  const current = engine.get(w.id);
  try {
    if (LIVE_REVIEW_STATES.has(current.state) || current.state === "BLOCKED") {
      await engine.stop(w.id);
    }
    await engine.waitForIdle(w.id);
  } catch {
    if (current.run_id) stopped.add(current.run_id);
  }
}

function drainFixtureDispatch() {
  const latest = engine.get(w.id);
  ensureFixturePlanApproved(latest);
  engine.store.remove("queue", latest.id);
  engine.store.remove("functional_fix_intent", latest.id);
  for (const job of engine.store.jobs()) {
    if (job.workflow_id === latest.id) {
      engine.store.jobStatus(job.id, "delivered");
    }
  }
}

function putFixtureHumanPending(stage = "functional_retest") {
  drainFixtureDispatch();
  const latest = engine.get(w.id);
  engine.store.put("workflow", w.id, latest.project_id, {
    ...latest,
    state: "HUMAN_PENDING",
    stage,
    run_id: undefined,
    version: latest.version + 1,
    updated_at: now(),
  });
}
function putFixtureReviewing(phase: "before_human" | "after_human") {
  const latest = engine.get(w.id);
  ensureFixturePlanApproved(latest);
  const stage = phase === "before_human" ? "quality_before_human" : "review";
  const runId = `run-review-${phase}`;
  engine.store.put("plan_check_review_intent", w.id, w.id, { phase });
  engine.store.remove("interruption", w.id);
  engine.store.remove("queue", w.id);
  engine.store.put("run", runId, w.id, {
    id: runId,
    workflow_id: w.id,
    plan_revision: latest.plan_revision,
    adapter: "codex",
    purpose: "quality_review",
    routing_role: "reviewer",
    execution_spec_id: "spec-fixture-review",
    execution_spec_revision: 1,
    profile: fixtureReviewerProfile(),
    runtime_flavor: "profile-native",
    protocol: "lightweight",
    stage,
    status: "running",
    started_at: now(),
    deadline_at: Date.now() + 600000,
    package_hash: "fixture-review",
  } satisfies Run);
  engine.store.put("workflow", w.id, latest.project_id, {
    ...latest,
    state: "REVIEWING",
    stage,
    run_id: runId,
    review_request_id: latest.review_request_id ?? "rev-fixture",
    version: latest.version + 1,
    updated_at: now(),
  });
}
app.post("/__fixture/enter-review", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  const phase =
    (request.body as { phase?: string }).phase === "after_human"
      ? "after_human"
      : "before_human";
  holdFixtureReviews = true;
  await stopLiveFixtureRun();
  putFixtureReviewing(phase);
  const flow = engine.get(w.id);
  return {
    ok: true,
    phase,
    state: flow.state,
    stage: flow.stage,
    run_id: flow.run_id,
  };
});
app.post("/__fixture/seed-history-run", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  const runId = "run-history-u14";
  engine.store.put("run", runId, w.id, {
    id: runId,
    workflow_id: w.id,
    plan_revision: w.plan_revision,
    adapter: "codex",
    purpose: "quality_review",
    routing_role: "reviewer",
    execution_spec_revision: 1,
    profile: {
      id: "reviewer",
      revision: 1,
      adapterId: "codex",
      modelSelection: "explicit",
      modelId: "historical-bound-model",
      reasoning: { mode: "explicit", value: "xhigh" },
      selectionKind: "fixed",
      options: {},
    },
    stage: "quality_before_human",
    status: "completed",
    started_at: now(),
    ended_at: now(),
    deadline_at: Date.now(),
    package_hash: "fixture-history",
  } satisfies Run);
  return { ok: true, run_id: runId };
});

function fixtureProfile(
  id: string,
  adapterId: SupportedAdapterId,
  modelId: string,
  effort: string,
): ToolProfile {
  return {
    id,
    revision: 1,
    adapterId,
    modelSelection: "explicit",
    modelId,
    reasoning: { mode: "explicit", value: effort },
    selectionKind: "fixed",
    options: {},
  };
}

function fixtureRepairServices() {
  const specs = new ExecutionSpecService(engine.store, engine.config);
  const repairs = new RepairModelService(engine.store, specs);
  return { specs, repairs };
}

function ensureFixtureSpec() {
  const { specs } = fixtureRepairServices();
  const view = specs.readView(w.id);
  const current = view.persisted ? view.spec.revision : 0;
  return specs.updateExecutionSpec({
    request_id: crypto.randomUUID(),
    expected_spec_revision: current,
    workflow_id: w.id,
    planner_profile: view.spec.plannerProfile,
    executor_profile: view.spec.executorProfile,
    role_overrides: view.spec.roleOverrides ?? inheritRoleOverrides(),
    accessVerified: true,
  });
}

app.post("/__fixture/seed-retest", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  holdFixtureDispatch = true;
  holdFixtureReviews = true;
  try {
    await stopLiveFixtureRun();
    ensureFixtureSpec();
    putFixtureHumanPending();
    const deliveryId = "del-retest";
    engine.store.put("delivery_revision", deliveryId, w.id, {
      id: deliveryId,
      workflow_id: w.id,
      invalidated: false,
    });
    const { specs, repairs } = fixtureRepairServices();
    const issues = new FunctionalIssueService(engine.store);
    const stamp = Date.now();
    const firstDesc = "筛选无效-" + stamp;
    const secondDesc = "另一问题-" + stamp;
    const created = repairs.submitFunctionalRepair({
      workflow_id: w.id,
      request_id: crypto.randomUUID(),
      descriptions: [{ description: firstDesc }, { description: secondDesc }],
      selection: {
        mode: "custom",
        profile: fixtureProfile(
          "functional_fixer",
          "codex",
          "gpt-6-astra",
          "xhigh",
        ),
      },
      expected_spec_revision: specs.readView(w.id).spec.revision,
    });
    for (const issueId of created.issue_ids) {
      issues.markFixing(w.id, issueId);
      issues.markReadyForRetest(w.id, issueId, deliveryId);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    await engine.waitForIdle(w.id).catch(() => undefined);
    putFixtureHumanPending();
    return {
      ok: true,
      workflow_id: w.id,
      issue_ids: created.issue_ids,
      batch_id: created.batch.id,
      assignment_revision: created.assignment?.revision ?? 0,
      spec_revision: specs.readView(w.id).spec.revision,
      first_description: firstDesc,
      second_description: secondDesc,
      state: engine.get(w.id).state,
    };
  } finally {
    holdFixtureDispatch = false;
  }
});

app.post("/__fixture/bump-repair-assignment", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  const body = (request.body || {}) as Record<string, unknown>;
  const batchId = zString(body.batch_id);
  const expected = Number(body.expected_assignment_revision ?? 0);
  const { specs, repairs } = fixtureRepairServices();
  const receipt = repairs.assign({
    workflow_id: w.id,
    request_id: crypto.randomUUID(),
    batch_id: batchId,
    expected_assignment_revision: expected,
    expected_spec_revision: specs.readView(w.id).spec.revision,
    selection: { mode: "planner" },
  });
  return { ok: true, entity_revision: receipt.entity_revision };
});

app.post("/__fixture/seed-repair-batches", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  holdFixtureDispatch = true;
  holdFixtureReviews = true;
  try {
    await stopLiveFixtureRun();
    drainFixtureDispatch();
    ensureFixtureSpec();
    const latest = engine.get(w.id);
    const qualityOpen = ensureQualityRepairBatch(
      engine.store,
      w.id,
      "before_human",
      "rev-quality-open",
    );
    const qualityCovered = ensureQualityRepairBatch(
      engine.store,
      w.id,
      "after_human",
      "rev-quality-covered",
    );
    const { specs, repairs } = fixtureRepairServices();
    const coveredRevision = currentAssignmentRevision(
      engine.store,
      w.id,
      qualityCovered.id,
    );
    repairs.assign({
      workflow_id: w.id,
      request_id: crypto.randomUUID(),
      batch_id: qualityCovered.id,
      expected_assignment_revision: coveredRevision,
      expected_spec_revision: specs.readView(w.id).spec.revision,
      selection: {
        mode: "custom",
        profile: fixtureProfile("review_fixer", "codex", "gpt-6-astra", "high"),
      },
    });
    const functional = repairs.submitFunctionalRepair({
      workflow_id: w.id,
      request_id: crypto.randomUUID(),
      descriptions: [{ description: "开放功能批次" }],
      selection: {
        mode: "custom",
        profile: fixtureProfile(
          "functional_fixer",
          "codex",
          "gpt-5.6-sol",
          "high",
        ),
      },
      expected_spec_revision: specs.readView(w.id).spec.revision,
    });
    const runId = "run-active-repair";
    engine.store.put("run", runId, w.id, {
      id: runId,
      workflow_id: w.id,
      plan_revision: latest.plan_revision,
      adapter: "codex",
      purpose: "functional_fix",
      routing_role: "functional_fixer",
      execution_spec_revision: specs.readView(w.id).spec.revision,
      profile: fixtureProfile(
        "functional_fixer",
        "codex",
        "gpt-5.6-sol",
        "high",
      ),
      repair_batch_id: functional.batch.id,
      assignment_id: functional.assignment?.id,
      stage: "functional_fix",
      status: "running",
      started_at: now(),
      deadline_at: Date.now() + 600000,
      package_hash: "fixture-active-repair",
    } satisfies Run);
    engine.store.put("workflow", w.id, latest.project_id, {
      ...latest,
      state: "EXECUTING",
      stage: "functional_fix",
      run_id: runId,
      version: latest.version + 1,
      updated_at: now(),
    });
    engine.store.remove("queue", w.id);
    for (const job of engine.store.jobs()) {
      if (job.workflow_id === w.id) {
        engine.store.jobStatus(job.id, "delivered");
      }
    }
    return {
      ok: true,
      quality_open_id: qualityOpen.id,
      quality_covered_id: qualityCovered.id,
      functional_batch_id: functional.batch.id,
      run_id: runId,
      run_model: "gpt-5.6-sol",
    };
  } finally {
    holdFixtureDispatch = false;
  }
});

function currentAssignmentRevision(
  store: ReturnType<typeof setup>["store"],
  workflowId: string,
  batchId: string,
): number {
  const matched = store
    .list<{
      batch_id: string;
      status: string;
      revision: number;
    }>("repair_model_assignment", workflowId)
    .filter(
      (item) =>
        item.batch_id === batchId &&
        (item.status === "pending" || item.status === "active"),
    );
  matched.sort((a, b) => b.revision - a.revision);
  return matched[0]?.revision ?? 0;
}

function zString(value: unknown): string {
  if (typeof value !== "string" || !value) {
    throw new Error("缺少 batch_id");
  }
  return value;
}

app.post("/__fixture/attachments", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  const suffix = crypto.randomUUID();
  const isolated = await repository(s.root, "attachments-" + suffix);
  const attachmentProject = {
    ...project(isolated.repo),
    id: "attachments-" + suffix,
    name: "附件异步归档回归",
  };
  await engine.registerProject(attachmentProject);
  const flow = engine.create(
    {
      project_id: attachmentProject.id,
      title: "附件异步状态刷新",
      request: "展示附件状态",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "attachments-" + suffix,
  );
  const attachmentPlan = plan(objectHash(attachmentProject), isolated.baseline);
  attachmentPlan.task_model = "native-v2";
  engine.submitPlan(flow.id, attachmentPlan, flow.version, "attachment-plan");
  engine.transition(
    flow.id,
    [engine.get(flow.id).state],
    "HUMAN_PENDING",
    "manual_acceptance",
  );
  s.store.put("workspace", "ws-" + flow.id, flow.id, {
    id: "ws-" + flow.id,
    workflow_id: flow.id,
    repo_id: "main",
    root: isolated.repo,
    common_dir: join(isolated.repo, ".git"),
    branch: "task/fixture",
    baseline: isolated.baseline,
    owned: false,
  });
  mkdirSync(join(isolated.repo, ".reports"), { recursive: true });
  writeFileSync(
    join(isolated.repo, ".reports", "async.json"),
    '{"owner":"' + flow.id + '"}',
  );
  const deliveryId = "attachment-del-" + suffix;
  const manifest = {
    artifacts: [
      ".reports/async.json",
      ".reports/missing.json",
      { path: { bad: true } },
    ],
  };
  s.store.put("delivery", deliveryId, flow.id, {
    id: deliveryId,
    workflow_id: flow.id,
    run_id: "attachment-run-" + suffix,
    plan_revision: 1,
    plan_hash: engine.get(flow.id).plan_hash,
    status: "passed",
    submitted_at: new Date().toISOString(),
    manifest,
    attachment_status: [
      {
        delivery_id: deliveryId,
        repo_id: "main",
        path: { bad: true },
        state: "pending",
      },
    ],
  });
  for (const path of [".reports/async.json", ".reports/missing.json"])
    s.store.put(
      "attachment_archive",
      attachmentArchiveKey(deliveryId, "main", path),
      flow.id,
      { delivery_id: deliveryId, repo_id: "main", path, state: "pending" },
    );
  return { workflow_id: flow.id, delivery_id: deliveryId };
});
app.post("/__fixture/attachments/drain", async (request, reply) => {
  const input = request.body as {
    token?: string;
    workflow_id: string;
    delivery_id: string;
  };
  if (input.token !== shutdownToken) return reply.code(403).send({ ok: false });
  const delivery = s.store.get<any>("delivery", input.delivery_id);
  if (!delivery || delivery.workflow_id !== input.workflow_id)
    return reply.code(404).send({ ok: false });
  createArchiveJobFromManifest(s.store, {
    deliveryId: delivery.id,
    workflowId: delivery.workflow_id,
    runId: delivery.run_id,
    manifest: delivery.manifest,
  });
  void drainArchiveOutbox(s.store, { storageRoot: s.config.storage_root });
  return { ok: true };
});
app.post("/__fixture/feedback", async (request, reply) => {
  if ((request.body as { token?: string })?.token !== shutdownToken)
    return reply.code(403).send({ ok: false });
  const suffix = crypto.randomUUID();
  const isolated = await repository(s.root, "feedback-" + suffix);
  const feedbackProject = {
    ...project(isolated.repo),
    id: "feedback-" + suffix,
    name: "人工反馈回归",
  };
  await engine.registerProject(feedbackProject);
  const flow = engine.create(
    {
      project_id: feedbackProject.id,
      title: "完成审查后反馈功能问题",
      request: "根据人工反馈修复功能",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "feedback-" + suffix,
  );
  const approvedPlan = plan(objectHash(feedbackProject), isolated.baseline);
  approvedPlan.task_model = "native-v2";
  engine.submitPlan(flow.id, approvedPlan, flow.version, "feedback-plan");
  const current = engine.get(flow.id);
  s.store.put("approval", flow.id + "-1", flow.id, {
    plan_hash: current.plan_hash,
    revision: 1,
    approved_at: new Date().toISOString(),
  });
  const reviewId = "completed-review-" + suffix;
  s.store.put("run", reviewId, flow.id, {
    id: reviewId,
    workflow_id: flow.id,
    plan_revision: 1,
    adapter: "codex",
    protocol: "lightweight",
    purpose: "quality_review",
    stage: "quality_before_human",
    status: "completed",
    exit_code: 0,
    started_at: new Date().toISOString(),
    ended_at: new Date().toISOString(),
    package_hash: "fixture",
  });
  s.store.put("plan_check_review_intent", flow.id, flow.id, {
    phase: "before_human",
    review_run_id: reviewId,
  });
  s.store.put("feedback_fixture", flow.id, flow.id, {
    seeded_review_run_id: reviewId,
  });
  engine.transition(
    flow.id,
    [current.state],
    "HUMAN_PENDING",
    "manual_acceptance",
    { run_id: reviewId },
  );
  return { workflow_id: flow.id, review_run_id: reviewId };
});
app.post("/__fixture/feedback/stop", async (request, reply) => {
  const input = request.body as { token?: string; workflow_id: string };
  if (input.token !== shutdownToken) return reply.code(403).send({ ok: false });
  if (!s.store.get("feedback_fixture", input.workflow_id))
    return reply.code(404).send({ ok: false });
  await engine.stop(input.workflow_id, "local_console");
  return { ok: true };
});
app.post("/__fixture/shutdown", async (request, reply) => {
  if (!assertFixtureToken(request)) return reply.code(403).send({ ok: false });
  setTimeout(
    () =>
      void (async () => {
        for (const socket of app.websocketServer.clients) socket.terminate();
        await engine.runtime!.close();
        await app.close();
        s.store.close();
        process.exit(0);
      })(),
    100,
  );
  return { ok: true };
});
await app.listen({ host: "127.0.0.1", port: e2ePort });
console.log(`Fixture listening on ${e2ePort}`);
process.once(
  "SIGTERM",
  () =>
    void (async () => {
      await engine.runtime!.close();
      await app.close();
      s.store.close();
    })(),
);
