import { expect, it } from "vitest";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { proof } from "../helpers.js";
import { FunctionalIssueService } from "../../packages/core/src/functional-issues.js";

it("explicit overall acceptance resolves legacy issue bookkeeping without a hidden second confirmation", async () => {
  const s = await fixture();
  try {
    const w = s.engine.get(s.w.id);
    s.store.put("workflow", w.id, w.project_id, { ...w, state: "HUMAN_PENDING", stage: "accept", quality_policy_version: 2 });
    const issues = new FunctionalIssueService(s.store);
    const startup = issues.createIssue(w.id, "启动前后端，我来验收", [], { skipAutoBatch: true });
    issues.markReadyForRetest(w.id, startup.issue_id, "legacy-delivery");
    const feedback = issues.createIssue(w.id, "按钮大小反馈", [], { skipAutoBatch: true });
    const other = issues.createIssue("other-workflow", "其他任务问题", [], { skipAutoBatch: true });
    const p = proof(s.engine, w.id, "accept");
    await expect(s.engine.accept(w.id, "invalid-proof", p.binding)).rejects.toThrow();
    expect(issues.listIssues(w.id).every(i => i.status !== "confirmed")).toBe(true);
    await s.engine.accept(w.id, p.proof, p.binding);
    expect(s.engine.get(w.id).state).toBe("REVIEW_QUEUED");
    for (const id of [startup.issue_id, feedback.issue_id]) {
      expect(s.store.get("functional_issue", id)).toMatchObject({ status: "confirmed", confirmed_at: expect.any(String) });
    }
    expect(s.store.get("functional_issue", other.issue_id)).toMatchObject({ status: "open" });
    expect(s.store.list("acceptance", w.id)).toHaveLength(1);
    expect(s.store.list("test_result", w.id)).toHaveLength(0);
  } finally { await cleanup(s); }
}, 60000);
