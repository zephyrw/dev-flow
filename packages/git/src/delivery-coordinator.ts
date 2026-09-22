import type { Store } from "../../store/src/store.js";
import {
  requireCondition,
  type Workflow,
  type Workspace,
  type Snapshot,
  type Project,
  type Run,
  type MergeConflictRequest,
  type MergeConflictReceipt,
  type Delivery,
  type AcceptanceCarry,
  conflictImpactNeedsConfirmation,
  retainConflictFunctionImpact,
} from "../../contracts/src/index.js";
import { git, repositoryInfo, GitManager } from "./git.js";
import { CurrentDeliveryReader } from "../../evidence/src/current-delivery.js";
import { QualityCoordinator } from "../../core/src/quality-coordinator.js";
import { now, hash, id } from "../../core/src/util.js";
import { resolve, relative, isAbsolute, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";

const gitWriteEnv = {
  GIT_EDITOR: ":",
  GIT_MERGE_AUTOEDIT: "no",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

export function mergeConflictResolutionInstructions() {
  return (
    "合并发生代码冲突。严格在原批准计划和正式整改范围内解决冲突，同时保留双方有效需求。" +
    "禁止统一使用 ours/theirs、reset、stash 或删除历史。" +
    "完成后返回结构化回执，不得自行提交 Git 或删除工作树。" +
    "回执必须包含 function_impact，取值 none、changed 或 uncertain，必要时附 function_impact_explanation。" +
    "none 表示冲突解决未改变用户可感知功能；changed 表示功能行为已变；uncertain 表示无法确定功能影响。"
  );
}

export interface IntegrationReceipt {
  workflow_id: string;
  repo_id: string;
  candidate_commit: string;
  target_branch: string;
  source_root: string;
  merged_at: string;
  status: "success" | "partial" | "failed";
}
export interface CleanupReceipt {
  workflow_id: string;
  worktree_removed: boolean;
  branch_deleted: boolean;
  cleaned_at: string;
}
export interface CleanupWorkspacePreviewItem {
  workspace_id: string;
  repo_id: string;
  root: string;
  branch: string;
  head: string;
  workspace_version: number;
  writer_status: "idle" | "active" | "unknown";
  has_untracked: boolean;
  has_uncommitted: boolean;
  materials_summary: string[];
  is_safe_to_cleanup: boolean;
  block_reason?: string;
}
export interface CleanupPreviewResult {
  workflow_id: string;
  workflow_version: number;
  control_revision: number;
  preview_version: number;
  preview_digest: string;
  workspaces: CleanupWorkspacePreviewItem[];
  can_cleanup: boolean;
}
interface Candidate {
  workflow_id: string;
  repo_id: string;
  source_root: string;
  source_branch: string;
  source_commit: string;
  candidate_commit: string;
  source_delivery_revision: string;
  awaiting_verification: boolean;
}
export class GitDeliveryCoordinator {
  public currentDeliveryReader: CurrentDeliveryReader;
  constructor(
    private store: Store,
    private workspaceRoot: string,
    private manager?: GitManager,
  ) {
    this.currentDeliveryReader = new CurrentDeliveryReader(store);
  }
  private key(workflowId: string, repoId: string) {
    return workflowId + ":" + repoId;
  }
  private workflow(id: string) {
    return this.store.must<Workflow>("workflow", id);
  }
  private conflictAllowedPaths(
    snapshot: Snapshot,
    planRecord?: { plan?: { scope?: { allowed_paths?: string[] } } },
  ) {
    const allowed = new Set<string>();
    for (const repo of snapshot.repositories)
      for (const item of repo.changed_paths ?? []) allowed.add(item);
    for (const item of planRecord?.plan?.scope?.allowed_paths ?? [])
      allowed.add(item);
    return allowed;
  }
  private conflictRunBinding(workflowId: string, w: Workflow) {
    const takeover =
      this.store.get<{ planner: boolean }>("repair_assignment", workflowId)
        ?.planner === true;
    const spec = this.store
      .list<{ id: string; revision: number; plannerProfile?: Run["profile"]; executorProfile?: Run["profile"] }>(
        "execution_spec",
        workflowId,
      )
      .sort((a, b) => b.revision - a.revision)[0];
    const profile = takeover ? spec?.plannerProfile : spec?.executorProfile;
    const source = w.run_id ? this.store.get<Run>("run", w.run_id) : undefined;
    return {
      adapter: profile?.adapterId ??
        source?.adapter ??
        "codex",
      profile: profile ?? source?.profile,
      execution_spec_id: spec?.id ?? source?.execution_spec_id,
      protocol: source?.protocol ?? "lightweight",
    };
  }
  private update(w: Workflow, state: Workflow["state"], stage: string) {
    this.store.transaction(() => {
      const before = this.workflow(w.id);
      this.store.put("workflow", w.id, w.project_id, {
        ...before,
        state,
        stage,
        version: before.version + 1,
        updated_at: now(),
        blocker: undefined,
      });
      this.store.event(w.id, w.project_id, "StateChanged", {
        from: before.state,
        to: state,
        stage,
      });
    });
  }
  private async ensureCommitSnapshot(
    workflowId: string,
    manager: GitManager,
  ): Promise<Snapshot> {
    const intent = this.store.get<{ snapshot?: string }>(
      "commit_intent",
      workflowId,
    );
    if (intent?.snapshot) {
      const existing = this.store.get<Snapshot>("snapshot", intent.snapshot);
      if (existing) return existing;
    }
    const w = this.workflow(workflowId);
    const env = this.store.get<{ revision: number }>("environment", workflowId);
    const snapshot = await manager.snapshot(
      workflowId,
      env?.revision ?? w.environment_revision ?? 0,
    );
    this.store.transaction(() => {
      const current = this.workflow(workflowId);
      const acceptance = this.store.get<any>("acceptance", workflowId);
      this.store.put("snapshot", snapshot.id, workflowId, snapshot);
      this.store.put("workflow", current.id, current.project_id, {
        ...current,
        snapshot_id: snapshot.id,
      });
      // This is a display association for the snapshot created at commit time.
      // Preserve the human's original confirmation and its proof binding.
      const matchesPreviousSnapshot = acceptance && (
        (acceptance.snapshot_id ?? null) === (current.snapshot_id ?? null) ||
        (!!current.snapshot_id && acceptance.commit_snapshot_id === current.snapshot_id)
      );
      if (acceptance && matchesPreviousSnapshot &&
          current.version === w.version &&
          current.plan_revision === w.plan_revision &&
          current.environment_revision === w.environment_revision &&
          acceptance.plan_revision === current.plan_revision &&
          acceptance.environment_revision === current.environment_revision) {
        this.store.put("acceptance", workflowId, workflowId, {
          ...acceptance,
          commit_snapshot_id: snapshot.id,
        });
      }
    });
    return snapshot;
  }
  private source(w: Workflow, ws: Workspace) {
    const project = this.store.must<Project>("project", w.project_id);
    const root =
      ws.source_root ??
      project.repositories.find((r) => r.id === ws.repo_id)?.path;
    requireCondition(root, "SOURCE_MISSING", "缺少已登记的主工作区");
    return root;
  }
  async executeDelivery(
    workflowId: string,
    message?: string,
  ): Promise<{
    integrations: IntegrationReceipt[];
    cleanup?: CleanupReceipt;
    needsVerification?: boolean;
    hasConflict?: boolean;
    conflictRequest?: MergeConflictRequest;
  }> {
    const w = this.workflow(workflowId);
    requireCondition(
      ["COMMITTING", "INTEGRATING", "COMMIT_PARTIAL"].includes(w.state),
      "INVALID_STATE",
      "尚未完成终审，不能整合交付",
      409,
    );
    const delivery =
      this.currentDeliveryReader.getLatestRevision(workflowId);
    const deliveryRecord = delivery
      ? this.store.get<Delivery>("delivery", delivery.delivery_id)
      : undefined;
    new QualityCoordinator(this.store).assertPassed(workflowId, "after_human");
    const acceptance = this.store.get<any>("acceptance", workflowId);
    requireCondition(acceptance, "ACCEPTANCE_STALE", "尚未人工确认");
    const workspaces = this.store.list<Workspace>("workspace", workflowId);
    requireCondition(workspaces.length, "WORKSPACE_MISSING", "缺少工作区");
    const manager =
      this.manager ??
      new GitManager(
        this.store,
        this.workspaceRoot,
        join(this.workspaceRoot, ".delivery-state"),
      );
    const snapshot = await this.ensureCommitSnapshot(workflowId, manager);
    const project = this.store.must<Project>("project", w.project_id);
    const committed = await manager.commit(
      snapshot,
      project,
      message ?? "feat(devflow): " + w.title,
    );
    if (w.workspace_mode === "existing_workspace") {
      const integrations: IntegrationReceipt[] = [];
      for (const record of committed) {
        const ws = workspaces.find((x) => x.repo_id === record.repo_id)!;
        requireCondition(
          !ws.owned,
          "WORKSPACE_OWNERSHIP_INVALID",
          "主工作区不能标为任务所有",
        );
        requireCondition(
          (await git(ws.root, ["rev-parse", "HEAD"])) === record.commit,
          "COMMIT_CONFIRMATION_FAILED",
          "主工作区提交未确认",
        );
        const receipt: IntegrationReceipt = {
          workflow_id: workflowId,
          repo_id: ws.repo_id,
          candidate_commit: record.commit,
          target_branch: ws.branch,
          source_root: ws.root,
          status: "success",
          merged_at: now(),
        };
        this.store.put(
          "integration_receipt",
          this.key(workflowId, ws.repo_id),
          workflowId,
          receipt,
        );
        integrations.push(receipt);
      }
      this.update(w, "COMMITTED", "done");
      return { integrations };
    }
    let needsVerification = false;
    const candidates: Candidate[] = [];
    for (const ws of workspaces) {
      requireCondition(
        ws.owned,
        "WORKSPACE_OWNERSHIP_INVALID",
        "独立工作树未登记为当前任务所有",
      );
      const source = this.source(w, ws),
        info = await repositoryInfo(source);
      requireCondition(
        info.common_dir.toLowerCase() ===
          realpathSync(ws.common_dir).toLowerCase() &&
          info.branch === (ws.source_branch ?? info.branch) &&
          resolve(source).toLowerCase() !== resolve(ws.root).toLowerCase(),
        "SOURCE_BINDING_INVALID",
        "主工作区、仓库或目标分支与登记不符",
      );
      requireCondition(
        !(await git(source, ["status", "--porcelain"])),
        "SOURCE_BUSY",
        "主工作区存在未提交改动；请先处理后重试",
      );
      const previous = this.store.get<Candidate>(
        "integration_candidate",
        this.key(workflowId, ws.repo_id),
      );
      const candidate = committed.find((c) => c.repo_id === ws.repo_id)!;
      let head = candidate.commit;
      let contains =
        (await git(ws.root, ["merge-base", head, info.head])) === info.head;
      if (!contains) {
        // Persist the exact target before merging, so a conflict or restart cannot publish anything.
        this.store.put(
          "integration_candidate",
          this.key(workflowId, ws.repo_id),
          workflowId,
          {
            workflow_id: workflowId,
            repo_id: ws.repo_id,
            source_root: source,
            source_branch: info.branch,
            source_commit: info.head,
            candidate_commit: head,
            source_delivery_revision: delivery?.id ?? "",
            awaiting_verification: true,
          },
        );
        try {
          await git(
            ws.root,
            ["merge", "--no-edit", "--no-stat", info.head],
            gitWriteEnv,
          );
          head = await git(ws.root, ["rev-parse", "HEAD"]);
          this.store.put("workspace", ws.id, workflowId, {
            ...ws,
            execution_base: head,
          });
          contains = true;
        } catch (mergeError: any) {
          let hasMergeHead = false;
          try {
            await git(ws.root, ["rev-parse", "--verify", "MERGE_HEAD"]);
            hasMergeHead = true;
          } catch {}

          if (!hasMergeHead) throw mergeError;

          const diffOutput = await git(ws.root, [
            "diff",
            "--name-only",
            "--diff-filter=U",
          ]);
          const conflictPaths = diffOutput
            .split("\n")
            .map((s) => s.trim())
            .filter(Boolean);
          requireCondition(
            conflictPaths.length > 0,
            "CONFLICT_PATHS_EMPTY",
            "未读取到真实冲突路径",
          );

          const planRecord = this.store.get<any>(
            "plan",
            `${workflowId}-${w.plan_revision}`,
          );
          const planHash =
            w.plan_hash ??
            hash(JSON.stringify(planRecord?.plan ?? {}));

          const allowedPaths = this.conflictAllowedPaths(snapshot, planRecord);
          const outOfBounds = conflictPaths.some((p) => !allowedPaths.has(p));

          const conflictRequestId = hash(
            [
              workflowId,
              ws.repo_id,
              candidate.commit,
              info.head,
              planHash,
            ].join(":"),
          );

          const existingRequest = this.store.get<MergeConflictRequest>(
            "merge_conflict_request",
            conflictRequestId,
          );
          if (existingRequest && existingRequest.status === "running") {
            return {
              integrations: [],
              hasConflict: true,
              conflictRequest: existingRequest,
            };
          }

          const runId = id("conflict-run");
          const requestRecord: MergeConflictRequest = {
            id: conflictRequestId,
            workflow_id: workflowId,
            repo_id: ws.repo_id,
            plan_revision: w.plan_revision,
            plan_hash: planHash,
            candidate_commit: candidate.commit,
            source_commit: info.head,
            worktree_root: ws.root,
            common_dir: ws.common_dir,
            conflict_paths: conflictPaths,
            run_id: runId,
            source_stage: w.stage,
            source_state: w.state,
            quality_phase:
              this.store.get<{ phase?: "before_human" | "after_human" }>(
                "plan_check_review_intent",
                workflowId,
              )?.phase ?? "after_human",
            resolution_instructions: mergeConflictResolutionInstructions(),
            status: outOfBounds ? "blocked" : "running",
            created_at: now(),
            updated_at: now(),
          };

          this.store.transaction(() => {
            this.store.put(
              "merge_conflict_request",
              conflictRequestId,
              workflowId,
              requestRecord,
            );
            if (outOfBounds) {
              this.update(w, "BLOCKED", "merge_conflict_blocked");
              return;
            }
            const binding = this.conflictRunBinding(workflowId, w);
            const run: Run = {
              id: runId,
              workflow_id: workflowId,
              plan_revision: w.plan_revision,
              adapter: binding.adapter,
              profile: binding.profile,
              execution_spec_id: binding.execution_spec_id,
              stage: "merge_conflict_resolution",
              purpose: "merge_conflict" as any,
              status: "running",
              started_at: now(),
              deadline_at: Date.now() + 300000,
              package_hash: conflictRequestId,
              protocol: binding.protocol,
            };
            this.store.put("run", runId, workflowId, run);
            this.store.enqueue(workflowId, "dispatch_run", {
              purpose: "merge_conflict",
              workflow_id: workflowId,
              run_id: runId,
              request_id: conflictRequestId,
            });
          });

          return {
            integrations: [],
            hasConflict: true,
            conflictRequest: requestRecord,
          };
        }
      }
      const awaiting =
        !contains ||
        (!!previous?.awaiting_verification &&
          previous.source_delivery_revision === (delivery?.id ?? ""));
      const record: Candidate = {
        workflow_id: workflowId,
        repo_id: ws.repo_id,
        source_root: source,
        source_branch: info.branch,
        source_commit: info.head,
        candidate_commit: head,
        source_delivery_revision: awaiting
          ? (previous?.source_delivery_revision ?? delivery?.id ?? "")
          : delivery?.id ?? "",
        awaiting_verification: awaiting,
      };
      this.store.put(
        "integration_candidate",
        this.key(workflowId, ws.repo_id),
        workflowId,
        record,
      );
      candidates.push(record);
      needsVerification ||= awaiting;
    }
    if (needsVerification) {
      // Preserve commit history as evidence, but a new verified snapshot needs a new commit intent.
      this.store.put("candidate_commit_history", snapshot.id, workflowId, {
        snapshot_id: snapshot.id,
        committed,
      });
      for (const ws of workspaces)
        this.store.put("workspace", ws.id, workflowId, {
          ...ws,
          execution_base: await git(ws.root, ["rev-parse", "HEAD"]),
        });
      this.store.remove("commit_intent", workflowId);
      for (const c of committed) {
        this.store.remove("commit_result", workflowId + "-" + c.repo_id);
        this.store.remove("commit_index", workflowId + "-" + c.repo_id);
      }
      return { integrations: [], needsVerification: true };
    }
    // Validate all repositories first. A partially published multi-repo result is recoverable and never cleaned.
    for (const c of candidates) {
      const current = await repositoryInfo(c.source_root);
      requireCondition(
        current.head === c.source_commit &&
          current.branch === c.source_branch &&
          !(await git(c.source_root, ["status", "--porcelain"])),
        "SOURCE_BUSY",
        "主工作区在验证后变化，需重新吸收并验证",
      );
    }
    const integrations: IntegrationReceipt[] = [];
    for (const c of candidates) {
      const prior = this.store.get<IntegrationReceipt>(
        "integration_receipt",
        this.key(workflowId, c.repo_id),
      );
      if (
        prior?.candidate_commit === c.candidate_commit &&
        prior.status === "success"
      ) {
        integrations.push(prior);
        continue;
      }
      const current = await repositoryInfo(c.source_root);
      requireCondition(
        current.head === c.source_commit && current.branch === c.source_branch,
        "SOURCE_BUSY",
        "目标分支发生并发推进",
      );
      await git(c.source_root, ["merge", "--ff-only", c.candidate_commit], gitWriteEnv);
      requireCondition(
        (await git(c.source_root, ["rev-parse", "HEAD"])) ===
          c.candidate_commit,
        "MERGE_CONFIRMATION_FAILED",
        "合回后的提交未确认",
      );
      const receipt: IntegrationReceipt = {
        ...c,
        target_branch: c.source_branch,
        merged_at: now(),
        status: "success",
      };
      this.store.put(
        "integration_receipt",
        this.key(workflowId, c.repo_id),
        workflowId,
        receipt,
      );
      integrations.push(receipt);
    }
    this.update(w, "COMPLETED", "done");
    return {
      integrations,
    };
  }
  /**
   * 依据 CW2-D01 / §4 第 6 项规范：显式清理增加真正只读 preview
   */
  async previewCleanupWorkspaces(
    workflowId: string,
    requestedWorkspaceIds?: string[],
  ): Promise<CleanupPreviewResult> {
    const w = this.workflow(workflowId);
    const control = this.store.get<any>("workflow_dispatch_control", workflowId);
    const controlRevision = control?.revision ?? 1;

    // 检查是否有未结束的写者
    const activeRuns = this.store
      .list<Run>("run", workflowId)
      .filter((r) => r.status === "running");
    const activeDispatches = this.store
      .list<any>("cli_dispatch_record", workflowId)
      .filter((d: any) => ["starting", "running", "stopping"].includes(d.state));

    let writerStatus: "idle" | "active" | "unknown" = "idle";
    if (activeRuns.length > 0 || activeDispatches.length > 0) {
      writerStatus = "active";
    } else if (control?.writer_state && control.writer_state !== "idle") {
      writerStatus = control.writer_state;
    }

    const allWorkspaces = this.store.list<Workspace>("workspace", workflowId);
    const targetWorkspaces = requestedWorkspaceIds && requestedWorkspaceIds.length > 0
      ? allWorkspaces.filter((ws) => requestedWorkspaceIds.includes(ws.id))
      : allWorkspaces;

    const items: CleanupWorkspacePreviewItem[] = [];
    for (const ws of targetWorkspaces) {
      const receipt = this.store.get<IntegrationReceipt>(
        "integration_receipt",
        this.key(workflowId, ws.repo_id),
      );
      let head = "";
      let hasUntracked = false;
      let hasUncommitted = false;
      let isSafe = true;
      let blockReason: string | undefined;

      const root = existsSync(ws.root)
        ? realpathSync(ws.root)
        : resolve(ws.root);

      if (!receipt || receipt.status !== "success") {
        isSafe = false;
        blockReason = "该仓库尚未确认成功整合，禁止清理";
      } else if (writerStatus !== "idle") {
        isSafe = false;
        blockReason = `存在活跃写者 (状态: ${writerStatus})，禁止清理`;
      } else if (!ws.owned || !ws.branch.startsWith("devflow/")) {
        isSafe = false;
        blockReason = "非本任务受管临时分支，禁止清理";
      } else if (existsSync(root)) {
        try {
          head = (await git(root, ["rev-parse", "HEAD"])).trim();
          const statusOut = await git(root, ["status", "--porcelain"]);
          if (statusOut.trim()) {
            hasUncommitted = true;
            if (statusOut.includes("??")) {
              hasUntracked = true;
            }
            isSafe = false;
            blockReason = "工作树存在未提交或未跟踪内容，禁止清理以保护原件";
          }
        } catch (err: any) {
          isSafe = false;
          blockReason = `读取工作树 Git 状态失败: ${err.message}`;
        }
      }

      // 材料摘要
      const materialsSummary: string[] = [];
      const planDir = join(root, "docs", "plan", workflowId);
      if (existsSync(planDir)) materialsSummary.push("docs/plan");
      const procDir = join(root, "docs", "process", workflowId);
      if (existsSync(procDir)) materialsSummary.push("docs/process");

      items.push({
        workspace_id: ws.id,
        repo_id: ws.repo_id,
        root: ws.root,
        branch: ws.branch,
        head,
        workspace_version: (ws as any).version ?? 1,
        writer_status: writerStatus,
        has_untracked: hasUntracked,
        has_uncommitted: hasUncommitted,
        materials_summary: materialsSummary,
        is_safe_to_cleanup: isSafe,
        block_reason: blockReason,
      });
    }

    const previewVersion = (w.version ?? 1) * 100 + controlRevision;
    const previewDigest = hash(
      JSON.stringify({
        workflow_id: workflowId,
        workflow_version: w.version,
        control_revision: controlRevision,
        items: items.map((it) => ({
          id: it.workspace_id,
          root: it.root,
          branch: it.branch,
          head: it.head,
          safe: it.is_safe_to_cleanup,
        })),
      }),
    );

    const canCleanup = items.length > 0 && items.every((it) => it.is_safe_to_cleanup);

    return {
      workflow_id: workflowId,
      workflow_version: w.version,
      control_revision: controlRevision,
      preview_version: previewVersion,
      preview_digest: previewDigest,
      workspaces: items,
      can_cleanup: canCleanup,
    };
  }

  async cleanupWorkspaces(
    workflowId: string,
    requested: Array<{ id: string; root?: string; branch?: string; expected_version?: number }>,
    options?: {
      explicit_selection?: boolean;
      preview_version?: number;
      preview_digest?: string;
      expected_control_revision?: number;
      expected_workflow_version?: number;
    },
  ): Promise<CleanupReceipt> {
    const w = this.workflow(workflowId);
    requireCondition(
      options?.explicit_selection === true,
      "EXPLICIT_SELECTION_REQUIRED",
      "工作区清理必须由用户本次明确选择触发，禁止自动清理或沿用旧意图",
      400,
    );
    requireCondition(
      ["CLEANUP_PENDING", "COMPLETED"].includes(w.state),
      "INVALID_STATE",
      "只有确认整合成功后才能清理",
      409,
    );
    requireCondition(
      w.workspace_mode === "new_worktree",
      "INVALID_STATE",
      "主工作区无需清理",
      409,
    );

    if (options?.expected_workflow_version !== undefined) {
      requireCondition(
        w.version === options.expected_workflow_version,
        "VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${options.expected_workflow_version}, 当前 v${w.version}`,
        409,
      );
    }

    const control = this.store.get<any>("workflow_dispatch_control", workflowId);
    if (options?.expected_control_revision !== undefined && control) {
      requireCondition(
        control.revision === options.expected_control_revision,
        "REVISION_CONFLICT",
        `调度控制版本冲突: 期望 r${options.expected_control_revision}, 当前 r${control.revision}`,
        409,
      );
    }

    if (options?.preview_digest) {
      const currentPreview = await this.previewCleanupWorkspaces(workflowId);
      requireCondition(
        options.preview_digest === currentPreview.preview_digest,
        "PREVIEW_DIGEST_MISMATCH",
        "清理预览已过期或工作区事实已变更，禁止清理",
        409,
      );
    }

    // CW2-F07 / CW3-F15: 写者状态核查，禁止在 active/unknown/prepared/needs_reconcile 时清理
    const activeRuns = this.store
      .list<Run>("run", workflowId)
      .filter((r) => ["running", "starting", "executing"].includes((r.status || "").toLowerCase()));
    const activeDispatches = this.store
      .list<any>("cli_dispatch_record", workflowId)
      .filter((d: any) => ["prepared", "starting", "running", "stopping", "needs_reconcile"].includes((d.state || "").toLowerCase()));
    requireCondition(
      activeRuns.length === 0 &&
        activeDispatches.length === 0 &&
        (!control?.writer_state || control.writer_state === "idle"),
      "WRITER_ACTIVE",
      "当前存在正在运行的写者或写者状态未知，禁止清理",
      409,
    );

    const allWorkspaces = this.store.list<Workspace>("workspace", workflowId);
    requireCondition(
      requested.length > 0,
      "NO_WORKSPACES_SELECTED",
      "未指定要清理的目标工作区",
      400,
    );

    // 核验用户请求的每一项工作区都合法存在且归属一致（允许只选部分工作区 CW2-F07）
    const matchedWorkspaces: Array<{ ws: Workspace; req: any }> = [];
    for (const req of requested) {
      const found = allWorkspaces.find((ws) => ws.id === req.id);
      requireCondition(
        found !== undefined,
        "WORKSPACE_NOT_FOUND",
        `工作区 ${req.id} 不属于当前工作流`,
        404,
      );
      if (req.root) {
        requireCondition(
          resolve(req.root).toLowerCase() === resolve(found.root).toLowerCase(),
          "WORKSPACE_ROOT_MISMATCH",
          `工作区路径不匹配: ${req.root}`,
          409,
        );
      }
      if (req.branch) {
        requireCondition(
          req.branch === found.branch,
          "WORKSPACE_BRANCH_MISMATCH",
          `工作区分支不匹配: ${req.branch}`,
          409,
        );
      }
      matchedWorkspaces.push({ ws: found, req });
    }

    // 核验每个待清理工作区的整合回执、Git 登记状态和原件未修改事实
    const checked: Array<{
      ws: Workspace;
      source: string;
      registered: boolean;
    }> = [];

    for (const { ws } of matchedWorkspaces) {
      const receipt = this.store.get<IntegrationReceipt>(
        "integration_receipt",
        this.key(workflowId, ws.repo_id),
      );
      requireCondition(
        receipt?.status === "success",
        "MERGE_RECEIPT_MISSING",
        `仓库 ${ws.repo_id} 尚未确认成功整合，禁止清理`,
        409,
      );
      const source = this.source(w, ws);
      const info = await repositoryInfo(source);
      requireCondition(
        info.branch === receipt.target_branch &&
          (await git(source, [
            "merge-base",
            receipt.candidate_commit,
            info.head,
          ])) === receipt.candidate_commit,
        "MERGE_CONFIRMATION_FAILED",
        "主分支没有已确认的候选提交",
        409,
      );
      requireCondition(
        ws.owned &&
          ws.branch.startsWith("devflow/") &&
          ws.branch !== info.branch,
        "WORKSPACE_OWNERSHIP_INVALID",
        "禁止清理非本任务临时工作树或主分支",
        409,
      );
      const root = existsSync(ws.root)
        ? realpathSync(ws.root)
        : resolve(ws.root);
      const allowed = [
        this.workspaceRoot,
        join(ws.common_dir, "devflow", "worktrees"),
        join(source, ".worktrees"),
      ].some((base) => {
        const rel = relative(resolve(base), root);
        return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
      });
      requireCondition(
        allowed && root.toLowerCase() !== resolve(source).toLowerCase(),
        "CLEANUP_PATH_INVALID",
        "清理路径不在受管任务目录中",
        409,
      );
      const entries = (
        await git(source, ["worktree", "list", "--porcelain"])
      ).split(/\r?\n\r?\n/);
      const entry = entries.find(
        (e) =>
          e.split(/\r?\n/)[0]?.slice(9).replaceAll("\\", "/").toLowerCase() ===
          root.replaceAll("\\", "/").toLowerCase(),
      );
      if (entry) {
        requireCondition(
          entry.split(/\r?\n/).includes("branch refs/heads/" + ws.branch),
          "WORKTREE_BRANCH_CHANGED",
          "工作树分支与登记不一致",
          409,
        );
      }
      requireCondition(
        entry || !existsSync(root),
        "WORKTREE_NOT_REGISTERED",
        "目标目录不再是登记的工作树",
        409,
      );
      if (entry) {
        const statusOutput = await git(root, ["status", "--porcelain"]);
        requireCondition(
          !statusOutput.trim(),
          "WORKTREE_DIRTY",
          "工作树仍有未保存或未提交修改，禁止清理以保护原件",
          409,
        );
        requireCondition(
          (await git(source, [
            "merge-base",
            await git(root, ["rev-parse", "HEAD"]),
            receipt.candidate_commit,
          ])) === (await git(root, ["rev-parse", "HEAD"])),
          "WORKTREE_NOT_MERGED",
          "工作树仍有未整合修改，禁止清理",
          409,
        );
      }
      checked.push({ ws, source, registered: !!entry });
    }

    let worktreeRemoved = true;
    let branchDeleted = true;
    for (const { ws, source, registered } of checked) {
      try {
        if (registered) await git(source, ["worktree", "remove", ws.root]);
      } catch {
        worktreeRemoved = false;
        continue;
      }
      try {
        if (await git(source, ["branch", "--list", ws.branch])) {
          await git(source, ["branch", "-d", "--", ws.branch]);
        }
      } catch {
        branchDeleted = false;
      }
    }

    const receipt = {
      workflow_id: workflowId,
      worktree_removed: worktreeRemoved,
      branch_deleted: branchDeleted,
      cleaned_at: now(),
    };
    this.store.put("cleanup_receipt", workflowId, workflowId, receipt);

    // 只有全部工作区都已清理完成时才标记为 COMPLETED 终态
    const remainingWorkspaces = allWorkspaces.filter(
      (ws) => !checked.some((c) => c.ws.id === ws.id),
    );
    if (remainingWorkspaces.length === 0) {
      this.update(
        w,
        worktreeRemoved && branchDeleted ? "COMPLETED" : "CLEANUP_PENDING",
        worktreeRemoved && branchDeleted ? "done" : "cleanup",
      );
    }
    return receipt;
  }

  /**
   * 依据 CW-D01 规范：历史 CLEANUP_PENDING 若已有全部成功整合回执，恢复为“交付已完成、工作树保留”
   */
  reconcileCompletedWorkflows(workflowId: string): boolean {
    const w = this.workflow(workflowId);
    if (w.state === "CLEANUP_PENDING") {
      const workspaces = this.store.list<Workspace>("workspace", workflowId);
      const allSuccess =
        workspaces.length > 0 &&
        workspaces.every((ws) => {
          const receipt = this.store.get<IntegrationReceipt>(
            "integration_receipt",
            this.key(workflowId, ws.repo_id),
          );
          return receipt?.status === "success";
        });
      if (allSuccess) {
        this.update(w, "COMPLETED", "done");
        return true;
      }
    }
    return false;
  }

  async handleConflictResolution(
    workflowId: string,
    requestId: string,
    receipt: MergeConflictReceipt,
    assertCurrent: () => void = () => {},
  ): Promise<{
    newHead?: string;
    blocked?: boolean;
    acceptance?: unknown;
    carried?: boolean;
  }> {
    assertCurrent();
    const request = this.store.must<MergeConflictRequest>(
      "merge_conflict_request",
      requestId,
    );
    requireCondition(
      workflowId === request.workflow_id &&
        receipt.request_id === request.id &&
        receipt.workflow_id === request.workflow_id &&
        receipt.run_id === request.run_id &&
        receipt.candidate_commit === request.candidate_commit &&
        receipt.source_commit === request.source_commit,
      "RECEIPT_IDENTITY_MISMATCH",
      "冲突解决回执身份与请求不符",
    );

    if (request.status === "resolved") {
      const carry = this.store.transaction(() =>
        this.persistResolvedConflictCarry(workflowId, requestId, request, receipt),
      );
      return {
        newHead: this.resolvedCandidateHead(workflowId, request.repo_id),
        ...carry,
      };
    }

    const w = this.workflow(workflowId);
    const ws = this.store
      .list<Workspace>("workspace", workflowId)
      .find((x) => x.repo_id === request.repo_id);
    requireCondition(ws, "WORKSPACE_NOT_FOUND", "缺少工作区");

    if (
      receipt.status === "blocked" ||
      (receipt.blockers && receipt.blockers.length > 0)
    ) {
      this.store.transaction(() => {
        this.store.put("merge_conflict_request", requestId, workflowId, {
          ...request,
          status: "blocked",
          updated_at: now(),
        });
        this.update(w, "BLOCKED", "merge_conflict_blocked");
      });
      return { blocked: true };
    }

    // 核验真实 Git 状态
    const mergeHead = (
      await git(ws.root, ["rev-parse", "--verify", "MERGE_HEAD"])
    ).trim();
    requireCondition(
      mergeHead === request.source_commit,
      "MERGE_HEAD_MISMATCH",
      "MERGE_HEAD 与目标提交不符",
    );
    const currentHead = (await git(ws.root, ["rev-parse", "HEAD"])).trim();
    requireCondition(
      currentHead === request.candidate_commit,
      "CANDIDATE_COMMIT_MISMATCH",
      "当前 HEAD 与候选提交不符",
    );

    // Every repository is committed before integration starts. Retire that
    // shared intent only after retaining the other repositories' known heads
    // and index trees; never adopt an arbitrary HEAD as the next baseline.
    const intent = this.store.get<{
      snapshot: string;
      repos: Record<string, string>;
    }>("commit_intent", workflowId);
    const retainedWorkspaces: Workspace[] = [];
    if (intent) {
      const committedSnapshot = this.store.get<Snapshot>("snapshot", intent.snapshot);
      for (const other of this.store.list<Workspace>("workspace", workflowId)) {
        if (other.id === ws.id) continue;
        const committed = intent.repos[other.repo_id];
        if (!committed) continue;
        const candidate = this.store.get<Candidate>(
          "integration_candidate", this.key(workflowId, other.repo_id),
        );
        const originalBase = committedSnapshot?.repositories.find(
          (repo) => repo.workspace_id === other.id,
        )?.baseline;
        const integrated = originalBase && other.execution_base !== originalBase &&
          candidate && candidate.candidate_commit === other.execution_base
          ? candidate.candidate_commit : undefined;
        const expectedHead = integrated ?? committed;
        if (integrated)
          requireCondition(
            (await git(other.root, ["merge-base", committed, integrated])) === committed,
            "BASELINE_CHANGED", "其他仓库候选不包含本次提交，保留冲突现场",
          );
        requireCondition(
          (await git(other.root, ["rev-parse", "HEAD"])) === expectedHead,
          "BASELINE_CHANGED", "其他仓库 HEAD 已变化，保留冲突现场",
        );
        const expectedIndex = integrated
          ? await git(other.root, ["rev-parse", integrated + "^{tree}"])
          : this.store.get<{ tree: string }>(
              "commit_index", workflowId + "-" + other.repo_id,
            )?.tree ?? await git(other.root, ["rev-parse", committed + "^{tree}"]);
        requireCondition(
          (await git(other.root, ["write-tree"])) === expectedIndex,
          "INDEX_CHANGED", "其他仓库暂存区已变化，保留冲突现场",
        );
        retainedWorkspaces.push({
          ...other, execution_base: expectedHead,
          initial_index_tree: other.initial_index_tree === undefined ? undefined : expectedIndex,
        });
      }
    }

    // 将已解决的冲突路径暂存
    for (const p of request.conflict_paths) {
      assertCurrent();
      await git(ws.root, ["add", p]);
    }

    // 再次核验未合并文件是否为空
    const unmerged = await git(ws.root, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    requireCondition(
      !unmerged.trim(),
      "UNRESOLVED_CONFLICTS_REMAIN",
      "工作树仍有未解决的冲突",
    );

    assertCurrent();
    await git(
      ws.root,
      ["commit", "-m", "devflow: 保留双方需求并完成合并冲突修复"],
      gitWriteEnv,
    );
    const newHead = (await git(ws.root, ["rev-parse", "HEAD"])).trim();
    const newIndex = await git(ws.root, ["rev-parse", newHead + "^{tree}"]);
    requireCondition(
      (await git(ws.root, ["rev-parse", newHead + "^1"])) === request.candidate_commit &&
        (await git(ws.root, ["rev-parse", newHead + "^2"])) === request.source_commit,
      "CANDIDATE_COMMIT_MISMATCH", "冲突提交的父提交与请求不符，保留现场",
    );
    // Stopping cannot cancel a Git commit that already started. Record its
    // exact result without advancing a stopped or replacement workflow.
    if (!this.store.get("merge_conflict_commit", requestId))
      this.store.put("merge_conflict_commit", requestId, workflowId, {
        request_id: requestId,
        run_id: request.run_id,
        plan_revision: request.plan_revision,
        plan_hash: request.plan_hash,
        candidate_commit: request.candidate_commit,
        source_commit: request.source_commit,
        new_head: newHead,
        index_tree: newIndex,
        retained_workspaces: retainedWorkspaces,
        commit_intent: intent,
        completed_at: now(),
      });
    const current = this.workflow(workflowId);
    requireCondition(
      current.run_id === request.run_id &&
        current.plan_revision === request.plan_revision &&
        current.plan_hash === request.plan_hash,
      "RUN_REVOKED", "冲突运行已由新运行接替，已保留 Git 提交记录",
    );

    // 更新状态、候选与基线
    const carry = this.store.transaction(() => {
      this.store.put("workspace", ws.id, workflowId, {
        ...ws,
        execution_base: newHead,
        initial_index_tree: ws.initial_index_tree === undefined ? undefined : newIndex,
      });
      for (const retained of retainedWorkspaces)
        this.store.put("workspace", retained.id, workflowId, retained);
      this.store.put(
        "integration_candidate",
        this.key(workflowId, ws.repo_id),
        workflowId,
        {
          workflow_id: workflowId,
          repo_id: ws.repo_id,
          source_root: ws.source_root ?? this.source(w, ws),
          source_branch: ws.source_branch ?? ws.branch,
          source_commit: request.source_commit,
          candidate_commit: newHead,
          source_delivery_revision: w.snapshot_id ?? "",
          awaiting_verification: true,
        },
      );
      if (intent)
        this.store.put("candidate_commit_history", intent.snapshot, workflowId, {
          snapshot_id: intent.snapshot,
          committed: this.store.list("commit_result", workflowId),
        });
      this.store.remove("commit_intent", workflowId);
      for (const repoId of new Set([ws.repo_id, ...Object.keys(intent?.repos ?? {})])) {
        this.store.remove("commit_result", workflowId + "-" + repoId);
        this.store.remove("commit_index", workflowId + "-" + repoId);
      }
      return this.persistResolvedConflictCarry(
        workflowId,
        requestId,
        { ...request, status: "resolved", updated_at: now() },
        receipt,
      );
    });

    assertCurrent();
    return { newHead, ...carry };
  }
  conflictReviewBackground(workflowId: string) {
    return this.store.get<AcceptanceCarry>("acceptance_carry", workflowId);
  }
  private resolvedCandidateHead(workflowId: string, repoId: string) {
    return this.store.get<Candidate>(
      "integration_candidate",
      this.key(workflowId, repoId),
    )?.candidate_commit;
  }
  private persistResolvedConflictCarry(
    workflowId: string,
    requestId: string,
    request: MergeConflictRequest,
    receipt: MergeConflictReceipt,
  ) {
    const incomingImpact = receipt.function_impact;
    const incomingExplanation = receipt.function_impact_explanation;
    const existingCarry = this.store.get<AcceptanceCarry>(
      "acceptance_carry",
      workflowId,
    );
    const reportedImpact = retainConflictFunctionImpact(
      existingCarry?.reported_function_impact ?? request.reported_function_impact,
      incomingImpact,
    );
    const explanation =
      incomingExplanation ??
      existingCarry?.function_impact_explanation ??
      request.function_impact_explanation;
    this.store.put("merge_conflict_request", requestId, workflowId, {
      ...request,
      status: "resolved",
      reported_function_impact: reportedImpact,
      function_impact_explanation: explanation,
      updated_at: now(),
    });
    const acceptance = this.store.get("acceptance", workflowId);
    const original = acceptance ?? existingCarry?.original;
    if (original || existingCarry) {
      this.store.put("acceptance_carry", workflowId, workflowId, {
        original,
        requires_confirmation:
          existingCarry?.requires_confirmation === true ||
          conflictImpactNeedsConfirmation(reportedImpact),
        integration: true,
        reported_function_impact: reportedImpact,
        function_impact_explanation: explanation,
      });
    }
    this.store.remove("acceptance", workflowId);
    return {
      acceptance: original,
      carried: Boolean(original || existingCarry),
    };
  }
}
