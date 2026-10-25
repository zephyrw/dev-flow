import { ExecutorRoundOutputSchema, ReviewSchema } from "../../contracts/src/index.js";

function displayReview(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return;
  const value = raw as Record<string, unknown>;
  // Require the full review envelope, not a business object with a summary or verdict.
  if (typeof value.summary !== "string" || !value.summary.trim() || typeof value.verdict !== "string" ||
      !Array.isArray(value.findings) || !Array.isArray(value.unresolved_questions) ||
      !Object.hasOwn(value, "repair_document") || !Object.hasOwn(value, "quality")) return;
  const parsed = ReviewSchema.strict().safeParse(raw);
  if (!parsed.success) return;
  const labels: Record<string, string> = {
    summary: "摘要", notes: "说明", verdict: "结论", status: "状态", findings: "发现的问题",
    unresolved_questions: "待确认问题", repair_document: "整改方案", repair_plan: "整改计划", quality: "质量复核",
    function_impact: "功能影响", finding_id: "问题", severity: "严重程度", repo_id: "仓库", file_path: "文件",
    symbol: "位置", line_number: "行号", evidence_locations: "证据位置", evidence: "证据", trigger_condition: "触发条件",
    reproduction: "复现方法", expected_actual: "预期与实际", impact: "影响", cause: "原因", verification_type: "核实方式",
    title: "问题", message: "说明", description: "说明", path: "路径", line: "行号", commit_message: "提交说明",
    coverage: "审查范围", files: "文件", all_changed_files_reviewed: "已审查所有变更文件",
    all_requirements_checked: "已检查需求", upstream_downstream_checked: "已检查上下游", security_checked: "已检查安全",
    tests_validity_checked: "已检查测试", user_interaction: "需要协助",
  };
  const identity = new Set(["schema_version", "review_request_id", "workflow_id", "run_id", "plan_revision", "snapshot_id", "phase", "cycle", "feedback_cursor", "reviewed_at"]);
  const states: Record<string, string> = { pass: "通过", passed: "通过", quality_pass: "通过", findings: "需要整改",
    changes_required: "需要整改", incomplete: "未完成", need_user: "需要协助", completed: "已完成",
    none: "无功能变化", changed: "功能有变化", uncertain: "尚不确定" };
  let unknown = false;
  const render = (item: unknown, key = ""): string => {
    if (item === null || item === undefined || item === "") return "";
    if (Array.isArray(item)) return item.map(part => render(part)).filter(Boolean).join("\n\n");
    if (typeof item === "object") return Object.entries(item).map(([field, part]) => {
      if (identity.has(field)) return "";
      if (!labels[field]) { unknown = true; return ""; }
      const body = render(part, field);
      return body ? `${labels[field]}：${body}` : "";
    }).filter(Boolean).join("\n\n");
    if (typeof item === "boolean") return item ? "是" : "否";
    return ["verdict", "status", "function_impact"].includes(key) ? states[String(item)] ?? String(item) : String(item);
  };
  const output = render(value);
  return unknown ? undefined : output;
}

/** Only a complete, known DevFlow delivery contract is a protocol result. Ordinary JSON stays verbatim. */
export function displayResultEnvelope(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return text;
  try {
    const raw = JSON.parse(trimmed);
    const review = displayReview(raw);
    if (review) return review;
    if (!raw || typeof raw.summary !== "string" || !raw.summary.trim() || !raw.delivery ||
        !Array.isArray(raw.delivery.implementations) || !Array.isArray(raw.delivery.test_executions) ||
        !Array.isArray(raw.delivery.acceptance_mappings) ||
        Object.keys(raw).some(key => !["status", "summary", "notes", "artifacts", "repositories", "test_results", "delivery"].includes(key))) return text;
    const result = ExecutorRoundOutputSchema.strict().safeParse(raw);
    if (!result.success) return text;
    const value = result.data;
    const parts = [value.summary, value.notes, value.delivery?.summary, value.delivery?.notes].filter((part): part is string => typeof part === "string" && !!part.trim());
    for (const implementation of value.delivery?.implementations ?? [])
      parts.push([implementation.path, implementation.description].filter(Boolean).join("："));
    for (const test of value.delivery?.test_executions ?? [])
      parts.push(`${test.command}：${test.exit_code === 0 ? "通过" : typeof test.exit_code === "number" ? `未通过（退出码 ${test.exit_code}）` : "未记录结果"}`);
    for (const artifact of [...(value.artifacts ?? []), ...(value.delivery?.artifacts ?? [])])
      parts.push(typeof artifact === "string" ? artifact : [artifact.path, artifact.description].filter(Boolean).join("："));
    for (const repository of value.repositories ?? []) parts.push(`${repository.repo_id}：${repository.commit}`);
    for (const test of [...(value.test_results ?? []), ...(value.delivery?.test_results ?? [])]) {
      const state = { passed: "通过", failed: "失败", skipped: "跳过", not_run: "未执行" }[test.status];
      parts.push(`${test.test_id}${test.case_id ? ` / ${test.case_id}` : ""}：${state}${test.summary ? `，${test.summary}` : ""}`);
    }
    for (const item of value.delivery?.unfinished_items ?? []) parts.push(`未完成：${item.id} — ${item.reason}`);
    for (const item of value.delivery?.plan_conflicts ?? []) parts.push(`计划问题：${item.description}`);
    // Preserve optional or unfamiliar report fields until a faithful projection exists.
    if (Object.keys(raw.delivery).some(key => !["implementations", "test_executions", "test_results", "acceptance_mappings", "unfinished_items", "plan_conflicts", "status", "summary", "notes", "artifacts"].includes(key))) return text;
    return [...new Set(parts)].join("\n\n");
  } catch { return text; }
}
