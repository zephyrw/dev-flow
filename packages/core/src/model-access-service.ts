import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Store } from "../../store/src/store.js";
import {
  FlowError,
  ModelAccessRecordSchema,
  ModelVerificationJobSchema,
  ProbeTerminalSchema,
  ToolProfileSchema,
  VERIFY_JOB_TIMEOUT_MS,
  type IdentityConfidence,
  type FrozenInvocation,
  type ModelAccessRecord,
  type ModelAccessStatus,
  type ModelCatalog,
  type ModelEntry,
  type ModelVerificationJob,
  type NativeResolvedConfig,
  type ProbeTerminal,
  type SupportedAdapterId,
  type ToolProfile,
} from "../../contracts/src/index.js";
import { resolveModelSelection } from "../../adapters/sdk/src/model-selection.js";
import { selectionCapabilityFromCatalog } from "../../adapters/sdk/src/frozen-invocation.js";
import { parseStructuredProbeTerminal } from "../../adapters/sdk/src/probe-terminal.js";
import { nativeProfileSupported } from "../../adapters/sdk/src/native-identity.js";
import { fingerprintModelIdentity, modelIdentityKey, resolveModelIdentity, resolveModelIdentityInput, readManagedAgyModelIdentity, resolveModelExecutable, type AccessIdentityInput, type ManagedAgyModelIdentity } from "./model-identity.js";
export type { AccessIdentityInput } from "./model-identity.js";
import type {
  PreparedInvocation,
  ResolvedSelection,
} from "../../adapters/sdk/src/interface.js";
import { CATALOG_OUTPUT_LIMIT } from "../../contracts/src/model-catalog.js";
import { isDiscoveryEnvironmentError } from "../../adapters/sdk/src/catalog-parse.js";
import {
  ModelCatalogService,
  startLimitedCli,
  type CatalogScopeInput,
  type LimitedCliHandle,
  type LimitedCliResult,
} from "./model-catalog-service.js";
import { id, now, objectHash, redact } from "./util.js";

const ACCESS_KIND = "model_access";
const JOB_KIND = "model_verification_job";
const FORBIDDEN_PROBE_FLAGS = [
  "--force",
  "--always-approve",
  "--approve-mcps",
];
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
const OPENCODE_PROBE_CONFIG = JSON.stringify({
  permission: { "*": "deny" },
  mcp: {},
});

type ProbeAdapter = {
  prepareAccessProbe?: (
    selection: ResolvedSelection,
    context: { workspaceRoot: string; timeoutMs?: number },
  ) => PreparedInvocation;
  parseProbeTerminal?: (
    result: LimitedCliResult,
    selectedModel: string | null,
    context?: { adapterId: string; selectionKind?: "fixed" | "native-router" },
  ) => ProbeTerminal;
};

export const ACCESS_PROBE_PROMPT = "仅回复 OK，不读取文件，不调用工具";

export type VerifyAccessRequest = {
  request_id: string;
  profile: ToolProfile;
  force?: boolean;
  identity?: AccessIdentityInput;
  catalog?: ModelCatalog;
};

export type VerifyAccessOutcome =
  | { statusCode: 200; record: ModelAccessRecord }
  | { statusCode: 202; job: ModelVerificationJob };

export type ModelAccessServiceOptions = {
  catalog?: ModelCatalogService;
  extraEnv?: Record<string, string>;
  probeRoot?: string;
  verifyTimeoutMs?: number;
  probeAdapter?: ProbeAdapter;
  withManagedAccountVerification?: <T>(
    identity: ManagedAgyModelIdentity,
    verify: () => Promise<T>,
  ) => Promise<T>;
};

type FingerprintedIdentity = {
  nativeConfigScope: string;
  accountFingerprint: string;
  providerEndpointFingerprint: string;
  identityConfidence: IdentityConfidence;
};

type ProbeFailure = {
  status: Exclude<ModelAccessStatus, "unverified" | "checking" | "verified">;
  errorCode: string;
  retryable: boolean;
  message: string;
};

type LiveProbe = {
  jobId: string;
  accessKey: string;
  handle: LimitedCliHandle;
};

function hmacHex(secret: Buffer, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

function accessRecordId(parts: {
  adapterId: string;
  nativeConfigScope: string;
  providerEndpointFingerprint: string;
  accountFingerprint: string;
  accessModelKey: string;
}): string {
  return "acc-" + objectHash(parts);
}

function resolveAccessModelKey(entry: ModelEntry | undefined, nativeId: string): string {
  if (entry?.accessModelKey?.trim()) return entry.accessModelKey.trim();
  return nativeId;
}

function findCatalogEntry(
  catalog: ModelCatalog | undefined,
  profile: ToolProfile,
): ModelEntry | undefined {
  if (!catalog) return undefined;
  const nativeId = profile.modelId?.trim();
  if (!nativeId) return undefined;
  return catalog.entries.find((item) => item.nativeId === nativeId);
}

export function parseProbeTerminal(
  result: LimitedCliResult,
  selectedModel: string | null,
  adapterId?: string,
  selectionKind?: "fixed" | "native-router",
): ProbeTerminal {
  return ProbeTerminalSchema.parse(parseStructuredProbeTerminal({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    truncated: result.truncated,
    launchFailed: Boolean(result.spawnError),
    selectedModel,
    adapterId,
    selectionKind,
  }));
}

function probeSnippet(result: LimitedCliResult): string {
  const text = safeErrorText(
    ` exit=${result.exitCode} timeout=${result.timedOut} stdout=${result.stdout} stderr=${result.stderr}`,
  );
  return text ? ` (${text})` : "";
}

function containsForbiddenFlag(args: string[]): boolean {
  return args.some((arg) => FORBIDDEN_PROBE_FLAGS.includes(arg));
}

function classifyProbeFailure(result: LimitedCliResult): ProbeFailure {
  const combined = `${result.stdout}\n${result.stderr}\n${result.spawnError?.message ?? ""}`;
  const spawnCode = result.spawnError?.code;
  if (spawnCode === "ENOENT") {
    return {
      status: "unavailable",
      errorCode: "TOOL_NOT_FOUND",
      retryable: false,
      message: "未找到指定 CLI",
    };
  }
  if (
    spawnCode === "EACCES" ||
    spawnCode === "EPERM" ||
    isDiscoveryEnvironmentError(combined)
  ) {
    return {
      status: "environment_error",
      errorCode: "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
      retryable: false,
      message: "本机目录或权限不可用，不能判定账号未授权",
    };
  }
  if (result.timedOut) {
    return {
      status: "temporary_error",
      errorCode: "MODEL_PROBE_TIMEOUT",
      retryable: true,
      message: "模型访问探测超时",
    };
  }
  if (/401|unauthorized|not logged in|authentication required|login[_\s-]?required/i.test(combined)) {
    return {
      status: "login_required",
      errorCode: "MODEL_LOGIN_REQUIRED",
      retryable: false,
      message: "需要在原生工具中重新登录",
    };
  }
  if (/403|forbidden|not (allowed|authorized) to use/i.test(combined)) {
    return {
      status: "model_forbidden",
      errorCode: "MODEL_FORBIDDEN",
      retryable: false,
      message: "当前账号无权使用该模型",
    };
  }
  if (/model (not found|removed|unavailable)|no such model/i.test(combined)) {
    return {
      status: "unavailable",
      errorCode: "MODEL_UNAVAILABLE",
      retryable: false,
      message: "提供方已移除该模型",
    };
  }
  if (/429|too many requests|rate limit|econnrefused|enotfound|eai_again|etimedout|502|503|504|500 /i.test(combined)) {
    return {
      status: "temporary_error",
      errorCode: "MODEL_PROBE_TIMEOUT",
      retryable: true,
      message: "模型访问暂时不可用",
    };
  }
  return {
    status: "unavailable",
    errorCode: "MODEL_UNAVAILABLE",
    retryable: false,
    message: "模型访问探测未通过",
  };
}

function buildCodexProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const args = [
    "exec",
    "-c",
    'sandbox_mode="read-only"',
    "--skip-git-repo-check",
  ];
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs, "-");
  return {
    executable,
    args,
    cwd,
    env: { ...selection.effortEnv },
    stdin: ACCESS_PROBE_PROMPT,
  };
}

function buildAgyProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const args = ["--mode", "plan", "--sandbox"];
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs, "-p", ACCESS_PROBE_PROMPT);
  return {
    executable,
    args,
    cwd,
    env: { ...selection.effortEnv },
  };
}

function buildClaudeProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const mcpPath = join(cwd, "mcp.json");
  const args = [
    "--print",
    "--tools",
    "",
    "--strict-mcp-config",
    "--mcp-config",
    mcpPath,
  ];
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs);
  return {
    executable,
    args,
    cwd,
    env: { ...selection.effortEnv },
    stdin: ACCESS_PROBE_PROMPT,
  };
}

function buildCursorProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const args = ["--print", "--mode", "ask", "--trust"];
  if (process.platform !== "win32") {
    args.push("--sandbox", "enabled");
  }
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs, ACCESS_PROBE_PROMPT);
  return {
    executable,
    args,
    cwd,
    env: { ...selection.effortEnv },
  };
}

function buildGrokProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const args = [
    "--no-plan",
    "--no-subagents",
    "--disable-web-search",
    "--tools",
    "",
  ];
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs, "-p", ACCESS_PROBE_PROMPT);
  return {
    executable,
    args,
    cwd,
    env: { ...selection.effortEnv },
  };
}

function buildKimiProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const args = ["--plan"];
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs, "-p", ACCESS_PROBE_PROMPT);
  return {
    executable,
    args,
    cwd,
    env: { ...selection.effortEnv },
  };
}

function buildQoderProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const mcpPath = join(cwd, "mcp.json");
  const args = ["--print", "--tools", ""];
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs, ACCESS_PROBE_PROMPT);
  return {
    executable,
    args,
    cwd,
    env: {
      ...selection.effortEnv,
      QODER_CONFIG_DIR: cwd,
      QODER_MCP_CONFIG: mcpPath,
    },
  };
}

function buildOpenCodeProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  const args = ["run", "--format", "json", "--pure"];
  if (selection.modelToken) args.push("--model", selection.modelToken);
  args.push(...selection.effortArgs, ACCESS_PROBE_PROMPT);
  return {
    executable,
    args,
    cwd,
    env: {
      ...selection.effortEnv,
      OPENCODE_CONFIG: join(cwd, "opencode.json"),
    },
  };
}

function applyNativeProfileArgs(
  invocation: PreparedInvocation,
  profile: ToolProfile,
): PreparedInvocation {
  const name = profile.nativeConfigProfile?.trim();
  if (!name || name === "default") return invocation;
  if (profile.adapterId === "codex") {
    return {
      ...invocation,
      args: ["--profile", name, ...invocation.args],
    };
  }
  throw new FlowError("CLI_PARAMETER_UNSUPPORTED", "当前工具不支持原生 profile 选择", 422);
}

function writeProbeWorkspace(adapterId: SupportedAdapterId, cwd: string) {
  if (adapterId === "opencode") {
    writeFileSync(join(cwd, "opencode.json"), OPENCODE_PROBE_CONFIG);
  }
  if (adapterId === "qoder" || adapterId === "claude-code") {
    writeFileSync(join(cwd, "mcp.json"), EMPTY_MCP_CONFIG);
  }
}

function fallbackAccessProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
): PreparedInvocation {
  switch (selection.adapterId) {
    case "codex":
      return buildCodexProbe(selection, executable, cwd);
    case "agy":
      return buildAgyProbe(selection, executable, cwd);
    case "claude-code":
      return buildClaudeProbe(selection, executable, cwd);
    case "cursor-agent":
      return buildCursorProbe(selection, executable, cwd);
    case "grok-build":
      return buildGrokProbe(selection, executable, cwd);
    case "kimi-code":
      return buildKimiProbe(selection, executable, cwd);
    case "qoder":
      return buildQoderProbe(selection, executable, cwd);
    case "opencode":
      return buildOpenCodeProbe(selection, executable, cwd);
    default:
      throw new FlowError(
        "CLI_PARAMETER_UNSUPPORTED",
        "不支持的工具探测",
        422,
      );
  }
}

export function prepareAccessProbe(
  selection: ResolvedSelection,
  executable: string,
  cwd: string,
  adapter?: ProbeAdapter,
): PreparedInvocation {
  if (adapter?.prepareAccessProbe) {
    return adapter.prepareAccessProbe(selection, { workspaceRoot: cwd });
  }
  return fallbackAccessProbe(selection, executable, cwd);
}

function assertProbeSafe(invocation: PreparedInvocation, probeRoot: string) {
  if (containsForbiddenFlag(invocation.args)) {
    throw new FlowError(
      "CLI_PARAMETER_UNSUPPORTED",
      "探测禁止携带 --force 或 --always-approve",
      500,
    );
  }
  const cwd = resolve(invocation.cwd);
  const root = resolve(probeRoot);
  if (cwd !== root && !cwd.startsWith(root)) {
    throw new FlowError(
      "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
      "探测必须在受控空目录中运行",
      500,
    );
  }
}

function safeErrorText(text: string): string {
  return redact(text).slice(0, 500);
}

export class ModelAccessService {
  private readonly inflight = new Map<string, string>();
  private readonly live = new Map<string, LiveProbe>();
  private readonly cancelledJobs = new Set<string>();
  private closed = false;
  private readonly verifyTimeoutMs: number;
  private readonly hmacKey: Buffer;
  private readonly probeRoot: string;
  private readonly options: ModelAccessServiceOptions;

  constructor(store: Store, options: ModelAccessServiceOptions = {}) {
    this.store = store;
    this.options = options;
    this.probeRoot = options.probeRoot ?? join(dirname(store.file), "model-probe");
    this.verifyTimeoutMs = options.verifyTimeoutMs ?? VERIFY_JOB_TIMEOUT_MS;
    this.hmacKey = this.loadHmacKey();
  }

  private readonly store: Store;

  fingerprintValue(value: string): string {
    return hmacHex(this.hmacKey, value);
  }

  getAccess(accessKey: string): ModelAccessRecord | undefined {
    const raw = this.store.get<ModelAccessRecord>(ACCESS_KIND, accessKey);
    return raw ? ModelAccessRecordSchema.parse(raw) : undefined;
  }

  getVerification(jobId: string): ModelVerificationJob {
    const raw = this.store.get<unknown>(JOB_KIND, jobId);
    if (!raw) {
      throw new FlowError("NOT_FOUND", "验证作业不存在", 404);
    }
    return ModelVerificationJobSchema.parse(raw);
  }

  readiness(profile: ToolProfile): ModelAccessStatus {
    try {
      const record = this.lookupRecord(profile, this.identityFromProfile(profile));
      return record?.status ?? "unverified";
    } catch {
      return "unverified";
    }
  }

  requireVerified(profiles: ToolProfile[]): void {
    for (const profile of profiles) {
      this.assertProfileSupported(profile);
      this.assertCachedAccess(profile, this.identityFromProfile(profile));
    }
  }

  verifyAccess(input: {
    request_id: string;
    profile: unknown;
    force?: boolean;
    identity?: AccessIdentityInput;
    catalog?: ModelCatalog;
  }): { cached: boolean; job: ModelVerificationJob } {
    const started = this.beginVerify({
      request_id: input.request_id,
      profile: ToolProfileSchema.parse(input.profile),
      force: input.force,
      identity: input.identity,
      catalog: input.catalog,
    });
    if (started.statusCode === 200) {
      return {
        cached: true,
        job: this.cachedJob(input.request_id, started.record),
      };
    }
    return { cached: false, job: started.job };
  }

  async cancelVerification(
    jobId: string,
    _requestId: string,
  ): Promise<ModelVerificationJob> {
    return this.cancel(jobId);
  }

  async verify(req: VerifyAccessRequest): Promise<VerifyAccessOutcome> {
    return this.beginVerify(req);
  }

  private beginVerify(req: VerifyAccessRequest): VerifyAccessOutcome {
    const parsed = this.parseRequest(req);
    const native = this.resolveNativeConfig(parsed.profile, parsed.identity);
    const identityInput = this.identityFromNative(native, parsed.identity);
    const identity = this.fingerprintIdentity(identityInput);
    const catalog =
      req.catalog ?? this.cachedCatalogFromFingerprints(parsed.profile, identity);
    const entry = this.requireEntry(parsed.profile, catalog, identity);
    const selection = resolveModelSelection(parsed.profile, entry, selectionCapabilityFromCatalog(catalog, entry));
    const accessModelKey = resolveAccessModelKey(
      entry,
      selection.modelToken ?? entry.nativeId,
    );
    const accessKey = accessRecordId({
      adapterId: parsed.profile.adapterId,
      nativeConfigScope: identity.nativeConfigScope,
      providerEndpointFingerprint: identity.providerEndpointFingerprint,
      accountFingerprint: identity.accountFingerprint,
      accessModelKey,
    });
    if (!parsed.force) {
      const cached = this.getAccess(accessKey);
      if (cached?.status === "verified") {
        return { statusCode: 200, record: cached };
      }
    }
    const existingJobId = this.inflight.get(accessKey);
    if (existingJobId) {
      return { statusCode: 202, job: this.getVerification(existingJobId) };
    }
    return this.acceptJob(
      parsed,
      identity,
      accessKey,
      accessModelKey,
      selection,
      catalog,
    );
  }

  assertCachedAccess(
    profile: ToolProfile,
    identityInput: AccessIdentityInput,
    catalog?: ModelCatalog,
  ): ModelAccessRecord {
    const parsedProfile = ToolProfileSchema.parse(profile);
    this.assertProfileSupported(parsedProfile);
    const native = this.resolveNativeConfig(parsedProfile, identityInput);
    const identity = this.fingerprintIdentity(
      this.identityFromNative(native, identityInput),
    );
    const resolvedCatalog =
      catalog ?? this.cachedCatalogFromFingerprints(parsedProfile, identity);
    const accessModelKey = this.resolvePublishAccessModelKey(
      parsedProfile,
      resolvedCatalog,
    );
    const accessKey = accessRecordId({
      adapterId: parsedProfile.adapterId,
      nativeConfigScope: identity.nativeConfigScope,
      providerEndpointFingerprint: identity.providerEndpointFingerprint,
      accountFingerprint: identity.accountFingerprint,
      accessModelKey,
    });
    return this.requireVerifiedRecord(accessKey);
  }

  identityFromProfile(profile: ToolProfile): AccessIdentityInput {
    return resolveModelIdentityInput(this.store, profile);
  }

  assertFrozenAccess(profile: ToolProfile, frozen: FrozenInvocation): ModelAccessRecord {
    this.assertProfileSupported(profile);
    const native = this.resolveNativeConfig(profile);
    if (frozen.adapterId !== profile.adapterId ||
        frozen.accountScope !== native.accountFingerprint ||
        frozen.providerScope !== native.providerEndpointFingerprint) {
      throw new FlowError("MODEL_IDENTITY_CHANGED", "冻结模型对应的账号身份已变化", 409);
    }
    return this.requireVerifiedRecord(accessRecordId({
      adapterId: frozen.adapterId,
      nativeConfigScope: native.nativeConfigScope,
      accountFingerprint: frozen.accountScope,
      providerEndpointFingerprint: frozen.providerScope,
      accessModelKey: frozen.accessModelKey,
    }));
  }

  assertProfileSupported(profile: ToolProfile): void {
    if (profile.providerConfigRef || profile.toolsetRef) {
      throw new FlowError(
        "CLI_PARAMETER_UNSUPPORTED",
        "当前工具不支持 providerConfigRef/toolsetRef 注入，请在原生客户端配置",
        422,
      );
    }
    this.assertNativeProfileAllowed(profile);
  }

  assertNativeProfileAllowed(profile: ToolProfile): void {
    const requested = profile.nativeConfigProfile?.trim();
    if (!requested || requested === "default") return;
    if (nativeProfileSupported(profile.adapterId)) return;
    throw new FlowError(
      "CLI_PARAMETER_UNSUPPORTED",
      "当前工具不支持原生 profile 选择",
      422,
    );
  }

  resolveNativeConfig(
    profile: ToolProfile,
    identityInput?: AccessIdentityInput,
  ): NativeResolvedConfig {
    return resolveModelIdentity(this.store, profile, identityInput);
  }

  seedVerified(
    profile: ToolProfile,
    identityInput?: AccessIdentityInput,
    catalog?: ModelCatalog,
  ): ModelAccessRecord {
    const parsedProfile = ToolProfileSchema.parse(profile);
    this.assertProfileSupported(parsedProfile);
    const identity = this.fingerprintIdentity(this.identityFromNative(
      this.resolveNativeConfig(parsedProfile, identityInput),
      identityInput ?? this.identityFromProfile(parsedProfile),
    ));
    const resolvedCatalog =
      catalog ?? this.cachedCatalogFromFingerprints(parsedProfile, identity);
    const accessModelKey = this.resolvePublishAccessModelKey(
      parsedProfile,
      resolvedCatalog,
    );
    const accessKey = accessRecordId({
      adapterId: parsedProfile.adapterId,
      nativeConfigScope: identity.nativeConfigScope,
      providerEndpointFingerprint: identity.providerEndpointFingerprint,
      accountFingerprint: identity.accountFingerprint,
      accessModelKey,
    });
    const checked = now();
    const record = ModelAccessRecordSchema.parse({
      key: accessKey,
      status: "verified",
      checked_at: checked,
      adapterId: parsedProfile.adapterId,
      cliFingerprint: objectHash({
        path: resolveModelExecutable(parsedProfile),
        version: resolvedCatalog?.cliVersion ?? "",
      }),
      accountScope: identity.accountFingerprint,
      providerScope: identity.providerEndpointFingerprint,
      accessModelKey,
      verification_method: "native-probe",
      last_success_at: checked,
      identityConfidence: identity.identityConfidence,
    });
    this.putAccess(record);
    return record;
  }

  async cancel(jobId: string): Promise<ModelVerificationJob> {
    const job = this.getVerification(jobId);
    if (this.isTerminal(job.status)) return job;
    this.cancelledJobs.add(jobId);
    const live = this.live.get(jobId);
    if (live) {
      await live.handle.cancel();
      this.live.delete(jobId);
      if (this.inflight.get(live.accessKey) === jobId) {
        this.inflight.delete(live.accessKey);
      }
    }
    if (this.inflight.get(job.access_key) === jobId) this.inflight.delete(job.access_key);
    const cancelled = ModelVerificationJobSchema.parse({
      ...job,
      status: "cancelled",
      completed_at: now(),
      error_code: "CANCELLED",
      error_message: "验证已取消",
      retryable: true,
    });
    this.store.put(JOB_KIND, jobId, job.access_key, cancelled);
    const record = this.getAccess(job.access_key);
    if (record && record.status === "checking") {
      this.putAccess({
        ...record,
        status: record.last_success_at ? "verified" : "unverified",
        checked_at: now(),
      });
    }
    return cancelled;
  }

  async close(): Promise<void> {
    const jobs = [...new Set([...this.live.keys(), ...this.inflight.values()])];
    for (const jobId of jobs) {
      await this.cancel(jobId);
    }
    this.closed = true;
  }

  private requireVerifiedRecord(accessKey: string): ModelAccessRecord {
    const record = this.getAccess(accessKey);
    if (record?.status === "verified") return record;
    if (record?.status === "login_required") {
      throw new FlowError("MODEL_LOGIN_REQUIRED", "需要在原生工具中重新登录", 422);
    }
    if (record?.status === "model_forbidden") {
      throw new FlowError("MODEL_FORBIDDEN", "当前账号无权使用该模型", 422);
    }
    if (record?.status === "unavailable") {
      throw new FlowError("MODEL_UNAVAILABLE", "该模型当前不可用", 422);
    }
    if (record?.status === "environment_error") {
      throw new FlowError(
        "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
        "本机环境无法完成模型访问验证",
        503,
      );
    }
    throw new FlowError(
      "MODEL_ACCESS_REQUIRED",
      "保存前需要完成模型访问验证",
      422,
    );
  }

  private parseRequest(req: VerifyAccessRequest) {
    const profile = ToolProfileSchema.parse(req.profile);
    this.assertProfileSupported(profile);
    return {
      request_id: z.string().uuid().parse(req.request_id),
      profile,
      force: req.force === true,
      identity: req.identity ?? this.identityFromProfile(profile),
    };
  }

  private identityFromNative(
    native: NativeResolvedConfig,
    identityInput: AccessIdentityInput,
  ): AccessIdentityInput {
    return {
      nativeConfigScope: native.nativeConfigScope,
      accountId: native.accountId ?? identityInput.accountId,
      credentialSecret: native.accountId ? undefined : identityInput.credentialSecret,
      providerEndpoint: native.providerEndpoint ?? identityInput.providerEndpoint,
      accountFingerprint:
        native.accountFingerprint ?? identityInput.accountFingerprint,
      providerEndpointFingerprint:
        native.providerEndpointFingerprint ?? identityInput.providerEndpointFingerprint,
      identityConfidence: native.identityConfidence,
      displayLabel: identityInput.displayLabel ?? native.displayLabel,
    };
  }

  private resolvePublishAccessModelKey(
    profile: ToolProfile,
    catalog: ModelCatalog | undefined,
  ): string {
    if (profile.modelSelection !== "explicit" || !profile.modelId?.trim()) {
      return "native-config";
    }
    const entry = findCatalogEntry(catalog, profile);
    if (entry) {
      const selection = resolveModelSelection(profile, entry, selectionCapabilityFromCatalog(catalog, entry));
      return resolveAccessModelKey(
        entry,
        selection.modelToken ?? entry.nativeId,
      );
    }
    return profile.modelId.trim();
  }

  private lookupRecord(
    profile: ToolProfile,
    identityInput: AccessIdentityInput,
  ): ModelAccessRecord | undefined {
    const identity = this.fingerprintIdentity(identityInput);
    const catalog = this.cachedCatalogFromFingerprints(profile, identity);
    const accessKey = accessRecordId({
      adapterId: profile.adapterId,
      nativeConfigScope: identity.nativeConfigScope,
      providerEndpointFingerprint: identity.providerEndpointFingerprint,
      accountFingerprint: identity.accountFingerprint,
      accessModelKey: this.resolvePublishAccessModelKey(profile, catalog),
    });
    return this.getAccess(accessKey);
  }

  private cachedJob(
    requestId: string,
    record: ModelAccessRecord,
  ): ModelVerificationJob {
    return ModelVerificationJobSchema.parse({
      id: id("verif"),
      request_id: requestId,
      access_key: record.key,
      status: "verified",
      started_at: record.checked_at,
      deadline_at: record.checked_at,
      completed_at: record.checked_at,
      retryable: false,
    });
  }

  private cachedCatalog(
    profile: ToolProfile,
    identity: AccessIdentityInput,
  ): ModelCatalog | undefined {
    return this.cachedCatalogFromFingerprints(
      profile,
      this.fingerprintIdentity(identity),
    );
  }

  private cachedCatalogFromFingerprints(
    profile: ToolProfile,
    identity: FingerprintedIdentity,
  ): ModelCatalog | undefined {
    if (!this.options.catalog) return undefined;
    const scope: CatalogScopeInput = {
      adapterId: profile.adapterId,
      executablePath: resolveModelExecutable(profile),
      nativeConfigProfile: profile.nativeConfigProfile,
      nativeConfigScope: identity.nativeConfigScope,
      accountFingerprint: identity.accountFingerprint,
      providerFingerprint: identity.providerEndpointFingerprint,
    };
    return this.options.catalog.readCached(scope);
  }

  private requireEntry(
    profile: ToolProfile,
    catalog: ModelCatalog | undefined,
    identity?: FingerprintedIdentity,
  ): ModelEntry {
    const nativeId = profile.modelId?.trim();
    if (profile.modelSelection === "explicit" && !nativeId) {
      throw new FlowError("MODEL_NOT_LISTED", "显式选择模型时必须填写 modelId", 422);
    }
    const listed = findCatalogEntry(catalog, profile);
    if (listed) return listed;
    const manual = this.manualCandidate(profile, identity);
    if (manual) return manual;
    throw new FlowError("MODEL_NOT_LISTED", "所选模型不在当前目录中", 422);
  }

  private manualCandidate(
    profile: ToolProfile,
    identity?: FingerprintedIdentity,
  ): ModelEntry | undefined {
    const catalog = this.options.catalog;
    const nativeId = profile.modelId?.trim();
    if (!catalog || !nativeId) return undefined;
    const resolved =
      identity ??
      this.fingerprintIdentity(this.identityFromProfile(profile));
    const scope: CatalogScopeInput = {
      adapterId: profile.adapterId,
      executablePath: resolveModelExecutable(profile),
      nativeConfigProfile: profile.nativeConfigProfile,
      nativeConfigScope: resolved.nativeConfigScope,
      accountFingerprint: resolved.accountFingerprint,
      providerFingerprint: resolved.providerEndpointFingerprint,
    };
    return catalog.ensureManualCandidate(scope, nativeId);
  }

  private fingerprintIdentity(input: AccessIdentityInput): FingerprintedIdentity {
    return fingerprintModelIdentity(this.store, input);
  }

  private acceptJob(
    parsed: ReturnType<ModelAccessService["parseRequest"]>,
    identity: FingerprintedIdentity,
    accessKey: string,
    accessModelKey: string,
    selection: ResolvedSelection,
    catalog: ModelCatalog | undefined,
  ): VerifyAccessOutcome {
    const started = now();
    const job = ModelVerificationJobSchema.parse({
      id: id("verif"),
      request_id: parsed.request_id,
      access_key: accessKey,
      status: "checking",
      started_at: started,
      deadline_at: new Date(Date.parse(started) + this.verifyTimeoutMs).toISOString(),
      retryable: false,
    });
    this.store.put(JOB_KIND, job.id, accessKey, job);
    this.putAccess(
      this.checkingRecord(
        accessKey,
        parsed.profile,
        identity,
        accessModelKey,
        catalog,
      ),
    );
    this.inflight.set(accessKey, job.id);
    const managed = parsed.profile.adapterId === "agy" ? readManagedAgyModelIdentity(this.store) : undefined;
    void this.executeProbe(job, parsed.profile, selection, managed).catch((error) => {
      this.failProbeLaunch(job, error);
    });
    return { statusCode: 202, job };
  }

  private checkingRecord(
    accessKey: string,
    profile: ToolProfile,
    identity: FingerprintedIdentity,
    accessModelKey: string,
    catalog: ModelCatalog | undefined,
  ): ModelAccessRecord {
    const previous = this.getAccess(accessKey);
    return ModelAccessRecordSchema.parse({
      key: accessKey,
      status: "checking",
      checked_at: now(),
      adapterId: profile.adapterId,
      cliFingerprint: objectHash({
        path: resolveModelExecutable(profile),
        version: catalog?.cliVersion ?? "",
      }),
      accountScope: identity.accountFingerprint,
      providerScope: identity.providerEndpointFingerprint,
      accessModelKey,
      verification_method: "native-probe",
      identityConfidence: identity.identityConfidence,
      last_success_at: previous?.last_success_at,
    });
  }

  private async executeProbe(
    job: ModelVerificationJob,
    profile: ToolProfile,
    selection: ResolvedSelection,
    managed?: ManagedAgyModelIdentity,
  ): Promise<void> {
    const cwd = join(this.probeRoot, job.id);
    mkdirSync(cwd, { recursive: true });
    writeProbeWorkspace(profile.adapterId, cwd);
    const executable = resolveModelExecutable(profile);
    if (!executable) {
      this.finishFailure(job, {
        status: "environment_error",
        errorCode: "TOOL_NOT_FOUND",
        retryable: false,
        message: "缺少 CLI 路径",
      });
      return;
    }
    try {
      const probe = async (): Promise<LimitedCliResult> => {
        if (this.closed || this.cancelledJobs.has(job.id) || this.isTerminal(this.getVerification(job.id).status)) {
          throw new FlowError("CANCELLED", "验证已取消", 409);
        }
        const remainingMs = Date.parse(job.deadline_at) - Date.now();
        if (remainingMs <= 0) throw new FlowError("MODEL_PROBE_TIMEOUT", "等待账号验证超时", 503);
        const prepared = prepareAccessProbe(
          selection,
          executable,
          cwd,
          this.options.probeAdapter,
        );
        const invocation = applyNativeProfileArgs(prepared, profile);
        assertProbeSafe(invocation, this.probeRoot);
        const handle = startLimitedCli({
          adapterId: profile.adapterId,
          executable: invocation.executable,
          args: invocation.args,
          cwd: invocation.cwd,
          env: { ...invocation.env, ...(this.options.extraEnv ?? {}) },
          stdin: invocation.stdin,
          timeoutMs: remainingMs,
          outputLimit: CATALOG_OUTPUT_LIMIT,
        });
        this.live.set(job.id, {
          jobId: job.id,
          accessKey: job.access_key,
          handle,
        });
        return handle.result;
      };
      let result: LimitedCliResult;
      if (managed) {
        if (!this.options.withManagedAccountVerification) {
          throw new FlowError("VERIFICATION_ENVIRONMENT_UNAVAILABLE", "受管 AGY 验证需要账号服务协调", 503);
        }
        result = await this.options.withManagedAccountVerification(managed, probe);
        if (this.closed || this.cancelledJobs.has(job.id)) return;
        const current = readManagedAgyModelIdentity(this.store);
        if (!current || current.realmId !== managed.realmId || current.accountId !== managed.accountId ||
            current.authEpoch !== managed.authEpoch || current.credentialRevision !== managed.credentialRevision) {
          throw new FlowError("MODEL_IDENTITY_CHANGED", "验证期间 AGY 账号身份已变化，请重新验证", 409);
        }
      } else {
        // An unmanaged probe may not outlive enabling managed ownership either.
        if (profile.adapterId === "agy" && readManagedAgyModelIdentity(this.store)) {
          throw new FlowError("MODEL_IDENTITY_CHANGED", "AGY 账号管理状态已变化，请重新验证", 409);
        }
        result = await probe();
        if (profile.adapterId === "agy" && readManagedAgyModelIdentity(this.store)) {
          throw new FlowError("MODEL_IDENTITY_CHANGED", "验证期间 AGY 账号管理状态已变化，请重新验证", 409);
        }
      }
      this.applyProbeResult(job, selection, result);
    } catch (error) {
      this.failProbeLaunch(job, error);
    } finally {
      this.live.delete(job.id);
      this.cancelledJobs.delete(job.id);
      if (this.inflight.get(job.access_key) === job.id) {
        this.inflight.delete(job.access_key);
      }
    }
  }

  private failProbeLaunch(job: ModelVerificationJob, error: unknown) {
    if (this.closed || this.cancelledJobs.has(job.id) || this.isTerminal(this.getVerification(job.id).status)) return;
    const flow = error instanceof FlowError ? error : null;
    this.finishFailure(job, {
      status: "environment_error",
      errorCode: flow?.code ?? "VERIFICATION_ENVIRONMENT_UNAVAILABLE",
      retryable: false,
      message:
        flow?.message ??
        (error instanceof Error ? error.message : "本机环境无法完成验证"),
    });
  }

  private applyProbeResult(
    job: ModelVerificationJob,
    selection: ResolvedSelection,
    result: LimitedCliResult,
  ) {
    const current = this.store.get<ModelVerificationJob>(JOB_KIND, job.id);
    if (current && this.isTerminal(current.status)) return;
    if (result.cancelled) return;
    const commonTerminal = parseProbeTerminal(result, selection.modelToken, selection.adapterId, selection.selectionKind);
    const terminal = commonTerminal.success && this.options.probeAdapter?.parseProbeTerminal
      ? this.options.probeAdapter.parseProbeTerminal(result, selection.modelToken, { adapterId: selection.adapterId, selectionKind: selection.selectionKind })
      : commonTerminal;
    if (terminal.success) {
      this.finishSuccess(job);
      return;
    }
    if (terminal.observedModelStatus === "mismatch") {
      this.finishFailure(job, {
        status: "unavailable",
        errorCode: terminal.errorCode ?? "MODEL_UNAVAILABLE",
        retryable: false,
        message: terminal.message ?? "原生回退到其他模型，不能当作选定模型成功",
      });
      return;
    }
    const classified = classifyProbeFailure(result);
    this.finishFailure(job, {
      ...classified,
      message: classified.message + probeSnippet(result),
    });
  }

  private finishSuccess(job: ModelVerificationJob) {
    const record = this.getAccess(job.access_key);
    if (!record) return;
    const checked = now();
    const next = {
      key: record.key,
      status: "verified" as const,
      checked_at: checked,
      adapterId: record.adapterId,
      cliFingerprint: record.cliFingerprint,
      accountScope: record.accountScope,
      providerScope: record.providerScope,
      accessModelKey: record.accessModelKey,
      verification_method: record.verification_method,
      last_success_at: checked,
      identityConfidence: record.identityConfidence,
    };
    this.putAccess(next);
    this.putJob({
      ...job,
      status: "verified",
      completed_at: checked,
      retryable: false,
    });
    this.store.event("global", "global", "model_access_verified", {
      key: record.key,
      adapterId: record.adapterId,
      accessModelKey: record.accessModelKey,
    });
  }

  private finishFailure(job: ModelVerificationJob, failure: ProbeFailure) {
    const record = this.getAccess(job.access_key);
    const checked = now();
    if (failure.status === "login_required" && record) {
      this.invalidate(record, "MODEL_LOGIN_REQUIRED");
    } else if (failure.status === "model_forbidden" && record) {
      this.invalidate(record, "MODEL_FORBIDDEN");
    } else if (failure.status === "temporary_error" && record?.last_success_at) {
      this.putAccess({
        ...record,
        status: "verified",
        checked_at: checked,
        error_code: failure.errorCode,
      });
    } else if (record) {
      this.putAccess({
        ...record,
        status: failure.status,
        checked_at: checked,
        error_code: failure.errorCode,
      });
    }
    const jobStatus =
      failure.status === "temporary_error" ? "temporary_error" : "failed";
    this.putJob({
      ...job,
      status: jobStatus,
      completed_at: checked,
      error_code: failure.errorCode,
      error_message: safeErrorText(failure.message),
      retryable: failure.retryable,
    });
    this.store.event("global", "global", "model_access_failed", {
      key: record?.key,
      adapterId: record?.adapterId,
      error_code: failure.errorCode,
      error_message: safeErrorText(failure.message),
    });
  }

  invalidate(
    scope: { adapterId: string; accountScope: string; providerScope: string; accessModelKey: string },
    code: "MODEL_LOGIN_REQUIRED" | "MODEL_FORBIDDEN",
  ): void {
    const checked = now();
    for (const raw of this.store.list<ModelAccessRecord>(ACCESS_KIND, scope.adapterId)) {
      const record = ModelAccessRecordSchema.parse(raw);
      if (record.adapterId !== scope.adapterId || record.accountScope !== scope.accountScope ||
          record.providerScope !== scope.providerScope) continue;
      if (code === "MODEL_FORBIDDEN" && record.accessModelKey !== scope.accessModelKey) continue;
      this.putAccess({
        ...record,
        status: code === "MODEL_LOGIN_REQUIRED" ? "login_required" : "model_forbidden",
        checked_at: checked,
        error_code: code,
      });
    }
  }

  private putAccess(record: ModelAccessRecord) {
    const stored = ModelAccessRecordSchema.parse(record);
    this.store.put(ACCESS_KIND, stored.key, stored.adapterId, stored);
  }

  private putJob(job: ModelVerificationJob) {
    this.store.put(
      JOB_KIND,
      job.id,
      job.access_key,
      ModelVerificationJobSchema.parse(job),
    );
  }

  private isTerminal(status: ModelVerificationJob["status"]): boolean {
    return (
      status === "verified" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "temporary_error"
    );
  }

  private loadHmacKey(): Buffer {
    return modelIdentityKey(this.store);
  }
}
