import type { ProbeTerminal } from "../../../contracts/src/model-access.js";
import type { ProbeTerminalInput } from "./interface.js";
import { stripAnsi } from "./catalog-parse.js";

type JsonRecord = Record<string, unknown>;
const METADATA_KEYS = ["init", "item", "message", "result", "data", "payload", "response", "part", "state", "properties", "info"];

function asRecord(value: unknown): JsonRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as JsonRecord;
}

function parseJsonValue(text: string): unknown | undefined {
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

export function collectProbeJsonRecords(text: string): JsonRecord[] {
  const records: JsonRecord[] = [];
  const whole = parseJsonValue(text.trim());
  if (whole !== undefined) {
    pushJsonValue(records, whole);
    if (records.length > 0) return records;
  }
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseJsonValue(line.trim());
    if (parsed !== undefined) pushJsonValue(records, parsed);
  }
  return records;
}

function pushJsonValue(target: JsonRecord[], value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) pushJsonValue(target, item);
  } else {
    const record = asRecord(value);
    if (record) target.push(record);
  }
}

function readString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function metadataRecords(record: JsonRecord, depth = 0): JsonRecord[] {
  if (depth >= 6) return [record];
  const records = [record];
  for (const key of METADATA_KEYS) {
    const nested = asRecord(record[key]);
    if (nested) records.push(...metadataRecords(nested, depth + 1));
  }
  return records;
}

function observedModels(record: JsonRecord): string[] {
  const models: string[] = [];
  for (const metadata of metadataRecords(record)) {
    const objectModel = asRecord(metadata.model);
    const model = readString(metadata, ["model", "model_id", "modelId", "modelID", "nativeId"])
      ?? (objectModel ? readString(objectModel, ["id", "modelID", "modelId"]) : undefined);
    if (!model) continue;
    const provider = readString(metadata, ["providerID"])
      ?? (objectModel ? readString(objectModel, ["providerID", "providerId"]) : undefined);
    models.push(provider && !model.includes("/") ? `${provider}/${model}` : model);
  }
  return models;
}

export function readObservedModel(record: JsonRecord): string | undefined {
  return observedModels(record)[0];
}

function eventType(record: JsonRecord): string {
  return readString(record, ["type", "event", "kind"])?.toLowerCase() ?? "";
}

function nonemptyError(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

export function recordIsTerminalError(record: JsonRecord): boolean {
  return metadataRecords(record).some((metadata) => {
    const type = eventType(metadata);
    const subtype = readString(metadata, ["subtype"])?.toLowerCase() ?? "";
    const status = readString(metadata, ["status"])?.toLowerCase() ?? "";
    return metadata.is_error === true || metadata.isError === true || metadata.success === false ||
      nonemptyError(metadata.error) || nonemptyError(metadata.errors) ||
      /(^|[._-])(error|failed|failure|cancelled|canceled)($|[._-])/.test(type) ||
      /^error(?:$|[._-])/.test(subtype) ||
      ["error", "failed", "failure", "cancelled", "canceled", "incomplete"].includes(status) ||
      metadata.result === "error";
  });
}

export function recordIsTerminalSuccess(record: JsonRecord): boolean {
  if (recordIsTerminalError(record)) return false;
  const type = eventType(record);
  if (["result", "turn.completed", "response.completed", "agent_end"].includes(type)) return true;
  // OpenCode emits step_finish on every step; only stop is a completed response.
  // tool-calls and length must never certify the probe.
  return type === "step_finish" && asRecord(record.part)?.reason === "stop";
}

function normalizedModel(model: string, adapterId?: string): string {
  return adapterId === "opencode" ? model.split("#")[0]! : model;
}

function plainObservedModels(text: string): string[] {
  const models: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:using model|model)\s*[:=]?\s+["']?([A-Za-z0-9._:+/#-]+)/i);
    if (match?.[1]) models.push(match[1]);
  }
  return models;
}

function lastNonEmptyLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

export function parseStructuredProbeTerminal(input: ProbeTerminalInput): ProbeTerminal {
  if (input.timedOut) {
    return { success: false, observedModelStatus: "unknown", errorCode: "MODEL_PROBE_TIMEOUT", message: "模型访问探测超时" };
  }
  const stdout = stripAnsi(input.stdout);
  const stderr = stripAnsi(input.stderr);
  const combined = `${stdout}\n${stderr}`;
  const stdoutRecords = collectProbeJsonRecords(stdout);
  const records = [...stdoutRecords, ...collectProbeJsonRecords(stderr)];
  const models = [...records.flatMap(observedModels), ...plainObservedModels(combined)];
  const selected = input.selectedModel?.trim();
  const nativeRouter = input.selectionKind === "native-router";
  const mismatch = selected && !nativeRouter ? models.find((model) =>
    normalizedModel(model, input.adapterId) !== normalizedModel(selected, input.adapterId)) : undefined;
  const fallback = !nativeRouter && /\b(?:falling back|fallback to|switched to model)\b/i.test(combined);
  const observedModel = mismatch ?? models.at(-1);
  const observedModelStatus: ProbeTerminal["observedModelStatus"] = mismatch || fallback
    ? "mismatch" : observedModel && selected && !nativeRouter ? "matched" : "unknown";
  const failed = (message: string): ProbeTerminal => ({
    success: false, observedModel, observedModelStatus, errorCode: "MODEL_UNAVAILABLE", message,
  });
  if (mismatch || fallback) return failed("原生回退到其他模型，实际模型与选择不一致");
  const plainError = /(?:^|\n)\s*(?:error\b|fatal\b|401\b|403\b|unauthorized\b|not logged in\b|authentication required\b)/i.test(combined);
  if (records.some(recordIsTerminalError) || plainError) return failed("原生调用包含错误，探测未通过");
  if (input.exitCode !== 0 || input.cancelled || input.truncated || input.launchFailed) {
    return failed("原生调用未完整成功结束");
  }
  const structuredSuccess = stdoutRecords.some(recordIsTerminalSuccess);
  const hasStructuredOutput = records.length > 0 || /(?:^|\n)\s*[\[{]/.test(stdout);
  const plainSuccess = !hasStructuredOutput && lastNonEmptyLine(stdout) === "OK";
  if (!structuredSuccess && !plainSuccess) return failed("未解析到原生整轮成功终态");
  return { success: true, observedModel, observedModelStatus };
}

export function parseProbeTerminal(input: ProbeTerminalInput): ProbeTerminal {
  return parseStructuredProbeTerminal(input);
}
