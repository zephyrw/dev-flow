import { z } from "zod";
import { requireCondition } from "../../contracts/src/index.js";
export const BrowserActionSchema = z
  .object({
    tool: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
    capture: z
      .record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string())
      .default({}),
    assertions: z
      .array(
        z
          .object({
            pointer: z.string(),
            equals: z.unknown().optional(),
            contains: z.string().optional(),
            minimum: z.number().optional(),
            case_id: z.string().min(1).optional(),
          })
          .strict()
          .refine(
            (a) =>
              a.equals !== undefined ||
              a.contains !== undefined ||
              a.minimum !== undefined,
            "必须有实际断言",
          ),
      )
      .min(1),
  })
  .strict();
export const BrowserRecipeSchema = z
  .object({
    project_id: z.string(),
    scene_id: z.string(),
    origins: z.array(z.string()).min(1),
    actions: z.array(BrowserActionSchema).min(1),
  })
  .strict();
export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export function pointer(value: unknown, path: string): unknown {
  if (path === "") return value;
  requireCondition(
    path.startsWith("/"),
    "POINTER_INVALID",
    "断言路径必须使用 JSON Pointer",
  );
  return path
    .slice(1)
    .split("/")
    .reduce<unknown>(
      (obj, key) =>
        obj && typeof obj === "object"
          ? Object.hasOwn(obj, key.replace(/~1/g, "/").replace(/~0/g, "~"))
            ? (obj as Record<string, unknown>)[
                key.replace(/~1/g, "/").replace(/~0/g, "~")
              ]
            : undefined
          : undefined,
      value,
    );
}
export function template(value: unknown, vars: Record<string, unknown>): any {
  if (typeof value === "string") {
    const exact = /^\$\{([A-Z][A-Z0-9_]*)\}$/.exec(value);
    if (exact) {
      requireCondition(
        Object.hasOwn(vars, exact[1]!),
        "VARIABLE_MISSING",
        `缺少变量 ${exact[1]}`,
      );
      return vars[exact[1]!];
    }
    return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, name) => {
      requireCondition(
        Object.hasOwn(vars, name),
        "VARIABLE_MISSING",
        `缺少变量 ${name}`,
      );
      return String(vars[name]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => template(v, vars));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, template(v, vars)]),
    );
  return value;
}
export function toolData(result: any): any {
  if (result.structuredContent) return result.structuredContent;
  const text = result.content?.find((c: any) => c.type === "text")?.text;
  if (typeof text === "string") {
    try {
      return JSON.parse(text);
    } catch {
      return { text };
    }
  }
  return result;
}
export function assertResult(
  data: unknown,
  assertions: BrowserAction["assertions"],
  vars: Record<string, unknown>,
) {
  const cases = new Set<string>();
  for (const a of assertions) {
    const actual = pointer(data, a.pointer);
    if ("equals" in a)
      requireCondition(
        JSON.stringify(actual) === JSON.stringify(template(a.equals, vars)),
        "BROWSER_ASSERTION_FAILED",
        `结果不满足 ${a.pointer}`,
      );
    if (a.contains !== undefined)
      requireCondition(
        typeof actual === "string" &&
          actual.includes(template(a.contains, vars)),
        "BROWSER_ASSERTION_FAILED",
        `结果不满足 ${a.pointer}`,
      );
    if (a.minimum !== undefined)
      requireCondition(
        typeof actual === "number" &&
          Number.isFinite(actual) &&
          actual >= a.minimum,
        "BROWSER_ASSERTION_FAILED",
        `数值不满足 ${a.pointer}`,
      );
    if (a.case_id) cases.add(a.case_id);
  }
  return [...cases];
}
