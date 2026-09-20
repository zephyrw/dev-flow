import {
  PlanSelfCheckCoordinator,
  BEFORE_HUMAN_REVIEW_STAGE,
} from "./plan-self-check.js";
import { bindProfile, buildDispatchContext, isLegacyProtocol } from "./run-profile.js";
import { bindRepairAssignment, closeOpenRepairBatches } from "./repair-model-service.js";
import { QualityCoordinator } from "./quality-coordinator.js";
import { DocumentService } from "./document-service.js";
import {
  AsideSessionService,
  ASIDE_TIMEOUT_MS,
} from "../../asides/src/service.js";
import { FunctionalIssueService } from "./functional-issues.js";
import { workflowAttention } from "./attention.js";
import { assertSelectedSource } from "./source-change.js";
import { scheduleModelRetry, stageModelRunRetry } from "./model-retry.js";
import { currentRunObservation } from "./run-observation.js";
import { repairFailure, prepareRepairResume } from "./repair.js";
import { normalizeRuntimeFailure } from "../../runtime/src/errors.js";
import { ModelAccessService } from "./model-access-service.js";
import { runtimeFailureResolution } from "../../contracts/src/runtime-failure.js";
import {
  latestEvidence,
  currentEvidence,
  progressEvidence,
  testProgress,
  taskProofValid,
  recordTaskProof,
  invalidateTaskProofs,
} from "./progress.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ProjectSchema,
  normalizeOptionalDeliveryManifest,
  ReviewSchema,
  requireCondition,
  FlowError,
  type Workflow,
  type State,
  type Plan,
  type Project,
  type Run,
  type Snapshot,
  type Evidence,
  type Review,
  type Workspace,
  type DeliveryManifest,
  type Delivery,
  type DeliveryIssue,
  type AcceptanceResult,
  type DeliveryRevision,
  type TestExecution,
  type MergeConflictRequest,
  type MergeConflictReceipt,
  type QualityPhase,
  resolveTaskModel,
  type RunContinuation,
} from "../../contracts/src/index.js";
import type { Config } from "../../contracts/src/config.js";
import { Store } from "../../store/src/store.js";
import { Auth, type Principal } from "./auth.js";
import { atomicWrite, id, now, objectHash, hash } from "./util.js";
import { parsePlanDiagrams } from "../../plans/src/diagrams.js";
import { validatePlan } from "../../plans/src/validate.js";
import { GitDeliveryCoordinator } from "../../git/src/delivery-coordinator.js";
import { GitManager, repositoryInfo, git } from "../../git/src/git.js";
import { Scheduler } from "../../scheduler/src/scheduler.js";
import { FileBroker } from "../../workspace/src/files.js";
import {
  type HostToolExecutionFact,
  NativeRunRecordReader,
} from "../../evidence/src/native-run-records.js";
import {
  createArchiveJobFromManifest,
  drainArchiveOutbox,
  uniqueAttachments,
} from "../../evidence/src/archive-consumer.js";
import {
  normalizeDeliveredRound,
  normalizeReviewIntent,
} from "./round-intent.js";
import {
  boundRunContinuation,
  clearRunContinuation,
  clearWaitingContext,
  continuationFromHandoff,
  continuationFromWaiting,
  isCurrentPlanningSource,
  isOpenPlanningHandoff,
  isPlanningWaiting,
  isReviewRole,
  isSubsequentExecuteRun,
  readExecutionCompletion,
  readPlanningHandoff,
  readRunContinuation,
  readWaitingContext,
  recordExecutionCompletion,
  savePlanningHandoff,
  saveRunContinuation,
  saveWaitingContext,
  type WaitingContext,
} from "./waiting-context.js";
import type {
  QualityRepairAssignment,
  QualityTransfer,
} from "../../contracts/src/quality.js";

export interface PlanRecord {
  id: string;
  workflow_id: string;
  revision: number;
  hash: string;
  plan: Plan;
  created_at: string;
}

export type RoundResult = {
  status: string;
  summary?: string;
  message?: string;
  delivery_id?: string;
  issues?: { code: string; message: string }[];
  state?: string;
  acceptance_results?: AcceptanceResult[];
};

type ReviewPointer = {
  phase?: string;
  implementation_run_id?: string;
  completion_run_id?: string;
  review_run_id?: string;
  source_run_id?: string;
};

function reportedFunctionImpact(value: unknown) {
  return value === "changed" || value === "uncertain" ? value : undefined;
}

function textQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is string => typeof item === "string" && !!item.trim(),
  );
}

function formatDeliveryRejection(
  issues: { code: string; message: string }[],
  facts: HostToolExecutionFact[],
) {
  const base = `交付材料未能接收，共 ${issues.length} 项说明，规划模型将依据代码审查判断。`;
  const identity = issues.some((issue) =>
    ["HOST_IDENTITY_MISMATCH", "HOST_TIME_MISSING"].includes(issue.code),
  );
  if (!identity) return base;
  if (!facts.length)
    return (
      base +
      " 当前轮次没有可用的宿主执行记录。请使用命令对应的 step-N 或 task-N 作为 tool_call_id 重新提交；不要把已完成测试当作失败而再次启动全量套件。"
    );
  const ids = facts
    .map((fact) => {
      const aliases = (fact.aliases ?? []).filter(
        (alias) => alias !== fact.tool_call_id,
      );
      return aliases.length
        ? `${fact.tool_call_id}（别名 ${aliases.join("、")}）`
        : fact.tool_call_id;
    })
    .join("；");
  return (
    base +
    ` 不要重跑已完成测试。请使用本轮宿主执行 ID 重新提交交付：${ids}。`
  );
}
export interface Runtime {
  plan?(
    workflow: Workflow,
    run: Run,
  ): Promise<{ plan: unknown; markdown: string }>;
  aside?(
    workflow: Workflow,
    run: Run,
    question: { question: string; refs: unknown[] },
  ): Promise<string>;
  validateEnvironment?(workflow: Workflow): Promise<void>;
  operation?(
    workflow: Workflow,
    requestId: string,
    principal: Principal,
  ): Promise<unknown>;
  diagnose?(
    workflow: Workflow,
    error: string,
  ): Promise<{
    diagnosis: string;
    instructions: string;
    requires_plan_change: boolean;
    repair_plan?: unknown;
  }>;
  prepareVerification?(workflow: Workflow, principal: Principal): Promise<void>;
  resolveMergeConflict?(
    workflow: Workflow,
    run: Run,
    request: MergeConflictRequest,
  ): Promise<MergeConflictReceipt>;
  execute(workflow: Workflow, run: Run, token: string): Promise<void>;
  review(workflow: Workflow, run: Run): Promise<unknown>;
  stop(run: string): Promise<void>;
  check(
    workflow: Workflow,
    testId: string,
    principal: Principal,
  ): Promise<Evidence>;
  close(): Promise<void>;
}
export class Engine {
  auth: Auth;
  git: GitManager;
  scheduler: Scheduler;
  planSelfCheck: PlanSelfCheckCoordinator;
  get quality() {
    return new QualityCoordinator(this.store);
  }
  runtime?: Runtime;
  private busy = new Set<string>();
  private dispatching = false;
  private running = new Set<string>();
  private mergeRuns = new Map<string, Promise<void>>();
  private networkRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private clearNetworkRetryTimer(key: string) {
    clearTimeout(this.networkRetryTimers.get(key));
    this.networkRetryTimers.delete(key);
  }
  async waitForIdle(key: string) {
    const deadline = Date.now() + 30000;
    while (this.running.has(key) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 25));
    requireCondition(
      !this.running.has(key),
      "RUN_STILL_STOPPING",
      "旧执行轮次尚未退出，保留输入后请稍后继续",
    );
  }
  constructor(
    public store: Store,
    public config: Config,
  ) {
    this.auth = new Auth(store, config.server.human_origin);
    this.git = new GitManager(
      store,
      config.workspace_root,
      config.storage_root,
    );
    this.scheduler = new Scheduler(store);
    this.planSelfCheck = new PlanSelfCheckCoordinator(store);
  }
  list() {
    return this.store.list<Workflow>("workflow").reverse();
  }
  get(key: string) {
    return this.store.must<Workflow>("workflow", key);
  }
  project(key: string) {
    return this.store.must<Project>("project", key);
  }
  plan(key: string) {
    const w = this.get(key);
    return this.store.must<PlanRecord>("plan", `${key}-${w.plan_revision}`);
  }
  summary(key: string) {
    const w = this.get(key);
    const plan = w.plan_revision ? this.plan(key) : null;
    const tasks = this.taskStatus(key, false);
    return {
      workflow: w,
      runtime: currentRunObservation(this.store, w),
      human_accepted: this.displayHumanAccepted(key),
      attention: workflowAttention(this, key),
      loading: true,
      plan: plan
        ? {
            ...plan,
            plan: {
              task_model: plan.plan.task_model,
              tasks: [],
              tests: [],
              modules: [],
              markdown: "",
            },
          }
        : null,
      tasks: [],
      task_counts: {
        total: tasks.length,
        developed: tasks.filter((t) => t.development_status === "completed")
          .length,
        verified: tasks.filter((t) => t.status === "verified").length,
        submitted: tasks.filter((t) => t.has_implementation).length,
      },
      test_progress: testProgress(
        plan?.plan ?? null,
        [
          ...(w.plan_revision ? this.displayEvidence(key) : []),
          ...(plan?.plan.task_model === "native-v2"
            ? []
            : this.store.list<Evidence>("development_evidence", key)),
        ],
        w,
      ),
      workspaces: this.store.list("workspace", key),
      environment: this.store.get("environment", key),
      project: this.project(w.project_id),
      context: this.store.get("entry_context", key),
      events: this.store
        .recentEvents(key, 30)
        .map((e) => this.store.publicEvent(e)),
      event_cursor: this.store.eventCursor(key),
      runs: [],
      evidence: [],
      commits: [],
      operations: this.store.list("operation_request", key),
      repair: this.store.get("repair_state", key),
      queue: this.store.get("queue_wait", key),
      active_task: this.store.get("task_activity", key),
    };
  }
  detail(key: string, verifyFiles = true) {
    const w = this.get(key);
    return {
      workflow: w,
      runtime: currentRunObservation(this.store, w),
      human_accepted: this.displayHumanAccepted(key),
      attention: workflowAttention(this, key),
      executor_plan_check: this.planSelfCheck.current(key) ?? null,
      plan: w.plan_revision
        ? (() => {
            const p = this.plan(key);
            const body =
              p.plan.markdown ??
              this.store
                .list<any>("project_document", key)
                .find((d) => d.hash === p.plan.design_ref?.content_hash)
                ?.content ??
              "";
            return { ...p, plan: { ...p.plan, markdown: body } };
          })()
        : null,
      workspaces: this.store.list<Workspace>("workspace", key),
      runs: this.store.list<Run>("run", key),
      evidence: w.plan_revision ? this.displayEvidence(key) : [],
      tasks: this.taskStatus(key, verifyFiles),
      test_progress: testProgress(
        w.plan_revision ? this.plan(key).plan : null,
        [
          ...(w.plan_revision ? this.displayEvidence(key) : []),
          ...(w.plan_revision && this.plan(key).plan.task_model === "native-v2"
            ? []
            : this.store.list<Evidence>("development_evidence", key)),
        ],
        w,
      ),
      active_task:
        this.store.get<any>("task_activity", key)?.run_id === w.run_id &&
        this.store.get<any>("task_activity", key)?.plan_revision ===
          w.plan_revision
          ? this.store.get("task_activity", key)
          : null,
      events: (() => {
        const rows = this.store.db
          .prepare(
            "SELECT data FROM events WHERE workflow_id=? AND json_extract(data, '$.type') NOT IN ('ServiceOutput','FixtureOutput','CheckOutput','BuildOutput','AgentEvent','NativeActivity','RunObserved') ORDER BY seq DESC LIMIT 500",
          )
          .all(key)
          .map((row: any) => JSON.parse(row.data))
          .concat(this.store.recentEvents(key, 500));
        const seen = new Set<number>();
        const deduped: any[] = [];
        for (const e of rows) {
          if (!seen.has(e.event_seq)) {
            seen.add(e.event_seq);
            deduped.push(e);
          }
        }
        return deduped.sort((a: any, b: any) => a.event_seq - b.event_seq);
      })(),
      environment: this.store.get("environment", key),
      review: this.store.get("review", w.review_request_id ?? ""),
      commits: this.store.list("commit_result", key),
      project: this.project(w.project_id),
      context: this.store.get("entry_context", key),
      operations: this.store.list("operation_request", key),
      repair: this.store.get("repair_state", key),
      queue:
        this.store.get("resource_wait", key) ??
        this.store.get("queue_wait", key),
      development_evidence: this.store.list("development_evidence", key),
      event_cursor: this.store.eventCursor(key),
      history_cursor: Math.max(1, this.store.eventCursor(key) - 499),
    };
  }
  async registerProject(input: unknown) {
    const p = ProjectSchema.parse(input);
    const assertUnused = () =>
      requireCondition(
        !this.store
          .list<Workflow>("workflow")
          .some(
            (w) =>
              w.project_id === p.id &&
              !["COMMITTED", "COMPLETED", "STOPPED", "RESEARCHING"].includes(
                w.state,
              ),
          ),
        "PROJECT_IN_USE",
        "活动工作流期间不能修改项目配置",
      );
    assertUnused();
    for (const repo of p.repositories) {
      const info = await repositoryInfo(repo.path);
      repo.path = info.path;
    }
    for (const s of p.services)
      requireCondition(
        p.repositories.some((r) => r.id === s.repo_id) &&
          p.commands.some(
            (c) => c.id === s.command_id && c.lifecycle === "service",
          ),
        "SERVICE_COMMAND_INVALID",
        "服务引用无效",
      );
    if (p.services.some((s) => s.port_pool === "backend"))
      for (const service of p.services.filter(
        (s) => s.port_pool === "frontend",
      ))
        requireCondition(
          service.backend_probe_path,
          "UPSTREAM_PROBE_REQUIRED",
          "前后端项目必须声明从前端访问后端的检查路径",
        );
    for (const command of p.commands) {
      if (p.repositories.length > 1)
        requireCondition(
          command.repo_id &&
            p.repositories.some((r) => r.id === command.repo_id),
          "COMMAND_REPOSITORY_REQUIRED",
          "多仓检查必须指定 repo_id",
        );
    }
    if (p.data.fixture_command_id)
      requireCondition(
        p.commands.some(
          (c) =>
            c.id === p.data.fixture_command_id && c.lifecycle === "fixture",
        ),
        "FIXTURE_COMMAND_INVALID",
        "数据初始化必须引用登记的 fixture 命令",
      );
    if (p.data.mode === "external_lock")
      requireCondition(
        p.data.resource_id,
        "DATA_RESOURCE_REQUIRED",
        "共享数据需要明确的全局资源 ID",
      );
    requireCondition(
      new Set(p.commands.map((c) => c.id)).size === p.commands.length,
      "DUPLICATE_COMMAND",
      "命令 ID 重复",
    );
    assertUnused();
    this.store.put("project", p.id, p.id, p);
    return { project: p, config_hash: objectHash(p) };
  }
  create(
    input: {
      project_id: string;
      title: string;
      request: string;
      complexity: "simple" | "complex";
      workspace_mode: "existing_workspace" | "new_worktree";
    },
    key: string,
  ) {
    this.project(input.project_id);
    return this.store.deduplicate("create:" + key, input, () => {
      const w: Workflow = {
        ...input,
        id: id("wf"),
        state: "RESEARCHING",
        stage: "research",
        version: 1,
        plan_revision: 0,
        environment_revision: 0,
        created_at: now(),
        updated_at: now(),
        feedback: [],
      };
      this.store.put("workflow", w.id, w.project_id, w);
      this.store.event(w.id, w.project_id, "WorkflowCreated", {
        title: w.title,
      });
      return w;
    });
  }
  transition(
    key: string,
    allowed: State[],
    state: State,
    stage: string,
    patch: Partial<Workflow> = {},
  ) {
    return this.store.transaction(() => {
      const w = this.get(key);
      requireCondition(
        allowed.includes(w.state),
        "INVALID_STATE",
        `${w.state} 不能进入 ${state}`,
      );
      const next = {
        ...w,
        ...patch,
        state,
        stage,
        version: w.version + 1,
        updated_at: now(),
      };
      this.store.put("workflow", key, w.project_id, next);
      if (state === "COMMITTED" || state === "COMPLETED") {
        closeOpenRepairBatches(this.store, key);
      }
      this.store.event(key, w.project_id, "StateChanged", {
        from: w.state,
        to: state,
        stage,
        ...(patch.blocker
          ? {
              blocker: {
                code: patch.blocker.code,
                message: patch.blocker.message,
              },
            }
          : {}),
      });
      return next;
    });
  }
  async submitValidatedPlan(
    key: string,
    input: unknown,
    expectedVersion: number,
    idempotency: string,
  ) {
    await parsePlanDiagrams(input);
    return this.submitPlan(key, input, expectedVersion, idempotency);
  }
  submitPlan(
    key: string,
    input: unknown,
    expectedVersion: number,
    idempotency: string,
  ) {
    return this.store.deduplicate(
      "plan:" + key + ":" + idempotency,
      input,
      () => {
        const w = this.get(key);
        requireCondition(
          w.version === expectedVersion,
          "VERSION_CONFLICT",
          "工作流版本已变化",
        );
        requireCondition(
          [
            "RESEARCHING",
            "PLANNING",
            "PLAN_PENDING",
            "REPAIR_PLAN_PENDING",
            "REPAIR_RESEARCH_REQUIRED",
            "STOPPED",
            "BLOCKED",
          ].includes(w.state),
          "INVALID_STATE",
          "当前阶段不能提交计划",
        );
        const validated = validatePlan(input);
        const p = this.project(w.project_id);
        if (p.repositories.length > 1) {
          for (const repo of p.repositories)
            requireCondition(
              validated.plan.scope.repository_paths[repo.id],
              "REPOSITORY_SCOPE_REQUIRED",
              "多仓计划必须按仓库分别声明修改范围",
            );
          for (const task of validated.plan.tasks)
            requireCondition(
              task.repo_id &&
                validated.plan.scope.repository_paths[task.repo_id] &&
                task.paths.every((path) =>
                  validated.plan.scope.repository_paths[
                    task.repo_id!
                  ]!.includes(path),
                ),
              "TASK_REPOSITORY_REQUIRED",
              "多仓任务必须绑定仓库及其批准路径",
            );
        }
        requireCondition(
          validated.plan.project_config_hash === objectHash(p),
          "PROJECT_CONFIG_CHANGED",
          "计划使用了旧项目配置",
        );
        requireCondition(
          resolveTaskModel(validated.plan) === "native-v2" ||
            w.complexity === validated.plan.complexity,
          "COMPLEXITY_MISMATCH",
          "计划复杂度与工作流不符",
        );
        for (const r of p.repositories)
          requireCondition(
            validated.plan.baselines[r.id],
            "BASELINE_MISSING",
            "缺少仓库基线",
          );
        if (resolveTaskModel(validated.plan) !== "native-v2") {
          for (const t of validated.plan.tests) {
            if (t.layer === "opentabs")
              requireCondition(
                p.browser_scenes.some((s) => s.id === t.scene_id),
                "SCENE_MISSING",
                "浏览器场景尚未登记",
              );
            else
              requireCondition(
                p.commands.some(
                  (c) =>
                    c.id === t.command_id &&
                    c.lifecycle === "check" &&
                    c.parser !== "none" &&
                    c.report_path,
                ),
                "CHECK_MISSING",
                "测试检查命令或报告解析器尚未登记",
              );
          }
        }
        const revision = w.plan_revision + 1;
        this.supersedePendingContinuation(key, w.state !== "PLANNING");
        if (w.plan_revision > 0) {
          this.invalidate(key, "计划版本变化，旧验收与测试不能沿用");
          if (w.run_id) this.auth.revokeRun(w.run_id);
        }
        const record: PlanRecord = {
          id: `${key}-${revision}`,
          workflow_id: key,
          revision,
          hash: validated.hash,
          plan: validated.plan,
          created_at: now(),
        };
        this.store.put("plan", record.id, key, record);
        const state = w.plan_revision ? "REPAIR_PLAN_PENDING" : "PLAN_PENDING";
        const updated = this.transition(
          key,
          [w.state],
          state,
          "plan_approval",
          {
            plan_revision: revision,
            plan_hash: record.hash,
            snapshot_id: undefined,
            blocker: undefined,
          },
        );
        this.exportDocuments(key);
        return updated;
      },
    );
  }
  binding(key: string, action: string, extra: unknown = {}) {
    const w = this.get(key);
    return {
      workflow_id: key,
      action,
      version: w.version,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash ?? null,
      snapshot_id: w.snapshot_id ?? null,
      environment_revision: w.environment_revision,
      extra,
    };
  }
  approve(key: string, proof: string, binding: unknown) {
    return this.store.transaction(() => {
      const w = this.get(key);
      requireCondition(
        objectHash(binding) === objectHash(this.binding(key, "approve")),
        "BINDING_CHANGED",
        "计划已变化",
      );
      requireCondition(
        ["PLAN_PENDING", "REPAIR_PLAN_PENDING"].includes(w.state),
        "INVALID_STATE",
        "没有待批准计划",
      );
      this.auth.consumeProof(proof, "approve", binding);
      this.store.put("approval", `${key}-${w.plan_revision}`, key, {
        plan_hash: w.plan_hash,
        revision: w.plan_revision,
        proof,
        approved_at: now(),
      });
      this.clearCurrentImplementationIntent(key);
      this.supersedePendingContinuation(key);
      const updated = this.transition(key, [w.state], "QUEUED", "prepare");
      this.scheduler.enqueue(key, w.project_id);
      this.store.enqueue(key, "dispatch", {});
      return updated;
    });
  }
  async accept(key: string, proof: string, binding: unknown) {
    return this.exclusive(key, async () => {
      const w = this.get(key);
      requireCondition(
        w.state === "HUMAN_PENDING",
        "INVALID_STATE",
        "当前不能验收",
      );
      requireCondition(
        objectHash(binding) === objectHash(this.binding(key, "accept")),
        "BINDING_CHANGED",
        "验收内容已变化",
      );
      if (resolveTaskModel(this.plan(key).plan) === "native-v2") {
        if (this.store.get("human_reconfirmation_required", key))
          this.quality.assertPassed(key, "after_human");
        else if (!this.store.get("functional_retest_ready", key))
          this.quality.assertPassed(key, "before_human");
        requireCondition(
          !new FunctionalIssueService(this.store).hasUnresolvedIssues(key),
          "UNRESOLVED_ISSUES",
          "存在尚未确认修复的功能问题",
        );
      }
      this.store.transaction(() => {
        this.auth.consumeProof(proof, "accept", binding);
        this.store.put("acceptance", key, key, {
          snapshot_id: w.snapshot_id,
          environment_revision: w.environment_revision,
          plan_revision: w.plan_revision,
          proof,
          accepted_at: now(),
        });
        this.store.remove("human_reconfirmation_required", key);
        this.store.remove("functional_retest_ready", key);
        this.store.remove("functional_fix_intent", key);
        this.store.remove("acceptance_carry", key);
        this.patchReviewPointer(key, { phase: "after_human" });
        this.transition(key, ["HUMAN_PENDING"], "REVIEW_QUEUED", "review");
        this.scheduler.enqueue(key, w.project_id);
        this.store.enqueue(key, "dispatch", {});
      });
      return this.get(key);
    });
  }
  queueFormalFeedback(key: string, messageId: string) {
    const w = this.get(key),
      message = this.store.must<any>("feedback_message", messageId);
    requireCondition(
      message.workflow_id === key,
      "MESSAGE_NOT_FOUND",
      "反馈不属于此任务",
    );
    if (message.status !== "pending") return w;
    if (
      [
        "EXECUTING",
        "VERIFYING",
        "REVIEWING",
        "PLANNING",
        "QUEUED",
        "REVIEW_QUEUED",
      ].includes(w.state)
    )
      return w;
    if (
      message.kind === "planning" &&
      [
        "PLAN_PENDING",
        "REPAIR_PLAN_PENDING",
        "RESEARCHING",
        "REPAIR_RESEARCH_REQUIRED",
      ].includes(w.state)
    ) {
      this.invalidate(key, "规划反馈");
      this.closePlanningHandoff(key, "superseded");
      const next = this.transition(key, [w.state], "PLANNING", "planning", {
        run_id: undefined,
        feedback: [...w.feedback, message.text],
      });
      this.scheduler.enqueue(key, w.project_id);
      this.store.enqueue(key, "dispatch_run", { purpose: "planning" });
      return next;
    }
    return this.feedback(key, message.text, "within_plan");
  }
  feedback(key: string, text: string, scope: "within_plan" | "new_scope") {
    const w = this.get(key);
    requireCondition(
      [
        "HUMAN_PENDING",
        "STOPPED",
        "BLOCKED",
        "WAITING_INPUT",
        "RECOVERY_REQUIRED",
        "WAITING_AUTHORIZATION",
      ].includes(w.state),
      "INVALID_STATE",
      "请先停止当前执行再反馈",
    );
    requireCondition(
      text.trim().length > 0 && text.length < 20000,
      "FEEDBACK_INVALID",
      "反馈内容无效",
    );
    if (scope === "within_plan") prepareRepairResume(this, key);
    this.store.remove("model_retry", key);
    if (
      scope !== "within_plan" ||
      !runtimeFailureResolution(w.blocker?.code, w.blocker?.message)
    )
      this.store.remove("repair_state", key);
    const waiting = readWaitingContext(this.store, key);
    if (w.state === "WAITING_INPUT" && waiting && scope === "within_plan")
      return this.resumeFromWaiting(key, text, waiting);
    if (scope === "within_plan") {
      const restored = this.restoreFailedRole(key, text);
      if (restored) return restored;
    }
    this.invalidate(key, "用户反馈");
    this.clearCurrentImplementationIntent(key);
    if (scope === "new_scope" || w.state === "HUMAN_PENDING")
      this.supersedePendingContinuation(key);
    else this.stageExecuteContinuation(key);
    const state = scope === "new_scope" ? "REPAIR_RESEARCH_REQUIRED" : "QUEUED";
    const next = this.transition(
      key,
      [w.state],
      state,
      scope === "new_scope" ? "research" : "execute",
      { feedback: [...w.feedback, text], blocker: undefined },
    );
    if (scope === "within_plan") {
      this.scheduler.enqueue(key, w.project_id);
      this.store.enqueue(key, "dispatch", {});
    }
    return next;
  }
  invalidate(
    key: string,
    reason: string,
    changed?: { paths: string[]; repo: string },
  ) {
    this.store.transaction(() => {
      const current = this.get(key);
      this.store.put("workflow", key, current.project_id, {
        ...current,
        snapshot_id: undefined,
        version: current.version + 1,
        updated_at: now(),
      });
      if (reason.startsWith("计划版本变化"))
        for (const kind of ["evidence", "development_evidence"])
          for (const e of this.store.list<Evidence>(kind, key))
            this.store.put(kind, e.id, key, { ...e, status: "stale" });
      if (reason === "代码修改" || reason.startsWith("已授权操作")) {
        const plan = current.plan_revision ? this.plan(key).plan : null;
        const impacted = new Set(
          plan?.tasks
            .filter(
              (t) =>
                !changed ||
                ((!t.repo_id || t.repo_id === changed.repo) &&
                  t.paths.some((p) => changed.paths.includes(p))),
            )
            .map((t) => t.id),
        );
        for (let added = true; added; ) {
          added = false;
          for (const t of plan?.tasks ?? [])
            if (
              !impacted.has(t.id) &&
              t.depends_on.some((d) => impacted.has(d))
            ) {
              impacted.add(t.id);
              added = true;
            }
        }
        for (const kind of ["evidence", "development_evidence"])
          for (const e of this.store.list<Evidence>(kind, key))
            if (
              !changed ||
              plan?.tests
                .find((t) => t.id === e.test_id)
                ?.task_ids.some((t) => impacted.has(t))
            )
              this.store.put(kind, e.id, key, { ...e, status: "stale" });
      }
      // Re-entering development or restarting the worker does not erase test
      // outcomes. Source changes are scoped above; environment identity and
      // plan revision are checked by progressEvidence/currentEvidence.
      this.store.remove("acceptance", key);
      for (const rev of this.store.list<DeliveryRevision>(
        "delivery_revision",
        key,
      )) {
        if (!rev.invalidated) {
          this.store.put("delivery_revision", rev.id, key, {
            ...rev,
            invalidated: true,
            invalidated_at: now(),
            invalidated_reason: reason,
          });
        }
      }
      for (const r of this.store.list<{ id: string }>("review", key))
        this.store.put("review", r.id, key, {
          ...r,
          stale: true,
          invalidated_at: now(),
          invalidated_reason: reason,
        });
      this.store.event(key, this.get(key).project_id, "EvidenceInvalidated", {
        reason,
      });
    });
  }
  worker(principal: Principal, key: string, write = false) {
    requireCondition(
      principal.expires > Date.now() &&
        !principal.revoked &&
        principal.role === "worker" &&
        principal.workflow_id === key,
      "FORBIDDEN",
      "无权访问该工作流",
      403,
    );
    const w = this.get(key);
    requireCondition(
      principal.run_id === w.run_id &&
        ["EXECUTING", "VERIFYING"].includes(w.state),
      "RUN_REVOKED",
      "执行轮次已结束或已被停止",
      403,
    );
    if (principal.run_id) {
      const currentRun = this.store.get<Run>("run", principal.run_id);
      if (currentRun?.deadline_at && Date.now() >= currentRun.deadline_at) {
        throw new FlowError("TIMEOUT", "执行轮次已达到配置时限", 403);
      }
    }
    if (write)
      requireCondition(
        w.state === "EXECUTING" &&
          !this.busy.has(key) &&
          !this.store.get("check_lock", key),
        "SNAPSHOT_FROZEN",
        "测试和验收阶段禁止修改",
        403,
      );
    return w;
  }
  files(principal: Principal, key: string, repo: string, write = false) {
    this.worker(principal, key, write);
    const ws = this.store
      .list<Workspace>("workspace", key)
      .find((x) => x.repo_id === repo);
    requireCondition(ws, "WORKSPACE_MISSING", "仓库未绑定该工作流");
    return {
      root: ws.root,
      broker: new FileBroker((paths) => {
        invalidateTaskProofs(this, key, paths, repo);
        this.invalidate(key, "代码修改", { paths, repo });
        this.store.event(
          key,
          this.get(key).project_id,
          "FilesChanged",
          {
            repo_id: repo,
            paths,
            task_id: this.store.get<any>("task_activity", key)?.task_id,
          },
          principal.run_id,
        );
      }),
    };
  }
  claimTask(
    principal: Principal,
    key: string,
    taskId: string,
    summary: string,
  ) {
    this.worker(principal, key);
    const plan = this.plan(key).plan;
    const task = plan.tasks.find((t) => t.id === taskId);
    requireCondition(task, "TASK_MISSING", "未知任务");
    for (const dependency of task.depends_on)
      requireCondition(
        this.store.get(
          "task_claim",
          `${key}-${this.get(key).plan_revision}-${dependency}`,
        ),
        "TASK_DEPENDENCY_INCOMPLETE",
        `前置任务 ${dependency} 尚未完成声明`,
      );
    requireCondition(
      summary.trim().length >= 10,
      "TASK_SUMMARY_REQUIRED",
      "需要说明实际实现和证据",
    );
    if (plan.task_model === "leaf-v1") this.worker(principal, key, true);
    if (plan.task_model === "leaf-v1") {
      const changed = recordTaskProof(this, principal, key, taskId);
      if (
        !changed &&
        this.store.get(
          "task_claim",
          `${key}-${this.get(key).plan_revision}-${taskId}`,
        )
      )
        return {
          status: "already_recorded",
          message:
            "该实现内容未变化，已有记录仍有效。请读取测试结果并修复失败项，无需重复提交全部任务。",
        };
    }
    this.store.put(
      "task_claim",
      `${key}-${this.get(key).plan_revision}-${taskId}`,
      key,
      {
        id: taskId,
        plan_revision: this.get(key).plan_revision,
        summary,
        run_id: principal.run_id,
        claimed_at: now(),
      },
    );
    this.store.event(
      key,
      this.get(key).project_id,
      "TaskClaimed",
      { task_id: taskId, summary, plan_revision: this.get(key).plan_revision },
      principal.run_id,
    );
    return {
      status: "claimed",
      message:
        plan.task_model === "leaf-v1"
          ? "细项完成条件已检查；测试结果单独统计，仍需完成测试与人工验收。"
          : "声明已记录；勾选仍需要当前快照测试证据。",
    };
  }
  taskStatus(key: string, verifyFiles = true) {
    const w = this.get(key);
    if (!w.plan_revision) return [];
    const plan = this.plan(key).plan;
    const currentRun = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    if (!isLegacyProtocol(currentRun, plan)) {
      const intent = this.reviewPointer(key);
      const completionRunId =
        intent.completion_run_id ?? intent.source_run_id;
      const implementationRunId = intent.implementation_run_id;
      const currentAttempt =
        ["EXECUTING", "VERIFYING"].includes(w.state) && w.run_id
          ? w.run_id
          : implementationRunId;
      const newAttempt =
        (!!implementationRunId && implementationRunId !== completionRunId) ||
        (!!currentAttempt && currentAttempt !== completionRunId);
      const recorded = !newAttempt && completionRunId
        ? readExecutionCompletion(this.store, completionRunId)
        : undefined;
      const completion = completionRunId && !newAttempt
        ? this.store
            .list<Delivery>("delivery", key)
            .reverse()
            .find((d) => d.run_id === completionRunId) ??
          (recorded
            ? {
                run_id: completionRunId,
                status: "passed" as const,
                manifest: { summary: recorded.summary },
                submitted_at: recorded.recorded_at,
              }
            : undefined)
        : undefined;
      const done = !!recorded || completion?.status === "passed";
      return plan.tasks.map((t) => ({
        id: t.id,
        title: t.title,
        module_id: t.module_id,
        completed: done,
        development_status: done ? "completed" : "in_progress",
        validation_status: "not_certified",
        implementation_status: done ? "completed" : "in_progress",
        has_implementation: done,
        status: done ? "completed" : "pending",
        summary: completion?.manifest?.summary ?? "",
        completed_at: completion?.submitted_at,
        started_at: undefined,
        recheck_reason: undefined,
      }));
    }
    const workspaces = this.store.list<Workspace>("workspace", key);
    const proofs = new Map<string, any>();
    if (plan.task_model === "leaf-v1") {
      for (const p of this.store.entries<any>("task_proof", key))
        if (p.id === `${key}-${w.plan_revision}-${p.value.task_id}`)
          proofs.set(p.value.task_id, p.value);
    }
    const memo = {
      ownValid: new Map<string, boolean>(),
      completed: new Map<string, boolean>(),
      fileHashes: new Map<string, string | null>(),
      proofs,
      workspaces,
      plan,
      w,
    };
    const evidence = [
      ...this.getEvidence(key),
      ...this.store.list<Evidence>("development_evidence", key),
    ];
    const developmentSnapshots = new Map<string, Snapshot>();
    for (const e of evidence)
      if (e.status === "passed" && !developmentSnapshots.has(e.snapshot_id)) {
        const snapshot = this.store.get<Snapshot>("snapshot", e.snapshot_id);
        if (snapshot) developmentSnapshots.set(e.snapshot_id, snapshot);
      }
    const claims = new Map(
      this.store
        .list<any>("task_claim", key)
        .filter((c) => c.plan_revision === w.plan_revision)
        .map((c) => [c.id, c]),
    );
    if (!verifyFiles)
      for (const task of plan.tasks)
        memo.ownValid.set(
          task.id,
          !!proofs.get(task.id) && !proofs.get(task.id).stale,
        );
    const activity = this.store.get<any>("task_activity", key);
    return plan.tasks.map((t) => {
      const claim = claims.get(t.id);
      const testsPassed =
        !!claim &&
        t.test_ids.every((test) => {
          const e = latestEvidence(evidence, test, w);
          return progressEvidence(e, w) && e!.status === "passed";
        });
      const proof = proofs.get(t.id) ?? null;
      const completed =
        plan.task_model === "leaf-v1" &&
        taskProofValid(this, key, t.id, false, new Set(), memo);
      const ownValid =
        !!proof && taskProofValid(this, key, t.id, true, new Set(), memo);
      const verified =
        testsPassed && (plan.task_model !== "leaf-v1" || completed);
      const unitTests = plan.tests.filter(
        (test) => test.layer === "unit" && t.test_ids.includes(test.id),
      );
      const basicChecks = unitTests.map((test) =>
        latestEvidence(evidence, test.id, w),
      );
      const basicPassed =
        unitTests.length > 0 &&
        basicChecks.every((e) => {
          if (!progressEvidence(e, w) || e?.status !== "passed" || !proof)
            return false;
          const repo = developmentSnapshots
            .get(e.snapshot_id)
            ?.repositories.find((r) => !t.repo_id || r.repo_id === t.repo_id);
          return (
            !!repo &&
            t.paths.every(
              (path) =>
                (repo.files.find((f) => f.path === path)?.hash ?? null) ===
                proof.hashes[path],
            )
          );
        });
      const basicFailed = basicChecks.some((e) => e?.status === "failed");
      const developmentStatus =
        verified || (completed && basicPassed)
          ? "completed"
          : basicFailed
            ? "check_failed"
            : completed
              ? "pending_check"
              : undefined;
      return {
        id: t.id,
        title: t.title,
        module_id: t.module_id,
        completed,
        development_status:
          developmentStatus ??
          (proof && !ownValid
            ? "needs_changes"
            : claim
              ? "pending_check"
              : "pending"),
        validation_status: verified
          ? "passed"
          : t.test_ids.some(
                (test) =>
                  latestEvidence(evidence, test, w)?.status === "failed",
              )
            ? "failed"
            : t.test_ids.some(
                  (test) =>
                    latestEvidence(evidence, test, w)?.status === "stale",
                )
              ? "stale"
              : "not_run",
        has_implementation: !!claim || !!proof,
        recheck_reason:
          !completed && proof
            ? ownValid
              ? "前置任务变更，等待前置实现核验；本任务实现记录保留"
              : (proof.stale_reason ??
                "实现内容需要重新核验，历史实现记录已保留")
            : undefined,
        implementation_status: completed
          ? "completed"
          : activity?.task_id === t.id &&
              activity?.run_id === w.run_id &&
              activity?.plan_revision === w.plan_revision &&
              w.state === "EXECUTING"
            ? "active"
            : ownValid
              ? "needs_recheck"
              : proof
                ? "needs_changes"
                : claim
                  ? "pending_check"
                  : "pending",
        started_at:
          activity?.task_id === t.id ? activity.started_at : undefined,
        completed_at: proof?.completed_at,
        status: verified ? "verified" : claim ? "claimed" : "pending",
        summary: claim?.summary ?? "",
      };
    });
  }
  verifyEvidence(_key: string, _allowPending = false) {
    return;
  }
  async freeze(key: string, principal: Principal) {
    return this.exclusive(key, async () => {
      this.worker(principal, key);
      let w = this.get(key);
      requireCondition(
        w.state === "EXECUTING",
        "INVALID_STATE",
        "不能重复冻结",
      );
      requireCondition(
        !this.store.get("check_lock", key),
        "CHECK_RUNNING",
        "等待当前开发检查完成后再冻结",
      );
      requireCondition(
        this.taskStatus(key).every((t) =>
          this.plan(key).plan.task_model === "leaf-v1"
            ? t.completed
            : t.status !== "pending",
        ),
        "TASK_NOT_CLAIMED",
        "所有任务都应完成实际实现声明后才能冻结",
      );
      try {
        await this.runtime?.prepareVerification?.(w, principal);
        this.store.remove(
          "freeze_attempts",
          `${key}:${principal.run_id}:freeze_attempts`,
        );
      } catch (error) {
        const current = this.get(key);
        if (
          current.run_id === principal.run_id &&
          current.state === "EXECUTING"
        ) {
          const repair = await repairFailure(
            this,
            key,
            error,
            principal.run_id!,
          );
          this.store.event(
            key,
            w.project_id,
            "PrepareVerificationFailed",
            {
              attempt: this.store.get<any>("repair_state", key)?.attempts ?? 1,
              error: error instanceof Error ? error.message : String(error),
              code:
                error instanceof FlowError ? error.code : "VERIFICATION_ERROR",
            },
            principal.run_id,
          );
          if (repair?.retry)
            throw new FlowError(
              error instanceof FlowError
                ? error.code
                : "PREPARE_VERIFICATION_FAILED",
              `${repair.instructions}\n执行会话已保留。修复后再次调用 devflow_freeze。`,
            );
          if (!repair) this.block(key, error);
          this.auth.revokeRun(principal.run_id!);
          await this.runtime?.stop(principal.run_id!).catch(() => {});
        }
        throw error;
      }
      w = this.worker(principal, key);
      requireCondition(
        w.state === "EXECUTING",
        "RUN_REVOKED",
        "执行阶段已变化",
      );
      const version = w.version;
      const snapshot = await this.git.snapshot(key, w.environment_revision);
      const current = this.worker(principal, key);
      requireCondition(
        current.state === "EXECUTING" && current.version === version,
        "RUN_REVOKED",
        "冻结期间任务已经变化，请重新读取当前状态",
      );
      const plan = this.plan(key).plan;
      for (const r of snapshot.repositories)
        for (const p of r.changed_paths)
          requireCondition(
            (
              plan.scope.repository_paths[r.repo_id] ?? plan.scope.allowed_paths
            ).includes(p),
            "SCOPE_VIOLATION",
            `发现范围外修改 ${p}`,
          );
      this.transition(key, ["EXECUTING"], "VERIFYING", "tests", {
        snapshot_id: snapshot.id,
      });
      this.exportDocuments(key);
      return snapshot;
    });
  }
  async finish(key: string, principal: Principal) {
    this.worker(principal, key);
    const w = this.get(key);
    requireCondition(
      w.state === "VERIFYING",
      "INVALID_STATE",
      "尚未冻结并测试",
    );
    return {
      status: "ready",
      message: "本轮完成说明已记录；等待执行器进程正常退出后交接。",
    };
  }
  async deliver(
    key: string,
    manifest: unknown,
    hostRecordReader?: NativeRunRecordReader,
  ): Promise<RoundResult> {
    return this.receiveRoundResult(
      key,
      this.get(key).run_id!,
      manifest,
      hostRecordReader,
      true,
    );
  }
  async receiveRoundResult(
    key: string,
    runId: string,
    manifest: unknown,
    hostRecordReader?: NativeRunRecordReader,
    deliverySubmit = false,
  ): Promise<RoundResult> {
    return this.exclusive(key, async () =>
      this.applyRoundResult(
        key,
        runId,
        manifest,
        hostRecordReader,
        deliverySubmit,
      ),
    );
  }
  private reviewPointer(key: string): ReviewPointer {
    return this.store.get<ReviewPointer>("plan_check_review_intent", key) ?? {};
  }
  private patchReviewPointer(key: string, patch: ReviewPointer) {
    this.store.put("plan_check_review_intent", key, key, {
      ...this.reviewPointer(key),
      ...patch,
    });
  }
  private clearCurrentImplementationIntent(key: string) {
    this.patchReviewPointer(key, {
      implementation_run_id: undefined,
      completion_run_id: undefined,
      source_run_id: undefined,
    });
    const staged = readRunContinuation(this.store, key);
    if (staged?.purpose === "execute") clearRunContinuation(this.store, key);
  }
  private startImplementationAttempt(key: string, runId: string) {
    this.patchReviewPointer(key, {
      implementation_run_id: runId,
      completion_run_id: undefined,
      source_run_id: undefined,
    });
  }
  private supersedePendingContinuation(key: string, supersedeHandoff = true) {
    this.clearNetworkRetryTimer(key);
    clearRunContinuation(this.store, key);
    clearWaitingContext(this.store, key);
    const handoff = readPlanningHandoff(this.store, key);
    if (supersedeHandoff && isOpenPlanningHandoff(handoff))
      savePlanningHandoff(this.store, key, { ...handoff, status: "superseded" });
  }
  stageExecuteContinuation(key: string) {
    const w = this.get(key);
    const run = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    const continuation = boundRunContinuation(this.store, w.run_id);
    if (
      !run || run.workflow_id !== key || run.plan_revision !== w.plan_revision ||
      run.status === "completed" || !isSubsequentExecuteRun(run) ||
      continuation?.purpose !== "execute"
    ) return;
    saveRunContinuation(this.store, key, key, continuation);
  }
  private recordImplementationCompletion(key: string, runId: string) {
    this.patchReviewPointer(key, {
      implementation_run_id: runId,
      completion_run_id: runId,
      source_run_id: runId,
    });
  }
  private consumeContinuation(
    key: string,
    purpose: RunContinuation["purpose"],
    role: RunContinuation["role"],
  ): RunContinuation | undefined {
    const staged = readRunContinuation(this.store, key);
    const waiting = readWaitingContext(this.store, key);
    const stagedMatch = staged?.purpose === purpose ? staged : undefined;
    const waitingMatch =
      waiting &&
      waiting.purpose === purpose &&
      (waiting.continuation ||
        waiting.intent === "need_user" ||
        waiting.intent === "unclear")
        ? continuationFromWaiting(waiting)
        : undefined;
    const continuation = stagedMatch ?? waitingMatch;
    if (!continuation) return;
    return { ...continuation, purpose, role: continuation.role || role };
  }
  private persistBoundContinuation(
    key: string,
    runId: string,
    run: Run,
    continuation: RunContinuation,
  ) {
    const bound: Run = {
      ...run,
      continuation,
      ...(continuation.purpose !== "planning" && continuation.conversation_id
        ? { continuation_conversation_id: continuation.conversation_id }
        : {}),
    };
    this.store.put("run", runId, key, bound);
    saveRunContinuation(this.store, runId, key, continuation);
    clearRunContinuation(this.store, key);
    const waiting = readWaitingContext(this.store, key);
    if (waiting && waiting.purpose === continuation.purpose)
      clearWaitingContext(this.store, key);
    return bound;
  }
  private staleRoundResult(
    key: string,
    runId: string,
    deliverySubmit = false,
  ): RoundResult | undefined {
    const w = this.get(key);
    const run = this.store.get<Run>("run", runId);
    const stopped = this.store.get("run_stop", runId);
    const current =
      w.run_id === runId &&
      run?.workflow_id === key &&
      ["EXECUTING", "VERIFYING"].includes(w.state) &&
      !stopped;
    const prior = readExecutionCompletion(this.store, runId);
    if (current) {
      if (prior && !deliverySubmit)
        return { status: prior.intent, summary: prior.summary };
      return undefined;
    }
    if (
      deliverySubmit &&
      prior &&
      w.run_id === runId &&
      run?.workflow_id === key &&
      !stopped
    )
      return undefined;
    if (prior && run?.workflow_id === key)
      return { status: prior.intent, summary: prior.summary };
    this.store.put("stale_round_result", runId, key, {
      run_id: runId,
      workflow_id: key,
      recorded_at: now(),
    });
    return { status: "ignored", message: "过期回执" };
  }
  private queueUnclearFollowup(
    key: string,
    context: {
      purpose: WaitingContext["purpose"];
      role: WaitingContext["role"];
      phase?: string;
      run_id?: string;
      conversation_id?: string;
      source_execution_run_id?: string;
      original_text?: string;
      questions?: string[];
      stage: string;
    },
  ) {
    saveWaitingContext(this.store, key, {
      purpose: context.purpose,
      role: context.role,
      phase: context.phase,
      run_id: context.run_id,
      conversation_id: context.conversation_id,
      source_execution_run_id: context.source_execution_run_id,
      original_text: context.original_text,
      questions: context.questions,
      continuation: true,
      intent: "unclear",
    });
    saveRunContinuation(this.store, key, key, {
      kind: "intent_clarification",
      source_run_id:
        context.run_id ?? context.source_execution_run_id ?? "",
      purpose: context.purpose,
      role: context.role,
      phase: context.phase,
      conversation_id: context.conversation_id,
      original_text: context.original_text,
      questions: context.questions,
    });
    if (context.purpose === "review") {
      this.transition(
        key,
        [this.get(key).state],
        "REVIEW_QUEUED",
        context.stage,
        { blocker: undefined },
      );
    } else {
      this.transition(key, [this.get(key).state], "QUEUED", context.stage, {
        blocker: undefined,
      });
    }
    this.scheduler.enqueue(key, this.get(key).project_id);
    this.store.enqueue(key, "dispatch", {});
  }
  private async applyRoundResult(
    key: string,
    runId: string,
    manifest: unknown,
    hostRecordReader: NativeRunRecordReader | undefined,
    deliverySubmit: boolean,
  ): Promise<RoundResult> {
    const stale = this.staleRoundResult(key, runId, deliverySubmit);
    if (stale) return stale;
    const w = this.get(key);
    const normalized = normalizeDeliveredRound(
      manifest,
      deliverySubmit ? { deliverySubmit: true } : undefined,
    );
    if (normalized.intent !== "completed")
      return this.routeExecutionIntent(key, runId, normalized);

    let payload: DeliveryManifest = normalizeOptionalDeliveryManifest(normalized.payload);

      // 幂等性检查 (C08 / R11, R12)
      if (payload.submission_id) {
        const existingDeliveries = this.store.list<Delivery>("delivery", key);
        const matchedDelivery = existingDeliveries.find(
          (d) => d.manifest.submission_id === payload.submission_id,
        );
        if (matchedDelivery) {
          const currentHash = objectHash(payload);
          const existingHash = objectHash(matchedDelivery.manifest);
          if (currentHash === existingHash) {
            // 检查该交付对应的修订版本是否已作废
            const revisions = this.store.list<DeliveryRevision>(
              "delivery_revision",
              key,
            );
            const matchedRev = revisions.find(
              (r) => r.delivery_id === matchedDelivery.id,
            );
            if (
              matchedRev?.invalidated ||
              matchedDelivery.plan_revision !== w.plan_revision ||
              matchedDelivery.plan_hash !== w.plan_hash ||
              (w.state === "EXECUTING" && matchedDelivery.run_id !== w.run_id)
            ) {
              return {
                status: "rejected",
                message:
                  "先前提交的交付结果已经失效作废，不能复用旧的通过结果，请重新测试并生成新交付",
                issues: [
                  {
                    code: "EVIDENCE_INVALIDATED",
                    message: "交付修订版本已作废",
                  },
                ],
              };
            }

            if (matchedDelivery.status === "passed" && matchedRev) {
              const acceptanceResults = this.store
                .list<AcceptanceResult>("acceptance_result", key)
                .filter((r) => r.delivery_id === matchedDelivery.id);
              return {
                status: "accepted",
                delivery_id: matchedDelivery.id,
                state: this.get(key).state,
                message:
                  "交付已接收；覆盖与完成情况由规划模型独立审查。",
                acceptance_results: acceptanceResults,
              };
            } else {
              const issues = this.store
                .list<DeliveryIssue>("delivery_issue", key)
                .filter((i) => i.delivery_id === matchedDelivery.id);
              const facts = w.run_id
                ? this.store.list<HostToolExecutionFact>(
                    "native_execution",
                    w.run_id,
                  )
                : [];
              return {
                status: "rejected",
                delivery_id: matchedDelivery.id,
                message: formatDeliveryRejection(issues, facts),
                issues,
              };
            }
          } else {
            throw new FlowError(
              "DELIVERY_CONFLICT",
              `提交标识 '${payload.submission_id}' 已被使用且清单内容不一致，请更换 submission_id 重试`,
            );
          }
        }
      }

      requireCondition(
        ["EXECUTING", "VERIFYING"].includes(w.state),
        "INVALID_STATE",
        "当前工作流不在执行或验证阶段，不能交付",
      );
      const plan = this.plan(key).plan;
      const run = this.store.must<Run>("run", runId);
      this.planSelfCheck.validateDelivery(w, run, payload);
      const workspaces = this.store.list<Workspace>("workspace", key);

      if (!["running", "completed"].includes(run.status)) {
        return {
          status: "rejected",
          message: "当前执行轮次已处于失败状态 (failed)，不能交付",
          issues: [
            { code: "EXECUTION_FAILED", message: "执行器进程已处于失败状态" },
          ],
        };
      }

      if (!hostRecordReader) {
        hostRecordReader = new NativeRunRecordReader(
          this.store.list<HostToolExecutionFact>("native_execution", run.id),
        );
      }

      const deliveryId = id("del");
      const inputManifest = {
        id: id("man"),
        workflow_id: key,
        repo_id: workspaces[0]?.repo_id ?? "main",
        fingerprint: "",
        files: [] as { path: string; hash: string }[],
        created_at: now(),
      };
      this.store.put("input_manifest", inputManifest.id, key, inputManifest);
      const attachments = uniqueAttachments(payload, workspaces);
      const attachmentRecords = attachments.map((item) => ({
        delivery_id: deliveryId,
        repo_id: item.repo_id,
        path: item.path,
        state: "pending" as const,
      }));
      const delivery: Delivery = {
        id: deliveryId,
        workflow_id: key,
        run_id: run.id,
        plan_revision: w.plan_revision,
        plan_hash: payload.plan_hash,
        status: "pending",
        input_manifest_id: inputManifest.id,
        manifest: payload,
        submitted_at: now(),
        attachment_status: attachmentRecords,
      };
      this.store.put("delivery", deliveryId, key, delivery);
      const importResult = {
        delivery,
        inputManifest,
        archivedReports: new Map(),
        reportHashes: {},
        inputFingerprints: {} as Record<string, string>,
      };

      const validation = {
        passed: true,
        issues: [] as DeliveryIssue[],
        acceptanceResults: this.store.list<AcceptanceResult>(
          "acceptance_result",
          key,
        ).filter((r) => r.delivery_id === importResult.delivery.id),
      };

      if (validation.passed) {
        const assignment = this.store.get<QualityRepairAssignment>(
          "repair_assignment",
          key,
        );
        recordExecutionCompletion(this.store, {
          run_id: run.id,
          workflow_id: key,
          intent: "completed",
          assignment_id: assignment?.assignment_id,
          source_review_id: assignment?.source_review_id,
          phase: assignment?.phase,
          summary: payload.summary,
          recorded_at: now(),
        });
        if (assignment && !assignment.consumed_completion_run_id)
          this.store.put("repair_assignment", key, key, {
            ...assignment,
            current_attempt_run_id: run.id,
            repair_run_id: run.id,
          });
        this.recordImplementationCompletion(key, run.id);
        const snapshotId = w.snapshot_id;
        const inputFingerprints = importResult.inputFingerprints;

        const isExecutionFinished = run.status === "completed";
        const revisionId = id("dlr");
        const deliveryRevision: DeliveryRevision = {
          id: revisionId,
          workflow_id: key,
          delivery_id: importResult.delivery.id,
          snapshot_id: snapshotId,
          plan_revision: w.plan_revision,
          plan_hash: w.plan_hash ?? "",
          input_fingerprints: inputFingerprints,
          execution_finished: isExecutionFinished,
          run_id: run.id,
          conversation_id: payload.conversation_id,
          created_at: now(),
        };
        this.store.put("delivery_revision", revisionId, key, deliveryRevision);

        this.store.transaction(() => {
          this.store.put("delivery", importResult.delivery.id, key, {
            ...importResult.delivery,
            status: "passed",
            attachment_status: attachmentRecords,
          });
          if (attachments.length) {
            const job = createArchiveJobFromManifest(this.store, {
              deliveryId: importResult.delivery.id,
              workflowId: key,
              runId: run.id,
              workspaces,
              manifest: payload,
            });
            if (job)
              this.store.enqueue(key, "archive_delivery", job);
          }
          for (const issue of this.store.list<DeliveryIssue>(
            "delivery_issue",
            key,
          ))
            if (
              issue.status === "open" &&
              issue.delivery_id !== importResult.delivery.id
            )
              this.store.put("delivery_issue", issue.id, key, {
                ...issue,
                status: "resolved",
                resolved_at: now(),
              });
          const snapshotFiles = (repoId?: string) => {
            if (!snapshotId) return [] as { path: string; hash: string }[];
            return (
              this.store
                .get<Snapshot>("snapshot", snapshotId)
                ?.repositories.find(
                  (r) => r.repo_id === (repoId ?? workspaces[0]?.repo_id),
                )?.files ?? []
            );
          };
          for (const task of plan.tasks) {
            const hashes = Object.fromEntries(
              snapshotFiles(task.repo_id)
                .filter((f) => task.paths.includes(f.path))
                .map((f) => [f.path, f.hash]),
            );
            this.store.put("task_proof", `${key}-${task.id}`, key, {
              task_id: task.id,
              workflow_id: key,
              run_id: run.id,
              summary: `本轮执行完成 (${importResult.delivery.id})`,
              completed_at: now(),
              verified: isExecutionFinished,
              hashes,
            });
            this.store.put(
              "task_proof",
              `${key}-${w.plan_revision}-${task.id}`,
              key,
              {
                task_id: task.id,
                workflow_id: key,
                run_id: run.id,
                summary: `本轮执行完成 (${importResult.delivery.id})`,
                completed_at: now(),
                verified: isExecutionFinished,
                hashes,
              },
            );
          }

          this.transition(
            key,
            [w.state],
            "VERIFYING",
            "delivery_received",
            { snapshot_id: snapshotId },
          );

          this.store.event(
            key,
            w.project_id,
            "DeliveryAccepted",
            {
              delivery_id: importResult.delivery.id,
              run_id: run.id,
              snapshot_id: snapshotId,
              acceptance_count: validation.acceptanceResults.length,
            },
            run.id,
          );
        });

        if (isExecutionFinished) await this.finalizeNativeDelivery(key, run.id);
        return {
          status: "accepted",
          delivery_id: importResult.delivery.id,
          state: this.get(key).state,
          message:
            "交付已接收；对照材料交给规划模型审查。不要因 issues 重跑测试或再次交付。",
          acceptance_results: validation.acceptanceResults,
          ...(validation.issues.length ? { issues: validation.issues } : {}),
        };
      } else {
        this.store.event(
          key,
          w.project_id,
          "DeliveryRejected",
          {
            delivery_id: importResult.delivery.id,
            run_id: run.id,
            issues: validation.issues,
          },
          run.id,
        );

        return {
          status: "rejected",
          delivery_id: importResult.delivery.id,
          message: formatDeliveryRejection(
            validation.issues,
            hostRecordReader.getAllFacts(),
          ),
          issues: validation.issues,
        };
      }
  }
  async finalizeNativeDelivery(key: string, runId: string) {
    const w = this.get(key);
    if (!["EXECUTING", "VERIFYING"].includes(w.state)) return;
    if (this.store.get("run_stop", runId)) return;
    const completion = readExecutionCompletion(this.store, runId);
    if (!completion || completion.intent !== "completed") return;
    const active = this.store.get<Run>("run", runId);
    if (
      w.run_id !== runId ||
      (active?.status &&
        !["running", "completed"].includes(active.status)) ||
      (active?.exit_code !== undefined && active.exit_code !== 0)
    )
      return;
    let rev = this.store
      .list<DeliveryRevision>("delivery_revision", key)
      .reverse()
      .find(
        (r) =>
          !r.invalidated &&
          r.run_id === runId &&
          r.plan_revision === w.plan_revision,
      );
    if (!rev) {
      const existing = this.store
        .list<Delivery>("delivery", key)
        .reverse()
        .find((d) => d.run_id === runId);
      const deliveryId = existing?.id ?? id("dlv");
      if (!existing)
        this.store.put("delivery", deliveryId, key, {
          id: deliveryId,
          workflow_id: key,
          run_id: runId,
          plan_revision: w.plan_revision,
          plan_hash: w.plan_hash,
          status: "passed",
          manifest: {
            status: "completed",
            summary: completion.summary ?? "本轮执行已完成",
          },
          submitted_at: now(),
        });
      rev = {
        id: id("dlr"),
        workflow_id: key,
        delivery_id: deliveryId,
        snapshot_id: w.snapshot_id,
        plan_revision: w.plan_revision,
        plan_hash: w.plan_hash ?? "",
        input_fingerprints: {},
        execution_finished: true,
        run_id: runId,
        created_at: now(),
      };
      this.store.put("delivery_revision", rev.id, key, rev);
    }
    if (["QUEUED", "REVIEW_QUEUED", "HUMAN_PENDING"].includes(w.state))
      return;
    requireCondition(
      ["VERIFYING", "EXECUTING"].includes(w.state),
      "INVALID_STATE",
      "当前阶段不能交接审查",
    );
    const pending = this.store
      .list<any>("feedback_message", key)
      .filter((m) => m.status === "pending");
    if (pending.length) {
      this.invalidate(key, "执行期间收到新反馈，进入下一轮落实");
      this.clearCurrentImplementationIntent(key);
      this.transition(key, [w.state], "QUEUED", "execute", {
        feedback: [...w.feedback, ...pending.map((m) => m.text)],
      });
      this.scheduler.enqueue(key, w.project_id);
      this.store.enqueue(key, "dispatch_run", { purpose: "implement" });
      return;
    }
    this.store.transaction(() => {
      this.store.put("delivery_revision", rev.id, key, {
        ...rev,
        execution_finished: true,
      });
      for (const proof of this.store.entries<any>("task_proof", key))
        if (proof.value.run_id === runId)
          this.store.put("task_proof", proof.id, key, {
            ...proof.value,
            verified: true,
          });
      const issues = new FunctionalIssueService(this.store);
      for (const issue of issues
        .listIssues(key)
        .filter((i) => i.status === "fixing")) {
        if (active && !issueInRepairBatch(this, key, active, issue.issue_id)) continue;
        issues.markReadyForRetest(key, issue.issue_id, rev.id);
      }
      if (this.store.get("functional_fix_intent", key))
        this.store.put("functional_retest_ready", key, key, { run_id: runId });
      const phase = this.reviewPointer(key).phase ?? "before_human";
      this.recordImplementationCompletion(key, runId);
      this.patchReviewPointer(key, { phase });
      this.transition(
        key,
        [w.state],
        "REVIEW_QUEUED",
        phase === "before_human" ? BEFORE_HUMAN_REVIEW_STAGE : "review",
      );
      this.store.event(
        key,
        w.project_id,
        "NativeDeliveryReadyForReview",
        { delivery_revision_id: rev.id },
        runId,
      );
      this.scheduler.enqueue(key, w.project_id);
      this.store.enqueue(key, "dispatch", {});
    });
  }
  async reportConflict(
    key: string,
    conflict: {
      description: string;
      conflict_evidence: string;
      affected_modules?: string[];
    },
  ) {
    const w = this.get(key);
    const runId = w.run_id;
    this.store.event(
      key,
      w.project_id,
      "DesignConflictReported",
      conflict,
      runId,
    );
    const issueId = id("iss");
    this.store.put("delivery_issue", issueId, key, {
      id: issueId,
      workflow_id: key,
      delivery_id: "conflict",
      code: "DESIGN_CONFLICT",
      message: `${conflict.description}: ${conflict.conflict_evidence}`,
      module_id: conflict.affected_modules?.[0],
      status: "open",
      created_at: now(),
    });
    this.transition(key, [w.state], "REPAIR_RESEARCH_REQUIRED", "research", {
      blocker: {
        code: "DESIGN_CONFLICT",
        message: `设计冲突待修订: ${conflict.description}`,
      },
    });
    return {
      status: "recorded",
      message:
        "设计冲突已记录，工作流已进入方案修订阶段 (REPAIR_RESEARCH_REQUIRED)。",
      issue_id: issueId,
    };
  }
  async stop(
    key: string,
    source: "local_console" | "controller" = "controller",
    expectedRunId?: string | null,
  ) {
    const w = this.get(key);
    requireCondition(
      ![
        "COMMITTED",
        "COMPLETED",
        "COMMITTING",
        "INTEGRATING",
        "CLEANUP_PENDING",
        "COMMIT_PARTIAL",
      ].includes(w.state),
      "INVALID_STATE",
      "该阶段不能暂停执行",
    );
    if (expectedRunId !== undefined && (w.run_id ?? null) !== expectedRunId) {
      throw new FlowError(
        "ACTIVE_RUN_CHANGED",
        "当前执行轮次已变化，不能停止接替的新轮次",
        409,
      );
    }
    const run = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    const reviewPhase = this.store.get<{ phase?: string }>(
      "plan_check_review_intent",
      key,
    )?.phase;
    const interruption = {
      category: "pause",
      source,
      at: now(),
      prior_state: w.state,
      prior_stage: w.stage,
      prior_purpose: run?.purpose,
      prior_run_id: w.run_id,
      run_id: w.run_id,
      review_phase: reviewPhase,
      repair_batch_id: run?.repair_batch_id,
      logical_round_id: run?.logical_round_id,
      message:
        source === "local_console"
          ? "你在控制台暂停了执行"
          : "执行已由控制程序暂停",
      next_action: "核实后继续这个任务",
    };
    this.store.put("interruption", key, key, interruption);
    this.clearNetworkRetryTimer(key);
    if (w.run_id) this.store.put("run_stop", w.run_id, key, interruption);
    if (w.run_id) this.auth.revokeRun(w.run_id);
    this.store.remove("queue", key);
    this.store.remove("model_retry", key);
    this.store.remove("pending_model_retry", key);
    this.store.remove("transient_network_retry", key);
    this.transition(key, [w.state], "STOPPING", "stop");
    if (w.run_id) await this.runtime?.stop(w.run_id);
    await this.mergeRuns.get(key);
    const next = this.transition(key, ["STOPPING"], "STOPPED", "stopped");
    this.store.event(key, w.project_id, "Stopped", {
      ...interruption,
      agent_stopped: true,
      services_retained:
        this.store.get<{ status: string }>("environment", key)?.status ===
        "ready",
    });
    return next;
  }
  async exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    requireCondition(
      !this.busy.has(key),
      "WORKFLOW_BUSY",
      "该工作流有操作正在执行",
    );
    this.busy.add(key);
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
    }
  }
  assertProjectConfiguration(key: string) {
    const workflow = this.get(key);
    requireCondition(
      this.plan(key).plan.project_config_hash ===
        objectHash(this.project(workflow.project_id)),
      "PROJECT_CONFIG_CHANGED",
      "项目配置已变化，必须重新制定并批准计划",
    );
  }

  /** Consume durable intents through the same dispatcher used by the HTTP entry points. */
  async consumeOutbox() {
    let wakeArchive = false;
    for (const job of this.store.jobs()) {
      if (job.kind === "archive_delivery") {
        wakeArchive = true;
        continue;
      }
      if (!["dispatch", "dispatch_run"].includes(job.kind)) continue;
      let payload: any;
      try {
        payload = JSON.parse(job.data);
        if (typeof payload === "string") {
          try {
            payload = JSON.parse(payload);
          } catch {}
        }
      } catch {
        payload = {};
      }
      const purpose = payload.purpose;
      const known = [
        undefined,
        "planning",
        "implement",
        "plan_self_check",
        "quality_review",
        "planner_takeover",
        "functional_fix",
        "aside",
        "spec_switch",
        "feedback_interrupt",
        "merge_conflict",
      ];
      if (!known.includes(purpose)) {
        this.store.jobStatus(job.id, "rejected");
        this.store.event(
          job.workflow_id,
          this.get(job.workflow_id).project_id,
          "DispatchRejected",
          { code: "DISPATCH_PURPOSE_UNKNOWN", purpose },
        );
        continue;
      }
      if (purpose === "merge_conflict") {
        const request = this.store.get<MergeConflictRequest>(
          "merge_conflict_request",
          payload.request_id,
        );
        if (!request || request.status !== "running") {
          this.store.jobStatus(job.id, "delivered");
          continue;
        }
        const w = this.get(job.workflow_id);
        const run = this.store.must<Run>("run", payload.run_id);
        if (!this.ownsMergeConflict(w.id, run.id, request.id)) {
          this.store.jobStatus(job.id, "delivered");
          continue;
        }
        if (this.runtime && (this.runtime as any).resolveMergeConflict) {
          const pending: Promise<void> = (this.runtime as any)
            .resolveMergeConflict(w, run, request)
            .then(async (receipt: MergeConflictReceipt) => {
              await this.handleMergeConflictResult(
                w.id,
                run.id,
                request.id,
                receipt,
              );
            })
            .catch((err: any) => {
              this.handleMergeConflictError(w.id, run.id, request.id, err);
            })
            .finally(() => {
              if (this.mergeRuns.get(w.id) === pending) this.mergeRuns.delete(w.id);
            });
          this.mergeRuns.set(w.id, pending);
        }
        this.store.jobStatus(job.id, "delivered");
        continue;
      }
      if (purpose === "aside") {
        if (!this.runtime?.aside) continue;
        const aside = this.store.get<any>("aside_session", payload.aside_id);
        if (
          !aside ||
          ["cancelled", "expired", "completed"].includes(aside.status)
        ) {
          this.store.jobStatus(job.id, "delivered");
          continue;
        }
        if (
          this.store
            .list<Run>("run", job.workflow_id)
            .some((r) => r.purpose === "aside" && r.status === "running")
        )
          continue;
        const w = this.get(job.workflow_id),
          runId = id("aside-run");
        const binding = bindProfile(
          this.store,
          this.config,
          w.id,
          "aside",
          buildDispatchContext(this.store, w.id, "aside"),
        );
        const run: Run = {
          id: runId,
          workflow_id: w.id,
          plan_revision: aside.plan_revision ?? w.plan_revision,
          adapter: binding.profile.adapterId,
          ...binding,
          stage: "aside",
          status: "running",
          started_at: now(),
          deadline_at: Date.now() + ASIDE_TIMEOUT_MS,
          package_hash: objectHash(aside),
          protocol: "lightweight",
        };
        this.store.transaction(() => {
          this.store.put("run", runId, w.id, run);
          this.store.jobStatus(job.id, "delivered");
          this.store.put("aside_session", aside.id, w.id, {
            ...aside,
            run_id: runId,
          });
        });
        void this.runtime
          .aside(w, run, aside)
          .then((answer) => {
            new AsideSessionService(this.store).settleRun(w.id, aside.id, {
              answer,
            });
            this.store.put("run", runId, w.id, {
              ...run,
              status: "completed",
              exit_code: 0,
              ended_at: now(),
            });
          })
          .catch((error) => {
            new AsideSessionService(this.store).settleRun(w.id, aside.id, {
              error,
            });
            this.store.put("run", runId, w.id, {
              ...run,
              status: "failed",
              ended_at: now(),
              result: { error: String(error) },
            });
          });
        continue;
      }
      if (purpose === "spec_switch") {
        const w = this.get(job.workflow_id);
        const expectedRunId = payload.expected_run_id;
        if (!expectedRunId) {
          this.store.event(
            job.workflow_id,
            w.project_id,
            "SpecSwitchRecorded",
            {
              message: "配置已记录，需用户按当前状态继续",
            },
          );
          this.store.jobStatus(job.id, "delivered");
          continue;
        }
        if (w.run_id && w.run_id !== expectedRunId) {
          this.store.event(job.workflow_id, w.project_id, "DispatchRejected", {
            code: "ACTIVE_RUN_CHANGED",
            expected_run_id: expectedRunId,
            current_run_id: w.run_id,
          });
          this.store.jobStatus(job.id, "delivered");
          continue;
        }
        if (
          [
            "EXECUTING",
            "REVIEWING",
            "PLANNING",
            "QUEUED",
            "VERIFYING",
          ].includes(w.state)
        ) {
          await this.stop(w.id, "local_console", expectedRunId);
        }
        this.store.jobStatus(job.id, "delivered");
        continue;
      }
      if (purpose === "feedback_interrupt") {
        const w = this.get(job.workflow_id);
        if (
          [
            "EXECUTING",
            "REVIEWING",
            "PLANNING",
            "QUEUED",
            "VERIFYING",
          ].includes(w.state)
        )
          await this.stop(w.id, "local_console");
        this.store.jobStatus(job.id, "delivered");
        continue;
      }
      this.store.transaction(() => {
        const w = this.get(job.workflow_id);
        if (["QUEUED", "REVIEW_QUEUED", "PLANNING"].includes(w.state)) {
          if (!this.store.get("queue", w.id))
            this.scheduler.enqueue(w.id, w.project_id);
        }
        this.store.jobStatus(job.id, "delivered");
      });
    }
    if (wakeArchive) this.wakeArchiveDrain();
  }

  private wakeArchiveDrain() {
    void drainArchiveOutbox(this.store, {
      storageRoot: this.config.storage_root,
    });
  }

  async handleMergeConflictResult(
    workflowId: string,
    runId: string,
    requestId: string,
    receipt: MergeConflictReceipt,
  ) {
    if (!this.ownsMergeConflict(workflowId, runId, requestId)) return;
    const coordinator = new GitDeliveryCoordinator(
      this.store,
      this.config.workspace_root,
      this.git,
    );
    const res = await coordinator.handleConflictResolution(
      workflowId,
      requestId,
      receipt,
      () => requireCondition(
        this.ownsMergeConflict(workflowId, runId, requestId, true),
        "RUN_REVOKED",
        "冲突处理已停止或已由新运行接替",
      ),
    );
    if (!this.ownsMergeConflict(workflowId, runId, requestId, true)) return;
    if (res.blocked) {
      this.store.put("run", runId, workflowId, {
        ...this.store.must<Run>("run", runId),
        status: "failed",
        ended_at: now(),
      });
      return;
    }
    this.store.put("run", runId, workflowId, {
      ...this.store.must<Run>("run", runId),
      status: "completed",
      exit_code: 0,
      ended_at: now(),
    });
    const carried = this.store.get<{ original?: unknown }>(
      "acceptance_carry",
      workflowId,
    );
    const acceptance =
      this.store.get("acceptance", workflowId) ??
      carried?.original ??
      (res as { acceptance?: unknown }).acceptance;
    this.invalidate(workflowId, "冲突修复后的代码需要重新进行代码质量审查");
    if (acceptance && !carried)
      this.store.put("acceptance_carry", workflowId, workflowId, {
        original: acceptance,
        requires_confirmation: false,
        integration: true,
      });
    const request = this.store.get<MergeConflictRequest>(
      "merge_conflict_request",
      requestId,
    );
    const phase = request?.quality_phase ?? "after_human";
    this.patchReviewPointer(workflowId, { phase });
    this.transition(
      workflowId,
      ["COMMITTING", "INTEGRATING", "EXECUTING", "BLOCKED"],
      "REVIEW_QUEUED",
      phase === "before_human" ? BEFORE_HUMAN_REVIEW_STAGE : "review",
      {
        feedback: [
          ...this.get(workflowId).feedback,
          "已解决主分支合并冲突，请交接代码质量审查。",
        ],
      },
    );
    this.scheduler.enqueue(workflowId, this.get(workflowId).project_id);
    this.store.enqueue(workflowId, "dispatch", {});
  }

  handleMergeConflictError(
    workflowId: string,
    runId: string,
    requestId: string,
    err: any,
  ) {
    if (err?.code === "RUN_REVOKED" ||
        !this.ownsMergeConflict(workflowId, runId, requestId)) return;
    const request = this.store.get<MergeConflictRequest>(
      "merge_conflict_request",
      requestId,
    );
    if (request) {
      this.store.put("merge_conflict_request", requestId, workflowId, {
        ...request,
        status: "blocked",
        updated_at: now(),
      });
    }
    const run = this.store.get<Run>("run", runId);
    if (run) {
      this.store.put("run", runId, workflowId, {
        ...run,
        status: "failed",
        ended_at: now(),
        result: { error: String(err) },
      });
    }
    const w = this.get(workflowId);
    this.transition(workflowId, [w.state], "BLOCKED", "merge_conflict_blocked");
  }
  private ownsMergeConflict(workflowId: string, runId: string, requestId: string, settled = false) {
    const w = this.get(workflowId);
    const run = this.store.get<Run>("run", runId);
    const request = this.store.get<MergeConflictRequest>("merge_conflict_request", requestId);
    return w.run_id === runId && run?.workflow_id === workflowId &&
      request?.workflow_id === workflowId && request.run_id === runId &&
      request.plan_revision === w.plan_revision && request.plan_hash === w.plan_hash &&
      (request.status === "running" || (settled && ["resolved", "blocked"].includes(request.status))) &&
      !this.store.get("run_stop", runId) &&
      (["EXECUTING", "COMMITTING", "INTEGRATING"].includes(w.state) ||
        (settled && request.status === "blocked" && w.state === "BLOCKED"));
  }

  private assignPlanningRun(w: Workflow, run: Run) {
    const existing = readPlanningHandoff(this.store, w.id);
    const waiting = readWaitingContext(this.store, w.id);
    let handoff = existing;
    if (!handoff && waiting && isPlanningWaiting(waiting)) {
      handoff = {
        handoff_id: id("pho"),
        source_run_id: waiting.run_id ?? waiting.source_execution_run_id ?? "",
        source_role: "executor",
        source_conversation_id: waiting.conversation_id,
        plan_revision: w.plan_revision,
        original_text: waiting.original_text,
        questions: waiting.questions,
        target_role: "planner",
        status: "pending",
      };
    }
    this.store.transaction(() => {
      if (handoff && ["pending", "assigned"].includes(handoff.status)) {
        handoff = savePlanningHandoff(this.store, w.id, {
          ...handoff,
          status: "assigned",
          target_run_id: run.id,
        });
        const continuation = continuationFromHandoff(handoff);
        this.persistBoundContinuation(w.id, run.id, run, continuation);
      } else {
        this.store.put("run", run.id, w.id, run);
      }
      const leftover = readWaitingContext(this.store, w.id);
      if (leftover && isPlanningWaiting(leftover))
        clearWaitingContext(this.store, w.id);
    });
    return this.store.must<Run>("run", run.id);
  }
  private closePlanningHandoff(
    workflowId: string,
    status: "resolved" | "superseded",
  ) {
    const handoff = readPlanningHandoff(this.store, workflowId);
    if (handoff && ["pending", "assigned"].includes(handoff.status))
      savePlanningHandoff(this.store, workflowId, { ...handoff, status });
    const waiting = readWaitingContext(this.store, workflowId);
    if (waiting && isPlanningWaiting(waiting))
      clearWaitingContext(this.store, workflowId);
    const staged = readRunContinuation(this.store, workflowId);
    if (staged?.purpose === "planning")
      clearRunContinuation(this.store, workflowId);
  }
  private async runPlanning(w: Workflow, runId: string) {
    requireCondition(
      this.runtime?.plan,
      "PLANNER_UNAVAILABLE",
      "当前运行时不支持规划",
    );
    const binding = bindProfile(
      this.store,
      this.config,
      w.id,
      "planning",
      buildDispatchContext(this.store, w.id, "planning"),
    );
    const run: Run = {
      id: runId,
      workflow_id: w.id,
      plan_revision: w.plan_revision,
      adapter: binding.profile.adapterId,
      ...binding,
      stage: "planning",
      status: "running",
      started_at: now(),
      deadline_at: Date.now() + this.config.timeouts.agent_minutes * 60000,
      package_hash: objectHash({
        request: w.request,
        messages: this.store.list("feedback_message", w.id),
        spec: binding.execution_spec_id,
      }),
      protocol: "lightweight",
    };
    w = this.transition(w.id, ["PLANNING"], "PLANNING", "planning", {
      run_id: runId,
      blocker: undefined,
    });
    const bound = this.assignPlanningRun(w, run);
    this.store.remove("pending_model_retry", w.id);
    for (const msg of this.store
      .list<any>("feedback_message", w.id)
      .filter((m) => m.status === "pending"))
      this.store.put("feedback_message", msg.message_id, w.id, {
        ...msg,
        status: "acknowledged",
        ack_run: runId,
      });
    try {
      const result = await this.runtime.plan(w, bound);
      requireCondition(
        this.get(w.id).state === "PLANNING" &&
          this.get(w.id).run_id === runId &&
          !this.store.get("run_stop", runId),
        "RUN_REVOKED",
        "规划已停止，不能发布旧结果",
      );
      requireCondition(
        typeof result.markdown === "string" && result.markdown.trim(),
        "PLAN_DOCUMENT_MISSING",
        "规划未返回完整正文",
      );
      const normalized = result.markdown.replace(/\r\n/g, "\n");
      const plan = result.plan as any;
      if (plan.design_ref)
        requireCondition(
          plan.design_ref.content_hash === hash(normalized),
          "PLAN_DOCUMENT_HASH_MISMATCH",
          "规划正文哈希不匹配",
        );
      const doc = new DocumentService(
        this.store,
        this.config.storage_root,
      ).publishDocument(w.id, "plan", normalized, w.plan_revision + 1);
      await this.submitValidatedPlan(
        w.id,
        plan,
        this.get(w.id).version,
        "planning-" + runId,
      );
      this.store.put("planning_document", w.id, w.id, {
        document_id: doc.id,
        plan_revision: this.get(w.id).plan_revision,
      });
      this.store.put("run", runId, w.id, {
        ...this.store.must<Run>("run", runId),
        status: "completed",
        exit_code: 0,
        ended_at: now(),
      });
      this.closePlanningHandoff(w.id, "resolved");
    } catch (error) {
      this.store.put("run", runId, w.id, {
        ...this.store.must<Run>("run", runId),
        status: this.store.get("run_stop", runId) ? "stopped" : "failed",
        ended_at: now(),
        result: { error: String(error) },
      });
      if (
        this.get(w.id).state === "PLANNING" &&
        this.get(w.id).run_id === runId
      )
        this.block(w.id, error);
    }
  }

  async dispatch() {
    if (this.dispatching || !this.runtime) return;
    this.dispatching = true;
    try {
      await this.consumeOutbox();
      this.wakeArchiveDrain();
      let last: string | undefined;
      const attempted = new Set(this.running);
      for (let n = 0; n < this.list().length; n++) {
        const item = this.scheduler.next(
          last,
          this.config.scheduler.aging_minutes,
          attempted,
        );
        if (!item) break;
        attempted.add(item.id);
        last = item.project;
        const w = this.get(item.id);
        if (!["QUEUED", "REVIEW_QUEUED", "PLANNING"].includes(w.state)) {
          this.store.remove("queue", w.id);
          continue;
        }
        if (this.running.has(w.id)) continue;
        const review = w.state === "REVIEW_QUEUED";
        const slot = this.scheduler.capacity(
          review ? "reviewer" : "executor",
          review
            ? this.config.scheduler.reviewers
            : this.config.scheduler.executors,
        );
        if (!slot) {
          this.store.put("queue_wait", w.id, w.id, {
            kind: "capacity",
            resource: review ? "reviewer" : "executor",
            message: review ? "等待独立复核名额" : "等待执行模型名额",
            owners: this.store
              .list<any>("lease")
              .filter((l) =>
                l.id.startsWith(review ? "reviewer:" : "executor:"),
              )
              .map((l) => l.owner),
          });
          continue;
        }
        const runId = id("run");
        const known = this.store.list<Workspace>("workspace", w.id);
        const context = this.store.get<{ roots: Record<string, string> }>(
          "entry_context",
          w.id,
        );
        const roots = known.length
          ? known.map((ws) => ws.root)
          : this.project(w.project_id).repositories.map((repo) =>
              w.workspace_mode === "existing_workspace"
                ? (context?.roots[repo.id] ?? repo.path)
                : join(this.config.workspace_root, w.project_id, w.id, repo.id),
            );
        const leases = this.scheduler.acquire(w.id, runId, [
          slot,
          ...roots.map((root) => "write:" + root.toLowerCase()),
        ]);
        if (!leases) {
          const owners = this.store
            .list<any>("lease")
            .filter((l) =>
              roots.some((root) => l.id === "write:" + root.toLowerCase()),
            )
            .map((l) => l.owner);
          this.store.put("queue_wait", w.id, w.id, {
            kind: "workspace",
            resource: roots.join("、"),
            message: "等待工作目录写入权限",
            owners,
          });
          continue;
        }
        this.store.put("queue_wait", w.id, w.id, {
          kind: "preparing",
          message:
            w.workspace_mode === "existing_workspace"
              ? "已取得执行名额，正在检查主工作区"
              : "已取得执行名额，正在准备独立工作区",
          owners: [],
        });
        this.store.event(
          w.id,
          w.project_id,
          "PreparationStarted",
          {
            message:
              w.workspace_mode === "existing_workspace"
                ? "正在检查主工作区"
                : "正在准备独立工作区",
          },
          runId,
        );
        this.store.remove("queue", w.id);
        this.running.add(w.id);
        void this.run(
          w.id,
          runId,
          review,
          leases.map((l) => l.id),
        ).catch((e) => this.block(w.id, e));
      }
    } finally {
      this.dispatching = false;
    }
  }
  private async run(
    key: string,
    runId: string,
    review: boolean,
    leases: string[],
  ) {
    this.clearNetworkRetryTimer(key);
    const runtime = this.runtime!;
    const queued = this.get(key);
    let activated = false;
    const ownsPreparation = () => {
      const current = this.get(key);
      return (
        current.state === queued.state &&
        current.version === queued.version &&
        current.plan_revision === queued.plan_revision &&
        current.plan_hash === queued.plan_hash
      );
    };
    try {
      let w = queued;
      if (w.state === "PLANNING") {
        await assertSelectedSource(this, w);
        await this.runPlanning(w, runId);
        return;
      }
      if (review && !ownsPreparation()) return;
      if (!review) {
        prepareRepairResume(this, key);
        const plan = this.plan(key);
        const approval = this.store.must<{ plan_hash: string }>(
          "approval",
          `${key}-${w.plan_revision}`,
        );
        requireCondition(
          approval.plan_hash === plan.hash,
          "APPROVAL_STALE",
          "审批不匹配",
        );
        const project = this.project(w.project_id);
        const context = this.store.get<{ roots: Record<string, string> }>(
          "entry_context",
          key,
        );
        const sources = {
          ...project,
          repositories: project.repositories.map((repo) => ({
            ...repo,
            path: context?.roots[repo.id] ?? repo.path,
          })),
        };
        for (const repo of sources.repositories) {
          const registered = project.repositories.find(
            (r) => r.id === repo.id,
          )!;
          const [source, original] = await Promise.all([
            repositoryInfo(repo.path),
            repositoryInfo(registered.path),
          ]);
          requireCondition(
            source.common_dir.toLowerCase() ===
              original.common_dir.toLowerCase(),
            "PROJECT_MISMATCH",
            "任务工作区已不属于登记仓库",
          );
        }
        await assertSelectedSource(this, w);
        await this.git.prepare(
          sources,
          key,
          w.workspace_mode,
          plan.plan.baselines,
        );
        if (!ownsPreparation()) return;
        const keys = this.store
          .list<Workspace>("workspace", key)
          .map((ws) => "write:" + ws.root.toLowerCase());
        requireCondition(
          this.scheduler.acquire(key, runId, keys),
          "WORKSPACE_BUSY",
          "工作区被占用",
        );
        leases.push(...keys);
      }
      const takeover = this.store.get<{ planner: boolean }>(
        "repair_assignment",
        key,
      )?.planner;
      const purpose = review
        ? "quality_review"
        : takeover ? "planner_takeover" : "implement";
      const dispatchContext = buildDispatchContext(this.store, key, purpose);
      const profileBinding = bindProfile(
        this.store,
        this.config,
        key,
        purpose,
        dispatchContext,
      );
      w = this.transition(
        key,
        [review ? "REVIEW_QUEUED" : "QUEUED"],
        review ? "REVIEWING" : "EXECUTING",
        review
          ? this.store.get<{ phase: string }>("plan_check_review_intent", key)
              ?.phase === "before_human"
            ? BEFORE_HUMAN_REVIEW_STAGE
            : "review"
          : this.store.get<{ planner: boolean }>("repair_assignment", key)
                ?.planner
            ? "planner_takeover"
            : "execute",
        {
          run_id: runId,
          review_request_id: review ? id("review") : w.review_request_id,
          blocker: undefined,
        },
      );
      activated = true;
      this.store.remove("queue_wait", key);
      const deadline = Date.now() + this.config.timeouts.agent_minutes * 60000;
      const continuationPurpose = review ? "review" : "execute";
      const role = review
        ? "planner"
        : this.store.get<{ planner?: boolean }>("repair_assignment", key)
            ?.planner
          ? "planner"
          : "executor";
      const continuation = this.consumeContinuation(key, continuationPurpose, role);
      let run: Run = {
        ...profileBinding,
        id: runId,
        workflow_id: key,
        plan_revision: w.plan_revision,
        adapter: profileBinding.profile.adapterId,
        stage: w.stage,
        status: "running",
        started_at: now(),
        deadline_at: deadline,
        package_hash: objectHash({
          plan: this.plan(key),
          feedback: w.feedback,
          snapshot: w.snapshot_id,
        }),
        protocol: "lightweight",
      };
      this.store.transaction(() => {
        if (continuation)
          run = this.persistBoundContinuation(key, runId, run, continuation);
        else this.store.put("run", runId, key, run);
        if (!review) {
          const assignment = this.store.get<QualityRepairAssignment>(
            "repair_assignment",
            key,
          );
          if (assignment)
            this.store.put("repair_assignment", key, key, {
              ...assignment,
              current_attempt_run_id: runId,
              repair_cycle_id:
                assignment.repair_cycle_id ?? assignment.assignment_id,
            });
          this.startImplementationAttempt(key, runId);
        } else {
          this.patchReviewPointer(key, { review_run_id: runId });
        }
        if (profileBinding.assignment_id) bindRepairAssignment(this.store, key, profileBinding.assignment_id);
        this.store.remove("pending_model_retry", key);
      });
      for (const msg of this.store
        .list<any>("feedback_message", key)
        .filter((m) => m.status === "pending"))
        this.store.put("feedback_message", msg.message_id, key, {
          ...msg,
          status: "acknowledged",
          ack_run: runId,
        });
      if (!review) {
        markOpenIssuesFixing(this, key, profileBinding.repair_batch_id);
      }
      const timer = setInterval(
        () => this.scheduler.heartbeat(key, runId),
        5000,
      );
      try {
        if (review) {
          const result = await runtime.review(w, run);
          if (this.store.get("run_stop", runId) || this.get(key).run_id !== runId) {
            this.store.put("run", runId, key, {
              ...this.store.must<Run>("run", runId),
              status: "stopped",
              ended_at: now(),
            });
            return;
          }
          this.store.put("run", runId, key, {
            ...this.store.must<Run>("run", runId),
            status: "completed",
            exit_code: 0,
            ended_at: now(),
          });
          if (
            this.get(key).run_id === runId &&
            this.get(key).state === "REVIEWING"
          )
            await this.receiveReview(key, result);
        } else {
          const stopGraceMs = Math.max(
            (this.config.timeouts.stop_seconds ?? 0) * 1000,
            3000,
          );
          const ttl = Math.max(0, deadline - Date.now()) + stopGraceMs;
          const token = this.auth.issue(
            { role: "worker", workflow_id: key, run_id: runId },
            ttl,
          );
          await runtime.execute(w, run, token);
          const current = this.get(key);
          const currentRun = this.store.must<Run>("run", runId);
          if (
            current.run_id === runId &&
            current.state === "VERIFYING" &&
            isLegacyProtocol(currentRun, this.plan(key).plan)
          ) {
            await this.finish(key, {
              role: "worker",
              workflow_id: key,
              run_id: runId,
              expires: Date.now() + 1000,
            });
            this.transition(
              key,
              ["VERIFYING"],
              "HUMAN_PENDING",
              "manual_acceptance",
            );
          } else if (
            current.run_id === runId &&
            ["HUMAN_PENDING", "VERIFYING", "REVIEW_QUEUED"].includes(
              current.state,
            )
          ) {
            if (current.state === "VERIFYING")
              await this.finalizeNativeDelivery(key, runId);
          } else if (current.state === "EXECUTING") {
            const containerManifest = join(
              this.config.storage_root,
              "containers",
              key,
              "delivery_manifest.json",
            );
            if (existsSync(containerManifest)) {
              try {
                const content = JSON.parse(
                  readFileSync(containerManifest, "utf8"),
                );
                await this.receiveRoundResult(key, runId, content);
              } catch {}
            }
            if (this.get(key).state === "EXECUTING")
              await this.finalizeNativeDelivery(key, runId);
          }
        }
        const finalState = this.get(key).state;
        const recorded = readExecutionCompletion(this.store, runId);
        const waiting = [
          "WAITING_INPUT",
          "PLANNING",
          "QUEUED",
          "REPAIR_RESEARCH_REQUIRED",
          "WAITING_AUTHORIZATION",
        ];
        if (!recorded) waiting.push("REVIEW_QUEUED");
        const finalStatus = this.store.get("run_stop", runId)
          ? "stopped"
          : recorded
            ? "completed"
            : waiting.includes(finalState)
            ? "waiting"
            : finalState === "BLOCKED"
              ? "failed"
              : "completed";
        this.store.put("run", runId, key, {
          ...this.store.must<Run>("run", runId),
          status: finalStatus,
          ...(finalStatus === "completed"
            ? {
                exit_code:
                  this.store.must<Run>("run", runId).exit_code ?? 0,
              }
            : {}),
          ended_at: now(),
        });
        if (
          finalStatus === "completed" &&
          !review
        )
          await this.finalizeNativeDelivery(key, runId);
        this.store.remove("transient_network_retry", key);
      } finally {
        clearInterval(timer);
        this.auth.revokeRun(runId);
      }
    } catch (e) {
      const w = this.get(key);
      const ownsRun =
        activated &&
        w.run_id === runId &&
        [
          "EXECUTING",
          "VERIFYING",
          "REVIEWING",
          "COMMITTING",
          "HUMAN_PENDING",
        ].includes(w.state);
      if (ownsRun && !review) {
        const normalized = normalizeRuntimeFailure(e);
        const errorCode =
          normalized instanceof FlowError
            ? normalized.code
            : e instanceof FlowError
              ? e.code
              : "INTERNAL_FAILURE";
        const errorText =
          normalized instanceof FlowError
            ? String(normalized.message) +
              " " +
              JSON.stringify(normalized.details ?? {})
            : String(e);
        const isTransientNetwork =
          errorCode === "MODEL_CONNECTION_FAILED" ||
          /bad record mac|local error:\s*tls:|streamGenerateContent.*(?:request failed|bad record mac)/i.test(
            errorText,
          );

        const retryState = this.store.get<{ count: number; last_at: number }>(
          "transient_network_retry",
          key,
        ) ?? { count: 0, last_at: 0 };

        if (isTransientNetwork && retryState.count < 10) {
          this.stageExecuteContinuation(key);
          retryState.count += 1;
          retryState.last_at = Date.now();
          this.store.put("transient_network_retry", key, key, retryState);
          stageModelRunRetry(this.store, key, runId);
          const current = this.get(key);
          this.store.event(
            key,
            current.project_id,
            "ModelRetryScheduled",
            {
              attempt: retryState.count,
              max_attempts: 10,
              code: "MODEL_CONNECTION_FAILED",
              message: `检测到偶发模型网络连接异常（第 ${retryState.count}/10 次重试），代码与现场已保留，正在安排自动重试。`,
            },
            runId,
          );
          this.transition(
            key,
            [current.state],
            "QUEUED",
            current.stage,
            {
              feedback: current.feedback,
              blocker: undefined,
            },
          );
          const delayMs = Math.min(
            30000,
            3000 * Math.pow(1.5, retryState.count - 1),
          );
          this.clearNetworkRetryTimer(key);
          this.networkRetryTimers.set(key, setTimeout(() => {
            this.networkRetryTimers.delete(key);
            const latest = this.get(key);
            if (latest.state !== "QUEUED" || latest.run_id !== runId ||
                this.store.get("run_stop", runId) || latest.plan_revision !== current.plan_revision)
              return;
            this.scheduler.enqueue(key, current.project_id);
            void this.dispatch();
          }, delayMs));
        } else {
          const repair = await repairFailure(this, key, e, runId);
          if (repair?.retry) {
            stageModelRunRetry(this.store, key, runId);
            this.stageExecuteContinuation(key);
            const current = this.get(key);
            this.invalidate(key, "异常修复，将按原角色继续");
            this.transition(
              key,
              [current.state],
              "QUEUED",
              this.store.get<{ planner?: boolean }>("repair_assignment", key)?.planner
                ? "planner_takeover" : "auto_repair",
              {
                feedback: [...current.feedback, repair.instructions],
                blocker: undefined,
              },
            );
            this.scheduler.enqueue(key, current.project_id);
          } else if (!repair) this.block(key, e);
        }
      } else if (ownsRun || (!activated && ownsPreparation()))
        this.block(key, e);
      const run = this.store.get<Run>("run", runId);
      if (run)
        this.store.put("run", runId, key, {
          ...run,
          status: this.store.get("run_stop", runId)
            ? "stopped"
            : [
                  "WAITING_AUTHORIZATION",
                  "WAITING_INPUT",
                  "REPAIR_PLAN_PENDING",
                ].includes(this.get(key).state)
              ? "waiting"
              : "failed",
          ended_at: now(),
          result: this.store.get("run_stop", runId)
            ? { interruption: this.store.get("run_stop", runId) }
            : { error: String(e) },
        });
    } finally {
      this.scheduler.release(key, runId, leases, true);
      if (
        !["QUEUED", "REVIEW_QUEUED", "PLANNING"].includes(this.get(key).state)
      )
        this.store.remove("queue_wait", key);
      this.exportDocuments(key);
      this.running.delete(key);
      queueMicrotask(() => void this.dispatch());
    }
  }

  private qualityFindingsFromReview(review: Review) {
    const mapped = (review.findings ?? []).map((f, index) => ({
      finding_id: f.id ?? `finding-${index + 1}`,
      severity: "major" as const,
      evidence: f.evidence ?? "",
      impact: f.consequence ?? "",
      cause: f.reason ?? f.trigger ?? "",
      file_path: f.path,
      line_number: f.line,
    }));
    const combined = [...(review.quality?.findings ?? []), ...mapped];
    const seen = new Set<string>();
    const unique: typeof combined = [];
    for (const finding of combined) {
      const id = finding.finding_id;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push(finding);
    }
    return unique;
  }

  private prepareNativeRepairReview(w: Workflow, review: Review) {
    const phase =
      this.store.get<{ phase: QualityPhase }>(
        "plan_check_review_intent",
        w.id,
      )?.phase ?? "before_human";
    const findings = this.qualityFindingsFromReview(review);
    const quality = {
      ...review.quality,
      workflow_id: w.id,
      run_id: w.run_id!,
      phase,
      verdict: "changes_required" as const,
      findings: findings.length ? findings : review.quality?.findings ?? [],
      repair_plan: review.quality?.repair_plan ?? [],
      function_impact: review.quality?.function_impact,
      plan_revision: w.plan_revision,
      feedback_cursor: Math.max(
        0,
        ...this.store.list<any>("feedback_message", w.id).map((m) => m.seq),
      ),
      reviewed_at: now(),
      summary: review.summary,
      notes: review.notes,
    };
    delete (quality as { cycle?: unknown }).cycle;
    const body = (
      review.repair_document ??
      review.notes ??
      review.summary ??
      findings
        .map((f) => `${f.finding_id}: ${f.cause || f.impact || f.evidence}`)
        .join("\n")
    ).replace(/\r\n/g, "\n");
    return { quality, body, withinScope: true };
  }

  private async applyNativeRepairReview(w: Workflow, review: Review) {
    requireCondition(
      this.get(w.id).state === "REVIEWING" &&
        this.get(w.id).run_id === w.run_id &&
        !this.store.get("run_stop", w.run_id!),
      "RUN_REVOKED",
      "审查已停止，不能派发整改",
    );
    const { quality, body, withinScope } = this.prepareNativeRepairReview(
      w,
      review,
    );
    if (review.repair_plan) await parsePlanDiagrams(review.repair_plan);
    this.store.transaction(() =>
      this.commitNativeRepairDecision(w, review, quality, body, withinScope),
    );
    if (body.trim()) {
      try {
        new DocumentService(
          this.store,
          this.config.storage_root,
        ).publishDocument(w.id, "repair_plan", body, w.plan_revision);
      } catch {}
    }
    return this.get(w.id);
  }
  private persistQualityTransferRecord(
    transfer: QualityTransfer,
    extras: {
      next_assignment_id?: string;
      completion_run_id?: string;
    } = {},
  ) {
    this.store.put(
      "quality_transfer",
      `${transfer.workflow_id}:${transfer.review_run_id}`,
      transfer.workflow_id,
      {
        workflow_id: transfer.workflow_id,
        review_run_id: transfer.review_run_id,
        phase: transfer.phase,
        cycle: transfer.cycle,
        next_assignment_id:
          extras.next_assignment_id ?? transfer.next_assignment_id,
        action: transfer.decision.action,
        completion_run_id: extras.completion_run_id,
      },
    );
  }
  private writeRepairAssignment(
    w: Workflow,
    transfer: QualityTransfer,
    body: string,
  ) {
    const assignmentId =
      transfer.next_assignment_id ?? transfer.assignment?.assignment_id;
    if (!assignmentId) return;
    const next = this.get(w.id);
    this.store.put("repair_assignment", w.id, w.id, {
      ...(transfer.assignment ?? {}),
      assignment_id: assignmentId,
      repair_cycle_id: assignmentId,
      planner: transfer.decision.action === "takeover_by_planner",
      phase: transfer.phase,
      source: "quality_review",
      source_review_id: transfer.review_run_id,
      plan_revision: next.plan_revision,
      plan_hash: next.plan_hash,
      instructions: body,
    });
  }
  private carryAcceptanceAfterQualityRepair(
    w: Workflow,
    transfer: QualityTransfer,
    quality: ReturnType<Engine["prepareNativeRepairReview"]>["quality"],
  ) {
    if (transfer.phase !== "after_human") return;
    const acceptance =
      this.store.get<any>("acceptance", w.id) ??
      this.store.get<any>("acceptance_carry", w.id)?.original;
    if (!acceptance) return;
    const previous = this.store.get<any>("acceptance_carry", w.id);
    this.store.put("acceptance_carry", w.id, w.id, {
      original: acceptance,
      requires_confirmation:
        previous?.requires_confirmation === true ||
        reportedFunctionImpact(quality.function_impact) !== undefined ||
        reportedFunctionImpact(previous?.reported_function_impact) !==
          undefined ||
        (quality.repair_plan ?? []).some(
          (item: { function_impact?: string }) =>
            reportedFunctionImpact(item.function_impact) !== undefined,
        ),
      reported_function_impact:
        reportedFunctionImpact(quality.function_impact) ??
        previous?.reported_function_impact,
      review_id: quality.run_id,
    });
  }
  private commitNativeRepairDecision(
    w: Workflow,
    review: Review,
    quality: ReturnType<Engine["prepareNativeRepairReview"]>["quality"],
    body: string,
    withinScope: boolean,
  ) {
    const transfer = this.quality.prepareQualityTransfer(w.id, quality);
    const applied = this.quality.applyQualityTransfer(transfer);
    const decision = applied.decision;
    if (decision.action === "retry_incomplete") {
      this.queueUnclearFollowup(w.id, {
        purpose: "review",
        role: "planner",
        phase: this.reviewPointer(w.id).phase ?? "before_human",
        run_id: w.run_id,
        conversation_id: w.run_id
          ? this.store.get<Run>("run", w.run_id)?.conversation_id
          : undefined,
        source_execution_run_id: this.reviewPointer(w.id).completion_run_id,
        original_text: decision.message,
        stage:
          (this.reviewPointer(w.id).phase ?? "before_human") === "before_human"
            ? BEFORE_HUMAN_REVIEW_STAGE
            : "review",
      });
      return;
    }
    const priorTransfer = this.store.get<{ next_assignment_id?: string }>(
      "quality_transfer",
      `${w.id}:${applied.review_run_id}`,
    );
    if (priorTransfer?.next_assignment_id) {
      this.ensureRepairDispatch(w.id, decision.action);
      return;
    }
    if (review.repair_plan) {
      this.transition(
        w.id,
        ["REVIEWING"],
        "REPAIR_RESEARCH_REQUIRED",
        "repair_plan",
      );
      this.submitPlan(
        w.id,
        review.repair_plan,
        this.get(w.id).version,
        "quality-" + applied.review_run_id,
      );
    }
    this.writeRepairAssignment(w, applied, body);
    this.persistQualityTransferRecord(applied, {
      completion_run_id: this.reviewPointer(w.id).completion_run_id,
    });
    this.patchReviewPointer(w.id, { phase: applied.phase });
    this.clearCurrentImplementationIntent(w.id);
    this.carryAcceptanceAfterQualityRepair(w, applied, quality);
    if (withinScope) this.ensureRepairDispatch(w.id, decision.action);
  }
  private ensureRepairDispatch(
    workflowId: string,
    action: string,
  ) {
    const current = this.get(workflowId);
    const stage =
      action === "takeover_by_planner" ? "planner_takeover" : "execute";
    if (current.state === "REVIEWING")
      this.transition(workflowId, ["REVIEWING"], "QUEUED", stage);
    else if (current.state === "REPAIR_PLAN_PENDING") {
      this.store.put(
        "approval",
        workflowId + "-" + current.plan_revision,
        workflowId,
        {
          plan_hash: current.plan_hash,
          revision: current.plan_revision,
          approved_at: now(),
          method: "planner_repair_within_approved_scope",
          source_review: current.run_id,
        },
      );
      this.transition(
        workflowId,
        ["REPAIR_PLAN_PENDING"],
        "QUEUED",
        stage,
      );
    }
    this.scheduler.enqueue(workflowId, current.project_id);
    this.store.enqueue(workflowId, "dispatch_run", {
      purpose:
        action === "takeover_by_planner" ? "planner_takeover" : "implement",
    });
  }
  private applyPassedAcceptanceCarry(
    key: string,
    w: Workflow,
    review: Review,
    result: { run_id: string },
    phase: string,
  ) {
    if (phase !== "after_human") return false;
    const carry = this.store.get<any>("acceptance_carry", key);
    if (!carry) return false;
    const impact =
      reportedFunctionImpact(carry.reported_function_impact) ??
      reportedFunctionImpact(review.quality?.function_impact);
    if (carry.requires_confirmation === true || impact) {
      this.store.put(
        "human_reconfirmation_required",
        key,
        key,
        this.quality.fingerprint(key),
      );
      this.transition(
        key,
        ["REVIEWING"],
        "HUMAN_PENDING",
        "manual_acceptance",
      );
      return true;
    }
    this.store.put("acceptance", key, key, {
      ...carry.original,
      snapshot_id: w.snapshot_id,
      plan_revision: w.plan_revision,
      environment_revision: w.environment_revision,
      original_confirmation: carry.original,
      derived_after_quality_review: result.run_id,
    });
    this.store.remove("acceptance_carry", key);
    return false;
  }
  private commitNativePassedDecision(key: string, w: Workflow, review: Review) {
    const phase =
      w.stage === BEFORE_HUMAN_REVIEW_STAGE ? "before_human" : "after_human";
    const result = {
      ...review.quality,
      workflow_id: key,
      run_id: w.run_id!,
      phase,
      verdict: "passed" as const,
      findings: [],
      repair_plan: [],
      function_impact: review.quality?.function_impact,
      plan_revision: w.plan_revision,
      feedback_cursor: Math.max(
        0,
        ...this.store.list<any>("feedback_message", key).map((m) => m.seq),
      ),
      reviewed_at: now(),
    };
    delete (result as { cycle?: unknown }).cycle;
    return this.store.transaction(() => {
      const transfer = this.quality.prepareQualityTransfer(key, result);
      if (transfer.decision.action === "retry_incomplete") {
        this.queueUnclearFollowup(key, {
          purpose: "review",
          role: "planner",
          phase,
          run_id: w.run_id,
          conversation_id: this.store.get<Run>("run", w.run_id!)
            ?.conversation_id,
          source_execution_run_id: this.reviewPointer(key).completion_run_id,
          original_text: transfer.decision.message,
          stage:
            phase === "before_human" ? BEFORE_HUMAN_REVIEW_STAGE : "review",
        });
        return "followup" as const;
      }
      requireCondition(
        transfer.decision.action === "pass",
        "REVIEW_INCOMPLETE",
        transfer.decision.message,
      );
      this.quality.applyQualityTransfer(transfer);
      this.persistQualityTransferRecord(transfer, {
        completion_run_id: this.reviewPointer(key).completion_run_id,
      });
      if (this.applyPassedAcceptanceCarry(key, w, review, result, phase))
        return "human_pending" as const;
      if (w.stage === BEFORE_HUMAN_REVIEW_STAGE) {
        this.transition(
          key,
          ["REVIEWING"],
          "HUMAN_PENDING",
          "manual_acceptance",
        );
        return "human_pending" as const;
      }
      return "commit" as const;
    });
  }

  async receiveReview(key: string, input: unknown) {
    const sanitized =
      input && typeof input === "object" ? { ...(input as any) } : input;
    if (sanitized && typeof sanitized === "object" && "id" in sanitized) {
      delete (sanitized as any).id;
    }
    const parsed = ReviewSchema.safeParse(sanitized);
    const w = this.get(key);
    if (w.run_id && this.store.get("run_stop", w.run_id)) return w;
    requireCondition(
      w.state === "REVIEWING" && !this.store.get("run_stop", w.run_id!),
      "REVIEW_BINDING_INVALID",
      "当前不在审查阶段",
    );
    if (!parsed.success) {
      this.queueUnclearFollowup(key, {
        purpose: "review",
        role: "planner",
        phase: this.reviewPointer(key).phase ?? "before_human",
        run_id: w.run_id,
        conversation_id: w.run_id
          ? this.store.get<Run>("run", w.run_id)?.conversation_id
          : undefined,
        source_execution_run_id: this.reviewPointer(key).completion_run_id,
        original_text:
          typeof input === "object" ? JSON.stringify(input) : String(input ?? ""),
        stage:
          (this.reviewPointer(key).phase ?? "before_human") === "before_human"
            ? BEFORE_HUMAN_REVIEW_STAGE
            : "review",
      });
      return this.get(key);
    }
    const reviewIntent = normalizeReviewIntent(parsed.data);
    const review = {
      ...parsed.data,
      workflow_id: key,
      review_request_id: w.review_request_id ?? parsed.data.review_request_id,
      plan_revision: w.plan_revision,
      snapshot_id: w.snapshot_id ?? parsed.data.snapshot_id,
      findings: parsed.data.findings ?? [],
      unresolved_questions: parsed.data.unresolved_questions ?? [],
      verdict:
        reviewIntent.intent === "passed"
          ? ("passed" as const)
          : reviewIntent.intent === "changes_required"
            ? ("changes_required" as const)
            : parsed.data.verdict,
    };
    this.store.put("review", review.review_request_id ?? w.run_id!, key, {
      ...review,
      id: review.review_request_id ?? w.run_id,
      original_result: parsed.data,
    });
    if (reviewIntent.intent === "unclear") {
      this.queueUnclearFollowup(key, {
        purpose: "review",
        role: "planner",
        phase: this.reviewPointer(key).phase ?? "before_human",
        run_id: w.run_id,
        conversation_id: this.store.get<Run>("run", w.run_id!)?.conversation_id,
        source_execution_run_id: this.reviewPointer(key).completion_run_id,
        original_text: review.summary ?? review.notes,
        stage:
          (this.reviewPointer(key).phase ?? "before_human") === "before_human"
            ? BEFORE_HUMAN_REVIEW_STAGE
            : "review",
      });
      return this.get(key);
    }
    if (reviewIntent.intent === "need_user") {
      const phase = this.reviewPointer(key).phase ?? "before_human";
      saveWaitingContext(this.store, key, {
        purpose: "review",
        role: "planner",
        phase,
        run_id: w.run_id,
        conversation_id: this.store.get<Run>("run", w.run_id!)?.conversation_id,
        source_execution_run_id: this.reviewPointer(key).completion_run_id,
        original_text: review.summary ?? review.notes,
        intent: "need_user",
        questions: reviewIntent.questions,
      });
      this.transition(key, ["REVIEWING"], "WAITING_INPUT", w.stage, {
        blocker: {
          code: "REVIEW_NEEDS_USER",
          message:
            reviewIntent.questions.join("；") || "审查需要用户输入",
        },
      });
      return this.get(key);
    }
    const passed = reviewIntent.intent === "passed";
    if (!passed) {
      if (!isLegacyProtocol(this.store.get<Run>("run", w.run_id!), this.plan(key).plan))
        return this.applyNativeRepairReview(w, review);
      this.transition(
        key,
        ["REVIEWING"],
        review.repair_plan ? "REPAIR_PLAN_PENDING" : "REPAIR_RESEARCH_REQUIRED",
        "repair_plan",
      );
      if (review.repair_plan)
        await this.submitValidatedPlan(
          key,
          review.repair_plan,
          this.get(key).version,
          id("repair"),
        );
      return this.get(key);
    }
    if (!isLegacyProtocol(this.store.get<Run>("run", w.run_id!), this.plan(key).plan)) {
      const outcome = this.commitNativePassedDecision(key, w, review);
      if (outcome !== "commit") return this.get(key);
    }
    if (w.stage === BEFORE_HUMAN_REVIEW_STAGE) {
      return this.transition(
        key,
        ["REVIEWING"],
        "HUMAN_PENDING",
        "manual_acceptance",
      );
    }
    const acceptance = this.store.get("acceptance", key);
    requireCondition(acceptance, "ACCEPTANCE_STALE", "尚未人工确认");
    const project = this.project(w.project_id);
    const approvedPlan = this.plan(key);
    const approval = this.store.get<{ plan_hash: string; revision: number }>(
      "approval",
      `${key}-${w.plan_revision}`,
    );
    requireCondition(
      approval?.plan_hash === approvedPlan.hash &&
        approval.revision === w.plan_revision,
      "APPROVAL_STALE",
      "提交前计划批准缺失或已变化",
    );
    const lightweight = !isLegacyProtocol(
      this.store.get<Run>("run", w.run_id!),
      approvedPlan.plan,
    );
    this.transition(key, ["REVIEWING"], "COMMITTING", "commit");
    try {
      if (lightweight) {
        const outcome = await this.withWorkspaceWrite(key, id("commit"), () =>
          new GitDeliveryCoordinator(
            this.store,
            this.config.workspace_root,
            this.git,
          ).executeDelivery(key, review.commit_message),
        );
        await this.applyCommitOutcome(key, outcome);
      } else {
        const snapshot = w.snapshot_id
          ? this.store.get<Snapshot>("snapshot", w.snapshot_id)
          : undefined;
        await this.git.commit(
          snapshot ??
            (await this.git.snapshot(key, w.environment_revision)),
          project,
          review.commit_message ?? "devflow: apply approved changes",
        );
        this.transition(key, ["COMMITTING"], "COMMITTED", "done");
      }
    } catch (e) {
      if (this.get(key).state === "CLEANUP_PENDING") {
        this.transition(
          key,
          ["CLEANUP_PENDING"],
          "CLEANUP_PENDING",
          "cleanup",
          { blocker: { code: "CLEANUP_FAILED", message: String(e) } },
        );
        throw e;
      }
      this.transition(
        key,
        ["COMMITTING", "INTEGRATING"],
        "COMMIT_PARTIAL",
        "commit_recovery",
        { blocker: { code: "COMMIT_PARTIAL", message: String(e) } },
      );
      throw e;
    }
    return this.get(key);
  }
  async retryReview(key: string) {
    await this.waitForIdle(key);
    const w = this.get(key);
    const run = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    requireCondition(
      ["BLOCKED", "STOPPED"].includes(w.state) &&
        run &&
        ["review", BEFORE_HUMAN_REVIEW_STAGE].includes(run.stage),
      "INVALID_STATE",
      "只能重试因复核中断的任务",
    );
    if (run.stage === "review")
      requireCondition(
        this.store.get("acceptance", key),
        "ACCEPTANCE_REQUIRED",
        "终审需要有效人工确认",
      );
    this.transition(key, [w.state], "REVIEW_QUEUED", run.stage, {
      blocker: undefined,
    });
    this.scheduler.enqueue(key, w.project_id);
    void this.dispatch();
    return this.get(key);
  }

  async retryCommit(key: string) {
    const w = this.get(key);
    requireCondition(
      w.state === "COMMIT_PARTIAL",
      "INVALID_STATE",
      "当前不是部分提交恢复",
    );
    const review = this.store.must<Review>("review", w.review_request_id!);
    requireCondition(
      normalizeReviewIntent(review).intent === "passed",
      "REVIEW_INCOMPLETE",
      "只能重试原复核通过的提交",
    );
    const keys = this.store
      .list<Workspace>("workspace", key)
      .map((ws) => "write:" + ws.root.toLowerCase());
    const run = id("commit-recovery");
    requireCondition(
      this.scheduler.acquire(key, run, keys),
      "WORKSPACE_BUSY",
      "工作区正在使用",
    );
    try {
      const candidates = this.store.list<any>("integration_candidate", key);
      if (candidates.some((c) => c.awaiting_verification)) {
        const workspaces = this.store.list<Workspace>("workspace", key);
        for (const candidate of candidates.filter(
          (c) => c.awaiting_verification,
        )) {
          const ws = workspaces.find((ws) => ws.repo_id === candidate.repo_id);
          requireCondition(ws, "WORKSPACE_MISSING", "整合恢复缺少原工作树");
          const info = await repositoryInfo(ws.root);
          requireCondition(
            info.branch === ws.branch,
            "BRANCH_CHANGED",
            "工作树分支发生变化",
          );
          let merging = false;
          try {
            await git(ws.root, ["rev-parse", "--verify", "MERGE_HEAD"]);
            merging = true;
          } catch {}
          requireCondition(
            !merging,
            "MERGE_CONFLICT",
            "工作树仍有未完成的合并，请先解决冲突；保留现场",
          );
          requireCondition(
            (await git(ws.root, [
              "merge-base",
              info.head,
              candidate.source_commit,
            ])) === candidate.source_commit &&
              (await git(ws.root, [
                "merge-base",
                info.head,
                candidate.candidate_commit,
              ])) === candidate.candidate_commit,
            "INTEGRATION_CHANGED",
            "恢复候选未包含原任务及目标提交",
          );
          this.store.put("workspace", ws.id, key, {
            ...ws,
            execution_base: info.head,
          });
          this.store.put("integration_candidate", key + ":" + ws.repo_id, key, {
            ...candidate,
            candidate_commit: info.head,
          });
        }
        const acceptance = this.store.get("acceptance", key);
        this.store.put("candidate_commit_history", "recovery-" + run, key, {
          results: this.store.list("commit_result", key),
          intent: this.store.get("commit_intent", key),
        });
        this.store.remove("commit_intent", key);
        for (const ws of workspaces) {
          this.store.remove("commit_result", key + "-" + ws.repo_id);
          this.store.remove("commit_index", key + "-" + ws.repo_id);
        }
        this.invalidate(key, "恢复已吸收主分支的新候选");
        if (acceptance)
          this.store.put("acceptance_carry", key, key, {
            original: acceptance,
            requires_confirmation: false,
            integration: true,
          });
        this.patchReviewPointer(key, { phase: "after_human" });
        this.clearCurrentImplementationIntent(key);
        this.transition(key, ["COMMIT_PARTIAL"], "QUEUED", "execute", {
          blocker: undefined,
          feedback: [
            ...w.feedback,
            "恢复整合候选：主分支已吸收，请检查新候选并完成必要修改后交接代码质量审查。",
          ],
        });
        this.scheduler.enqueue(key, w.project_id);
        this.store.enqueue(key, "dispatch", {});
        return this.get(key);
      }
      const outcome = await new GitDeliveryCoordinator(
        this.store,
        this.config.workspace_root,
        this.git,
      ).executeDelivery(key, review.commit_message);
      await this.applyCommitOutcome(key, outcome);
      return this.get(key);
    } catch (e) {
      if (["REVIEWING", "COMMITTING", "COMMIT_PARTIAL"].includes(this.get(key).state))
        this.transition(
          key,
          [this.get(key).state],
          "COMMIT_PARTIAL",
          "commit_recovery",
          { blocker: { code: "COMMIT_RETRY_FAILED", message: String(e) } },
        );
      throw e;
    } finally {
      this.scheduler.release(key, run, keys, true);
    }
  }
  private routeExecutionIntent(
    key: string,
    runId: string,
    normalized: ReturnType<typeof normalizeDeliveredRound>,
  ): RoundResult {
    const run = this.store.get<Run>("run", runId);
    const conversationId = run?.conversation_id;
    if (normalized.intent === "need_planner") {
      const questions = textQuestions(
        (normalized.payload as { unresolved_questions?: unknown })
          .unresolved_questions,
      );
      const originalText = [normalized.summary, normalized.notes]
        .filter((item): item is string => !!item)
        .join("\n");
      savePlanningHandoff(this.store, key, {
        handoff_id: id("pho"),
        source_run_id: runId,
        source_role: "executor",
        source_conversation_id: conversationId,
        plan_revision: this.get(key).plan_revision,
        original_text: originalText || undefined,
        summary: normalized.summary,
        notes: normalized.notes,
        questions: questions.length ? questions : undefined,
        target_role: "planner",
        status: "pending",
      });
      const waiting = readWaitingContext(this.store, key);
      if (waiting && isPlanningWaiting(waiting))
        clearWaitingContext(this.store, key);
      this.transition(key, ["EXECUTING", "VERIFYING"], "PLANNING", "planning", {
        run_id: undefined,
        blocker: {
          code: "NEED_PLANNER",
          message: normalized.summary ?? "执行需要规划澄清",
        },
      });
      this.store.enqueue(key, "dispatch_run", { purpose: "planning" });
      return { status: "need_planner", summary: normalized.summary };
    }
    if (normalized.intent === "unclear") {
      this.queueUnclearFollowup(key, {
        purpose: "execute",
        role: "executor",
        run_id: runId,
        conversation_id: conversationId,
        source_execution_run_id: runId,
        original_text: normalized.summary,
        questions: textQuestions(
          (normalized.payload as { unresolved_questions?: unknown })
            .unresolved_questions,
        ),
        stage: "execute",
      });
      return { status: "unclear", summary: normalized.summary };
    }
    saveWaitingContext(this.store, key, {
      purpose: "execute",
      role: "executor",
      run_id: runId,
      conversation_id: conversationId,
      source_execution_run_id: runId,
      original_text: normalized.summary,
      questions: textQuestions(
        (normalized.payload as { unresolved_questions?: unknown })
          .unresolved_questions,
      ),
      intent: normalized.intent,
    });
    this.transition(key, ["EXECUTING", "VERIFYING"], "WAITING_INPUT", "execute", {
      blocker: {
        code:
          normalized.intent === "need_user"
            ? "NEED_USER"
            : "EXECUTION_INTENT_UNCLEAR",
        message:
          normalized.summary ??
          (normalized.intent === "need_user"
            ? "执行需要用户输入"
            : "未能辨认本轮结果。请说明：已完成、需要规划澄清，或需要用户输入。"),
      },
    });
    return { status: normalized.intent, summary: normalized.summary };
  }
  restoreFailedRole(key: string, reason: string) {
    const current = this.get(key);
    if (!["STOPPED", "BLOCKED", "RECOVERY_REQUIRED", "WAITING_AUTHORIZATION"].includes(current.state)) return;
    const interruption = this.store.get<{ run_id?: string; prior_state?: string }>("interruption", key);
    if (current.state === "STOPPED" && interruption?.run_id === current.run_id &&
        interruption?.prior_state === "HUMAN_PENDING") return;
    const review = this.restoreReviewRole(key, reason);
    if (review) return review;
    return this.restorePlanningRole(key, reason);
  }
  private resumeFeedback(w: Workflow, reason: string) {
    if (!reason || reason === "用户恢复执行") return w.feedback;
    return [...w.feedback, reason];
  }
  private restoreReviewRole(key: string, reason: string) {
    const w = this.get(key);
    const run = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    const continuation = boundRunContinuation(this.store, w.run_id);
    if (!isReviewRole(continuation, run)) return;
    if (!run || run.workflow_id !== key || run.plan_revision !== w.plan_revision) return;
    const waiting = readWaitingContext(this.store, key);
    const staged = readRunContinuation(this.store, key);
    const pendingReview = (waiting?.purpose === "review" && waiting.run_id === run.id) ||
      (staged?.purpose === "review" && staged.source_run_id === run.id);
    if (run.status === "completed" && !pendingReview && w.state !== "RECOVERY_REQUIRED") return;
    if (continuation) saveRunContinuation(this.store, key, key, continuation);
    this.store.remove("model_retry", key);
    const phase = continuation?.phase ?? this.reviewPointer(key).phase;
    this.patchReviewPointer(key, {
      ...(phase ? { phase } : {}),
      review_run_id: continuation?.source_run_id || run?.id,
    });
    const stage =
      phase === "before_human" || run?.stage === BEFORE_HUMAN_REVIEW_STAGE
        ? BEFORE_HUMAN_REVIEW_STAGE
        : "review";
    const next = this.transition(key, [w.state], "REVIEW_QUEUED", stage, {
      feedback: this.resumeFeedback(w, reason),
      blocker: undefined,
    });
    this.scheduler.enqueue(key, w.project_id);
    this.store.enqueue(key, "dispatch", {});
    return next;
  }
  private restorePlanningRole(key: string, reason: string) {
    const w = this.get(key);
    const run = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    const handoff = readPlanningHandoff(this.store, key);
    const waiting = readWaitingContext(this.store, key);
    if (
      isCurrentPlanningSource({
        handoff,
        waiting,
        state: w.state,
        blockerCode: w.blocker?.code,
        runId: w.run_id,
        run,
      })
    ) {
      const continuation = boundRunContinuation(this.store, w.run_id);
      if (continuation?.purpose === "planning")
        saveRunContinuation(this.store, key, key, continuation);
      this.store.remove("model_retry", key);
      const next = this.transition(key, [w.state], "PLANNING", "planning", {
        run_id: undefined,
        feedback: this.resumeFeedback(w, reason),
        blocker: undefined,
      });
      this.store.enqueue(key, "dispatch_run", { purpose: "planning" });
      return next;
    }
    if (isOpenPlanningHandoff(handoff) && isSubsequentExecuteRun(run)) {
      savePlanningHandoff(this.store, key, {
        ...handoff,
        status: "superseded",
      });
    }
  }
  resumeFromWaiting(
    key: string,
    text: string,
    waiting: WaitingContext,
  ) {
    const w = this.get(key);
    const userAnswer = waiting.intent === "need_user";
    const continuation = continuationFromWaiting(waiting, {
      kind: userAnswer
        ? "user_answer"
        : waiting.intent === "unclear" || waiting.continuation
          ? "intent_clarification"
          : "runtime_resume",
      ...(userAnswer ? { answer: text } : {}),
    });
    saveRunContinuation(this.store, key, key, continuation);
    const feedback =
      userAnswer || text !== "用户恢复执行" ? [...w.feedback, text] : w.feedback;
    if (waiting.purpose === "review") {
      this.patchReviewPointer(key, {
        phase: waiting.phase,
        review_run_id: waiting.run_id,
      });
      const next = this.transition(
        key,
        [w.state],
        "REVIEW_QUEUED",
        waiting.phase === "before_human"
          ? BEFORE_HUMAN_REVIEW_STAGE
          : "review",
        { feedback, blocker: undefined },
      );
      this.scheduler.enqueue(key, w.project_id);
      this.store.enqueue(key, "dispatch", {});
      return next;
    }
    if (isPlanningWaiting(waiting)) {
      this.ensurePlanningHandoffFromWaiting(key, waiting);
      const next = this.transition(key, [w.state], "PLANNING", "planning", {
        run_id: undefined,
        feedback,
        blocker: undefined,
      });
      this.store.enqueue(key, "dispatch_run", { purpose: "planning" });
      return next;
    }
    const next = this.transition(key, [w.state], "QUEUED", "execute", {
      feedback,
      blocker: undefined,
    });
    this.scheduler.enqueue(key, w.project_id);
    this.store.enqueue(key, "dispatch", {});
    return next;
  }
  private ensurePlanningHandoffFromWaiting(
    key: string,
    waiting: WaitingContext,
  ) {
    const current = readPlanningHandoff(this.store, key);
    if (current && ["pending", "assigned"].includes(current.status)) return;
    savePlanningHandoff(this.store, key, {
      handoff_id: id("pho"),
      source_run_id: waiting.run_id ?? waiting.source_execution_run_id ?? "",
      source_role: "executor",
      source_conversation_id: waiting.conversation_id,
      original_text: waiting.original_text,
      questions: waiting.questions,
      target_role: "planner",
      status: "pending",
    });
  }
  private workspaceWriteKeys(key: string) {
    return this.store
      .list<Workspace>("workspace", key)
      .map((ws) => "write:" + ws.root.toLowerCase());
  }
  private holdsWorkspaceWrite(key: string) {
    const keys = this.workspaceWriteKeys(key);
    return (
      keys.length > 0 &&
      keys.every((lock) => {
        const lease = this.store.get<{ owner: string; status: string }>(
          "lease",
          lock,
        );
        return lease?.owner === key && lease.status === "active";
      })
    );
  }
  private async withWorkspaceWrite<T>(
    key: string,
    runId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const keys = this.workspaceWriteKeys(key);
    if (!keys.length || this.holdsWorkspaceWrite(key)) return fn();
    requireCondition(
      this.scheduler.acquire(key, runId, keys),
      "WORKSPACE_BUSY",
      "工作区正在使用",
    );
    try {
      return await fn();
    } finally {
      this.scheduler.release(key, runId, keys, true);
    }
  }
  private async applyCommitOutcome(
    key: string,
    outcome: {
      hasConflict?: boolean;
      conflictRequest?: MergeConflictRequest;
      needsVerification?: boolean;
    },
  ) {
    if (outcome.hasConflict) {
      this.transition(
        key,
        ["COMMITTING", "COMMIT_PARTIAL"],
        "EXECUTING",
        "merge_conflict_resolution",
        { run_id: outcome.conflictRequest?.run_id },
      );
      return;
    }
    if (outcome.needsVerification) {
      this.patchReviewPointer(key, { phase: "after_human" });
      this.transition(
        key,
        ["COMMITTING", "COMMIT_PARTIAL"],
        "REVIEW_QUEUED",
        "review",
      );
      this.scheduler.enqueue(key, this.get(key).project_id);
      this.store.enqueue(key, "dispatch", {});
    }
  }
  block(key: string, error: unknown) {
    error = normalizeRuntimeFailure(error);
    const w = this.get(key);
    if (
      [
        "COMMITTED",
        "COMPLETED",
        "CLEANUP_PENDING",
        "COMMIT_PARTIAL",
        "STOPPED",
        "STOPPING",
      ].includes(w.state)
    )
      return;
    const code = error instanceof FlowError ? error.code : "INTERNAL_FAILURE";
    const message = error instanceof Error ? error.message : String(error);
    const run = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    const frozen = run?.frozen_invocation ?? run?.model_binding?.frozen_invocation;
    if (frozen && (code === "MODEL_AUTH" || code === "MODEL_LOGIN_REQUIRED" || code === "MODEL_FORBIDDEN")) {
      new ModelAccessService(this.store).invalidate(
        frozen,
        code === "MODEL_FORBIDDEN" ? "MODEL_FORBIDDEN" : "MODEL_LOGIN_REQUIRED",
      );
    }
    this.store.put("interruption", key, key, {
      category: "error",
      source: "runtime",
      at: now(),
      prior_state: w.state,
      prior_stage: w.stage,
      prior_purpose: run?.purpose,
      prior_run_id: w.run_id,
      run_id: w.run_id,
      repair_batch_id: run?.repair_batch_id,
      logical_round_id: run?.logical_round_id,
      message,
      next_action: "处理错误后继续这个任务",
      ...(error instanceof FlowError ? { details: error.details } : {}),
    });
    this.transition(key, [w.state], "BLOCKED", "blocked", {
      blocker: {
        code,
        message,
      },
    });
    if (code === "MODEL_QUOTA" && error instanceof FlowError)
      scheduleModelRetry(
        this,
        key,
        String(
          (error.details as any)?.result?.error ??
            (error.details as any)?.diagnostic ??
            "",
        ),
      );
  }
  recover() {
    for (const w of this.list()) {
      if (
        w.state !== "BLOCKED" ||
        w.blocker?.code !== "MODEL_QUOTA" ||
        this.store.get("model_retry", w.id)
      )
        continue;
      const result = this.store
        .recentEvents(w.id, 100)
        .reverse()
        .find(
          (e) =>
            e.run_id === w.run_id && (e.payload as any)?.event === "result",
        );
      if (result)
        scheduleModelRetry(
          this,
          w.id,
          String((result.payload as any)?.result?.error ?? ""),
          Date.parse(result.created_at),
        );
    }
    for (const w of this.list())
      if (w.state === "QUEUED" || (w.state === "PLANNING" && !w.run_id))
        this.scheduler.enqueue(w.id, w.project_id);
    for (const w of this.list())
      if (
        [
          "EXECUTING",
          ...(w.state === "PLANNING" && w.run_id ? ["PLANNING"] : []),
          "VERIFYING",
          "HUMAN_PENDING",
          "REVIEW_QUEUED",
          "REVIEWING",
          "STOPPING",
          "COMMITTING",
          "INTEGRATING",
        ].includes(w.state)
      ) {
        if (w.run_id) this.auth.revokeRun(w.run_id);
        this.transition(
          w.id,
          [w.state],
          ["COMMITTING", "INTEGRATING"].includes(w.state)
            ? "COMMIT_PARTIAL"
            : "RECOVERY_REQUIRED",
          "recovery",
          {
            blocker: {
              code: "CONTROLLER_RESTARTED",
              message:
                "控制器重启；Host 管道关闭后会终止子进程。核实进程和工作区后才能重试。",
            },
          },
        );
      }
    this.scheduler.suspectExpired(0);
  }
  exportDocuments(key: string) {
    const w = this.get(key);
    if (!w.plan_revision) return;
    const p = this.plan(key);
    const root = join(
      this.config.storage_root,
      "documents",
      key,
      `r${w.plan_revision}`,
    );
    mkdirSync(root, { recursive: true });
    atomicWrite(join(root, "计划.md"), p.plan.markdown ?? "");
    const planCheck = this.planSelfCheck.current(key);
    if (planCheck) {
      const revision =
        planCheck.delivery_revision_id &&
        this.store.get<DeliveryRevision>(
          "delivery_revision",
          planCheck.delivery_revision_id,
        );
      const report =
        revision &&
        this.store.get<Delivery>("delivery", revision.delivery_id)?.manifest
          .plan_self_check;
      atomicWrite(
        join(root, "执行模型计划复核.md"),
        `# 执行模型正式计划复核\n\n本文件为执行事实记录，不是实施计划。状态：${planCheck.status}；计划版本：${planCheck.plan_revision}。\n\n` +
          `请求：${planCheck.id}；源交付：${planCheck.source_delivery_revision_id}；复核轮次：${planCheck.run_id ?? "待调度"}。\n\n` +
          (report
            ? report.checks
                .map(
                  (c) =>
                    `- ${c.check_id}：${c.status}；${c.evidence.join("；")}`,
                )
                .join("\n")
            : "尚无通过的逐项复核报告。") +
          "\n",
      );
    }
    const allEvidence = [
      ...this.store.list<Evidence>("evidence", key),
      ...this.store.list<Evidence>("development_evidence", key),
    ];
    const progress = testProgress(p.plan, allEvidence, w);
    const tasks = this.taskStatus(key)
      .map((t) => {
        const definition = p.plan.tasks.find((task) => task.id === t.id)!;
        return `### ${t.id} ${t.title}\n\n-[${t.development_status === "completed" ? "x" : " "}] 开发完成：${({ completed: "已完成", active: "进行中", needs_changes: "需修改", check_failed: "自检未通过", pending_check: "待检查", pending: "未开始" } as Record<string, string>)[t.development_status] ?? t.development_status}\n\n- [${t.validation_status === "passed" ? "x" : " "}] 验证完成：${({ passed: "已通过", failed: "未通过", stale: "需重测", not_run: "未验证" } as Record<string, string>)[t.validation_status]}\n\n修改位置：${definition.repo_id ?? "默认仓库"} / ${definition.paths.join("、")}\n\n输入：${definition.inputs}\n\n核心实现：${definition.implementation}\n\n保持行为：${definition.preserve}\n\n完成标准：${definition.completion}\n\n前置任务：${definition.depends_on.join("、") || "无"}；关联测试：${definition.test_ids.join("、")}\n\n停止条件：${definition.stop_conditions}\n\n实际声明：${t.summary || "尚未提交"}\n`;
      })
      .join("\n");
    const tests = p.plan.tests
      .map((t) => {
        const e = latestEvidence(allEvidence, t.id, w);
        return `### ${t.id} / ${t.layer}\n\n-[${e?.status === "passed" && progressEvidence(e, w) ? "x" : " "}] ${e?.status ?? "not_run"}\n\n关联任务：${t.task_ids.join("、")}；用例清单：\n${progress.cases
          .filter((c) => c.test_id === t.id)
          .map(
            (c) =>
              `- [${c.status === "passed" ? "x" : " "}] ${c.id} · ${({ passed: "已通过", failed: "未通过", skipped: "已跳过", stale: "需重测", not_run: "未运行", missing: "缺少结果" } as Record<string, string>)[c.status]}`,
          )
          .join(
            "\n",
          )}\n\n操作步骤：\n${t.steps.map((step, i) => `${i + 1}. ${step}`).join("\n")}\n\n断言：\n${t.assertions.map((a) => "- " + a).join("\n")}\n\n${e ? `证据：${e.id}\n\n快照：${e.snapshot_id}；环境：${e.environment_revision}\n\n结果：发现 ${e.discovered}，通过 ${e.passed}，失败 ${e.failed}，跳过 ${e.skipped}，退出码 ${e.exit_code}\n\n原始文件：\n${e.files.map((f) => "- " + f.path + " / SHA-256 " + f.hash).join("\n")}` : "尚无运行证据。"}\n`;
      })
      .join("\n");
    if (p.plan.complexity === "complex") {
      atomicWrite(
        join(root, "开发进度.md"),
        `# 开发进度\n\n计划哈希：${p.hash}\n状态：${w.state}\n\n${tasks}\n`,
      );
      atomicWrite(join(root, "测试进度.md"), `# 测试进度\n\n${tests}\n`);
    } else
      atomicWrite(
        join(root, "计划.md"),
        `${p.plan.markdown}\n\n## 开发进度\n\n${tasks}\n\n## 测试进度\n\n${tests}\n`,
      );
  }
  // Read-only presentation: keep runner case names in review evidence, but use
  // the submitted plan scene IDs when counting the plan's displayed results.
  displayEvidence(key: string): Evidence[] {
    const evidence = this.getEvidence(key);
    if (resolveTaskModel(this.plan(key).plan) !== "native-v2") return evidence;
    const results = this.store.list<AcceptanceResult>("acceptance_result", key);
    return evidence.map((e) => {
      const source = results.find((r) => r.id === e.id);
      const expected = this.plan(key).plan.tests.find((t) => t.id === e.test_id)
        ?.expected_case_ids ?? [];
      const cases = source
        ? results.filter((r) =>
            r.delivery_id === source.delivery_id && r.requirement_id === e.test_id,
          ).map((r) => ({
            id: expected.includes(r.scene_id) ? r.scene_id : r.case_id,
            status: r.status,
          }))
        : [];
      return { ...e, cases, case_ids: cases.map((c) => c.id) };
    });
  }
  // Display an existing confirmation only; never infer it from workflow order.
  displayHumanAccepted(key: string): boolean {
    const w = this.get(key);
    const acceptance = this.store.get<any>("acceptance", key);
    return !!acceptance &&
      ((acceptance.snapshot_id ?? null) === (w.snapshot_id ?? null) ||
        (!!w.snapshot_id && acceptance.commit_snapshot_id === w.snapshot_id)) &&
      acceptance.plan_revision === w.plan_revision &&
      acceptance.environment_revision === w.environment_revision;
  }
  activeNativeDelivery(key: string): {
    revision: DeliveryRevision;
    delivery: Delivery;
  } | null {
    if (resolveTaskModel(this.plan(key).plan) !== "native-v2") return null;
    const workflow = this.get(key);
    const revision = this.store
      .list<DeliveryRevision>("delivery_revision", key)
      .reverse()
      .find((r) => !r.invalidated);
    if (
      !revision ||
      revision.plan_revision !== workflow.plan_revision ||
      revision.plan_hash !== workflow.plan_hash ||
      revision.snapshot_id !== workflow.snapshot_id ||
      !revision.execution_finished ||
      this.store.get<Run>("run", revision.run_id!)?.status !== "completed"
    )
      return null;
    const delivery = this.store.get<Delivery>("delivery", revision.delivery_id);
    if (!delivery || delivery.status !== "passed") return null;
    return { revision, delivery };
  }
  deliveryReportFiles(delivery: Delivery): { path: string; hash: string }[] {
    return Object.entries(delivery.report_hashes ?? {}).map(
      ([relPath, hash]) => ({
        path: join(
          this.config.storage_root,
          "deliveries",
          delivery.id,
          "reports",
          relPath,
        ),
        hash,
      }),
    );
  }
  reviewDeliveryMaterials(key: string) {
    const active = this.activeNativeDelivery(key);
    const evidence = this.getEvidence(key);
    if (!active)
      return {
        delivery: null,
        reports: [] as { path: string; hash: string }[],
        open_issues: [] as { code: string; message: string }[],
        evidence_ids: evidence.map((e) => e.id),
      };
    const { delivery } = active;
    return {
      delivery: {
        id: delivery.id,
        status: delivery.status,
        run_id: delivery.run_id,
        submitted_at: delivery.submitted_at,
        implementations: delivery.manifest.implementations ?? [],
        test_executions: delivery.manifest.test_executions ?? [],
        acceptance_mappings: delivery.manifest.acceptance_mappings ?? [],
      },
      reports: this.deliveryReportFiles(delivery),
      open_issues: this.store
        .list<DeliveryIssue>("delivery_issue", key)
        .filter(
          (issue) =>
            issue.delivery_id === delivery.id && issue.status === "open",
        )
        .map((issue) => ({ code: issue.code, message: issue.message })),
      evidence_ids: evidence.map((e) => e.id),
    };
  }
  getEvidence(key: string): Evidence[] {
    const existing = this.store.list<Evidence>("evidence", key);
    if (
      existing.length > 0 &&
      resolveTaskModel(this.plan(key).plan) !== "native-v2"
    )
      return existing;
    const plan = this.plan(key).plan;
    if (resolveTaskModel(plan) !== "native-v2") return [];
    const active = this.activeNativeDelivery(key);
    if (!active) return [];
    const { revision, delivery } = active;
    const files = this.deliveryReportFiles(delivery);
    const acceptances = this.store
      .list<AcceptanceResult>("acceptance_result", key)
      .filter((a) => a.delivery_id === delivery.id && a.status === "passed");
    if (acceptances.length === 0) {
      if (files.length === 0) return [];
      return [
        this.unmappedReportEvidence(key, delivery, revision, files),
      ];
    }
    const grouped = new Map<string, AcceptanceResult[]>();
    for (const a of acceptances)
      grouped.set(a.requirement_id, [
        ...(grouped.get(a.requirement_id) ?? []),
        a,
      ]);
    return [...grouped.values()].map((group) => {
      const a = group[0]!;
      const caseIds = [...new Set(group.map((item) => item.case_id))];
      const testDef = plan.tests.find((t) => t.id === a.requirement_id);
      const ev: Evidence = {
        id: a.id,
        workflow_id: key,
        test_id: a.requirement_id,
        status: "passed",
        phase: "delivery",
        layer: testDef?.layer ?? "unit",
        environment_revision: this.get(key).environment_revision,
        run_id: revision.run_id ?? delivery.run_id,
        plan_revision: revision.plan_revision,
        snapshot_id: revision.snapshot_id ?? "",
        case_ids: caseIds,
        cases: caseIds.map((id) => ({ id, status: "passed" as const })),
        passed: caseIds.length,
        failed: 0,
        skipped: 0,
        discovered: caseIds.length,
        exit_code: 0,
        files,
        created_at: delivery.submitted_at,
      };
      return ev;
    });
  }
  private unmappedReportEvidence(
    key: string,
    delivery: Delivery,
    revision: DeliveryRevision,
    files: { path: string; hash: string }[],
  ): Evidence {
    return {
      id: "ev-" + delivery.id,
      workflow_id: key,
      test_id: "delivery-reports",
      status: "passed",
      phase: "delivery",
      layer: "unit",
      environment_revision: this.get(key).environment_revision,
      run_id: revision.run_id ?? delivery.run_id,
      plan_revision: revision.plan_revision,
      snapshot_id: revision.snapshot_id ?? "",
      case_ids: [],
      cases: [],
      passed: 0,
      failed: 0,
      skipped: 0,
      discovered: 0,
      exit_code: 0,
      files,
      created_at: delivery.submitted_at,
    };
  }
}

function markOpenIssuesFixing(engine: Engine, key: string, batchId?: string) {
  const issues = new FunctionalIssueService(engine.store);
  const allowed = batchIssueIds(engine, key, batchId);
  for (const issue of issues.listIssues(key).filter((item) => item.status === "open")) {
    if (allowed && !allowed.has(issue.issue_id)) continue;
    issues.markFixing(key, issue.issue_id);
  }
}

function issueInRepairBatch(
  engine: Engine,
  key: string,
  run: Run,
  issueId: string,
) {
  const allowed = batchIssueIds(engine, key, run.repair_batch_id);
  if (!allowed) return true;
  return allowed.has(issueId);
}

function batchIssueIds(engine: Engine, key: string, batchId?: string) {
  if (!batchId) return undefined;
  const batch = engine.store.get<{ issue_ids?: string[]; workflow_id?: string }>(
    "repair_model_batch",
    batchId,
  );
  if (!batch || batch.workflow_id !== key) return new Set<string>();
  return new Set(batch.issue_ids ?? []);
}
