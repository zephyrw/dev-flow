import type { Store } from "../../store/src/store.js";
import type {
  FunctionalIssue,
  WorkspaceReference,
} from "../../contracts/src/feedback.js";
import { FlowError } from "../../contracts/src/index.js";
import { id, now } from "./util.js";
import {
  ensureFunctionalBatchForIssue,
  recordFunctionalFixIntent,
  syncFunctionalAssignmentStatus,
} from "./repair-model-service.js";

export class FunctionalIssueService {
  constructor(private store: Store) {}

  createIssue(
    workflowId: string,
    description: string,
    refs: WorkspaceReference[] = [],
    options: { skipAutoBatch?: boolean } = {},
  ): FunctionalIssue {
    const existing = this.listIssues(workflowId);
    const issue: FunctionalIssue = {
      issue_id: id("issue"),
      workflow_id: workflowId,
      created_seq: existing.length + 1,
      description,
      refs,
      status: "open",
      created_at: now(),
    };
    this.store.put("functional_issue", issue.issue_id, workflowId, issue);
    if (!options.skipAutoBatch) {
      const batch = ensureFunctionalBatchForIssue(
        this.store,
        workflowId,
        issue.issue_id,
      );
      recordFunctionalFixIntent(this.store, workflowId, batch.id);
    }
    return issue;
  }

  listIssues(workflowId: string): FunctionalIssue[] {
    return this.store.list<FunctionalIssue>("functional_issue", workflowId);
  }

  markFixing(workflowId: string, issueId: string): FunctionalIssue {
    const issue = this.store.get<FunctionalIssue>("functional_issue", issueId);
    if (!issue || issue.workflow_id !== workflowId) {
      throw new FlowError("NOT_FOUND", `功能问题 ${issueId} 不存在`, 404);
    }
    issue.status = "fixing";
    this.store.put("functional_issue", issueId, workflowId, issue);
    return issue;
  }

  markReadyForRetest(
    workflowId: string,
    issueId: string,
    fixDeliveryId: string,
  ): FunctionalIssue {
    const issue = this.store.get<FunctionalIssue>("functional_issue", issueId);
    if (!issue || issue.workflow_id !== workflowId) {
      throw new FlowError("NOT_FOUND", `功能问题 ${issueId} 不存在`, 404);
    }
    issue.status = "ready_for_retest";
    issue.fix_delivery_id = fixDeliveryId;
    this.store.put("functional_issue", issueId, workflowId, issue);
    return issue;
  }

  userConfirmIssue(
    workflowId: string,
    issueId: string,
    passed: boolean,
    feedback?: string,
  ): FunctionalIssue {
    const issue = this.store.get<FunctionalIssue>("functional_issue", issueId);
    if (!issue || issue.workflow_id !== workflowId) {
      throw new FlowError("NOT_FOUND", `功能问题 ${issueId} 不存在`, 404);
    }

    if (passed) {
      if (issue.status !== "ready_for_retest") {
        throw new FlowError(
          "INVALID_STATE",
          `功能问题 ${issueId} 当前处于 ${issue.status} 状态，尚未完成修复并提交复测，无法直接确认通过`,
          400,
        );
      }
      issue.status = "confirmed";
      issue.confirmed_at = now();
    } else {
      issue.status = "open";
      issue.retest_feedback = feedback;
    }

    this.store.put("functional_issue", issueId, workflowId, issue);
    if (!passed) {
      const batch = this.store
        .list<{
          id: string;
          kind?: string;
          status?: string;
          issue_ids?: string[];
        }>("repair_model_batch", workflowId)
        .find(
          (item) =>
            item.kind === "functional" &&
            item.status === "open" &&
            item.issue_ids?.includes(issueId),
        );
      if (batch) {
        recordFunctionalFixIntent(this.store, workflowId, batch.id);
      }
    }
    syncFunctionalAssignmentStatus(this.store, workflowId);
    return issue;
  }

  hasUnresolvedIssues(workflowId: string): boolean {
    const issues = this.listIssues(workflowId);
    return issues.some((i) => i.status !== "confirmed");
  }
}
