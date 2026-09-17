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
} from "../../contracts/src/index.js";
import { git, repositoryInfo, GitManager } from "./git.js";
import { CurrentDeliveryReader } from "../../evidence/src/current-delivery.js";
import { QualityCoordinator } from "../../core/src/quality-coordinator.js";
import { now, hash, id } from "../../core/src/util.js";
import { resolve, relative, isAbsolute, join } from "node:path";
import { existsSync, realpathSync } from "node:fs";

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
      this.currentDeliveryReader.requireValidDelivery(workflowId);
    new QualityCoordinator(this.store).assertPassed(workflowId, "after_human");
    const acceptance = this.store.get<any>("acceptance", workflowId);
    requireCondition(
      acceptance?.snapshot_id === w.snapshot_id &&
        acceptance.plan_revision === w.plan_revision &&
        acceptance.environment_revision === w.environment_revision,
      "ACCEPTANCE_STALE",
      "人工确认已失效",
    );
    const workspaces = this.store.list<Workspace>("workspace", workflowId);
    requireCondition(workspaces.length, "WORKSPACE_MISSING", "缺少工作区");
    const snapshot = this.store.must<Snapshot>("snapshot", w.snapshot_id!);
    const manager =
      this.manager ??
      new GitManager(
        this.store,
        this.workspaceRoot,
        join(this.workspaceRoot, ".delivery-state"),
      );
    const project = this.store.must<Project>("project", w.project_id);
    // Freeze and commit only the already verified snapshot; no git add -A and no swallowed commit errors.
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
      const contains =
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
            source_delivery_revision: delivery.revision!.id,
            awaiting_verification: true,
          },
        );
        try {
          await git(ws.root, ["merge", "--no-edit", info.head]);
          head = await git(ws.root, ["rev-parse", "HEAD"]);
          this.store.put("workspace", ws.id, workflowId, {
            ...ws,
            execution_base: head,
          });
          needsVerification = true;
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

          const planRecord = this.store.get<any>("plan", workflowId);
          const planHash =
            w.plan_hash ??
            hash(JSON.stringify(planRecord?.plan ?? {}));

          const allowedPaths = new Set<string>();
          for (const item of snapshot.repositories.flatMap(
            (r) => r.changed_paths,
          )) {
            allowedPaths.add(item);
          }
          for (const item of planRecord?.plan?.scope?.allowed_paths ?? []) {
            allowedPaths.add(item);
          }
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
            const run: Run = {
              id: runId,
              workflow_id: workflowId,
              plan_revision: w.plan_revision,
              adapter: "codex",
              stage: "merge_conflict_resolution",
              purpose: "merge_conflict" as any,
              status: "running",
              started_at: now(),
              deadline_at: Date.now() + 300000,
              package_hash: conflictRequestId,
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
          previous.source_delivery_revision === delivery.revision!.id);
      const record: Candidate = {
        workflow_id: workflowId,
        repo_id: ws.repo_id,
        source_root: source,
        source_branch: info.branch,
        source_commit: info.head,
        candidate_commit: head,
        source_delivery_revision: awaiting
          ? (previous?.source_delivery_revision ?? delivery.revision!.id)
          : delivery.revision!.id,
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
      await git(c.source_root, ["merge", "--ff-only", c.candidate_commit]);
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
    this.update(w, "CLEANUP_PENDING", "cleanup");
    return {
      integrations,
      cleanup: await this.cleanupWorkspaces(workflowId, workspaces),
    };
  }
  async cleanupWorkspaces(
    workflowId: string,
    requested: Workspace[],
  ): Promise<CleanupReceipt> {
    const w = this.workflow(workflowId);
    requireCondition(
      ["CLEANUP_PENDING", "COMPLETED"].includes(w.state),
      "INVALID_STATE",
      "只有确认全部整合成功后才能清理",
      409,
    );
    requireCondition(
      w.workspace_mode === "new_worktree",
      "INVALID_STATE",
      "主工作区无需清理",
      409,
    );
    const workspaces = this.store.list<Workspace>("workspace", workflowId);
    requireCondition(
      workspaces.length > 0 &&
        workspaces.length === requested.length &&
        workspaces.every((ws) =>
          requested.some(
            (r) =>
              r.id === ws.id && r.root === ws.root && r.branch === ws.branch,
          ),
        ),
      "WORKSPACE_BINDING_INVALID",
      "清理目标与登记的工作区不一致",
    );
    // Validate every receipt and ownership before any destructive operation.
    const checked: Array<{
      ws: Workspace;
      source: string;
      registered: boolean;
    }> = [];
    for (const ws of workspaces) {
      const receipt = this.store.get<IntegrationReceipt>(
        "integration_receipt",
        this.key(workflowId, ws.repo_id),
      );
      requireCondition(
        receipt?.status === "success",
        "MERGE_RECEIPT_MISSING",
        "尚有仓库未确认整合，禁止清理",
      );
      const source = this.source(w, ws),
        info = await repositoryInfo(source);
      requireCondition(
        info.branch === receipt.target_branch &&
          (await git(source, [
            "merge-base",
            receipt.candidate_commit,
            info.head,
          ])) === receipt.candidate_commit,
        "MERGE_CONFIRMATION_FAILED",
        "主分支没有已确认的候选提交",
      );
      requireCondition(
        ws.owned &&
          ws.branch.startsWith("devflow/") &&
          ws.branch !== info.branch,
        "WORKSPACE_OWNERSHIP_INVALID",
        "禁止清理非本任务临时工作树或主分支",
      );
      const root = existsSync(ws.root)
        ? realpathSync(ws.root)
        : resolve(ws.root);
      const allowed = [
        this.workspaceRoot,
        join(ws.common_dir, "devflow", "worktrees"),
      ].some((base) => {
        const rel = relative(resolve(base), root);
        return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
      });
      requireCondition(
        allowed && root.toLowerCase() !== resolve(source).toLowerCase(),
        "CLEANUP_PATH_INVALID",
        "清理路径不在受管任务目录中",
      );
      const entries = (
        await git(source, ["worktree", "list", "--porcelain"])
      ).split(/\r?\n\r?\n/);
      const entry = entries.find(
        (e) =>
          e.split(/\r?\n/)[0]?.slice(9).replaceAll("\\", "/").toLowerCase() ===
          root.replaceAll("\\", "/").toLowerCase(),
      );
      if (entry)
        requireCondition(
          entry.split(/\r?\n/).includes("branch refs/heads/" + ws.branch),
          "WORKTREE_BRANCH_CHANGED",
          "工作树分支与登记不一致",
        );
      requireCondition(
        entry || !existsSync(root),
        "WORKTREE_NOT_REGISTERED",
        "目标目录不再是登记的工作树",
      );
      if (entry)
        requireCondition(
          !(await git(root, ["status", "--porcelain"])) &&
            (await git(source, [
              "merge-base",
              await git(root, ["rev-parse", "HEAD"]),
              receipt.candidate_commit,
            ])) === (await git(root, ["rev-parse", "HEAD"])),
          "WORKTREE_NOT_MERGED",
          "工作树仍有未整合修改，禁止清理",
        );
      checked.push({ ws, source, registered: !!entry });
    }
    let worktreeRemoved = true,
      branchDeleted = true;
    for (const { ws, source, registered } of checked) {
      try {
        if (registered) await git(source, ["worktree", "remove", ws.root]);
      } catch {
        worktreeRemoved = false;
        continue;
      }
      try {
        if (await git(source, ["branch", "--list", ws.branch]))
          await git(source, ["branch", "-d", "--", ws.branch]);
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
    this.update(
      w,
      worktreeRemoved && branchDeleted ? "COMPLETED" : "CLEANUP_PENDING",
      worktreeRemoved && branchDeleted ? "done" : "cleanup",
    );
    return receipt;
  }

  async handleConflictResolution(
    workflowId: string,
    requestId: string,
    receipt: MergeConflictReceipt,
  ): Promise<{ newHead?: string; blocked?: boolean }> {
    const request = this.store.must<MergeConflictRequest>(
      "merge_conflict_request",
      requestId,
    );
    requireCondition(
      receipt.request_id === request.id &&
        receipt.workflow_id === request.workflow_id &&
        receipt.run_id === request.run_id &&
        receipt.candidate_commit === request.candidate_commit &&
        receipt.source_commit === request.source_commit,
      "RECEIPT_IDENTITY_MISMATCH",
      "冲突解决回执身份与请求不符",
    );

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

    // 将已解决的冲突路径暂存
    for (const p of request.conflict_paths) {
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

    // 完成合并提交
    await git(ws.root, ["commit", "--no-edit"]);
    const newHead = (await git(ws.root, ["rev-parse", "HEAD"])).trim();

    // 更新状态、候选与基线
    this.store.transaction(() => {
      this.store.put("merge_conflict_request", requestId, workflowId, {
        ...request,
        status: "resolved",
        updated_at: now(),
      });
      this.store.put("workspace", ws.id, workflowId, {
        ...ws,
        execution_base: newHead,
      });
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
      this.store.remove("commit_intent", workflowId);
      this.store.remove("commit_result", workflowId + "-" + ws.repo_id);
      this.store.remove("commit_index", workflowId + "-" + ws.repo_id);
      this.store.remove("acceptance", workflowId);
    });

    return { newHead };
  }
}

