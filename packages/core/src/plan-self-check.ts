import type { Store } from "../../store/src/store.js";
import {
  requireCondition,
  type Workflow,
  type Run,
  type Plan,
  type DeliveryManifest,
  type DeliveryRevision,
  type Delivery,
} from "../../contracts/src/index.js";
import {
  PlanSelfCheckReportSchema,
  type PlanSelfCheckRequest,
} from "../../contracts/src/plan-self-check.js";
import { id, now, objectHash, hash } from "./util.js";

export const PLAN_SELF_CHECK_STAGE = "executor_plan_self_check";
export const BEFORE_HUMAN_REVIEW_STAGE = "quality_before_human";
type Authority = { revision: number; hash: string; plan: Plan };

/** Event-driven gate: uses the ordinary executor queue, no polling or model calls here. */
export class PlanSelfCheckCoordinator {
  constructor(private store: Store) {}
  current(key: string) {
    return this.store.get<PlanSelfCheckRequest>("executor_plan_check", key);
  }
  authorities(w: Workflow): Authority[] {
    return this.store
      .list<Authority>("plan", w.id)
      .filter(
        (p) =>
          p.revision <= w.plan_revision &&
          this.store.get<{ plan_hash: string }>(
            "approval",
            w.id + "-" + p.revision,
          )?.plan_hash === p.hash,
      )
      .sort((a, b) => a.revision - b.revision)
      .map((p) => {
        let markdown = p.plan.markdown;
        const expected = p.plan.design_ref?.content_hash;
        if (
          expected &&
          (!markdown || hash(markdown.replace(/\r\n/g, "\n")) !== expected)
        ) {
          const doc = this.store
            .list<{ hash: string; content: string }>("project_document", w.id)
            .find((d) => d.hash === expected);
          requireCondition(
            doc && hash(doc.content.replace(/\r\n/g, "\n")) === expected,
            "PLAN_DOCUMENT_MISSING",
            "缺少正式计划引用的完整设计正文，不能用摘要替代逐项复核",
          );
          markdown = doc.content;
        }
        requireCondition(
          markdown?.trim(),
          "PLAN_DOCUMENT_MISSING",
          "正式计划缺少完整正文",
        );
        return { ...p, plan: { ...p.plan, markdown } };
      });
  }
  private context(w: Workflow) {
    return objectHash({
      feedback: w.feedback,
      environment_revision: w.environment_revision,
    });
  }
  private authorityHash(w: Workflow) {
    // Include actual immutable plan contents, not only their claimed hashes.
    return objectHash(this.authorities(w));
  }
  pending(w: Workflow) {
    const r = this.current(w.id);
    return r && r.status !== "passed" && this.matches(w, r) ? r : undefined;
  }
  private matches(w: Workflow, r: PlanSelfCheckRequest) {
    return (
      r.workflow_id === w.id &&
      r.plan_revision === w.plan_revision &&
      r.plan_hash === w.plan_hash &&
      r.context_hash === this.context(w) &&
      r.authority_hash === this.authorityHash(w)
    );
  }
  queue(w: Workflow, source: DeliveryRevision) {
    const plans = this.authorities(w);
    requireCondition(
      plans.some(
        (p) => p.revision === w.plan_revision && p.hash === w.plan_hash,
      ),
      "APPROVAL_STALE",
      "逐项复核必须绑定当前已批准的正式计划",
    );
    const request: PlanSelfCheckRequest = {
      id: id("plancheck"),
      workflow_id: w.id,
      plan_revision: w.plan_revision,
      plan_hash: w.plan_hash!,
      authority_hash: this.authorityHash(w),
      context_hash: this.context(w),
      source_delivery_revision_id: source.id,
      source_run_id: source.run_id!,
      status: "queued",
      created_at: now(),
      check_ids: plans.flatMap((p) => [
        `r${p.revision}:document`,
        ...p.plan.tasks.map((t) => `r${p.revision}:task:${t.id}`),
        ...p.plan.tests.map((t) => `r${p.revision}:test:${t.id}`),
        ...(p.plan.work_items ?? []).map(
          (t) => `r${p.revision}:work_item:${t.id}`,
        ),
        ...(p.plan.acceptance_items ?? []).map(
          (t) => `r${p.revision}:acceptance:${t.id}`,
        ),
      ]),
    };
    this.store.put("executor_plan_check", w.id, w.id, request);
    return request;
  }
  start(w: Workflow, run: Run) {
    const r = this.pending(w);
    requireCondition(
      r && r.source_run_id !== run.id,
      "PLAN_SELF_CHECK_STALE",
      "缺少当前交付对应的独立执行复核请求",
    );
    this.store.put("executor_plan_check", w.id, w.id, {
      ...r,
      run_id: run.id,
      status: "running",
    });
  }
  validateDelivery(w: Workflow, run: Run, manifest: DeliveryManifest) {
    const report = manifest.plan_self_check;
    if (run.stage !== PLAN_SELF_CHECK_STAGE) {
      requireCondition(
        !report,
        "PLAN_SELF_CHECK_WRONG_RUN",
        "普通开发轮次不能冒充程序发起的计划复核",
      );
      return;
    }
    const r = this.current(w.id);
    requireCondition(
      r &&
        this.matches(w, r) &&
        r.run_id === run.id &&
        r.source_run_id !== run.id,
      "PLAN_SELF_CHECK_STALE",
      "计划复核请求、上下文或轮次已变化",
    );
    const parsed = PlanSelfCheckReportSchema.safeParse(report);
    requireCondition(
      parsed.success,
      "PLAN_SELF_CHECK_REQUIRED",
      "请提交逐项复核报告 plan_self_check；不得用替代计划或完成自述代替",
    );
    const result = parsed.data;
    requireCondition(
      result.request_id === r.id &&
        result.source_delivery_revision_id === r.source_delivery_revision_id &&
        result.run_id === run.id &&
        result.plan_revision === r.plan_revision &&
        result.plan_hash === r.plan_hash &&
        result.authority_hash === r.authority_hash,
      "PLAN_SELF_CHECK_STALE",
      "复核报告与当前正式计划、源交付或执行轮次不匹配",
    );
    const ids = result.checks.map((c) => c.check_id);
    requireCondition(
      ids.length === r.check_ids.length &&
        new Set(ids).size === ids.length &&
        r.check_ids.every((check) => ids.includes(check)),
      "PLAN_SELF_CHECK_INCOMPLETE",
      "必须逐项覆盖原始计划和正式整改计划的正文、所有工作项及验收项，不能遗漏或重复",
    );
    requireCondition(
      result.verdict === "passed" &&
        result.checks.every((c) => c.status === "passed") &&
        result.findings.every((f) => f.status === "fixed"),
      "PLAN_SELF_CHECK_FINDINGS_OPEN",
      "复核仍有问题；请修复、重新测试并更新本轮交付后再提交",
    );
  }
  complete(
    w: Workflow,
    run: Run,
    revision: DeliveryRevision,
    manifest: DeliveryManifest,
  ) {
    this.validateDelivery(w, run, manifest);
    requireCondition(
      run.stage === PLAN_SELF_CHECK_STAGE &&
        run.status === "completed" &&
        (run.exit_code === undefined || run.exit_code === 0) &&
        !this.store.get("run_stop", run.id) &&
        revision.run_id === run.id &&
        revision.execution_finished &&
        !revision.invalidated,
      "PLAN_SELF_CHECK_NOT_FINISHED",
      "计划复核进程及其交付尚未成功完成",
    );
    const request = this.current(w.id)!;
    const passed: PlanSelfCheckRequest = {
      ...request,
      status: "passed",
      delivery_revision_id: revision.id,
      report_hash: objectHash(manifest.plan_self_check),
      completed_at: now(),
    };
    this.store.put("executor_plan_check", w.id, w.id, passed);
    return passed;
  }
  assertPassed(w: Workflow) {
    const r = this.current(w.id);
    requireCondition(
      r?.status === "passed" && this.matches(w, r),
      "PLAN_SELF_CHECK_REQUIRED",
      "执行模型尚未完成当前正式计划的逐项复核，不能进入规划模型审查",
    );
    const rev = this.store.get<DeliveryRevision>(
      "delivery_revision",
      r.delivery_revision_id!,
    );
    const run = this.store.get<Run>("run", r.run_id!);
    const delivery =
      rev && this.store.get<Delivery>("delivery", rev.delivery_id);
    requireCondition(
      rev &&
        run &&
        delivery &&
        !rev.invalidated &&
        rev.execution_finished &&
        rev.snapshot_id === w.snapshot_id &&
        rev.plan_hash === w.plan_hash &&
        run.status === "completed" &&
        (run.exit_code === undefined || run.exit_code === 0) &&
        !this.store.get("run_stop", run.id) &&
        objectHash(delivery.manifest.plan_self_check) === r.report_hash,
      "PLAN_SELF_CHECK_STALE",
      "执行复核通过记录与当前代码交付不匹配，必须重新复核",
    );
    this.validateDelivery(w, run, delivery.manifest);
    return r;
  }
}
