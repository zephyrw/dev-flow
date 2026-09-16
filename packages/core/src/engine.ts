import { matchesCommand } from "../../evidence/src/command-match.js";
import { workflowAttention } from "./attention.js";
import { scheduleModelRetry } from "./model-retry.js";
import { repairFailure } from "./repair.js";
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
  DeliveryManifestSchema,
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
  resolveTaskModel,
} from "../../contracts/src/index.js";
import type { Config } from "../../contracts/src/config.js";
import { Store } from "../../store/src/store.js";
import { Auth, type Principal } from "./auth.js";
import { atomicWrite, id, now, objectHash, hash } from "./util.js";
import { parsePlanDiagrams } from "../../plans/src/diagrams.js";
import { validatePlan } from "../../plans/src/validate.js";
import { GitManager, repositoryInfo } from "../../git/src/git.js";
import { Scheduler } from "../../scheduler/src/scheduler.js";
import { FileBroker } from "../../workspace/src/files.js";
import { DeliveryImporter } from "../../evidence/src/delivery-importer.js";
import { EvidenceValidator } from "../../evidence/src/validator.js";
import {
  type HostToolExecutionFact,
  NativeRunRecordReader,
} from "../../evidence/src/native-run-records.js";
import { WorkspaceFingerprintService } from "../../workspace/src/fingerprint.js";

export interface PlanRecord {
  id: string;
  workflow_id: string;
  revision: number;
  hash: string;
  plan: Plan;
  created_at: string;
}
export interface Runtime {
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
  runtime?: Runtime;
  private busy = new Set<string>();
  private dispatching = false;
  private running = new Set<string>();
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
          ...this.store.list<Evidence>("evidence", key),
          ...this.store.list<Evidence>("development_evidence", key),
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
      attention: workflowAttention(this, key),
      plan: w.plan_revision ? this.plan(key) : null,
      workspaces: this.store.list<Workspace>("workspace", key),
      runs: this.store.list<Run>("run", key),
      evidence: this.store.list<Evidence>("evidence", key),
      tasks: this.taskStatus(key, verifyFiles),
      test_progress: testProgress(
        w.plan_revision ? this.plan(key).plan : null,
        [
          ...this.store.list<Evidence>("evidence", key),
          ...this.store.list<Evidence>("development_evidence", key),
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
            "SELECT data FROM events WHERE workflow_id=? AND json_extract(data, '$.type') NOT IN ('ServiceOutput','FixtureOutput','CheckOutput','BuildOutput','AgentEvent') ORDER BY seq DESC LIMIT 500",
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
              !["COMMITTED", "STOPPED", "RESEARCHING"].includes(w.state),
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
      const snapshot = this.store.must<Snapshot>("snapshot", w.snapshot_id!);
      requireCondition(
        await this.git.matches(snapshot),
        "SNAPSHOT_CHANGED",
        "代码变化，请重新测试",
      );
      const revisions = this.store.list<DeliveryRevision>(
        "delivery_revision",
        key,
      );
      const activeRev = revisions
        .reverse()
        .find((r) => !r.invalidated && r.plan_revision === w.plan_revision);
      if (activeRev) {
        const runId = activeRev.run_id || w.run_id;
        const run = runId ? this.store.get<Run>("run", runId) : null;
        requireCondition(
          run != null &&
            run.status === "completed" &&
            activeRev.execution_finished,
          run?.status === "running"
            ? "EXECUTION_NOT_FINISHED"
            : "EXECUTION_FAILED",
          run?.status === "running"
            ? "执行器进程仍在运行中，等待执行器正常退出后开放人工验收"
            : `执行器未成功完成 (当前状态: ${run?.status ?? "unknown"})，不能开放人工验收`,
        );
      } else if (w.run_id) {
        const run = this.store.get<Run>("run", w.run_id);
        if (run) {
          requireCondition(
            run.status !== "running",
            "EXECUTION_NOT_FINISHED",
            "执行器进程仍在运行中，等待执行器正常退出后开放人工验收",
          );
          requireCondition(
            run.status === "completed",
            "EXECUTION_FAILED",
            `执行器未成功完成 (当前状态: ${run.status})，不能开放人工验收`,
          );
        }
      }
      this.verifyEvidence(key);
      await this.runtime?.validateEnvironment?.(w);
      this.store.transaction(() => {
        this.auth.consumeProof(proof, "accept", binding);
        this.store.put("acceptance", key, key, {
          snapshot_id: snapshot.id,
          environment_revision: w.environment_revision,
          plan_revision: w.plan_revision,
          proof,
          accepted_at: now(),
        });
        this.transition(key, ["HUMAN_PENDING"], "REVIEW_QUEUED", "review");
        this.scheduler.enqueue(key, w.project_id);
        this.store.enqueue(key, "dispatch", {});
      });
      return this.get(key);
    });
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
    if (scope === "within_plan") this.assertProjectConfiguration(key);
    this.store.remove("model_retry", key);
    this.store.remove("repair_state", key);
    this.invalidate(key, "用户反馈");
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
    if (resolveTaskModel(plan) === "native-v2") {
      const activeRev = this.store
        .list<DeliveryRevision>("delivery_revision", key)
        .reverse()
        .find((r) => !r.invalidated && r.plan_revision === w.plan_revision);
      const passedDelivery = activeRev
        ? this.store
            .list<Delivery>("delivery", key)
            .find(
              (d) => d.id === activeRev.delivery_id && d.status === "passed",
            )
        : undefined;
      const acceptanceResults = passedDelivery
        ? this.store
            .list<AcceptanceResult>("acceptance_result", key)
            .filter((r) => r.delivery_id === passedDelivery.id)
        : [];
      const allPassed =
        !!passedDelivery &&
        !!activeRev?.execution_finished &&
        this.store.get<Run>("run", activeRev.run_id ?? "")?.status ===
          "completed" &&
        acceptanceResults.length > 0 &&
        acceptanceResults.every((r) => r.status === "passed");

      return plan.tasks.map((t) => {
        const hasImpl = passedDelivery?.manifest.implementations.some(
          (i) => !i.task_id || i.task_id === t.id,
        );
        const verified = allPassed && !!hasImpl;
        return {
          id: t.id,
          title: t.title,
          module_id: t.module_id,
          completed: verified,
          development_status: verified ? "completed" : "pending",
          validation_status: verified ? "passed" : "not_run",
          implementation_status: verified ? "completed" : "pending",
          has_implementation: !!hasImpl,
          status: verified ? "verified" : "pending",
          summary: verified ? `已通过终局核验交付 (${passedDelivery!.id})` : "",
          completed_at: verified ? passedDelivery?.submitted_at : undefined,
          started_at: undefined,
          recheck_reason: undefined,
        };
      });
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
  verifyEvidence(key: string, allowPending = false) {
    const w = this.get(key),
      plan = this.plan(key).plan;
    if (resolveTaskModel(plan) === "native-v2") {
      const activeRev = this.store
        .list<DeliveryRevision>("delivery_revision", key)
        .reverse()
        .find((r) => !r.invalidated && r.plan_revision === w.plan_revision);
      requireCondition(
        activeRev,
        "TEST_EVIDENCE_MISSING",
        "缺少当前计划版本的有效交付核验结果",
      );
      const passedDelivery = this.store
        .list<Delivery>("delivery", key)
        .find((d) => d.id === activeRev!.delivery_id && d.status === "passed");
      requireCondition(
        passedDelivery,
        "TEST_EVIDENCE_MISSING",
        "缺少当前计划版本的有效交付核验结果",
      );
      requireCondition(
        activeRev.plan_hash === w.plan_hash &&
          activeRev.snapshot_id === w.snapshot_id,
        "EVIDENCE_STALE",
        "交付版本与当前计划或快照不一致",
      );
      const sources = this.store.list<Workspace>("workspace", key);
      requireCondition(sources.length > 0, "WORKSPACE_MISSING", "缺少工作区");
      for (const ws of sources)
        requireCondition(
          WorkspaceFingerprintService.compute(ws.root).fingerprint ===
            activeRev.input_fingerprints[ws.repo_id],
          "FINGERPRINT_STALE",
          "测试后工作区输入发生变化: " + ws.repo_id,
        );
      if (!allowPending)
        requireCondition(
          activeRev.execution_finished &&
            this.store.get<Run>("run", activeRev.run_id ?? "")?.status ===
              "completed",
          "EXECUTION_NOT_FINISHED",
          "执行器尚未成功完成",
        );
      if (passedDelivery.report_hashes) {
        for (const [relReport, expectedHash] of Object.entries(
          passedDelivery.report_hashes,
        )) {
          let reportPath = join(
            this.config.storage_root,
            "deliveries",
            passedDelivery.id,
            "reports",
            relReport,
          );
          if (!existsSync(reportPath) && relReport.includes("::")) {
            const parts = relReport.split("::");
            if (parts.length >= 2 && parts[0] && parts[1]) {
              const candidate = join(
                this.config.storage_root,
                "deliveries",
                passedDelivery.id,
                "reports",
                parts[0],
                parts[1],
              );
              if (existsSync(candidate)) {
                reportPath = candidate;
              }
            }
          }
          requireCondition(
            existsSync(reportPath) &&
              hash(readFileSync(reportPath)) === expectedHash,
            "EVIDENCE_TAMPERED",
            `交付归档测试报告 '${relReport}' 不存在或已被篡改`,
          );
        }
      }
      requireCondition(
        allowPending ||
          this.taskStatus(key).every((t) => t.status === "verified"),
        "TASK_INCOMPLETE",
        "任务尚未全部完成",
      );
      return;
    }
    const evidence = this.store.list<Evidence>("evidence", key);
    for (const t of plan.tests) {
      const selected = latestEvidence(evidence, t.id, w);
      const e =
        currentEvidence(selected, w) && selected!.status === "passed"
          ? selected
          : undefined;
      requireCondition(
        e,
        "TEST_EVIDENCE_MISSING",
        `缺少当前快照的 ${t.id} 通过证据`,
      );
      for (const f of e.files)
        requireCondition(
          existsSync(f.path) && hash(readFileSync(f.path)) === f.hash,
          "EVIDENCE_TAMPERED",
          "测试证据文件被修改",
        );
    }
    requireCondition(
      this.taskStatus(key).every((t) => t.status === "verified"),
      "TASK_INCOMPLETE",
      "任务尚未全部完成",
    );
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
    this.verifyEvidence(key);
    await this.runtime?.validateEnvironment?.(w);
    requireCondition(
      await this.git.matches(this.store.must("snapshot", w.snapshot_id!)),
      "SNAPSHOT_CHANGED",
      "测试期间代码发生变化",
    );
    return {
      status: "ready",
      message: "证据已齐备；等待执行器进程正常退出后开放人工验收。",
    };
  }
  async deliver(
    key: string,
    manifest: DeliveryManifest,
    hostRecordReader?: NativeRunRecordReader,
  ) {
    return this.exclusive(key, async () => {
      const w = this.get(key);
      requireCondition(
        resolveTaskModel(this.plan(key).plan) === "native-v2",
        "INVALID_MODE",
        "只有原生模式可以提交交付清单",
      );

      const parsed = DeliveryManifestSchema.safeParse(manifest);
      if (!parsed.success)
        return {
          status: "rejected",
          message: "交付清单格式无效",
          issues: [
            {
              code: "INVALID_DELIVERY_MANIFEST",
              message: parsed.error.message,
            },
          ],
        };
      manifest = parsed.data;

      // 幂等性检查 (C08 / R11, R12)
      if (manifest.submission_id) {
        const existingDeliveries = this.store.list<Delivery>("delivery", key);
        const matchedDelivery = existingDeliveries.find(
          (d) => d.manifest.submission_id === manifest.submission_id,
        );
        if (matchedDelivery) {
          const currentHash = objectHash(manifest);
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
              try {
                this.verifyEvidence(key, true);
              } catch (error) {
                return {
                  status: "rejected",
                  delivery_id: matchedDelivery.id,
                  message: String(error),
                  issues: [
                    { code: "EVIDENCE_INVALIDATED", message: String(error) },
                  ],
                };
              }
              const acceptanceResults = this.store
                .list<AcceptanceResult>("acceptance_result", key)
                .filter((r) => r.delivery_id === matchedDelivery.id);
              return {
                status: "accepted",
                delivery_id: matchedDelivery.id,
                state: this.get(key).state,
                message:
                  "交付核验已记录；只有当前执行器成功结束后才开放人工验收。",
                acceptance_results: acceptanceResults,
              };
            } else {
              const issues = this.store
                .list<DeliveryIssue>("delivery_issue", key)
                .filter((i) => i.delivery_id === matchedDelivery.id);
              return {
                status: "rejected",
                delivery_id: matchedDelivery.id,
                message: `终局核验未通过，共发现 ${issues.length} 个问题，请参考 issues 进行针对性修复后再次交付。`,
                issues,
              };
            }
          } else {
            throw new FlowError(
              "DELIVERY_CONFLICT",
              `提交标识 '${manifest.submission_id}' 已被使用且清单内容不一致，请更换 submission_id 重试`,
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
      const run = this.store.must<Run>("run", w.run_id!);
      const workspaces = this.store.list<Workspace>("workspace", key);
      const workspaceRoot = workspaces[0]?.root ?? this.config.workspace_root;

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

      const importer = new DeliveryImporter(
        this.store,
        this.config.storage_root,
      );
      const importResult = importer.importDelivery({
        workflowId: key,
        runId: run.id,
        planRevision: w.plan_revision,
        workspaceRoot,
        workspaces,
        manifest,
        hostRecordReader,
      });

      const validator = new EvidenceValidator(this.store);
      const validation = validator.validate({
        workflow: w,
        run,
        plan,
        delivery: importResult.delivery,
        archivedReports: importResult.archivedReports,
        hostRecordReader,
        currentInputManifest: importResult.inputManifest,
        inputFingerprints: importResult.inputFingerprints,
        workspaceRoot,
        workspaces,
      });

      if (validation.passed) {
        let snapshotId = w.snapshot_id;
        try {
          const snapshot = await this.git.snapshot(key, w.environment_revision);
          for (const ws of workspaces)
            requireCondition(
              WorkspaceFingerprintService.compute(ws.root).fingerprint ===
                importResult.inputFingerprints[ws.repo_id],
              "FINGERPRINT_STALE",
              "交付冻结期间输入发生变化",
            );
          this.store.put("snapshot", snapshot.id, key, snapshot);
          snapshotId = snapshot.id;
        } catch (snapshotErr: any) {
          const errCode = snapshotErr?.code || "SNAPSHOT_FAILED";
          const errMsg = snapshotErr?.message || String(snapshotErr);
          this.store.put("delivery", importResult.delivery.id, key, {
            ...importResult.delivery,
            status: "rejected",
          });
          const issue: DeliveryIssue = {
            id: id("iss"),
            workflow_id: key,
            delivery_id: importResult.delivery.id,
            code: errCode,
            message: errMsg,
            status: "open",
            created_at: now(),
          };
          this.store.put("delivery_issue", issue.id, key, issue);
          return {
            status: "rejected",
            message: `Git 代码快照冻结失败 (${errCode}): ${errMsg}`,
            issues: [{ code: errCode, message: errMsg }],
          };
        }

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
          conversation_id: manifest.conversation_id,
          created_at: now(),
        };
        this.store.put("delivery_revision", revisionId, key, deliveryRevision);

        this.store.transaction(() => {
          this.store.put("delivery", importResult.delivery.id, key, {
            ...importResult.delivery,
            status: "passed",
          });
          for (const issue of this.store.list<DeliveryIssue>(
            "delivery_issue",
            key,
          ))
            if (issue.status === "open")
              this.store.put("delivery_issue", issue.id, key, {
                ...issue,
                status: "resolved",
                resolved_at: now(),
              });
          for (const task of plan.tasks) {
            this.store.put("task_proof", `${key}-${task.id}`, key, {
              task_id: task.id,
              workflow_id: key,
              run_id: run.id,
              summary: `终局核验通过交付 (${importResult.delivery.id})`,
              completed_at: now(),
              verified: isExecutionFinished,
              hashes: Object.fromEntries(
                (
                  this.store
                    .must<Snapshot>("snapshot", snapshotId!)
                    .repositories.find(
                      (r) =>
                        r.repo_id === (task.repo_id ?? workspaces[0]?.repo_id),
                    )?.files ?? []
                )
                  .filter((f) => task.paths.includes(f.path))
                  .map((f) => [f.path, f.hash]),
              ),
            });
            this.store.put(
              "task_proof",
              `${key}-${w.plan_revision}-${task.id}`,
              key,
              {
                task_id: task.id,
                workflow_id: key,
                run_id: run.id,
                summary: `终局核验通过交付 (${importResult.delivery.id})`,
                completed_at: now(),
                verified: isExecutionFinished,
                hashes: Object.fromEntries(
                  (
                    this.store
                      .must<Snapshot>("snapshot", snapshotId!)
                      .repositories.find(
                        (r) =>
                          r.repo_id ===
                          (task.repo_id ?? workspaces[0]?.repo_id),
                      )?.files ?? []
                  )
                    .filter((f) => task.paths.includes(f.path))
                    .map((f) => [f.path, f.hash]),
                ),
              },
            );
          }

          this.transition(
            key,
            [w.state],
            isExecutionFinished ? "HUMAN_PENDING" : "VERIFYING",
            isExecutionFinished ? "manual_acceptance" : "delivery_received",
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

        return {
          status: "accepted",
          delivery_id: importResult.delivery.id,
          state: this.get(key).state,
          message: "交付核验已记录；只有当前执行器成功结束后才开放人工验收。",
          acceptance_results: validation.acceptanceResults,
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
          message: `终局核验未通过，共发现 ${validation.issues.length} 个问题，请参考 issues 进行针对性修复后再次交付。`,
          issues: validation.issues,
        };
      }
    });
  }
  async finalizeNativeDelivery(key: string, runId: string) {
    const w = this.get(key);
    requireCondition(
      w.run_id === runId &&
        this.store.get<Run>("run", runId)?.status === "completed",
      "EXECUTION_NOT_FINISHED",
      "当前执行轮次未成功结束",
    );
    const rev = this.store
      .list<DeliveryRevision>("delivery_revision", key)
      .reverse()
      .find(
        (r) =>
          !r.invalidated &&
          r.run_id === runId &&
          r.plan_revision === w.plan_revision,
      );
    requireCondition(rev, "TEST_EVIDENCE_MISSING", "当前执行缺少有效交付");
    this.verifyEvidence(key, true);
    requireCondition(
      await this.git.matches(
        this.store.must<Snapshot>("snapshot", rev.snapshot_id!),
      ),
      "SNAPSHOT_CHANGED",
      "交付后代码发生变化",
    );
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
      if (w.state === "VERIFYING")
        this.transition(
          key,
          ["VERIFYING"],
          "HUMAN_PENDING",
          "manual_acceptance",
        );
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
  ) {
    const w = this.get(key);
    requireCondition(
      !["COMMITTED", "COMMITTING", "COMMIT_PARTIAL"].includes(w.state),
      "INVALID_STATE",
      "该阶段不能暂停执行",
    );
    const interruption = {
      category: "pause",
      source,
      at: now(),
      prior_stage: w.stage,
      run_id: w.run_id,
      message:
        source === "local_console"
          ? "你在控制台暂停了执行"
          : "执行已由控制程序暂停",
      next_action: "核实后继续这个任务",
    };
    this.store.put("interruption", key, key, interruption);
    if (w.run_id) this.store.put("run_stop", w.run_id, key, interruption);
    if (w.run_id) this.auth.revokeRun(w.run_id);
    this.store.remove("queue", key);
    this.store.remove("model_retry", key);
    this.transition(key, [w.state], "STOPPING", "stop");
    if (w.run_id) await this.runtime?.stop(w.run_id);
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
  async dispatch() {
    if (this.dispatching || !this.runtime) return;
    this.dispatching = true;
    try {
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
        if (!["QUEUED", "REVIEW_QUEUED"].includes(w.state)) {
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
          message: "已取得执行名额，正在准备任务工作区",
          owners: [],
        });
        this.store.event(
          w.id,
          w.project_id,
          "PreparationStarted",
          { message: "正在准备任务工作区" },
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
      if (!review) {
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
        this.assertProjectConfiguration(key);
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
      w = this.transition(
        key,
        [review ? "REVIEW_QUEUED" : "QUEUED"],
        review ? "REVIEWING" : "EXECUTING",
        review ? "review" : "execute",
        {
          run_id: runId,
          review_request_id: review ? id("review") : w.review_request_id,
          blocker: undefined,
        },
      );
      activated = true;
      this.store.remove("queue_wait", key);
      const deadline = Date.now() + this.config.timeouts.agent_minutes * 60000;
      const run: Run = {
        id: runId,
        workflow_id: key,
        plan_revision: w.plan_revision,
        adapter: review ? "codex" : "agy",
        stage: w.stage,
        status: "running",
        started_at: now(),
        deadline_at: deadline,
        package_hash: objectHash({
          plan: this.plan(key),
          feedback: w.feedback,
          snapshot: w.snapshot_id,
        }),
      };
      this.store.put("run", runId, key, run);
      const timer = setInterval(
        () => this.scheduler.heartbeat(key, runId),
        5000,
      );
      try {
        if (review) {
          const result = await runtime.review(w, run);
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
          if (
            current.run_id === runId &&
            current.state === "VERIFYING" &&
            resolveTaskModel(this.plan(key).plan) !== "native-v2"
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
            ["HUMAN_PENDING", "VERIFYING"].includes(current.state)
          ) {
            // 原生模式下通过 devflow_deliver 已成功核验并进入 HUMAN_PENDING
          } else if (current.state === "EXECUTING") {
            const containerManifest = join(
              this.config.storage_root,
              "containers",
              key,
              "delivery_manifest.json",
            );
            let autoDelivered = false;
            if (existsSync(containerManifest)) {
              try {
                const content = JSON.parse(
                  readFileSync(containerManifest, "utf8"),
                );
                const result = await this.deliver(key, content);
                if (result.status === "accepted") {
                  autoDelivered = true;
                } else {
                  throw new FlowError(
                    "DELIVERY_REJECTED",
                    result.message,
                    422,
                    { issues: result.issues },
                  );
                }
              } catch (error) {
                if (error instanceof FlowError) throw error;
                throw new FlowError(
                  "AUTO_DELIVERY_FAILED",
                  "读取或验证交付清单失败: " + String(error),
                  422,
                );
              }
            }
            if (!autoDelivered && this.get(key).state === "EXECUTING") {
              throw new FlowError(
                "EXECUTION_INCOMPLETE",
                "执行器退出，但未完成测试阶段或提交交付清单",
              );
            }
          }
        }
        const finalState = this.get(key).state;
        const finalStatus = this.store.get("run_stop", runId)
          ? "stopped"
          : finalState === "BLOCKED"
            ? "failed"
            : "completed";
        this.store.put("run", runId, key, {
          ...this.store.must<Run>("run", runId),
          status: finalStatus,
          ended_at: now(),
        });
        if (
          finalStatus === "completed" &&
          !review &&
          resolveTaskModel(this.plan(key).plan) === "native-v2"
        )
          await this.finalizeNativeDelivery(key, runId);
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
        const repair = await repairFailure(this, key, e, runId);
        if (repair?.retry) {
          const current = this.get(key);
          this.invalidate(key, "异常修复，交付证据需重验");
          this.transition(key, [current.state], "QUEUED", "auto_repair", {
            feedback: [...current.feedback, repair.instructions],
            blocker: undefined,
          });
          this.scheduler.enqueue(key, current.project_id);
        } else if (!repair) this.block(key, e);
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
      if (!["QUEUED", "REVIEW_QUEUED"].includes(this.get(key).state))
        this.store.remove("queue_wait", key);
      this.exportDocuments(key);
      this.running.delete(key);
      queueMicrotask(() => void this.dispatch());
    }
  }
  async receiveReview(key: string, input: unknown) {
    const sanitized =
      input && typeof input === "object" ? { ...(input as any) } : input;
    if (sanitized && typeof sanitized === "object" && "id" in sanitized) {
      delete (sanitized as any).id;
    }
    const review = ReviewSchema.parse(sanitized),
      w = this.get(key);
    requireCondition(
      w.state === "REVIEWING" &&
        review.workflow_id === key &&
        review.review_request_id === w.review_request_id &&
        review.plan_revision === w.plan_revision &&
        review.snapshot_id === w.snapshot_id,
      "REVIEW_BINDING_INVALID",
      "复核对象不一致",
    );
    const snapshot = this.store.must<Snapshot>("snapshot", w.snapshot_id!);
    requireCondition(
      await this.git.matches(snapshot),
      "SNAPSHOT_CHANGED",
      "复核期间代码变化",
    );
    this.store.put("review", review.review_request_id, key, {
      ...review,
      id: review.review_request_id,
    });
    const confirmed = review.findings.filter(
      (f) =>
        f.disposition === "confirmed" &&
        ["introduced", "in_scope"].includes(f.relation_to_change),
    );
    if (
      review.verdict !== "pass" ||
      confirmed.length ||
      review.unresolved_questions.length
    ) {
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
    const coverage = review.coverage;
    requireCondition(
      coverage.all_changed_files_reviewed &&
        coverage.all_requirements_checked &&
        coverage.upstream_downstream_checked &&
        coverage.security_checked &&
        coverage.tests_validity_checked,
      "REVIEW_INCOMPLETE",
      "复核覆盖不完整",
    );
    for (const r of snapshot.repositories)
      for (const p of r.changed_paths)
        requireCondition(
          coverage.files.includes(`${r.repo_id}:${p}`),
          "REVIEW_FILE_MISSING",
          `未复核 ${r.repo_id}:${p}`,
        );
    this.verifyEvidence(key);
    const acceptance = this.store.must<{
      snapshot_id: string;
      plan_revision: number;
      environment_revision: number;
    }>("acceptance", key);
    requireCondition(
      acceptance.snapshot_id === w.snapshot_id &&
        acceptance.plan_revision === w.plan_revision &&
        acceptance.environment_revision === w.environment_revision,
      "ACCEPTANCE_STALE",
      "人工验收已失效",
    );
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
    requireCondition(
      approvedPlan.plan.project_config_hash === objectHash(project),
      "PROJECT_CONFIG_CHANGED",
      "项目配置已变化，必须重新制定并批准计划",
    );
    const isNative = resolveTaskModel(approvedPlan.plan) === "native-v2";
    for (const c of project.commands.filter(
      (c) =>
        c.required_before_commit || project.git?.required_hooks.includes(c.id),
    )) {
      if (isNative) {
        const activeRev = this.store
          .list<DeliveryRevision>("delivery_revision", key)
          .reverse()
          .find((r) => !r.invalidated && r.snapshot_id === w.snapshot_id);
        requireCondition(
          !!activeRev,
          "HOOK_EVIDENCE_MISSING",
          `缺少提交前检查 ${c.id}（有效交付版本不存在）`,
        );

        const matched = this.store
          .list<TestExecution>("test_execution", key)
          .filter(
            (e) =>
              e.delivery_id === activeRev!.delivery_id &&
              e.run_id === activeRev!.run_id &&
              e.exit_code === 0 &&
              e.repo_id ===
                (c.repo_id ??
                  this.store.list<Workspace>("workspace", key)[0]?.repo_id) &&
              matchesCommand(e.command, c.executable, c.args ?? []),
          );
        requireCondition(
          matched.length > 0,
          "HOOK_EVIDENCE_MISSING",
          "缺少当前交付的必需检查执行证据: " + c.id,
        );
        if (c.parser !== "none") {
          const delivery = this.store.must<Delivery>(
            "delivery",
            activeRev!.delivery_id,
          );
          const calls = new Set(matched.map((e) => e.tool_call_id));
          const declarations = delivery.manifest.test_executions.filter((e) =>
            calls.has(e.tool_call_id),
          );
          requireCondition(
            declarations.some(
              (e) =>
                e.report_paths.length > 0 &&
                (!c.report_path || e.report_paths.includes(c.report_path)),
            ),
            "HOOK_EVIDENCE_MISSING",
            "缺少必需检查报告: " + c.id,
          );
        }
      } else {
        if (c.parser === "none" || c.id === "build") {
          const hasBuild = this.store
            .recentEvents(key, 500)
            .some((e) => e.type === "BuildReady");
          requireCondition(
            hasBuild,
            "HOOK_EVIDENCE_MISSING",
            `缺少提交前构建 ${c.id}`,
          );
          continue;
        }
        requireCondition(
          this.store
            .list<Evidence>("evidence", key)
            .some(
              (e) =>
                this.plan(key).plan.tests.some(
                  (t) => t.id === e.test_id && t.command_id === c.id,
                ) && e.status === "passed",
            ),
          "HOOK_EVIDENCE_MISSING",
          `缺少提交前检查 ${c.id}`,
        );
      }
    }
    this.transition(key, ["REVIEWING"], "COMMITTING", "commit");
    try {
      await this.git.commit(snapshot, project, review.commit_message);
      this.transition(key, ["COMMITTING"], "COMMITTED", "done");
    } catch (e) {
      this.transition(
        key,
        ["COMMITTING"],
        "COMMIT_PARTIAL",
        "commit_recovery",
        { blocker: { code: "COMMIT_PARTIAL", message: String(e) } },
      );
      throw e;
    }
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
      review.verdict === "pass",
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
      this.transition(key, ["COMMIT_PARTIAL"], "REVIEWING", "commit_recovery");
      return await this.receiveReview(key, review);
    } catch (e) {
      if (this.get(key).state === "REVIEWING")
        this.transition(
          key,
          ["REVIEWING"],
          "COMMIT_PARTIAL",
          "commit_recovery",
          { blocker: { code: "COMMIT_RETRY_FAILED", message: String(e) } },
        );
      throw e;
    } finally {
      this.scheduler.release(key, run, keys, true);
    }
  }
  block(key: string, error: unknown) {
    const w = this.get(key);
    if (
      ["COMMITTED", "COMMIT_PARTIAL", "STOPPED", "STOPPING"].includes(w.state)
    )
      return;
    const code = error instanceof FlowError ? error.code : "INTERNAL_FAILURE";
    const message = error instanceof Error ? error.message : String(error);
    this.store.put("interruption", key, key, {
      category: "error",
      source: "runtime",
      at: now(),
      prior_stage: w.stage,
      run_id: w.run_id,
      message,
      next_action: "处理错误后继续这个任务",
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
        String((error.details as any)?.result?.error ?? ""),
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
      if (w.state === "QUEUED") this.scheduler.enqueue(w.id, w.project_id);
    for (const w of this.list())
      if (
        [
          "EXECUTING",
          "VERIFYING",
          "HUMAN_PENDING",
          "REVIEW_QUEUED",
          "REVIEWING",
          "STOPPING",
          "COMMITTING",
        ].includes(w.state)
      ) {
        if (w.run_id) this.auth.revokeRun(w.run_id);
        this.transition(
          w.id,
          [w.state],
          w.state === "COMMITTING" ? "COMMIT_PARTIAL" : "RECOVERY_REQUIRED",
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
    atomicWrite(join(root, "计划.md"), p.plan.markdown);
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
  getEvidence(key: string): Evidence[] {
    const existing = this.store.list<Evidence>("evidence", key);
    if (
      existing.length > 0 &&
      resolveTaskModel(this.plan(key).plan) !== "native-v2"
    )
      return existing;
    const plan = this.plan(key).plan;
    if (resolveTaskModel(plan) === "native-v2") {
      const activeRev = this.store
        .list<DeliveryRevision>("delivery_revision", key)
        .reverse()
        .find((r) => !r.invalidated);
      const workflow = this.get(key);
      if (
        !activeRev ||
        activeRev.plan_revision !== workflow.plan_revision ||
        activeRev.plan_hash !== workflow.plan_hash ||
        activeRev.snapshot_id !== workflow.snapshot_id ||
        !activeRev.execution_finished ||
        this.store.get<Run>("run", activeRev.run_id!)?.status !== "completed"
      )
        return [];
      const delivery = this.store.get<Delivery>(
        "delivery",
        activeRev.delivery_id,
      );
      if (!delivery || delivery.status !== "passed") return [];
      const acceptances = this.store
        .list<AcceptanceResult>("acceptance_result", key)
        .filter((a) => a.delivery_id === delivery.id && a.status === "passed");
      const grouped = new Map<string, AcceptanceResult[]>();
      for (const a of acceptances)
        grouped.set(a.requirement_id, [
          ...(grouped.get(a.requirement_id) ?? []),
          a,
        ]);
      return [...grouped.values()].map((group) => {
        const a = group[0]!;
        const caseIds = [...new Set(group.map((item) => item.case_id))];
        const files: { path: string; hash: string }[] = [];
        if (delivery.report_hashes) {
          for (const [relPath, h] of Object.entries(delivery.report_hashes)) {
            files.push({
              path: join(
                this.config.storage_root,
                "deliveries",
                delivery.id,
                "reports",
                relPath,
              ),
              hash: h,
            });
          }
        }
        const testDef = plan.tests.find((t) => t.id === a.requirement_id);
        const ev: Evidence = {
          id: a.id,
          workflow_id: key,
          test_id: a.requirement_id,
          status: "passed",
          phase: "delivery",
          layer: testDef?.layer ?? "unit",
          environment_revision: this.get(key).environment_revision,
          run_id: activeRev.run_id ?? delivery.run_id,
          plan_revision: activeRev.plan_revision,
          snapshot_id: activeRev.snapshot_id ?? "",
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
    return [];
  }
}
