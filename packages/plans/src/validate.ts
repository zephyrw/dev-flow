import {
  PlanSchema,
  FlowError,
  requireCondition,
  type Plan,
} from "../../contracts/src/index.js";
import { objectHash } from "../../core/src/util.js";
export function validatePlan(input: unknown): {
  plan: Plan;
  hash: string;
  diagrams: string[];
} {
  const plan = PlanSchema.parse(input);
  const taskIds = new Set(plan.tasks.map((t) => t.id)),
    testIds = new Set(plan.tests.map((t) => t.id));
  requireCondition(
    taskIds.size === plan.tasks.length && testIds.size === plan.tests.length,
    "DUPLICATE_ID",
    "任务或测试编号重复",
    422,
  );
  const active = new Set<string>(),
    done = new Set<string>();
  function visit(key: string) {
    if (active.has(key)) throw new FlowError("TASK_CYCLE", "任务依赖存在环");
    if (done.has(key)) return;
    active.add(key);
    const task = plan.tasks.find((t) => t.id === key);
    requireCondition(task, "TASK_MISSING", `缺失任务 ${key}`, 422);
    for (const dep of task.depends_on) visit(dep);
    for (const test of task.test_ids)
      requireCondition(
        testIds.has(test),
        "TEST_MISSING",
        `缺失测试 ${test}`,
        422,
      );
    for (const p of task.paths)
      requireCondition(
        plan.scope.allowed_paths.includes(p),
        "SCOPE_MISMATCH",
        `任务路径未批准 ${p}`,
        422,
      );
    active.delete(key);
    done.add(key);
  }
  taskIds.forEach(visit);
  for (const t of plan.tests)
    for (const key of t.task_ids)
      requireCondition(
        taskIds.has(key),
        "TASK_MISSING",
        `缺失任务 ${key}`,
        422,
      );
  for (const layer of ["unit", "integration", "e2e", "opentabs"])
    requireCondition(
      plan.tests.some((t) => t.layer === layer) ||
        plan.exemptions.some((e) => e.layer === layer),
      "MISSING_LAYER",
      `缺少 ${layer} 测试`,
      422,
    );
  requireCondition(
    !plan.exemptions.some((e) => plan.tests.some((t) => t.layer === e.layer)),
    "LAYER_CONFLICT",
    "同层不能同时必需和豁免",
    422,
  );
  const diagrams = [
    ...plan.markdown.matchAll(/^```mermaid\r?\n([\s\S]*?)^```\s*$/gm),
  ].map((m) => m[1]!);
  requireCondition(
    diagrams.length >= (plan.complexity === "complex" ? 4 : 1),
    "DIAGRAM_MISSING",
    "缺少必需图解",
    422,
  );
  if (plan.complexity === "complex")
    requireCondition(
      diagrams.some((d) => d.includes("sequenceDiagram")) &&
        diagrams.some((d) => /flowchart|graph /.test(d)),
      "DIAGRAM_TYPE",
      "复杂计划需要流程图和时序图",
      422,
    );
  requireCondition(
    !/(?:TODO|TBD|待定|待确认)\s*[:：]/i.test(plan.markdown),
    "UNRESOLVED_DECISION",
    "正式计划存在未解决决策",
    422,
  );
  plan.markdown = plan.markdown.replace(/\r\n/g, "\n");
  return { plan, hash: objectHash(plan), diagrams };
}
