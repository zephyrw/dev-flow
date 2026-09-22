import type { Store } from "../../store/src/store.js";
import type {
  FunctionalIssue,
  FunctionalIssueStatus,
  WorkspaceReference,
} from "../../contracts/src/feedback.js";
import { FlowError } from "../../contracts/src/index.js";
import { id, now } from "./util.js";

export class FunctionalIssueService {
  constructor(private store: Store) {}

  createIssue(
    workflowId: string,
    description: string,
    refs: WorkspaceReference[] = [],
    attachment_ids: string[] = [],
  ): FunctionalIssue {
    const existing = this.listIssues(workflowId);
    const issue: FunctionalIssue = {
      issue_id: id("issue"),
      workflow_id: workflowId,
      created_seq: existing.length + 1,
      description,
      refs,
      attachment_ids: attachment_ids.slice(),
      status: "open",
      created_at: now(),
    };
    this.store.put("functional_issue", issue.issue_id, workflowId, issue);
    return issue;
  }

  listIssues(workflowId: string): FunctionalIssue[] {
    return this.store.list<FunctionalIssue>("functional_issue", workflowId);
  }

  /**
   * 派发修复中
   */
  markFixing(workflowId: string, issueId: string): FunctionalIssue {
    const issue = this.store.get<FunctionalIssue>("functional_issue", issueId);
    if (!issue || issue.workflow_id !== workflowId) {
      throw new FlowError("NOT_FOUND", `功能问题 ${issueId} 不存在`, 404);
    }
    issue.status = "fixing";
    this.store.put("functional_issue", issueId, workflowId, issue);
    return issue;
  }

  /**
   * 执行模型修复后标记待用户复测（模型只能标 ready_for_retest，严禁自确认）
   */
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

  /**
   * 用户复测确认（唯一确认通道，RQ-08）
   */
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
    return issue;
  }

  /**
   * 检查是否所有功能问题均已解决并确认
   */
  hasUnresolvedIssues(workflowId: string): boolean {
    const issues = this.listIssues(workflowId);
    return issues.some((i) => i.status !== "confirmed");
  }
}
