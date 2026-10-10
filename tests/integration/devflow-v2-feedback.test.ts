import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { DocumentService } from "../../packages/core/src/document-service.js";
import { FeedbackService } from "../../packages/core/src/feedback-service.js";
import { FunctionalIssueService } from "../../packages/core/src/functional-issues.js";
import { buildServer } from "../../apps/api/src/server.js";
import { now } from "../../packages/core/src/util.js";
import type { FastifyInstance } from "fastify";
import { readFileSync, writeFileSync } from "node:fs";

describe("IT-FEEDBACK: 项目原件、游标增量推进、问题跟踪与用户确认权限", () => {
  let env: IsolatedTestEnv;
  let app: FastifyInstance;
  let docService: DocumentService;
  let fbService: FeedbackService;
  let issueService: FunctionalIssueService;
  const workflowId = "wf_feedback_test";

  beforeEach(async () => {
    env = createIsolatedTestEnv();
    app = await buildServer(env.engine);
    docService = new DocumentService(env.store, env.root);
    fbService = new FeedbackService(env.store);
    issueService = new FunctionalIssueService(env.store);

    env.store.put("workflow", workflowId, "proj_fb", {
      id: workflowId,
      project_id: "proj_fb",
      title: "反馈与文档流转测试",
      state: "PLAN_PENDING",
      version: 1,
      plan_revision: 1,
      created_at: now(),
      updated_at: now(),
    });
    env.store.put("workspace", "workspace-feedback", workflowId, {
      id: "workspace-feedback", workflow_id: workflowId, repo_id: "main",
      root: env.repoRoot, source_root: env.repoRoot, branch: "fixture", baseline: "a".repeat(40),
    });
  });

  afterEach(async () => {
    await app.close();
    await env.cleanup();
  });

  it("TC-FB-01: 重新登记保留项目原件，审批读取当前原件并拒绝其他工作流文档", () => {
    // 1. 发布第一版计划
    const doc1 = docService.publishDocument(
      workflowId,
      "plan",
      "# 初始计划\n\n## 模块划分\n",
    );
    expect(doc1.revision).toBe(1);

    // 2. 正常审批
    const approved = docService.approveDocument(workflowId, doc1.id, {
      request_id: "req_app_01",
      expected_version: 1,
      document_revision: 1,
      document_hash: doc1.hash,
      feedback_cursor: 0,
    });
    expect(approved.approved_by_human).toBe(true);

    // Registration uses the same project original and cannot overwrite user progress.
    const doc2 = docService.publishDocument(
      workflowId,
      "plan",
      "# 更新计划\n\n## 新模块划分\n",
    );
    expect(doc2.id).toBe(doc1.id);
    expect(doc2.path).toBe(doc1.path);
    expect(doc2.content).toBe(doc1.content);
    expect(readFileSync(doc1.path!, "utf8")).toBe(doc1.content);

    const progress = doc1.content + "\n- [x] 原计划的实现进度\n";
    writeFileSync(doc1.path!, progress, "utf8");
    const latest = docService.approveDocument(workflowId, doc2.id, {
      request_id: "req_app_current", expected_version: 1,
      document_revision: 1, document_hash: doc1.hash, feedback_cursor: 0,
    });
    expect(latest.content).toBe(progress);
    expect(latest.hash).not.toBe(doc1.hash);
    expect(latest.approved_by_human).toBe(true);
    expect(env.store.get<any>("project_document", doc1.id)).not.toHaveProperty("content");

    // Workflow ownership remains a real authorization boundary.
    expect(() => {
      docService.approveDocument("another-workflow", doc2.id, {
        request_id: "req_app_tamper",
        expected_version: 1,
        document_revision: 2,
        document_hash: "tampered_hash_val",
        feedback_cursor: 0,
      });
    }).toThrow(/审批的文档不存在/);
  });

  it("TC-FB-02: 反馈消息按 seq 严格有序，游标增量分页查询且幂等记录 (RQ-08)", () => {
    // 提交三条反馈
    const fb1 = fbService.submitFeedback({
      request_id: "fb_req_1",
      workflow_id: workflowId,
      kind: "planning",
      text: "请补充性能指标要求",
    });
    const fb2 = fbService.submitFeedback({
      request_id: "fb_req_2",
      workflow_id: workflowId,
      kind: "planning",
      text: "请补充降级重试方案",
    });
    const fb3 = fbService.submitFeedback({
      request_id: "fb_req_3",
      workflow_id: workflowId,
      kind: "planning",
      text: "请补充回滚操作手册",
    });

    expect(fb1.seq).toBeLessThan(fb2.seq);
    expect(fb2.seq).toBeLessThan(fb3.seq);

    // 游标初始分页（after_seq = 0, limit = 2）
    const page1 = fbService.listMessages(workflowId, 0, 2);
    expect(page1.messages.length).toBe(2);
    expect(page1.messages[0]!.message_id).toBe(fb1.message_id);
    expect(page1.messages[1]!.message_id).toBe(fb2.message_id);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBe(fb2.seq);

    // 增量查询第二页
    const page2 = fbService.listMessages(workflowId, page1.nextCursor!, 2);
    expect(page2.messages.length).toBe(1);
    expect(page2.messages[0]!.message_id).toBe(fb3.message_id);
    expect(page2.hasMore).toBe(false);

    // 消息确认 ack
    expect(() =>
      fbService.acknowledgeMessage(workflowId, fb1.message_id),
    ).toThrow();
    env.store.put("run", "real-run", workflowId, {
      id: "real-run",
      workflow_id: workflowId,
      status: "running",
    });
    env.store.put("workflow", workflowId, "proj", {
      ...env.store.must<any>("workflow", workflowId),
      run_id: "real-run",
    });
    const acked = fbService.acknowledgeMessage(workflowId, fb1.message_id);
    expect(acked.status).toBe("acknowledged");
  });

  it("TC-FB-03: 功能问题流转状态机与模型自审自确认防御 (LF-14~16, RQ-08)", () => {
    // 1. 用户提出功能问题
    const issue = issueService.createIssue(workflowId, "点击登录按钮无反应", [
      {
        ref_id: "ref_1",
        repo_id: "repo_default",
        relative_path: "src/login.ts",
        kind: "file",
        availability: "available",
        label: "login handler: line 10-20",
      },
    ]);
    expect(issue.status).toBe("open");

    // 2. 模型执行修复中
    issueService.markFixing(workflowId, issue.issue_id);
    const fixingIssue = env.store.get<any>("functional_issue", issue.issue_id);
    expect(fixingIssue.status).toBe("fixing");

    // 3. 模型修复完成只能标记 ready_for_retest，若未到该状态用户直接通过则拦截
    expect(() => {
      issueService.userConfirmIssue(workflowId, issue.issue_id, true);
    }).toThrow(/尚未完成修复并提交复测/);

    // 4. 模型提交复测交付物
    issueService.markReadyForRetest(workflowId, issue.issue_id, "del_rev_001");
    const retestIssue = env.store.get<any>("functional_issue", issue.issue_id);
    expect(retestIssue.status).toBe("ready_for_retest");

    // 5. 存在未确认问题时，检查阻断
    expect(issueService.hasUnresolvedIssues(workflowId)).toBe(true);

    // 6. 用户复测不通过，退回 open 状态
    issueService.userConfirmIssue(
      workflowId,
      issue.issue_id,
      false,
      "偶现白屏问题未根治",
    );
    const rejectedIssue = env.store.get<any>(
      "functional_issue",
      issue.issue_id,
    );
    expect(rejectedIssue.status).toBe("open");
    expect(rejectedIssue.retest_feedback).toBe("偶现白屏问题未根治");

    // 7. 重新修复与复测通过
    issueService.markReadyForRetest(workflowId, issue.issue_id, "del_rev_002");
    issueService.userConfirmIssue(workflowId, issue.issue_id, true);
    const confirmedIssue = env.store.get<any>(
      "functional_issue",
      issue.issue_id,
    );
    expect(confirmedIssue.status).toBe("confirmed");
    expect(issueService.hasUnresolvedIssues(workflowId)).toBe(false);
  });
});
