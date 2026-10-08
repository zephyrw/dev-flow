import {
  normalizeExecutionIntent,
  normalizeReviewIntent,
} from "../../core/src/round-intent.js";

type RecordValue = Record<string, unknown>;
export type RoundOutputKind = "execution" | "review";
export type RoundOutputResult =
  | {
      kind: "resolved";
      value: RecordValue;
      source: string;
      candidate_count: number;
    }
  | {
      kind: "ambiguous" | "unrecognized";
      reason: string;
      rawText: string;
      candidate_count: number;
    };

export interface RoundOutputInput {
  kind: RoundOutputKind;
  structured?: unknown;
  outputText?: string;
  replyText?: string;
  workflow_id?: string;
  run_id?: string;
  plan_revision?: number;
  plan_hash?: string;
}

const MAX_TEXT = 16 * 1024 * 1024;
const MAX_CANDIDATES = 128;
const MAX_DEPTH = 128;
const record = (value: unknown): RecordValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const clean = (text: string) =>
  text
    .trim()
    .replace(/^\uFEFF/, "")
    .trim();
const field = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function parse(text: string): unknown {
  try {
    return JSON.parse(clean(text));
  } catch {
    return undefined;
  }
}

function canonical(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error("JSON 嵌套超过解析上限");
  if (Array.isArray(value))
    return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
  const rec = record(value);
  if (rec)
    return `{${Object.keys(rec)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(rec[key], depth + 1)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function envelope(
  value: unknown,
  input: RoundOutputInput,
): { value: RecordValue; intent: string; conflict?: string } | undefined {
  const rec = record(value);
  if (!rec || "test_id" in rec || "case_id" in rec) return undefined;
  const nested = record(
    input.kind === "execution" ? rec.delivery : rec.quality,
  );
  const fields =
    input.kind === "execution"
      ? [rec.status, rec.verdict, nested?.status, nested?.verdict]
      : [rec.verdict, rec.status, nested?.verdict];
  const provided = fields.map(field).filter((item): item is string => !!item);
  const normalize = (status: string) =>
    input.kind === "execution"
      ? normalizeExecutionIntent({ status }).intent
      : normalizeReviewIntent({ verdict: status }).intent;
  const intents = provided.map(normalize);
  if (!provided.length) return undefined;
  const conflict =
    new Set(intents).size > 1 ? "结果对象内的状态相互冲突" : undefined;
  for (const owner of [rec, nested]) {
    if (!owner) continue;
    for (const key of [
      "workflow_id",
      "run_id",
      "plan_revision",
      "plan_hash",
    ] as const) {
      if (
        owner[key] != null &&
        input[key] !== undefined &&
        owner[key] !== input[key]
      )
        return {
          value: rec,
          intent: "unclear",
          conflict: "结果不属于当前运行或批准计划",
        };
    }
  }
  return { value: rec, intent: intents[0]!, conflict };
}

type TextCandidates = { values: unknown[]; limited?: string };

/** Scan complete outer JSON values, never lift a test/child result out of a parent. */
function scanObjects(text: string, values: unknown[]): string | undefined {
  let start = -1,
    quoted = false,
    escaped = false;
  const stack: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (start < 0) {
      if (ch !== "{" && ch !== "[") continue;
      // A prose brace is not a JSON object opening. Arrays are consumed as a
      // whole so their children cannot masquerade as a round result.
      if (ch === "{" && !/^[\s]*(?:"|})/.test(text.slice(i + 1, i + 256)))
        continue;
      start = i;
      stack.push(ch);
      quoted = false;
      escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
      if (stack.length > MAX_DEPTH) return "JSON 嵌套超过解析上限";
    } else if (ch === "}" || ch === "]") {
      if (stack.pop() !== (ch === "}" ? "{" : "[")) {
        start = -1;
        stack.length = 0;
        continue;
      }
      if (!stack.length) {
        const value = parse(text.slice(start, i + 1));
        if (value !== undefined) values.push(value);
        if (values.length > MAX_CANDIDATES) return "JSON 候选超过解析上限";
        start = -1;
      }
    }
  }
  return start < 0 ? undefined : "存在未闭合的 JSON 候选";
}

function textCandidates(raw: string): TextCandidates {
  if (raw.length > MAX_TEXT)
    return { values: [], limited: "回复超过解析大小上限" };
  const text = clean(raw);
  const whole = parse(text);
  if (whole !== undefined) return { values: [whole] };
  const values: unknown[] = [];
  let outside = 0;
  // Only fence delimiter lines count; backticks inside JSON strings do not.
  const lines = [...text.matchAll(/^.*(?:\r?\n|$)/gm)].filter(
    (m) => m[0].length,
  );
  for (let i = 0; i < lines.length; i++) {
    const opening = /^[ \t]*(`{3,}|~{3,})([^\r\n]*)\r?\n?$/.exec(lines[i]![0]);
    if (!opening) continue;
    const begin = lines[i]!.index!;
    const limit = scanObjects(text.slice(outside, begin), values);
    if (limit) return { values, limited: limit };
    const bodyStart = begin + lines[i]![0].length;
    let end = i + 1;
    for (; end < lines.length; end++) {
      const closing = /^[ \t]*(`{3,}|~{3,})[ \t]*\r?\n?$/.exec(lines[end]![0]);
      if (
        closing &&
        closing[1]![0] === opening[1]![0] &&
        closing[1]!.length >= opening[1]!.length
      )
        break;
    }
    if (end === lines.length) return { values, limited: "存在未闭合的代码块" };
    if (["", "json"].includes(opening[2]!.trim().toLowerCase())) {
      const body = text.slice(bodyStart, lines[end]!.index!);
      const value = parse(body);
      if (value !== undefined) values.push(value);
      // A broken fenced document cannot lend authority to a valid child.
    }
    if (values.length > MAX_CANDIDATES)
      return { values, limited: "JSON 候选超过解析上限" };
    outside = lines[end]!.index! + lines[end]![0].length;
    i = end;
  }
  return { values, limited: scanObjects(text.slice(outside), values) };
}

function select(
  values: unknown[],
  source: string,
  input: RoundOutputInput,
  rawText: string,
): RoundOutputResult | undefined {
  const candidates = values
    .map((value) => envelope(value, input))
    .filter((item) => item !== undefined);
  if (!candidates.length) return undefined;
  const conflict = candidates.find((item) => item.conflict)?.conflict;
  if (conflict || new Set(candidates.map((item) => item.intent)).size > 1)
    return {
      kind: "ambiguous",
      reason: conflict ?? "回复包含互相冲突的结果",
      rawText,
      candidate_count: candidates.length,
    };
  // Deduplicate irrespective of object key ordering; pick one complete object.
  const unique = new Map<string, RecordValue>();
  try {
    for (const candidate of candidates) {
      const key = canonical(candidate.value);
      if (key.length > MAX_TEXT) throw new Error("结果超过解析大小上限");
      unique.set(key, candidate.value);
    }
  } catch (error) {
    return {
      kind: "ambiguous",
      reason: (error as Error).message,
      rawText,
      candidate_count: candidates.length,
    };
  }
  const selected = [...unique].reduce((a, b) =>
    a[0].length >= b[0].length ? a : b,
  );
  return {
    kind: "resolved",
    value: selected[1],
    source,
    candidate_count: unique.size,
  };
}

/** Sources are scoped by the caller to this invocation, not conversation history. */
export function extractRoundOutput(input: RoundOutputInput): RoundOutputResult {
  const rawText = input.replyText || input.outputText || "";
  let reason = "未提取到本轮结果对象";
  const structured = select([input.structured], "structured", input, rawText);
  if (structured) return structured;
  for (const [source, text] of [
    ["output_file", input.outputText],
    ["reply", input.replyText],
  ] as const) {
    if (!text) continue;
    const extracted = textCandidates(text);
    if (extracted.limited) reason = extracted.limited;
    const result = select(extracted.values, source, input, text);
    if (result && !extracted.limited) return result;
    if (result)
      return {
        kind: "ambiguous",
        reason: extracted.limited!,
        rawText: text,
        candidate_count: extracted.values.length,
      };
  }
  return { kind: "unrecognized", reason, rawText, candidate_count: 0 };
}
