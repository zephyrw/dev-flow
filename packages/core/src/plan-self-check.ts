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
          if (doc?.content) markdown = doc.content;
        }
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
  validateDelivery(_w: Workflow, _run: Run, _manifest: DeliveryManifest) {
    return;
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
    return this.current(w.id);
  }
}
