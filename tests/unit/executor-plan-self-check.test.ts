import { describe, it, expect } from "vitest";
import { Store } from "../../packages/store/src/store.js";
import {
  PlanSelfCheckCoordinator,
  PLAN_SELF_CHECK_STAGE,
} from "../../packages/core/src/plan-self-check.js";
import { HandoffBuilder } from "../../packages/adapters/agy/src/handoff.js";
import { PlanSelfCheckReportSchema } from "../../packages/contracts/src/plan-self-check.js";
import { plan } from "../helpers.js";
import type {
  Workflow,
  Run,
  DeliveryRevision,
  DeliveryManifest,
} from "../../packages/contracts/src/index.js";
import { objectHash, hash } from "../../packages/core/src/util.js";

function fixture() {
  const store = new Store(":memory:"),
    gate = new PlanSelfCheckCoordinator(store);
  const original = plan("project", "a".repeat(40));
  const repair = {
    ...original,
    markdown: original.markdown + "\n正式整改：保持原需求，修复边界。",
  };
  for (const [i, p] of [original, repair].entries()) {
    const revision = i + 1,
      hash = objectHash(p);
    store.put("plan", "w-" + revision, "w", { revision, hash, plan: p });
    store.put("approval", "w-" + revision, "w", { revision, plan_hash: hash });
  }
  const w: Workflow = {
    id: "w",
    project_id: "p",
    title: "t",
    request: "r",
    complexity: "simple",
    workspace_mode: "existing_workspace",
    state: "EXECUTING",
    stage: PLAN_SELF_CHECK_STAGE,
    version: 1,
    plan_revision: 2,
    plan_hash: objectHash(repair),
    environment_revision: 0,
    feedback: [],
    created_at: "now",
    updated_at: "now",
    snapshot_id: "snapshot",
  };
  const source: DeliveryRevision = {
    id: "source",
    workflow_id: "w",
    delivery_id: "delivery",
    snapshot_id: "snapshot",
    plan_revision: 2,
    plan_hash: w.plan_hash!,
    input_fingerprints: {},
    execution_finished: true,
    run_id: "development",
    created_at: "now",
  };
  gate.queue(w, source);
  const run: Run = {
    id: "selfcheck",
    workflow_id: "w",
    plan_revision: 2,
    adapter: "agy",
    stage: PLAN_SELF_CHECK_STAGE,
    status: "running",
    started_at: "now",
    package_hash: "pkg",
  };
  gate.start(w, run);
  const r = gate.current("w")!;
  const report = {
    request_id: r.id,
    source_delivery_revision_id: r.source_delivery_revision_id,
    plan_revision: 2,
    plan_hash: w.plan_hash!,
    authority_hash: r.authority_hash,
    run_id: run.id,
    verdict: "passed" as const,
    checks: r.check_ids.map((check_id) => ({
      check_id,
      status: "passed" as const,
      evidence: ["main:app.txt / UT01"],
    })),
    findings: [],
  };
  const manifest: DeliveryManifest = {
    implementations: [],
    test_executions: [],
    acceptance_mappings: [],
    unfinished_items: [],
    plan_conflicts: [],
    plan_self_check: report,
  };
  return { store, gate, w, source, run, report, manifest, original, repair };
}
describe("执行复核的计划、轮次和交付绑定", () => {
  it("精简 native 索引必须覆盖，设计引用缺失或正文被篡改时不派发", () => {
    const s = fixture();
    try {
      const p = s.store.must<any>("plan", "w-2");
      p.plan = {
        ...p.plan,
        markdown: undefined,
        tasks: [],
        tests: [],
        work_items: [{ id: "W1" }],
        acceptance_items: [{ id: "A1" }],
        design_ref: {
          content_hash: hash("完整正式设计"),
          summary: "不能只读此摘要",
        },
      };
      p.hash = objectHash(p.plan);
      s.w.plan_hash = p.hash;
      s.store.put("plan", "w-2", "w", p);
      s.store.put("approval", "w-2", "w", { plan_hash: p.hash });
      expect(() => s.gate.queue(s.w, s.source)).toThrow(
        "缺少正式计划引用的完整设计正文",
      );
      s.store.put("project_document", "design", "w", {
        hash: hash("完整正式设计"),
        content: "完整正式设计",
      });
      const req = s.gate.queue(s.w, s.source);
      expect(req.check_ids).toContain("r2:work_item:W1");
      expect(req.check_ids).toContain("r2:acceptance:A1");
      expect(s.gate.authorities(s.w)[1]!.plan.markdown).toBe("完整正式设计");
      s.store.put("project_document", "design", "w", {
        hash: hash("完整正式设计"),
        content: "执行模型替代计划",
      });
      expect(() => s.gate.authorities(s.w)).toThrow();
    } finally {
      s.store.close();
    }
  });
  it("同时检查原始与正式整改计划，恢复交接仍含完整索引和当前会话", () => {
    const s = fixture();
    try {
      const request = s.gate.current("w")!;
      expect(request.check_ids).toEqual([
        "r1:document",
        "r1:task:T01",
        "r1:test:UT01",
        "r2:document",
        "r2:task:T01",
        "r2:test:UT01",
      ]);
      const pkg = HandoffBuilder.buildPlanSelfCheckHandoff({
        workflow: s.w,
        plan: s.repair,
        runId: s.run.id,
        packageHash: "pkg",
        conversationId: "original-conversation",
        request,
      });
      expect(pkg.conversation_id).toBe("original-conversation");
      expect(pkg.index.tasks).toHaveLength(1);
      expect(pkg.index.acceptance_items).toHaveLength(1);
      expect(pkg.instructions).toContain("禁止创建");
      expect(pkg.authoritative_plans_file).toBe("AUTHORITATIVE_PLANS.json");
      s.gate.validateDelivery(s.w, s.run, s.manifest);
    } finally {
      s.store.close();
    }
  });
  it.each(["feedback", "environment", "plan", "authority"] as const)(
    "%s 变化后旧报告失效",
    (kind) => {
      const s = fixture();
      try {
        if (kind === "feedback") s.w.feedback.push("修复新的反馈");
        if (kind === "environment") s.w.environment_revision++;
        if (kind === "plan") s.w.plan_hash = "changed";
        if (kind === "authority") {
          const p = s.store.must<any>("plan", "w-1");
          p.plan.markdown = "被替代的实施计划";
          s.store.put("plan", "w-1", "w", p);
        }
        expect(s.gate.pending(s.w)).toBeUndefined();
        expect(() => s.gate.validateDelivery(s.w, s.run, s.manifest)).toThrow();
      } finally {
        s.store.close();
      }
    },
  );
  it("重复编号、只核对最新整改、空证据都不算完成", () => {
    const s = fixture();
    try {
      s.report.checks[1]!.check_id = s.report.checks[0]!.check_id;
      expect(() => s.gate.validateDelivery(s.w, s.run, s.manifest)).toThrow();
      s.report.checks = s.report.checks.filter((c) =>
        c.check_id.startsWith("r2:"),
      );
      expect(() => s.gate.validateDelivery(s.w, s.run, s.manifest)).toThrow();
      expect(
        PlanSelfCheckReportSchema.safeParse({
          ...s.report,
          checks: [
            { check_id: "r2:document", status: "passed", evidence: ["  "] },
          ],
        }).success,
      ).toBe(false);
    } finally {
      s.store.close();
    }
  });
  it.each(["failed", "stopped", "nonzero", "invalidated", "tampered"] as const)(
    "%s 的复核交付不能被规划审查消费",
    (kind) => {
      const s = fixture();
      try {
        const run = { ...s.run, status: "completed", exit_code: 0 };
        const rev = {
          ...s.source,
          id: "checked",
          run_id: run.id,
          delivery_id: "checked-delivery",
        };
        s.store.put("run", run.id, "w", run);
        s.store.put("delivery_revision", rev.id, "w", rev);
        s.store.put("delivery", rev.delivery_id, "w", { manifest: s.manifest });
        s.gate.complete(s.w, run, rev, s.manifest);
        expect(s.gate.assertPassed(s.w).status).toBe("passed");
        if (kind === "failed")
          s.store.put("run", run.id, "w", { ...run, status: "failed" });
        if (kind === "stopped")
          s.store.put("run_stop", run.id, "w", { stopped: true });
        if (kind === "nonzero")
          s.store.put("run", run.id, "w", { ...run, exit_code: 1 });
        if (kind === "invalidated")
          s.store.put("delivery_revision", rev.id, "w", {
            ...rev,
            invalidated: true,
          });
        if (kind === "tampered")
          s.store.put("delivery", rev.delivery_id, "w", {
            manifest: {
              ...s.manifest,
              plan_self_check: { ...s.report, findings: [{ id: "new" }] },
            },
          });
        expect(() => s.gate.assertPassed(s.w)).toThrow();
      } finally {
        s.store.close();
      }
    },
  );
});
