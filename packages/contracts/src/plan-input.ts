import { z } from "zod";
import { RelativePath } from "./base.js";
import { FlowError } from "./index.js";

/** Canonicalize directory notation only; never repair unsafe paths or types. */
export function normalizePlanPaths(input: unknown): unknown {
  const directory = (value: unknown) => {
    if (typeof value !== "string" || !value.endsWith("/")) return value;
    const candidate = value.slice(0, -1);
    return RelativePath.safeParse(candidate).success ? candidate : value;
  };
  const visit = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return ["paths", "allowed_paths"].includes(key)
      ? value.map(directory) : value.map(item => visit(item));
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).map(([name, child]) => [name,
      key === "repository_paths" && Array.isArray(child) ? child.map(directory) : visit(child, name)]));
  };
  return visit(input);
}

export function parsePlanInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(normalizePlanPaths(input));
  if (parsed.success) return parsed.data;
  const fields = parsed.error.issues.map(issue => {
    let value: unknown = input;
    for (const key of issue.path) value = value && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[key] : undefined;
    return { path: issue.path.map(String).join("."), value, reason: issue.message };
  });
  throw new FlowError("PLAN_VALIDATION_FAILED", "规划格式需要修正：" + fields.map(field => `${field.path}：${field.reason}`).join("；"), 422, { fields });
}
