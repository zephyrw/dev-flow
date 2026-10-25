import { ExecutorRoundOutputSchema } from "../../contracts/src/index.js";

/** Only a complete, known DevFlow delivery contract is a protocol result. Ordinary JSON stays verbatim. */
export function displayResultEnvelope(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return text;
  try {
    const raw = JSON.parse(trimmed);
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
