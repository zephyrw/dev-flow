import { z } from "zod";
import type { Store } from "../../store/src/store.js";
import {
  FlowError,
  MutationReceiptSchema,
  RepairModelAssignmentSchema,
  RepairModelBatchSchema,
  RepairSelectionSchema,
  inheritRoleOverrides,
  type FunctionalIssue,
  type FunctionalIssueView,
  type MutationReceipt,
  type QualityPhase,
  type RepairBatchView,
  type RepairKind,
  type RepairModelAssignment,
  type RepairModelBatch,
  type RepairSelection,
  type RoleOverrides,
  type ToolProfile,
} from "../../contracts/src/index.js";
import { id, now, objectHash } from "./util.js";
import type { ExecutionSpecService } from "./execution-spec-service.js";
import { assertProfilesVerified } from "./access-guard.js";

const BATCH_KIND = "repair_model_batch";
const ASSIGNMENT_KIND = "repair_model_assignment";

type AssignRepairRequest = {
  workflow_id: string;
  request_id: string;
  batch_id: string;
  expected_assignment_revision: number;
  expected_spec_revision: number;
  selection: unknown;
  remember_for_task?: boolean;
};

function assignmentStoreId(assignment: Pick<RepairModelAssignment, "id" | "revision">) {
  return assignment.id + ":r" + assignment.revision;
}

function needsSpecRevision(selection: RepairSelection, remember: boolean) {
  if (remember) return true;
  return selection.mode !== "task-default";
}

function listBatches(store: Store, workflowId: string) {
  return store.list<RepairModelBatch>(BATCH_KIND, workflowId);
}

function listAssignments(store: Store, workflowId: string) {
  return store.list<RepairModelAssignment>(ASSIGNMENT_KIND, workflowId);
}

export function openRepairBatch(
  store: Store,
  workflowId: string,
  kind: RepairKind,
  phase?: QualityPhase,
): RepairModelBatch | undefined {
  return listBatches(store, workflowId).find(
    (batch) =>
      batch.status === "open" &&
      batch.kind === kind &&
      (kind !== "quality" || batch.phase === phase),
  );
}

export function ensureQualityRepairBatch(
  store: Store,
  workflowId: string,
  phase: QualityPhase,
  sourceReviewId: string,
): RepairModelBatch {
  const existing = openRepairBatch(store, workflowId, "quality", phase);
  if (existing) {
    const next = { ...existing, source_review_id: sourceReviewId };
    store.put(BATCH_KIND, existing.id, workflowId, next);
    return next;
  }
  const batch = RepairModelBatchSchema.parse({
    id: id("batch"),
    workflow_id: workflowId,
    kind: "quality",
    phase,
    source_review_id: sourceReviewId,
    issue_ids: [],
    status: "open",
    created_at: now(),
  });
  store.put(BATCH_KIND, batch.id, workflowId, batch);
  return batch;
}

export function closeQualityRepairBatch(
  store: Store,
  workflowId: string,
  phase: QualityPhase,
) {
  const batch = openRepairBatch(store, workflowId, "quality", phase);
  if (!batch) return;
  closeBatch(store, batch);
}

export function closeOpenRepairBatches(store: Store, workflowId: string) {
  for (const batch of listBatches(store, workflowId)) {
    if (batch.status === "open") closeBatch(store, batch);
  }
}

function closeBatch(store: Store, batch: RepairModelBatch) {
  completeCurrentAssignment(store, batch);
  store.put(BATCH_KIND, batch.id, batch.workflow_id, {
    ...batch,
    status: "closed",
    closed_at: now(),
  });
}

function completeCurrentAssignment(store: Store, batch: RepairModelBatch) {
  const current = currentAssignmentOf(store, batch);
  if (!current) return;
  if (current.status === "completed" || current.status === "superseded") return;
  store.put(ASSIGNMENT_KIND, assignmentStoreId(current), batch.workflow_id, {
    ...current,
    status: "completed",
  });
}

function currentAssignmentOf(
  store: Store,
  batch: RepairModelBatch,
): RepairModelAssignment | undefined {
  const matched = listAssignments(store, batch.workflow_id).filter(
    (item) =>
      item.batch_id === batch.id &&
      (item.status === "pending" || item.status === "active"),
  );
  matched.sort((a, b) => b.revision - a.revision);
  if (batch.current_assignment_id) {
    return (
      matched.find((item) => item.id === batch.current_assignment_id) ??
      matched[0]
    );
  }
  return matched[0];
}

export function bindRepairAssignment(
  store: Store,
  workflowId: string,
  assignmentId: string,
) {
  const matched = listAssignments(store, workflowId).filter(
    (item) =>
      item.id === assignmentId &&
      (item.status === "pending" || item.status === "active"),
  );
  matched.sort((a, b) => b.revision - a.revision);
  const current = matched[0];
  if (!current || current.status === "active") return current;
  const next = { ...current, status: "active" as const };
  store.put(ASSIGNMENT_KIND, assignmentStoreId(next), workflowId, next);
  return next;
}

export function syncFunctionalAssignmentStatus(
  store: Store,
  workflowId: string,
) {
  const issues = store.list<FunctionalIssue>("functional_issue", workflowId);
  for (const batch of listBatches(store, workflowId)) {
    if (batch.kind !== "functional" || batch.status !== "open") continue;
    const members = issues.filter((issue) =>
      batch.issue_ids.includes(issue.issue_id),
    );
    if (!members.length) continue;
    if (!members.every((issue) => issue.status === "confirmed")) continue;
    closeBatch(store, batch);
  }
}

export function ensureFunctionalBatchForIssue(
  store: Store,
  workflowId: string,
  issueId: string,
) {
  const existing = listBatches(store, workflowId).find(
    (batch) =>
      batch.kind === "functional" &&
      batch.status === "open" &&
      batch.issue_ids.includes(issueId),
  );
  if (existing) return existing;
  const batch = RepairModelBatchSchema.parse({
    id: id("batch"),
    workflow_id: workflowId,
    kind: "functional",
    issue_ids: [issueId],
    status: "open",
    created_at: now(),
  });
  store.put(BATCH_KIND, batch.id, workflowId, batch);
  return batch;
}

export class RepairModelService {
  constructor(
    private store: Store,
    private specs: ExecutionSpecService,
  ) {}

  parseSelection(value: unknown): RepairSelection {
    if (value === undefined) return { mode: "task-default" };
    return RepairSelectionSchema.parse(value);
  }

  assign(input: AssignRepairRequest): MutationReceipt {
    const requestId = z.string().uuid().parse(input.request_id);
    const operationId = "repair-" + objectHash({ workflow: input.workflow_id, requestId });
    const requestHash = objectHash(input);
    return this.store.transaction(() => {
      const prior = this.store.get<{ hash: string; receipt: MutationReceipt }>("repair_assignment_operation", operationId);
      if (prior) {
        if (prior.hash !== requestHash) throw new FlowError("IDEMPOTENCY_CONFLICT", "同一请求不能修改为不同内容", 409);
        return MutationReceiptSchema.parse(prior.receipt);
      }
      const workflow = this.store.must<{ state: string }>("workflow", input.workflow_id);
      if (["COMMITTED", "COMPLETED", "COMMIT_PARTIAL", "CLEANUP_PENDING"].includes(workflow.state)) {
        throw new FlowError("TASK_TERMINAL", "任务已结束，不能修改修复指派", 422);
      }
      const receipt = this.assignOnce(input);
      this.store.put("repair_assignment_operation", operationId, input.workflow_id, { hash: requestHash, receipt });
      return receipt;
    });
  }

  private assignOnce(input: AssignRepairRequest): MutationReceipt {
    const requestId = z.string().uuid().parse(input.request_id);
    const expectedAssignment = z
      .number()
      .int()
      .nonnegative()
      .parse(input.expected_assignment_revision);
    const expectedSpec = z
      .number()
      .int()
      .nonnegative()
      .parse(input.expected_spec_revision);
    const selection = this.parseSelection(input.selection);
    const batch = this.requireOpenBatch(input.workflow_id, input.batch_id);
    const currentRevision = this.currentAssignmentRevision(batch);
    if (expectedAssignment !== currentRevision) {
      throw new FlowError("REPAIR_BATCH_MISMATCH", "修复指派版本已变化", 409);
    }
    this.assertSpecRevision(input.workflow_id, expectedSpec);
    const profile = this.profileFromSelection(input.workflow_id, selection, batch.kind);
    assertProfilesVerified(this.store, [profile]);
    if (selection.mode === "task-default") {
      const remembered = input.remember_for_task
        ? this.rememberFixer(input.workflow_id, requestId, profile, batch.kind)
        : undefined;
      const receipt = this.clearAssignment(batch, requestId, currentRevision);
      return remembered?.changed
        ? MutationReceiptSchema.parse({ ...receipt, changed: true, pending_roles: [batch.kind === "quality" ? "review_fixer" : "functional_fixer"] })
        : receipt;
    }
    const assignment = this.writeAssignment(batch, profile, batch.issue_ids);
    this.store.put(BATCH_KIND, batch.id, input.workflow_id, {
      ...batch,
      current_assignment_id: assignment.id,
    });
    if (input.remember_for_task) this.rememberFixer(input.workflow_id, requestId, profile, batch.kind);
    return MutationReceiptSchema.parse({
      operation_id: "op-repair-" + requestId,
      request_id: requestId,
      status: "committed",
      entity_revision: assignment.revision,
      changed: true,
      effective_from: "next-run",
      current_run_id: null,
      pending_roles: [batch.kind === "quality" ? "review_fixer" : "functional_fixer"],
    });
  }

  attachIssueRepair(input: {
    workflow_id: string;
    request_id: string;
    issue: FunctionalIssue;
    repair_model?: unknown;
    remember_for_task?: boolean;
    expected_spec_revision?: unknown;
  }): void {
    this.store.transaction(() => {
      const selection = this.parseSelection(input.repair_model);
      const remember = input.remember_for_task === true;
      if (needsSpecRevision(selection, remember)) {
        const expected = z.number().int().nonnegative().parse(input.expected_spec_revision);
        this.assertSpecRevision(input.workflow_id, expected);
      }
      const profile = selection.mode !== "task-default" || remember
        ? this.profileFromSelection(input.workflow_id, selection)
        : undefined;
      if (profile) assertProfilesVerified(this.store, [profile]);
      const batch = this.openFunctionalBatch(input.workflow_id, [input.issue.issue_id]);
      if (selection.mode === "task-default") {
        this.clearOverride(batch);
      } else {
        const assignment = this.writeAssignment(batch, profile!, batch.issue_ids);
        this.store.put(BATCH_KIND, batch.id, input.workflow_id, {
          ...batch,
          current_assignment_id: assignment.id,
        });
      }
      if (remember && profile) {
        this.rememberFixer(input.workflow_id, input.request_id, profile, "functional");
      }
      recordFunctionalFixIntent(this.store, input.workflow_id, batch.id);
    });
  }

  submitFunctionalRepair(input: {
    workflow_id: string;
    request_id: string;
    descriptions?: Array<{ description: string; refs?: FunctionalIssue["refs"] }>;
    issue_ids?: string[];
    selection: RepairSelection;
    expected_spec_revision: number;
    remember_for_task?: boolean;
  }) {
    return this.store.transaction(() => {
      const requestId = z.string().uuid().parse(input.request_id);
      const selection = this.parseSelection(input.selection);
      const expectedSpec = z.number().int().nonnegative().parse(input.expected_spec_revision);
      const remember = input.remember_for_task === true;
      if (needsSpecRevision(selection, remember)) {
        this.assertSpecRevision(input.workflow_id, expectedSpec);
      }
      const issueIds = [
        ...(input.issue_ids ?? []),
        ...this.createIssues(input.workflow_id, input.descriptions ?? []),
      ];
      const batch = this.openFunctionalBatch(input.workflow_id, issueIds);
      if (selection.mode === "task-default") {
        if (remember) {
          const profile = this.profileFromSelection(input.workflow_id, selection);
          this.rememberFixer(input.workflow_id, requestId, profile, "functional");
        }
        this.clearOverride(batch);
      } else {
        const profile = this.profileFromSelection(input.workflow_id, selection);
        assertProfilesVerified(this.store, [profile]);
        const assignment = this.writeAssignment(batch, profile, batch.issue_ids);
        this.store.put(BATCH_KIND, batch.id, input.workflow_id, {
          ...batch,
          current_assignment_id: assignment.id,
        });
        if (remember) {
          this.rememberFixer(input.workflow_id, requestId, profile, "functional");
        }
      }
      recordFunctionalFixIntent(this.store, input.workflow_id, batch.id);
      return {
        batch: this.store.must<RepairModelBatch>(BATCH_KIND, batch.id),
        assignment: currentAssignmentOf(this.store, batch),
        issue_ids: issueIds,
      };
    });
  }

  bindRun(workflowId: string, assignmentId: string) {
    return bindRepairAssignment(this.store, workflowId, assignmentId);
  }

  listOpenBatches(workflowId: string): RepairBatchView[] {
    return listBatches(this.store, workflowId)
      .filter((batch) => batch.status === "open")
      .map((batch) => {
        const assignment = currentAssignmentOf(this.store, batch);
        return {
          batch,
          assignment: assignment ?? null,
          inherited_profile: this.profileFromSelection(workflowId, { mode: "task-default" }, batch.kind),
          last_fixer_profile: lastFixerProfile(this.store, workflowId, batch.id),
          can_edit: true,
        };
      });
  }

  issueViews(workflowId: string): FunctionalIssueView[] {
    const inherited = inheritedFixerProfile(this.specs.getLatestSpec(workflowId));
    const issues = this.store.list<FunctionalIssue>("functional_issue", workflowId);
    return issues.map((issue) => {
      const batch = batchForIssue(this.store, workflowId, issue.issue_id);
      const assignment = batch ? currentAssignmentOf(this.store, batch) : undefined;
      return {
        issue: {
          issue_id: issue.issue_id,
          workflow_id: issue.workflow_id,
          created_seq: issue.created_seq,
          description: issue.description,
          status: issue.status,
          created_at: issue.created_at,
        },
        batch_id: batch?.id ?? null,
        assignment_revision: assignment?.revision ?? null,
        assignment_id: assignment?.id ?? null,
        inherited_profile: inherited,
        explicit_profile: assignment?.profile ?? null,
        last_fixer_profile: batch
          ? lastFixerProfile(this.store, workflowId, batch.id)
          : null,
      };
    });
  }

  private createIssues(
    workflowId: string,
    descriptions: Array<{ description: string; refs?: FunctionalIssue["refs"] }>,
  ) {
    return descriptions.map((item) => {
      const existing = this.store.list<FunctionalIssue>(
        "functional_issue",
        workflowId,
      );
      const issue: FunctionalIssue = {
        issue_id: id("issue"),
        workflow_id: workflowId,
        created_seq: existing.length + 1,
        description: item.description,
        refs: item.refs ?? [],
        status: "open",
        created_at: now(),
      };
      this.store.put("functional_issue", issue.issue_id, workflowId, issue);
      return issue.issue_id;
    });
  }

  private rememberFixer(
    workflowId: string,
    requestId: string,
    profile: ToolProfile,
    kind: RepairKind = "functional",
  ) {
    const view = this.specs.readView(workflowId);
    const overrides: RoleOverrides = {
      ...(view.spec.roleOverrides ?? inheritRoleOverrides()),
      [kind === "quality" ? "review_fixer" : "functional_fixer"]: { mode: "explicit", profile },
    };
    return this.specs.updateExecutionSpec({
      request_id: requestId,
      expected_spec_revision: view.persisted ? view.spec.revision : 0,
      workflow_id: workflowId,
      planner_profile: view.spec.plannerProfile,
      executor_profile: view.spec.executorProfile,
      role_overrides: overrides,
    });
  }

  private requireOpenBatch(workflowId: string, batchId: string): RepairModelBatch {
    const batch = this.store.get<RepairModelBatch>(BATCH_KIND, batchId);
    if (!batch || batch.workflow_id !== workflowId) {
      throw new FlowError(
        "REPAIR_BATCH_MISMATCH",
        "修复批次不存在或不属于当前任务",
        409,
      );
    }
    if (batch.status !== "open") {
      throw new FlowError("REPAIR_BATCH_MISMATCH", "修复批次已关闭", 409);
    }
    return RepairModelBatchSchema.parse(batch);
  }

  private currentAssignmentRevision(batch: RepairModelBatch): number {
    return currentAssignmentOf(this.store, batch)?.revision ?? 0;
  }

  private assertSpecRevision(workflowId: string, expected: number) {
    const specView = this.specs.readView(workflowId);
    const currentSpec = specView.persisted ? specView.spec.revision : 0;
    if (expected !== currentSpec) {
      throw new FlowError("SPEC_VERSION_CONFLICT", "执行配置版本已变化", 409);
    }
  }

  private openFunctionalBatch(
    workflowId: string,
    issueIds: string[],
  ): RepairModelBatch {
    const overlapping = listBatches(this.store, workflowId).filter(
      (batch) =>
        batch.kind === "functional" &&
        batch.status === "open" &&
        issueIds.some((issueId) => batch.issue_ids.includes(issueId)),
    );
    const unique = new Set(overlapping.map((batch) => batch.id));
    if (unique.size > 1) {
      throw new FlowError(
        "REPAIR_BATCH_MISMATCH",
        "所选功能问题属于不同修复批次，请分批提交",
        409,
      );
    }
    if (overlapping[0]) {
      const merged = Array.from(
        new Set([...overlapping[0].issue_ids, ...issueIds]),
      );
      const next = { ...overlapping[0], issue_ids: merged };
      this.store.put(BATCH_KIND, next.id, workflowId, next);
      return next;
    }
    const batch = RepairModelBatchSchema.parse({
      id: id("batch"),
      workflow_id: workflowId,
      kind: "functional",
      issue_ids: issueIds,
      status: "open",
      created_at: now(),
    });
    this.store.put(BATCH_KIND, batch.id, workflowId, batch);
    return batch;
  }

  private writeAssignment(
    batch: RepairModelBatch,
    profile: ToolProfile,
    issueIds: string[],
  ): RepairModelAssignment {
    const previous = currentAssignmentOf(this.store, batch);
    if (previous) {
      this.store.put(
        ASSIGNMENT_KIND,
        assignmentStoreId(previous),
        batch.workflow_id,
        {
          ...previous,
          status: "superseded",
        },
      );
    }
    const assignment = RepairModelAssignmentSchema.parse({
      id: previous?.id ?? id("assignment"),
      revision: (previous?.revision ?? 0) + 1,
      workflow_id: batch.workflow_id,
      batch_id: batch.id,
      kind: batch.kind,
      phase: batch.phase,
      source_review_id: batch.source_review_id,
      issue_ids: issueIds.length ? issueIds : batch.issue_ids,
      profile,
      status: "pending",
      created_at: now(),
      created_by: "human",
    });
    this.store.put(
      ASSIGNMENT_KIND,
      assignmentStoreId(assignment),
      batch.workflow_id,
      assignment,
    );
    return assignment;
  }

  private profileFromSelection(
    workflowId: string,
    selection: RepairSelection,
    kind: RepairKind = "functional",
  ): ToolProfile {
    const spec = this.specs.getLatestSpec(workflowId);
    if (selection.mode === "planner") return spec.plannerProfile;
    if (selection.mode === "executor") return spec.executorProfile;
    if (selection.mode === "custom") return selection.profile;
    const binding = spec.roleOverrides[kind === "quality" ? "review_fixer" : "functional_fixer"];
    return binding.mode === "explicit" ? binding.profile : spec.executorProfile;
  }

  private clearOverride(batch: RepairModelBatch) {
    const current = currentAssignmentOf(this.store, batch);
    if (!current) return;
    this.store.put(
      ASSIGNMENT_KIND,
      assignmentStoreId(current),
      batch.workflow_id,
      {
        ...current,
        status: "superseded",
      },
    );
    const next = { ...batch };
    delete next.current_assignment_id;
    this.store.put(BATCH_KIND, batch.id, batch.workflow_id, next);
  }

  private clearAssignment(
    batch: RepairModelBatch,
    requestId: string,
    currentRevision: number,
  ): MutationReceipt {
    const changed = Boolean(currentAssignmentOf(this.store, batch));
    this.clearOverride(batch);
    return MutationReceiptSchema.parse({
      operation_id: "op-repair-" + requestId,
      request_id: requestId,
      status: "committed",
      entity_revision: currentRevision,
      changed,
      effective_from: "next-run",
      current_run_id: null,
      pending_roles: changed ? [batch.kind === "quality" ? "review_fixer" : "functional_fixer"] : [],
    });
  }
}

export function recordFunctionalFixIntent(
  store: Store,
  workflowId: string,
  batchId: string,
) {
  const prior =
    store.get<Record<string, unknown>>("functional_fix_intent", workflowId) ??
    {};
  store.put("functional_fix_intent", workflowId, workflowId, {
    ...prior,
    batch_id: batchId,
  });
}

function inheritedFixerProfile(spec: {
  executorProfile: ToolProfile;
  roleOverrides: RoleOverrides;
}): ToolProfile {
  const binding = spec.roleOverrides.functional_fixer;
  if (binding.mode === "explicit") return binding.profile;
  return spec.executorProfile;
}

function lastFixerProfile(
  store: Store,
  workflowId: string,
  batchId: string,
): ToolProfile | null {
  const runs = store
    .list<{
      repair_batch_id?: string;
      model_binding?: { repair_batch_id?: string };
      profile?: ToolProfile;
      started_at?: string;
    }>("run", workflowId)
    .filter((run) => (run.model_binding?.repair_batch_id ?? run.repair_batch_id) === batchId && run.profile);
  runs.sort((left, right) =>
    (left.started_at ?? "") < (right.started_at ?? "")
      ? 1
      : (left.started_at ?? "") > (right.started_at ?? "")
        ? -1
        : 0,
  );
  return runs[0]?.profile ?? null;
}

function batchForIssue(
  store: Store,
  workflowId: string,
  issueId: string,
): RepairModelBatch | undefined {
  const matched = listBatches(store, workflowId).filter((batch) =>
    batch.issue_ids.includes(issueId),
  );
  matched.sort((left, right) =>
    left.created_at < right.created_at
      ? 1
      : left.created_at > right.created_at
        ? -1
        : 0,
  );
  return matched[0];
}
