import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Store } from "../../store/src/store.js";
import {
  CATALOG_FRESH_MS,
  CATALOG_OUTPUT_LIMIT,
  CATALOG_QUERY_CONCURRENCY,
  CATALOG_READ_TIMEOUT_MS,
  ModelCatalogSchema,
  PARSER_REVISION,
  TOOL_DISPLAY_ORDER,
  TOOL_SCAN_CONCURRENCY,
  VERSION_HELP_TIMEOUT_MS,
  ModelEntrySchema,
  type ModelCatalog,
  type ModelDiscoveryStatus,
  type ModelEntry,
  type ModelSource,
  type ModelInvocationCapability,
  type ToolDiscoveryStatus,
  type ToolSummary,
} from "../../contracts/src/model-catalog.js";
import {
  FlowError,
  SupportedAdapters,
  type SupportedAdapterId,
} from "../../contracts/src/index.js";
import { nativeLaunch } from "../../adapters/sdk/src/launch.js";
import { resolveAdapterExecutable } from "../../adapters/sdk/src/registry.js";
import {
  failedModelCatalog,
  freshModelCatalog,
  inferDiscoveryStatus,
  isDiscoveryEnvironmentError,
  makeEntryId,
} from "../../adapters/sdk/src/catalog-parse.js";
import { parseCodexModelCatalog } from "../../adapters/codex/src/model-configuration.js";
import { parseAgyModelCatalog } from "../../adapters/agy/src/model-configuration.js";
import { parseCursorModelCatalog } from "../../adapters/cursor/src/model-configuration.js";
import {
  claudeCatalogStdout,
  parseClaudeModelCatalog,
} from "../../adapters/claude/src/model-configuration.js";
import { parseGrokModelCatalog } from "../../adapters/grok/src/model-configuration.js";
import { parseKimiModelCatalog } from "../../adapters/kimi/src/model-configuration.js";
import { parseQoderModelCatalog } from "../../adapters/qoder/src/model-configuration.js";
import { parseOpenCodeModelCatalog, detectOpenCodeVariantEncoding } from "../../adapters/opencode/src/model-configuration.js";
import {
  parseMimoModelCatalog,
  detectMimoVariantEncoding,
} from "../../adapters/mimo/src/model-configuration.js";
import { now, objectHash } from "./util.js";
import { resolveModelIdentity } from "./model-identity.js";

const OPERATION_KIND = "model_config_operation";
const CATALOG_KIND = "model_catalog";
const POINTER_KIND = "model_catalog_pointer";
const TOOL_KIND = "model_tool_detection";
const FINGERPRINTS: Record<SupportedAdapterId, string> = {
  codex: "codex",
  agy: "agy|antigravity",
  "grok-build": "grok",
  "claude-code": "claude",
  "kimi-code": "kimi",
  qoder: "qoder",
  opencode: "opencode",
  "cursor-agent": "cursor|agent",
  "mimo-code": "mimo",
};

export type CatalogOperationStatus =
  | "prepared"
  | "ready"
  | "processing"
  | "committed"
  | "failed"
  | "retryable"
  | "rejected";

export type CatalogOperation = {
  id: string;
  operation_type: "discover" | "refresh";
  entity_id: string;
  request_id: string;
  status: CatalogOperationStatus;
  created_at: string;
  updated_at: string;
  completed_at?: string;
  adapter_ids?: SupportedAdapterId[];
  scope_id?: string;
  error_code?: string;
  error_message?: string;
};

export type CatalogScopeInput = {
  adapterId: SupportedAdapterId;
  executablePath: string;
  nativeConfigScope?: string;
  nativeConfigProfile?: string;
  accountFingerprint?: string;
  providerFingerprint?: string;
};

export type LimitedCliRequest = {
  adapterId: SupportedAdapterId;
  executable: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutMs: number;
  outputLimit: number;
};

export type LimitedCliResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
  pid?: number;
  spawnError?: NodeJS.ErrnoException;
};

export type LimitedCliHandle = {
  pid?: number;
  result: Promise<LimitedCliResult>;
  cancel: () => Promise<void>;
};

export type ModelCatalogServiceOptions = {
  extraEnv?: Record<string, string>;
  versionHelpTimeoutMs?: number;
  catalogTimeoutMs?: number;
  workingDirectory?: string;
  resolveExecutable?: (adapterId: SupportedAdapterId) => string | undefined;
};

type CatalogPointer = {
  catalogId: string;
  cliVersion?: string;
  updated_at: string;
};

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

export function collectSafeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue;
    if (/^(DEVFLOW_|MCP_)/i.test(key) || /WORKFLOW_TOKEN/i.test(key)) {
      continue;
    }
    env[key] = value;
  }
  return env;
}

export async function killProcessTree(pid: number): Promise<void> {
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5000,
      });
      return;
    }
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
}

export function startLimitedCli(req: LimitedCliRequest): LimitedCliHandle {
  try {
    const launch = nativeLaunch(req.executable, req.adapterId);
    const child = spawn(launch.executable, [...launch.prefix, ...req.args], {
      cwd: req.cwd,
      env: { ...collectSafeEnv(), ...(req.env ?? {}) },
      windowsHide: true,
      shell: false,
      stdio: "pipe",
    });
    return attachLimitedCli(child, req);
  } catch (error) {
    return failedLaunchHandle(error);
  }
}

function failedLaunchHandle(error: unknown): LimitedCliHandle {
  const message =
    error instanceof Error ? error.message : "无法启动本机 CLI";
  const code =
    error instanceof FlowError && error.code === "UNSUPPORTED_SHIM"
      ? "ENOENT"
      : error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "ENOENT";
  const spawnError = Object.assign(new Error(message), {
    code,
  }) as NodeJS.ErrnoException;
  return {
    result: Promise.resolve({
      stdout: "",
      stderr: message,
      exitCode: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
      spawnError,
    }),
    cancel: async () => undefined,
  };
}

export async function runLimitedCli(
  req: LimitedCliRequest,
): Promise<LimitedCliResult> {
  return startLimitedCli(req).result;
}

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: unknown;
};

function asJsonRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function writeJsonRpc(child: ChildProcess, message: object) {
  child.stdin?.write(JSON.stringify(message) + "\n");
}

function readJsonRpcLines(buffer: string): { rest: string; messages: JsonRpcMessage[] } {
  const lines = buffer.split(/\r?\n/);
  const rest = lines.pop() ?? "";
  const messages: JsonRpcMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      messages.push(JSON.parse(trimmed) as JsonRpcMessage);
    } catch {
      continue;
    }
  }
  return { rest, messages };
}

function nextCursorOf(result: unknown): string | undefined {
  const record = asJsonRecord(result);
  const cursor = record?.nextCursor;
  return typeof cursor === "string" && cursor.trim() ? cursor : undefined;
}

async function queryCodexAppServer(
  req: LimitedCliRequest,
): Promise<LimitedCliResult> {
  const launch = nativeLaunch(req.executable, req.adapterId);
  const child = spawn(launch.executable, [...launch.prefix, ...req.args], {
    cwd: req.cwd,
    env: { ...collectSafeEnv(), ...(req.env ?? {}) },
    windowsHide: true,
    shell: false,
    stdio: "pipe",
  });
  const chunks = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let timedOut = false;
  let truncated = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  let lineBuffer = "";
  let listId = 2;
  let initializeDone = false;
  let listDone = false;
  const append = (stream: "stdout" | "stderr", data: Buffer) => {
    const next = Buffer.concat([chunks[stream], data]);
    if (next.byteLength <= req.outputLimit) {
      chunks[stream] = next;
      return;
    }
    truncated = true;
    chunks[stream] = next.subarray(0, req.outputLimit);
  };
  const sendInitialize = () => {
    writeJsonRpc(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: {
          name: "devflow-model-catalog",
          title: "DevFlow model catalog",
          version: "0.2.0",
        },
      },
    });
  };
  const sendList = (cursor?: string) => {
    writeJsonRpc(child, {
      jsonrpc: "2.0",
      id: listId,
      method: "model/list",
      params: {
        includeHidden: false,
        limit: 20,
        ...(cursor ? { cursor } : {}),
      },
    });
  };
  const finishList = () => {
    if (listDone) return;
    listDone = true;
    child.stdin?.end();
  };
  child.stdout?.on("data", (data: Buffer) => {
    append("stdout", data);
    const parsed = readJsonRpcLines(lineBuffer + data.toString("utf8"));
    lineBuffer = parsed.rest;
    for (const message of parsed.messages) {
      if (message.id === 1 && !initializeDone) {
        initializeDone = true;
        writeJsonRpc(child, {
          jsonrpc: "2.0",
          method: "initialized",
        });
        sendList();
        continue;
      }
      if (message.id !== listId || message.result === undefined) continue;
      const cursor = nextCursorOf(message.result);
      if (!cursor) {
        finishList();
        continue;
      }
      listId += 1;
      sendList(cursor);
    }
  });
  child.stderr?.on("data", (data: Buffer) => append("stderr", data));
  child.once("spawn", sendInitialize);
  child.once("error", (error: NodeJS.ErrnoException) => {
    spawnError = error;
  });
  return new Promise<LimitedCliResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout: chunks.stdout.toString("utf8"),
        stderr: chunks.stderr.toString("utf8"),
        exitCode,
        timedOut,
        cancelled: false,
        truncated,
        pid: child.pid,
        spawnError,
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void cancelChild(child).finally(() => finish(null));
    }, req.timeoutMs);
    child.once("close", (code) => finish(code));
  });
}

function feedChildStdin(child: ChildProcess, stdin?: string) {
  let sent = false;
  const send = () => {
    if (sent || !child.stdin) return;
    sent = true;
    if (stdin) child.stdin.end(stdin);
    else child.stdin.end();
  };
  child.once("spawn", send);
  if (child.pid) send();
}

function attachLimitedCli(
  child: ChildProcess,
  req: LimitedCliRequest,
): LimitedCliHandle {
  const chunks = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let timedOut = false;
  let cancelled = false;
  let truncated = false;
  let settled = false;
  let spawnError: NodeJS.ErrnoException | undefined;
  let timer: NodeJS.Timeout | undefined;
  const handle: LimitedCliHandle = {
    pid: child.pid,
    result: Promise.resolve({
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      cancelled: false,
      truncated: false,
    }),
    cancel: async () => undefined,
  };
  const append = (stream: "stdout" | "stderr", data: Buffer) => {
    const next = Buffer.concat([chunks[stream], data]);
    if (next.byteLength <= req.outputLimit) {
      chunks[stream] = next;
      return;
    }
    truncated = true;
    chunks[stream] = next.subarray(0, req.outputLimit);
  };
  child.stdout?.on("data", (data: Buffer) => append("stdout", data));
  child.stderr?.on("data", (data: Buffer) => append("stderr", data));
  feedChildStdin(child, req.stdin);
  handle.result = new Promise<LimitedCliResult>((resolve) => {
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        stdout: chunks.stdout.toString("utf8"),
        stderr: chunks.stderr.toString("utf8"),
        exitCode,
        timedOut,
        cancelled,
        truncated,
        pid: child.pid,
        spawnError,
      });
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      spawnError = error;
      finish(null);
    });
    child.once("close", (code) => finish(code));
    child.once("spawn", () => {
      handle.pid = child.pid;
    });
    timer = setTimeout(() => {
      timedOut = true;
      void cancelChild(child).finally(() => finish(null));
    }, req.timeoutMs);
  });
  handle.cancel = async () => {
    cancelled = true;
    await cancelChild(child);
    await handle.result;
  };
  return handle;
}

async function cancelChild(child: ChildProcess): Promise<void> {
  if (child.pid) await killProcessTree(child.pid);
  else child.kill();
}

function asAdapter(value: string): SupportedAdapterId {
  const matched = SupportedAdapters.find((item) => item === value);
  if (!matched) {
    throw new FlowError("TOOL_NOT_FOUND", "未知工具：" + value, 422);
  }
  return matched;
}

function operationId(type: string, requestId: string, entity: string): string {
  return ("op-" + objectHash({ type, requestId, entity })).slice(0, 80);
}

function pointerId(scope: CatalogScopeInput): string {
  return "ptr-" + objectHash({
    adapterId: scope.adapterId,
    executablePath: scope.executablePath,
    nativeConfigScope: scope.nativeConfigScope ?? "default",
    accountFingerprint: scope.accountFingerprint ?? "none",
    providerFingerprint: scope.providerFingerprint ?? "none",
  });
}

function catalogEntityId(scope: CatalogScopeInput, cliVersion: string): string {
  return "catalog:" + objectHash({
    adapterId: scope.adapterId,
    executablePath: scope.executablePath,
    cliVersion,
    nativeConfigScope: scope.nativeConfigScope ?? "default",
    accountFingerprint: scope.accountFingerprint ?? "none",
    providerFingerprint: scope.providerFingerprint ?? "none",
  });
}

function parseAdapterCatalog(
  adapterId: SupportedAdapterId,
  stdout: string,
  stderr: string,
  truncated: boolean,
  scopeHash: string,
  cliPath: string,
  cliVersion: string,
  nativeConfigScope: string,
  source?: ModelSource,
): ModelCatalog {
  const input = {
    stdout,
    stderr,
    truncated,
    scopeHash,
    cliPath,
    cliVersion,
    nativeConfigScope,
    discoveredAt: now(),
    ...(source ? { source } : {}),
  };
  if (adapterId === "codex") return parseCodexModelCatalog(input);
  if (adapterId === "agy") return parseAgyModelCatalog(input);
  if (adapterId === "cursor-agent") return parseCursorModelCatalog(input);
  if (adapterId === "claude-code") return parseClaudeModelCatalog(input);
  if (adapterId === "grok-build") return parseGrokModelCatalog(input);
  if (adapterId === "kimi-code") return parseKimiModelCatalog(input);
  if (adapterId === "qoder") return parseQoderModelCatalog(input);
  if (adapterId === "opencode") return parseOpenCodeModelCatalog(input);
  if (adapterId === "mimo-code") return parseMimoModelCatalog(input);
  return failedModelCatalog(
    adapterId,
    input,
    "CLI_PARAMETER_UNSUPPORTED",
    "不支持的工具目录解析",
  );
}

function firstNonEmptyLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0);
  return line;
}

function catalogArgs(adapterId: SupportedAdapterId): string[] {
  if (adapterId === "qoder") return ["--list-models"];
  if (adapterId === "opencode") return ["models", "--verbose"];
  if (adapterId === "mimo-code") return ["models", "--verbose"];
  return ["models"];
}

function kimiConfigPath(): string {
  const home = process.env.KIMI_CODE_HOME?.trim();
  if (home) return join(home, "config.toml");
  return join(homedir(), ".kimi-code", "config.toml");
}

function codexCachePaths(): string[] {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return [join(home, "models_cache.json")];
}

function matchesFingerprint(adapterId: SupportedAdapterId, text: string): boolean {
  return new RegExp(FINGERPRINTS[adapterId], "i").test(text);
}

function classifySpawnOrOutput(
  result: LimitedCliResult,
): { code: string; message: string } | undefined {
  const combined = `${result.stdout}\n${result.stderr}\n${result.spawnError?.message ?? ""}`;
  const code = result.spawnError?.code;
  if (code === "ENOENT") {
    return { code: "TOOL_NOT_FOUND", message: "未找到指定 CLI" };
  }
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    isDiscoveryEnvironmentError(combined)
  ) {
    return {
      code: "DISCOVERY_ENVIRONMENT_UNAVAILABLE",
      message: "本机目录或权限不可用，不能判定账号未授权",
    };
  }
  if (result.timedOut) {
    return { code: "MODEL_PROBE_TIMEOUT", message: "读取模型目录超时" };
  }
  return undefined;
}

function withFreshness(catalog: ModelCatalog): ModelCatalog {
  const discoveryStatus: ModelDiscoveryStatus =
    catalog.discoveryStatus ?? inferDiscoveryStatus(catalog);
  const parserRevision = catalog.parserRevision ?? PARSER_REVISION;
  const isStale = catalog.status === "fresh" && Date.parse(catalog.staleAfter) <= Date.now();
  const status = isStale ? "stale" : catalog.status;

  if (
    catalog.status === status &&
    catalog.discoveryStatus === discoveryStatus &&
    catalog.parserRevision === parserRevision
  ) {
    return catalog;
  }
  return ModelCatalogSchema.parse({
    ...catalog,
    status,
    discoveryStatus,
    parserRevision,
  });
}

function missingCatalog(adapterId: SupportedAdapterId, scopeHash: string): ModelCatalog {
  const clock = now();
  return ModelCatalogSchema.parse({
    adapterId,
    scopeHash,
    status: "missing",
    discoveryStatus: "missing",
    parserRevision: PARSER_REVISION,
    discoveredAt: clock,
    staleAfter: new Date(Date.parse(clock) + CATALOG_FRESH_MS).toISOString(),
    entries: [],
  });
}

function publicOperationMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9]+/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

function isRetryableCatalogCode(code: string | undefined): boolean {
  return (
    code === "MODEL_PROBE_TIMEOUT" ||
    code === "DISCOVERY_ENVIRONMENT_UNAVAILABLE"
  );
}

function worseOperationStatus(
  current: CatalogOperationStatus,
  next: CatalogOperationStatus,
): CatalogOperationStatus {
  const rank: Record<CatalogOperationStatus, number> = {
    prepared: 0,
    ready: 1,
    processing: 2,
    committed: 3,
    retryable: 4,
    failed: 5,
    rejected: 6,
  };
  return rank[next] > rank[current] ? next : current;
}

export function assertManualNativeId(
  adapterId: SupportedAdapterId,
  nativeId: string,
): string {
  const id = nativeId.trim();
  if (!id || id !== nativeId) {
    throw new FlowError("INVALID_REQUEST", "模型 ID 不能为空或含首尾空白", 422);
  }
  if (id.length > 200) {
    throw new FlowError("INVALID_REQUEST", "模型 ID 超出长度限制", 422);
  }
  if (/[\s;|&$<>`\\\n\r]/.test(id) || id.startsWith("-")) {
    throw new FlowError("INVALID_REQUEST", "模型 ID 含有非法字符", 422);
  }
  const allowSlash =
    adapterId === "opencode" ||
    adapterId === "kimi-code" ||
    adapterId === "mimo-code";
  const pattern = allowSlash
    ? /^[A-Za-z0-9][A-Za-z0-9._:+/-]*$/
    : /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
  if (!pattern.test(id)) {
    throw new FlowError("INVALID_REQUEST", "模型 ID 格式无效", 422);
  }
  return id;
}

function manualCandidateEntry(
  adapterId: SupportedAdapterId,
  nativeId: string,
): ModelEntry {
  const clock = now();
  return ModelEntrySchema.parse({
    entryId: makeEntryId(adapterId, "manual", nativeId),
    adapterId,
    nativeId,
    label: nativeId,
    selectionKind: "fixed",
    effort: {
      status: "unknown",
      transport: "none",
      values: [],
    },
    source: "manual",
    discoveredAt: clock,
    hidden: false,
    availability: "candidate",
    capabilityRevision: `${nativeId}:manual:unknown`,
    accessModelKey: nativeId,
  });
}

function mergeManualEntries(
  discovered: ModelEntry[],
  previous: ModelCatalog | undefined,
): ModelEntry[] {
  const listed = new Set(discovered.map((entry) => entry.nativeId));
  const manuals = (previous?.entries ?? []).filter(
    (entry) => entry.source === "manual" && !listed.has(entry.nativeId),
  );
  return [...discovered, ...manuals];
}

type CatalogWork = {
  scanLimit: Semaphore;
  queryLimit: Semaphore;
  inflight: Map<string, Promise<ModelCatalog>>;
  operations: Map<string, Promise<void>>;
};
const catalogWorkByStore = new WeakMap<Store, CatalogWork>();

export class ModelCatalogService {
  private readonly scanLimit: Semaphore;
  private readonly queryLimit: Semaphore;
  private readonly inflight: Map<string, Promise<ModelCatalog>>;
  private readonly operationWork: Map<string, Promise<void>>;
  private readonly versionHelpTimeoutMs: number;
  private readonly catalogTimeoutMs: number;
  private readonly workingDirectory: string;
  private readonly extraEnv?: Record<string, string>;
  private readonly resolveExecutableFn?: (
    adapterId: SupportedAdapterId,
  ) => string | undefined;

  constructor(
    private readonly store: Store,
    options: ModelCatalogServiceOptions = {},
  ) {
    this.versionHelpTimeoutMs =
      options.versionHelpTimeoutMs ?? VERSION_HELP_TIMEOUT_MS;
    this.catalogTimeoutMs = options.catalogTimeoutMs ?? CATALOG_READ_TIMEOUT_MS;
    this.workingDirectory = options.workingDirectory ?? process.cwd();
    this.extraEnv = options.extraEnv;
    this.resolveExecutableFn = options.resolveExecutable;
    const active = catalogWorkByStore.get(store);
    const work = active ?? {
      scanLimit: new Semaphore(TOOL_SCAN_CONCURRENCY),
      queryLimit: new Semaphore(CATALOG_QUERY_CONCURRENCY),
      inflight: new Map<string, Promise<ModelCatalog>>(),
      operations: new Map<string, Promise<void>>(),
    };
    this.scanLimit = work.scanLimit;
    this.queryLimit = work.queryLimit;
    this.inflight = work.inflight;
    this.operationWork = work.operations;
    if (!active) {
      catalogWorkByStore.set(store, work);
      this.failIncompleteOperations();
    }
  }

  listTools(): ToolSummary[] {
    return TOOL_DISPLAY_ORDER.map((tool) =>
      this.summaryFromCache(tool.adapterId, tool.label),
    );
  }

  discoverTools(input: {
    request_id: string;
    adapter_ids: SupportedAdapterId[];
  }): { operation: CatalogOperation; created: boolean } {
    const requestId = z.string().uuid().parse(input.request_id);
    const adapterIds = [...new Set(input.adapter_ids.map(asAdapter))];
    const id = operationId("discover", requestId, adapterIds.join(","));
    const existing = this.store.get<CatalogOperation>(OPERATION_KIND, id);
    if (existing) {
      this.ensureOperationRunning(existing, existing.status === "retryable");
      return {
        operation:
          this.store.get<CatalogOperation>(OPERATION_KIND, id) ?? existing,
        created: false,
      };
    }
    const operation: CatalogOperation = {
      id,
      operation_type: "discover",
      entity_id: "global",
      request_id: requestId,
      status: "processing",
      created_at: now(),
      updated_at: now(),
      adapter_ids: adapterIds,
    };
    this.store.put(OPERATION_KIND, id, "global", operation);
    this.startOperation(operation);
    return { operation, created: true };
  }

  getModels(adapter: string, scopeId?: string): ModelCatalog {
    const adapterId = asAdapter(adapter);
    const wanted = scopeId?.trim() ? scopeId.trim() : "default";
    const scope = this.scopeForRefresh(adapterId, wanted);
    const cached = scope ? this.readCached(scope) : undefined;
    if (cached) return withFreshness(cached);
    return missingCatalog(adapterId, wanted);
  }

  refreshModels(input: {
    adapter: string;
    request_id: string;
    scope_id?: string;
  }): { operation: CatalogOperation; created: boolean } {
    const adapterId = asAdapter(input.adapter);
    const requestId = z.string().uuid().parse(input.request_id);
    const id = operationId("refresh", requestId, adapterId);
    const existing = this.store.get<CatalogOperation>(OPERATION_KIND, id);
    if (existing) {
      this.ensureOperationRunning(existing, existing.status === "retryable");
      return {
        operation:
          this.store.get<CatalogOperation>(OPERATION_KIND, id) ?? existing,
        created: false,
      };
    }
    const operation: CatalogOperation = {
      id,
      operation_type: "refresh",
      entity_id: adapterId,
      request_id: requestId,
      status: "processing",
      created_at: now(),
      updated_at: now(),
      adapter_ids: [adapterId],
      scope_id: input.scope_id,
    };
    this.store.put(OPERATION_KIND, id, "global", operation);
    this.startOperation(operation);
    return { operation, created: true };
  }

  getOperation(id: string): CatalogOperation {
    const operation = this.store.get<CatalogOperation>(OPERATION_KIND, id);
    if (!operation) {
      throw new FlowError("NOT_FOUND", "配置操作不存在", 404);
    }
    this.ensureOperationRunning(operation);
    return this.store.get<CatalogOperation>(OPERATION_KIND, id) ?? operation;
  }

  async waitForOperation(id: string): Promise<CatalogOperation> {
    const work = this.operationWork.get(id);
    if (work) await work;
    const operation = this.store.get<CatalogOperation>(OPERATION_KIND, id);
    if (!operation) {
      throw new FlowError("NOT_FOUND", "配置操作不存在", 404);
    }
    return operation;
  }

  async close(): Promise<void> {
    await Promise.all([...this.operationWork.values()]);
  }

  ensureManualCandidate(scope: CatalogScopeInput, nativeId: string): ModelEntry {
    const id = assertManualNativeId(scope.adapterId, nativeId);
    const previous = this.readCached(scope);
    const existing = previous?.entries.find((entry) => entry.nativeId === id);
    if (existing) return existing;
    const entry = manualCandidateEntry(scope.adapterId, id);
    const clock = now();
    const hasNonManual = previous?.entries.some((e) => e.source !== "manual") ?? false;
    const catalog = previous
      ? ModelCatalogSchema.parse({
          ...previous,
          entries: [...previous.entries, entry],
          discoveryStatus: hasNonManual ? (previous.discoveryStatus ?? "complete") : "missing",
          parserRevision: previous.parserRevision ?? PARSER_REVISION,
        })
      : ModelCatalogSchema.parse({
          ...freshModelCatalog(
            scope.adapterId,
            {
              stdout: "",
              scopeHash: catalogEntityId(scope, "manual").slice(8),
              cliPath: scope.executablePath,
              nativeConfigScope: scope.nativeConfigScope ?? "default",
              discoveredAt: clock,
              source: "manual",
            },
            [entry],
          ),
          status: "missing",
          discoveryStatus: "missing",
          parserRevision: PARSER_REVISION,
        });
    if (scope.nativeConfigProfile) catalog.nativeConfigProfile = scope.nativeConfigProfile;
    const catalogId = previous
      ? "catalog:" + previous.scopeHash
      : catalogEntityId(scope, "manual");
    this.writeCatalog(scope, catalogId, catalog);
    return entry;
  }

  readCached(scope: CatalogScopeInput): ModelCatalog | undefined {
    const pointer = this.store.get<CatalogPointer>(POINTER_KIND, pointerId(scope));
    if (!pointer) return undefined;
    const raw = this.store.get<ModelCatalog>(CATALOG_KIND, pointer.catalogId);
    if (!raw) return undefined;
    return withFreshness(ModelCatalogSchema.parse(raw));
  }

  loadForSelector(scope: CatalogScopeInput): ModelCatalog {
    return this.readCached(scope) ?? missingCatalog(scope.adapterId, "missing");
  }

  async scanTools(scopes: CatalogScopeInput[]): Promise<ToolSummary[]> {
    return Promise.all(
      scopes.map((scope) => this.scanLimit.run(() => this.scanOne(scope))),
    );
  }

  async discover(scope: CatalogScopeInput): Promise<ModelCatalog> {
    const key = pointerId(scope);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const work = this.queryLimit
      .run(() => this.runDiscovery(scope))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, work);
    return work;
  }

  private failIncompleteOperations() {
    for (const operation of this.store.list<CatalogOperation>(
      OPERATION_KIND,
      "global",
    )) {
      this.failIfOrphaned(operation);
    }
  }

  private ensureOperationRunning(
    operation: CatalogOperation,
    restartRetryable = false,
  ) {
    if (this.operationWork.has(operation.id)) return;
    if (operation.status === "processing") {
      this.startOperation(operation);
      return;
    }
    if (restartRetryable && operation.status === "retryable") {
      this.startOperation(operation);
    }
  }

  private failIfOrphaned(operation: CatalogOperation) {
    if (operation.status !== "processing") return;
    if (this.operationWork.has(operation.id)) return;
    this.patchOperation(operation.id, {
      status: "retryable",
      error_code: "DISCOVERY_ENVIRONMENT_UNAVAILABLE",
      error_message: "目录操作在进程中断后未完成",
      completed_at: now(),
      updated_at: now(),
    });
  }

  private startOperation(operation: CatalogOperation) {
    if (this.operationWork.has(operation.id)) return;
    const work = this.executeOperation(operation).finally(() => {
      this.operationWork.delete(operation.id);
    });
    this.operationWork.set(operation.id, work);
  }

  private async executeOperation(operation: CatalogOperation): Promise<void> {
    this.patchOperation(operation.id, {
      status: "processing",
      updated_at: now(),
    });
    try {
      const outcome =
        operation.operation_type === "refresh"
          ? await this.runRefreshWork(operation)
          : await this.runDiscoverWork(operation);
      this.patchOperation(operation.id, {
        status: outcome.status,
        error_code: outcome.errorCode,
        error_message: outcome.errorMessage,
        completed_at: now(),
        updated_at: now(),
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "目录操作失败";
      this.patchOperation(operation.id, {
        status: "failed",
        error_code: error instanceof FlowError ? error.code : "CATALOG_OUTPUT_INVALID",
        error_message: publicOperationMessage(message),
        completed_at: now(),
        updated_at: now(),
      });
    }
  }

  private async runDiscoverWork(
    operation: CatalogOperation,
  ): Promise<{
    status: CatalogOperationStatus;
    errorCode?: string;
    errorMessage?: string;
  }> {
    const adapterIds = operation.adapter_ids ?? [];
    const scopes = this.scopesForAdapters(adapterIds, operation.scope_id);
    await this.scanTools(scopes);
    let worst: CatalogOperationStatus = "committed";
    let errorCode: string | undefined;
    let errorMessage: string | undefined;
    for (const scope of scopes) {
      const catalog = await this.discover(scope);
      const next = this.statusFromCatalog(catalog);
      if (catalog.errorCode && next !== "committed") {
        errorCode = catalog.errorCode;
        errorMessage = catalog.errorMessage
          ? publicOperationMessage(catalog.errorMessage)
          : undefined;
      }
      worst = worseOperationStatus(worst, next);
    }
    return { status: worst, errorCode, errorMessage };
  }

  private async runRefreshWork(
    operation: CatalogOperation,
  ): Promise<{
    status: CatalogOperationStatus;
    errorCode?: string;
    errorMessage?: string;
  }> {
    const adapterId = asAdapter(operation.entity_id);
    const scope = this.scopeForRefresh(adapterId, operation.scope_id);
    if (!scope) {
      return {
        status: "failed",
        errorCode: "TOOL_NOT_FOUND",
        errorMessage: "未找到指定 CLI",
      };
    }
    const catalog = await this.discover(scope);
    const status = this.statusFromCatalog(catalog);
    return {
      status,
      errorCode: catalog.errorCode,
      errorMessage: catalog.errorMessage
        ? publicOperationMessage(catalog.errorMessage)
        : undefined,
    };
  }

  private statusFromCatalog(catalog: ModelCatalog): CatalogOperationStatus {
    if (!catalog.errorCode) return "committed";
    if (isRetryableCatalogCode(catalog.errorCode)) return "retryable";
    if (catalog.entries.length > 0) return "retryable";
    return "failed";
  }

  private scopesForAdapters(
    adapterIds: SupportedAdapterId[],
    scopeId?: string,
  ): CatalogScopeInput[] {
    const scopes: CatalogScopeInput[] = [];
    for (const adapterId of adapterIds) {
      const executablePath = this.lookupExecutable(adapterId);
      if (!executablePath) {
        this.store.put(TOOL_KIND, adapterId, "global", {
          adapterId,
          label: TOOL_DISPLAY_ORDER.find((tool) => tool.adapterId === adapterId)?.label ?? adapterId,
          probeStatus: "not-detected",
          catalogStatus: "missing",
          installHint: "未找到指定 CLI",
        });
        continue;
      }
      scopes.push(this.resolveScope(adapterId, executablePath, scopeId));
    }
    return scopes;
  }

  private scopeForRefresh(
    adapterId: SupportedAdapterId,
    scopeId?: string,
  ): CatalogScopeInput | undefined {
    const wanted = scopeId?.trim() ? scopeId.trim() : "default";
    const cached = this.latestMatching(adapterId, wanted);
    if (!cached && wanted.startsWith("codex-config:")) return undefined;
    const executablePath = cached?.cliPath ?? this.lookupExecutable(adapterId);
    if (!executablePath) return undefined;
    return this.resolveScope(
      adapterId,
      executablePath,
      cached
        ? cached.nativeConfigProfile
        : wanted === "default" ? undefined : wanted,
    );
  }

  private resolveScope(
    adapterId: SupportedAdapterId,
    executablePath: string,
    nativeConfigProfile?: string,
  ): CatalogScopeInput {
    const native = resolveModelIdentity(this.store, {
      adapterId,
      executableRef: executablePath,
      ...(nativeConfigProfile && nativeConfigProfile !== "default"
        ? { nativeConfigProfile }
        : {}),
    });
    if (nativeConfigProfile && nativeConfigProfile !== "default" && !native.profileSelectionSupported) {
      throw new FlowError("CLI_PARAMETER_UNSUPPORTED", "当前工具不支持命名原生配置", 422);
    }
    return {
      adapterId,
      executablePath: native.executablePath,
      nativeConfigScope: native.nativeConfigScope,
      nativeConfigProfile: native.nativeConfigProfile,
      accountFingerprint: native.accountFingerprint,
      providerFingerprint: native.providerEndpointFingerprint,
    };
  }

  private lookupExecutable(adapterId: SupportedAdapterId): string | undefined {
    if (this.resolveExecutableFn) {
      const custom = this.resolveExecutableFn(adapterId);
      if (custom) return custom;
    }
    return resolveAdapterExecutable(adapterId);
  }

  private patchOperation(id: string, patch: Partial<CatalogOperation>) {
    try {
      const current = this.store.get<CatalogOperation>(OPERATION_KIND, id);
      if (!current) return;
      this.store.put(OPERATION_KIND, id, "global", { ...current, ...patch });
    } catch {
      return;
    }
  }

  private summaryFromCache(
    adapterId: SupportedAdapterId,
    label: string,
  ): ToolSummary {
    const cached = this.latestByAdapter(adapterId);
    const detected = this.store.get<ToolSummary>(TOOL_KIND, adapterId);
    const probeStatus: ToolDiscoveryStatus = detected?.probeStatus ?? "not-detected";
    return {
      adapterId,
      label,
      executablePath: detected?.executablePath ?? cached?.cliPath,
      cliVersion: detected?.cliVersion ?? cached?.cliVersion,
      probeStatus,
      installHint: detected?.installHint,
      nativeConfigSummary: cached?.nativeConfigScope,
      catalogStatus: cached ? withFreshness(cached).status : "missing",
      catalogUpdatedAt: cached?.discoveredAt,
    };
  }

  private latestByAdapter(adapterId: SupportedAdapterId): ModelCatalog | undefined {
    return this.sortedCatalogs(adapterId)[0];
  }

  private latestMatching(
    adapterId: SupportedAdapterId,
    scopeId: string,
  ): ModelCatalog | undefined {
    return this.sortedCatalogs(adapterId).find((catalog) => {
      if (catalog.scopeHash === scopeId) return true;
      return catalog.nativeConfigProfile === scopeId ||
        (catalog.nativeConfigScope ?? "default") === scopeId;
    });
  }

  private sortedCatalogs(adapterId: SupportedAdapterId): ModelCatalog[] {
    return this.store
      .list<ModelCatalog>(CATALOG_KIND, adapterId)
      .map((row) => ModelCatalogSchema.parse(row))
      .sort((a, b) => (a.discoveredAt < b.discoveredAt ? 1 : -1));
  }

  private async scanOne(scope: CatalogScopeInput): Promise<ToolSummary> {
    const identity = await this.readVersionHelp(scope);
    return this.recordToolScan(scope, identity);
  }

  private recordToolScan(
    scope: CatalogScopeInput,
    identity: { cliVersion?: string; matched: boolean; errorCode?: string; errorMessage?: string },
  ): ToolSummary {
    const cached = this.readCached(scope);
    const summary: ToolSummary = {
      adapterId: scope.adapterId,
      label:
        TOOL_DISPLAY_ORDER.find((item) => item.adapterId === scope.adapterId)?.label
        ?? scope.adapterId,
      executablePath: scope.executablePath,
      cliVersion: identity.cliVersion,
      probeStatus: this.scanStatus(identity),
      installHint: identity.errorMessage,
      nativeConfigSummary: scope.nativeConfigScope,
      catalogStatus: cached ? withFreshness(cached).status : "missing",
      catalogUpdatedAt: cached?.discoveredAt,
    };
    this.store.put(TOOL_KIND, scope.adapterId, "global", summary);
    return summary;
  }

  private scanStatus(identity: {
    errorCode?: string;
    matched: boolean;
    cliVersion?: string;
  }): ToolDiscoveryStatus {
    if (identity.errorCode === "DISCOVERY_ENVIRONMENT_UNAVAILABLE") {
      return "environment-unavailable";
    }
    if (identity.errorCode === "TOOL_NOT_FOUND") return "not-detected";
    if (identity.cliVersion && !identity.matched) return "identity-mismatch";
    if (identity.matched) return "detected";
    return "not-detected";
  }

  private async runDiscovery(scope: CatalogScopeInput): Promise<ModelCatalog> {
    const previous = this.readCached(scope);
    if (previous?.entries.length) this.markRefreshing(previous);
    const identity = await this.readVersionHelp(scope);
    this.recordToolScan(scope, identity);
    if (identity.errorCode) {
      return this.keepLastSuccess(
        scope,
        previous,
        identity.errorCode,
        identity.errorMessage ?? "工具探测失败",
        identity.cliVersion ?? "",
      );
    }
    if (!identity.matched) {
      return this.keepLastSuccess(
        scope,
        previous,
        "TOOL_IDENTITY_MISMATCH",
        "版本与帮助未匹配产品身份",
        identity.cliVersion ?? "",
      );
    }
    const cliVersion = identity.cliVersion ?? "unknown";
    const parsed = await this.loadCatalog(scope, cliVersion);
    if (parsed.status === "failed") {
      return this.keepLastSuccess(
        scope,
        previous,
        parsed.errorCode ?? "CATALOG_OUTPUT_INVALID",
        parsed.errorMessage ?? "目录读取失败",
        cliVersion,
      );
    }
    const capability = await this.readInvocationCapability(scope);
    return this.persistCatalog(scope, cliVersion, {
      ...parsed,
      ...(capability ? { invocationCapability: capability } : {}),
    });
  }

  private async readInvocationCapability(
    scope: CatalogScopeInput,
  ): Promise<ModelInvocationCapability | undefined> {
    if (scope.adapterId === "opencode") {
      const help = await this.runCli(scope, ["run", "--help"], this.versionHelpTimeoutMs);
      if (help.exitCode !== 0 || help.timedOut || help.truncated || help.spawnError) return undefined;
      const encoding = detectOpenCodeVariantEncoding(help.stdout);
      return encoding ? { opencodeVariantEncoding: encoding } : undefined;
    }
    if (scope.adapterId === "mimo-code") {
      const help = await this.runCli(scope, ["run", "--help"], this.versionHelpTimeoutMs);
      if (help.exitCode !== 0 || help.timedOut || help.truncated || help.spawnError) return undefined;
      const encoding = detectMimoVariantEncoding(help.stdout);
      return encoding ? { opencodeVariantEncoding: encoding } : undefined;
    }
    return undefined;
  }

  private persistCatalog(
    scope: CatalogScopeInput,
    cliVersion: string,
    parsed: ModelCatalog,
  ): ModelCatalog {
    const previous = this.readCached(scope);
    const entityId = catalogEntityId(scope, cliVersion);
    const stored = ModelCatalogSchema.parse({
      ...parsed,
      entries: mergeManualEntries(parsed.entries, previous),
      scopeHash: entityId.slice(8),
      cliPath: scope.executablePath,
      cliVersion,
      nativeConfigScope: scope.nativeConfigScope ?? "default",
      nativeConfigProfile: scope.nativeConfigProfile,
      status: "fresh",
      discoveryStatus:
        parsed.discoveryStatus ?? (parsed.entries.length > 0 ? "complete" : "missing"),
      parserRevision: parsed.parserRevision ?? PARSER_REVISION,
    });
    this.writeCatalog(scope, entityId, stored);
    return stored;
  }

  private parseQuery(
    scope: CatalogScopeInput,
    cliVersion: string,
    query: LimitedCliResult,
    source?: ModelSource,
  ): ModelCatalog {
    const classified = classifySpawnOrOutput(query);
    if (classified) {
      return failedModelCatalog(
        scope.adapterId,
        {
          stdout: query.stdout,
          stderr: query.stderr,
          truncated: query.truncated,
          scopeHash: catalogEntityId(scope, cliVersion).slice(8),
          cliPath: scope.executablePath,
          cliVersion,
          nativeConfigScope: scope.nativeConfigScope ?? "default",
          discoveredAt: now(),
        },
        classified.code,
        classified.message,
      );
    }
    return parseAdapterCatalog(
      scope.adapterId,
      query.stdout,
      query.stderr,
      query.truncated,
      catalogEntityId(scope, cliVersion).slice(8),
      scope.executablePath,
      cliVersion,
      scope.nativeConfigScope ?? "default",
      source,
    );
  }

  private async loadCatalog(
    scope: CatalogScopeInput,
    cliVersion: string,
  ): Promise<ModelCatalog> {
    const query = await this.queryCatalog(scope);
    const parsed = this.parseQuery(scope, cliVersion, query);
    if (parsed.status !== "failed") return parsed;
    if (scope.adapterId === "cursor-agent") {
      const retry = await this.runCli(
        scope,
        ["--list-models"],
        this.catalogTimeoutMs,
      );
      const retried = this.parseQuery(scope, cliVersion, retry);
      if (retried.status !== "failed") return retried;
    }
    if (scope.adapterId === "codex") {
      const cache = this.readCodexCache(scope, cliVersion);
      if (cache) return cache;
    }
    return parsed;
  }

  private async queryCatalog(scope: CatalogScopeInput): Promise<LimitedCliResult> {
    if (scope.adapterId === "claude-code") {
      return {
        stdout: claudeCatalogStdout(),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        truncated: false,
      };
    }
    if (scope.adapterId === "kimi-code") {
      const path = kimiConfigPath();
      if (!existsSync(path)) {
        return {
          stdout: "",
          stderr: "未找到 Kimi config.toml",
          exitCode: 1,
          timedOut: false,
          cancelled: false,
          truncated: false,
        };
      }
      return {
        stdout: readFileSync(path, "utf8"),
        stderr: "",
        exitCode: 0,
        timedOut: false,
        cancelled: false,
        truncated: false,
      };
    }
    if (scope.adapterId === "codex") {
      return queryCodexAppServer({
        adapterId: scope.adapterId,
        executable: scope.executablePath,
        args: [...this.nativeProfileArgs(scope), "app-server"],
        cwd: this.workingDirectory,
        env: this.extraEnv,
        timeoutMs: this.catalogTimeoutMs,
        outputLimit: CATALOG_OUTPUT_LIMIT,
      });
    }
    return this.runCli(scope, catalogArgs(scope.adapterId), this.catalogTimeoutMs);
  }

  private readCodexCache(
    scope: CatalogScopeInput,
    cliVersion: string,
  ): ModelCatalog | undefined {
    // The single Codex cache does not identify a named profile/provider.
    if (scope.nativeConfigProfile && scope.nativeConfigProfile !== "default") return undefined;
    for (const path of codexCachePaths()) {
      if (!existsSync(path)) continue;
      const parsed = this.parseQuery(
        scope,
        cliVersion,
        {
          stdout: readFileSync(path, "utf8"),
          stderr: "",
          exitCode: 0,
          timedOut: false,
          cancelled: false,
          truncated: false,
        },
        "native-cache",
      );
      if (parsed.status !== "failed") return parsed;
    }
    return undefined;
  }

  private markRefreshing(catalog: ModelCatalog) {
    this.store.put(CATALOG_KIND, "catalog:" + catalog.scopeHash, catalog.adapterId, {
      ...catalog,
      status: "refreshing",
    });
  }

  private keepLastSuccess(
    scope: CatalogScopeInput,
    previous: ModelCatalog | undefined,
    errorCode: string,
    errorMessage: string,
    cliVersion: string,
  ): ModelCatalog {
    if (previous && previous.entries.length > 0) {
      const kept = ModelCatalogSchema.parse({
        ...previous,
        status: "failed",
        discoveryStatus: previous.discoveryStatus ?? inferDiscoveryStatus(previous),
        parserRevision: previous.parserRevision ?? PARSER_REVISION,
        errorCode,
        errorMessage,
        cliVersion: previous.cliVersion ?? cliVersion,
      });
      this.writeCatalog(scope, "catalog:" + previous.scopeHash, kept);
      return kept;
    }
    const failed = failedModelCatalog(
      scope.adapterId,
      {
        stdout: "",
        stderr: errorMessage,
        scopeHash: catalogEntityId(scope, cliVersion || "unknown").slice(8),
        cliPath: scope.executablePath,
        cliVersion,
        nativeConfigScope: scope.nativeConfigScope ?? "default",
        discoveredAt: now(),
      },
      errorCode,
      errorMessage,
    );
    this.writeCatalog(scope, "catalog:" + failed.scopeHash, failed);
    return failed;
  }

  private writeCatalog(
    scope: CatalogScopeInput,
    catalogId: string,
    catalog: ModelCatalog,
  ) {
    this.store.put(CATALOG_KIND, catalogId, scope.adapterId, catalog);
    const pointer: CatalogPointer = {
      catalogId,
      cliVersion: catalog.cliVersion,
      updated_at: now(),
    };
    this.store.put(POINTER_KIND, pointerId(scope), scope.adapterId, pointer);
  }

  private async readVersionHelp(scope: CatalogScopeInput): Promise<{
    cliVersion?: string;
    matched: boolean;
    errorCode?: string;
    errorMessage?: string;
  }> {
    if (!existsSync(scope.executablePath)) {
      return {
        matched: false,
        errorCode: "TOOL_NOT_FOUND",
        errorMessage: "未找到指定 CLI",
      };
    }
    const version = await this.runCli(scope, ["--version"], this.versionHelpTimeoutMs);
    const versionError = classifySpawnOrOutput(version);
    if (versionError) {
      return {
        matched: false,
        errorCode: versionError.code,
        errorMessage: versionError.message,
      };
    }
    const help = await this.runCli(scope, ["--help"], this.versionHelpTimeoutMs);
    const helpError = classifySpawnOrOutput(help);
    if (helpError) {
      return {
        matched: false,
        cliVersion: version.stdout.trim().split(/\r?\n/)[0],
        errorCode: helpError.code,
        errorMessage: helpError.message,
      };
    }
    const identityText = [
      version.stdout,
      version.stderr,
      help.stdout,
      help.stderr,
    ].join("\n");
    const cliVersion =
      firstNonEmptyLine(version.stdout) ?? firstNonEmptyLine(version.stderr);
    const matched = matchesFingerprint(scope.adapterId, identityText);
    return { cliVersion, matched };
  }

  private runCli(
    scope: CatalogScopeInput,
    args: string[],
    timeoutMs: number,
  ): Promise<LimitedCliResult> {
    return runLimitedCli({
      adapterId: scope.adapterId,
      executable: scope.executablePath,
      args: [...this.nativeProfileArgs(scope), ...args],
      cwd: this.workingDirectory,
      env: this.extraEnv,
      timeoutMs,
      outputLimit: CATALOG_OUTPUT_LIMIT,
    });
  }

  private nativeProfileArgs(scope: CatalogScopeInput): string[] {
    const profile = scope.nativeConfigProfile;
    if (!profile || profile === "default") return [];
    if (scope.adapterId !== "codex") {
      throw new FlowError("CLI_PARAMETER_UNSUPPORTED", "当前工具不支持命名原生配置", 422);
    }
    return ["--profile", profile];
  }
}
