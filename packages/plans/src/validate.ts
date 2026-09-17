import {
  PlanSchema,
  FlowError,
  requireCondition,
  type Plan,
} from "../../contracts/src/index.js";
import { objectHash } from "../../core/src/util.js";
import { NativePlanSchema } from "../../contracts/src/native-plan.js";
export function validatePlan(input: unknown): {
  plan: Plan;
  hash: string;
  diagrams: string[];
} {
  const plan = PlanSchema.parse(input);
  if (plan.task_model === "native-v2" && "work_items" in plan) {
    const native = NativePlanSchema.parse(
      Object.fromEntries(
        Object.keys(NativePlanSchema.shape).map((key) => [
          key,
          (plan as any)[key],
        ]),
      ),
    );
    const modules = new Set(native.modules.map((m) => m.id));
    requireCondition(
      modules.size > 0 && modules.size === (plan.modules || []).length,
      "MODULES_REQUIRED",
      "模块清单编号不能重复且不能为空",
      422,
    );
    const workItems = plan.work_items || [];
    const acceptanceItems = plan.acceptance_items || [];
    const workItemIds = new Set(workItems.map((w) => w.id));
    requireCondition(
      workItemIds.size === workItems.length,
      "DUPLICATE_ID",
      "工作项编号不能重复",
      422,
    );
    const acceptanceIds = new Set(acceptanceItems.map((a) => a.id));
    requireCondition(
      acceptanceIds.size === acceptanceItems.length,
      "DUPLICATE_ID",
      "验收项编号不能重复",
      422,
    );

    const active = new Set<string>();
    const done = new Set<string>();
    function visitNative(key: string) {
      if (active.has(key))
        throw new FlowError("TASK_CYCLE", "工作项依赖存在环");
      if (done.has(key)) return;
      active.add(key);
      const item = workItems.find((w: any) => w.id === key);
      requireCondition(item, "TASK_MISSING", `缺失工作项 ${key}`, 422);
      for (const dep of item!.depends_on) visitNative(dep);
      for (const p of item!.paths) {
        requireCondition(
          plan.scope.allowed_paths.includes(p),
          "SCOPE_MISMATCH",
          `工作项路径未批准 ${p}`,
          422,
        );
      }
      active.delete(key);
      done.add(key);
    }
    workItemIds.forEach(visitNative);

    for (const a of acceptanceItems) {
      requireCondition(
        (a.layer as string) !== "opentabs",
        "BROWSER_LAYER_RETIRED",
        "原生计划请将浏览器场景纳入 E2E，不再单列 OpenTabs 验收层",
        422,
      );
      for (const wid of a.work_item_ids) {
        requireCondition(
          workItemIds.has(wid),
          "TASK_MISSING",
          `验收项 ${a.id} 引用的工作项不存在 ${wid}`,
          422,
        );
      }
    }

    for (const item of native.work_items) {
      requireCondition(
        !item.module_id || modules.has(item.module_id),
        "MODULE_MISSING",
        "工作项模块不存在",
        422,
      );
      requireCondition(
        item.acceptance_ids.length > 0 &&
          item.acceptance_ids.every((id) =>
            native.acceptance_items.some(
              (a) => a.id === id && a.work_item_ids.includes(item.id),
            ),
          ),
        "ACCEPTANCE_LINK_MISSING",
        "工作项必须关联真实验收项",
        422,
      );
    }
    // Derived views feed the existing validator/UI; the formal native contract stays authoritative.
    const normalized: Plan = {
      ...plan,
      ...native,
      tasks: native.work_items.map((item) => ({
        id: item.id,
        module_id: item.module_id,
        repo_id: item.repo_id ?? Object.keys(native.baselines)[0],
        title: item.title,
        paths: item.paths,
        depends_on: item.depends_on,
        requirements: item.acceptance_ids,
        test_ids: item.acceptance_ids,
        inputs: "正式计划正文",
        implementation:
          "按照正式计划正文实施：" + (item.description ?? item.title),
        preserve: "保持批准范围外现有行为",
        completion: "全部关联验收项通过",
        stop_conditions: "与原始计划冲突时停止",
      })),
      tests: native.acceptance_items.map((a) => ({
        id: a.id,
        task_ids: a.work_item_ids,
        layer: a.layer,
        steps: [a.scenario],
        assertions: [a.expected_outcome],
        expected_case_ids: [a.id],
        timeout_seconds: a.timeout_seconds,
      })),
    };
    return { plan: normalized, hash: objectHash(normalized), diagrams: [] };
  }
  if (plan.task_model === "leaf-v1") {
    const modules = new Set(plan.modules?.map((m) => m.id));
    requireCondition(
      modules.size > 0 && modules.size === plan.modules?.length,
      "MODULES_REQUIRED",
      "细项计划需要唯一的模块分组",
      422,
    );
    for (const task of plan.tasks) {
      requireCondition(
        task.module_id &&
          modules.has(task.module_id) &&
          task.completion_checks?.length,
        "LEAF_CONTRACT_REQUIRED",
        `细项 ${task.id} 缺少模块或可检查的完成条件`,
        422,
      );
      for (const check of task.completion_checks!)
        requireCondition(
          task.paths.includes(check.path),
          "COMPLETION_SCOPE",
          "完成检查必须属于该细项的修改范围",
          422,
        );
    }
    requireCondition(
      plan.modules!.every((m) => plan.tasks.some((t) => t.module_id === m.id)),
      "EMPTY_MODULE",
      "模块不能没有细项",
      422,
    );
  }
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
  for (const test of plan.tests)
    requireCondition(
      new Set(test.expected_case_ids).size === test.expected_case_ids.length,
      "DUPLICATE_CASE",
      `测试 ${test.id} 的用例清单不能重复`,
      422,
    );
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
  // Historical plans can still carry OpenTabs evidence; it is not a fourth
  // required layer. New native plans run browser scenarios as E2E.
  requireCondition(
    plan.task_model !== "native-v2" ||
      !plan.tests.some((test) => test.layer === "opentabs"),
    "BROWSER_LAYER_RETIRED",
    "原生计划请将浏览器场景纳入 E2E，不再单列 OpenTabs 验收层",
    422,
  );
  for (const layer of ["unit", "integration", "e2e"])
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
  const markdown = plan.markdown || "";
  const diagrams = [
    ...markdown.matchAll(/^```mermaid\r?\n([\s\S]*?)^```\s*$/gm),
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
    (plan.unresolved_decisions?.length ?? 0) === 0,
    "UNRESOLVED_DECISION",
    "正式计划存在未解决决策",
    422,
  );
  requireCondition(
    !/(?:TODO|TBD|待定|待确认)\s*[:：]/i.test(markdown),
    "UNRESOLVED_DECISION",
    "正式计划存在未解决决策",
    422,
  );
  if (plan.markdown) {
    plan.markdown = plan.markdown.replace(/\r\n/g, "\n");
  }
  return { plan, hash: objectHash(plan), diagrams };
}
