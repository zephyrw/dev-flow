import {
  EFFORT_LABELS,
  TOOL_DISPLAY_ORDER,
  VERIFY_JOB_TIMEOUT_MS,
  type FunctionalIssueView,
  type ModelEntry,
  type RepairBatchView,
  type RepairSelection,
  type RoleOverrides,
  type SupportedAdapterId,
  type ToolProfile,
  type ToolSummary,
} from "../../../../packages/contracts/src/index.js";

export const ROLE_LABELS = {
  planner: "规划",
  executor: "执行",
  reviewer: "代码审查",
  review_fixer: "审查修复",
  functional_fixer: "人工问题修复",
} as const;

export const OVERRIDE_ROLES = [
  "reviewer",
  "review_fixer",
  "functional_fixer",
] as const;

export type OverrideRoleId = (typeof OVERRIDE_ROLES)[number];

export type ApiError = {
  code?: string;
  message: string;
  retryable?: boolean;
  status: number;
  details?: Record<string, unknown>;
};

export type AccessState = {
  status: string;
  message: string;
  verificationId?: string;
};

export type DefaultsSnapshot = {
  revision: number;
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  updatedAt?: string;
  source?: string;
  pendingDraft?: {
    plannerProfile: ToolProfile;
    executorProfile: ToolProfile;
    expected_defaults_revision: number;
  };
};

export type ExecutionSpecPayload = {
  workflow_id: string;
  workflow_version: number;
  spec_revision: number;
  source: string;
  persisted?: boolean;
  spec: {
    revision: number;
    plannerProfile: ToolProfile;
    executorProfile: ToolProfile;
    roleOverrides?: RoleOverrides;
    mode?: string;
  };
  resolved_roles?: Record<
    string,
    { profile: ToolProfile; inherited_from?: string }
  >;
  active_run: {
    run_id: string;
    role: string;
    bound_spec_revision: number;
    profile: ToolProfile;
    requested?: {
      adapterId?: string;
      modelId?: string | null;
      reasoning?: { mode: string; value?: string };
    };
    observed?: { model?: string; effort?: string } | null;
  } | null;
  pending_roles: string[];
  repair_assignments: Array<{
    id: string;
    revision: number;
    batch_id: string;
    kind: string;
    profile: ToolProfile;
    status: string;
    issue_ids?: string[];
  }>;
  can_edit: boolean;
  resume_target: {
    purpose?: string;
    stage?: string;
    label?: string;
    review_phase?: string;
    repair_batch_id?: string;
  } | null;
};

type VerificationSubscription = {
  controller: AbortController;
  promise: Promise<AccessState>;
  subscribers: number;
};
const verifyInflight = new Map<string, VerificationSubscription>();
const verificationJobs = new Map<string, { id: string; deadline?: string }>();
const verificationPosts = new Map<string, Promise<any>>();
const POLL_FAST_MS = 1000;
const POLL_SLOW_MS = 2000;
const POLL_FAST_WINDOW_MS = 5000;
const POLL_DEADLINE_MARGIN_MS = 5000;

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function cloneProfile(profile: ToolProfile): ToolProfile {
  return {
    ...profile,
    options: { ...(profile.options ?? {}) },
    reasoning: profile.reasoning ? { ...profile.reasoning } : profile.reasoning,
  };
}

export function blankProfile(
  id: string,
  adapterId: SupportedAdapterId,
): ToolProfile {
  return {
    id,
    revision: 1,
    adapterId,
    modelSelection: "explicit",
    selectionKind: "fixed",
    options: {},
  };
}

export function inheritOverrides(): RoleOverrides {
  return {
    reviewer: { mode: "inherit" },
    review_fixer: { mode: "inherit" },
    functional_fixer: { mode: "inherit" },
  };
}

export function toolLabel(adapterId: string): string {
  return (
    TOOL_DISPLAY_ORDER.find((item) => item.adapterId === adapterId)?.label ??
    adapterId
  );
}

export function effortCaption(value?: string): string {
  if (!value) return "";
  const known = EFFORT_LABELS[value as keyof typeof EFFORT_LABELS];
  return known ? `${known} · ${value}` : value;
}

export function profileSummary(
  profile?: ToolProfile | null,
  modelLabel?: string,
): string {
  if (!profile) return "未配置";
  const tool = toolLabel(profile.adapterId);
  const model =
    modelLabel ||
    profile.modelId ||
    (profile.modelSelection === "native-config"
      ? "原生命名配置"
      : "未选择模型");
  const effort =
    profile.reasoning?.mode === "explicit"
      ? effortCaption(profile.reasoning.value)
      : profile.reasoning?.mode === "native-default"
        ? "原生默认"
        : profile.reasoning?.mode === "not-applicable"
          ? "不适用"
          : "未选择强度";
  return `${tool} / ${model} / ${effort}`;
}

export function inheritSource(role: OverrideRoleId): "planner" | "executor" {
  return role === "reviewer" ? "planner" : "executor";
}

export function inheritSummary(
  role: OverrideRoleId,
  planner: ToolProfile,
  executor: ToolProfile,
): string {
  const source = inheritSource(role);
  const prefix = source === "planner" ? "跟随规划" : "跟随执行";
  return `${prefix}：${profileSummary(source === "planner" ? planner : executor)}`;
}

export function resumeContinueLabel(
  target: ExecutionSpecPayload["resume_target"],
): string {
  if (target?.label) return target.label;
  const purpose = target?.purpose ?? "";
  if (purpose === "planning" || purpose === "planner_takeover") {
    return "按新配置继续规划";
  }
  if (purpose === "quality_review" || purpose === "diagnose") {
    return "按新配置继续审查";
  }
  if (purpose === "functional_fix") return "按新配置继续修复";
  if (purpose.includes("repair") || target?.repair_batch_id) {
    return "按新配置继续修复";
  }
  return "按新配置继续开发";
}

export function purposeRoundLabel(purpose?: string, role?: string): string {
  if (role === "reviewer" || purpose === "quality_review") return "审查";
  if (
    role === "planner" ||
    purpose === "planning" ||
    purpose === "planner_takeover"
  ) {
    return "规划";
  }
  if (
    role === "review_fixer" ||
    role === "functional_fixer" ||
    purpose === "functional_fix"
  ) {
    return "修复";
  }
  return "开发";
}

export function isTerminalState(state?: string): boolean {
  return [
    "COMMITTED",
    "COMPLETED",
    "COMMIT_PARTIAL",
    "CLEANUP_PENDING",
  ].includes(state ?? "");
}

export function isRouteMissing(error: ApiError): boolean {
  return error.status === 404 || error.status === 501;
}

export async function readApiError(response: Response): Promise<ApiError> {
  const data = await response.json().catch(() => ({}));
  const body = data && typeof data === "object" ? data : {};
  const nested = body.error && typeof body.error === "object" ? body.error : {};
  const message =
    nested.message ||
    body.message ||
    nested.error ||
    `请求失败 (HTTP ${response.status})`;
  return {
    code: nested.code || body.code,
    message: String(message),
    retryable: nested.retryable ?? body.retryable,
    status: response.status,
    details: nested.details || body.details,
  };
}

async function requestJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (response.status === 204) return {};
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = await Promise.resolve({
      code: data?.error?.code || data?.code,
      message:
        data?.error?.message ||
        data?.message ||
        `请求失败 (HTTP ${response.status})`,
      retryable: data?.error?.retryable ?? data?.retryable,
      status: response.status,
      details: data?.error?.details || data?.details,
    } as ApiError);
    throw error;
  }
  return data;
}

export function asProfile(value: unknown): ToolProfile | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as ToolProfile;
  if (!record.adapterId) return undefined;
  return cloneProfile(record);
}

export async function getModelDefaults(
  signal?: AbortSignal,
): Promise<DefaultsSnapshot> {
  const data = await requestJson("/api/settings/model-defaults", { signal });
  const planner =
    asProfile(data.plannerProfile) ||
    asProfile(data.planner_profile) ||
    asProfile(data.defaults?.plannerProfile);
  const executor =
    asProfile(data.executorProfile) ||
    asProfile(data.executor_profile) ||
    asProfile(data.defaults?.executorProfile);
  if (!planner || !executor) {
    throw {
      code: "INVALID_RESPONSE",
      message: "系统默认配置缺少规划或执行模型",
      status: 500,
    } satisfies ApiError;
  }
  return {
    revision: Number(
      data.revision ?? data.defaults?.revision ?? data.defaults_revision ?? 0,
    ),
    plannerProfile: planner,
    executorProfile: executor,
    updatedAt: data.updated_at ?? data.defaults?.updated_at,
    source: data.source ?? data.defaults?.source,
    pendingDraft: data.pending_draft,
  };
}

export async function putModelDefaults(body: {
  request_id: string;
  expected_defaults_revision: number;
  planner_profile: ToolProfile;
  executor_profile: ToolProfile;
}): Promise<any> {
  return requestJson("/api/settings/model-defaults", {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function getModelTools(
  signal?: AbortSignal,
): Promise<ToolSummary[]> {
  const data = await requestJson("/api/model-tools", { signal });
  const list = Array.isArray(data) ? data : (data.tools ?? data.items ?? []);
  return Array.isArray(list) ? list : [];
}

export async function getAdapterModels(
  adapter: string,
  signal?: AbortSignal,
): Promise<{ entries: ModelEntry[]; catalog?: any; status?: string }> {
  const data = await requestJson(
    `/api/model-tools/${encodeURIComponent(adapter)}/models`,
    { signal },
  );
  const entries = data.entries ?? data.catalog?.entries ?? data.models ?? [];
  return {
    entries: Array.isArray(entries) ? entries : [],
    catalog: data.catalog ?? data,
    status: data.status ?? data.catalog?.status,
  };
}

export async function refreshAdapterModels(
  adapter: string,
  signal?: AbortSignal,
): Promise<any> {
  const operation = await requestJson(
    `/api/model-tools/${encodeURIComponent(adapter)}/models/refresh`,
    {
      method: "POST",
      body: JSON.stringify({ request_id: newRequestId() }),
      signal,
    },
  );
  return waitForModelOperation(operation, signal);
}

export async function discoverTools(
  adapterIds: string[],
  signal?: AbortSignal,
): Promise<any> {
  const operation = await requestJson("/api/model-tools/discover", {
    method: "POST",
    body: JSON.stringify({
      request_id: newRequestId(),
      adapter_ids: adapterIds,
    }),
    signal,
  });
  return waitForModelOperation(operation, signal);
}

async function waitForModelOperation(
  operation: any,
  signal?: AbortSignal,
): Promise<any> {
  let current = operation;
  const deadline = Date.now() + 180000;
  while (
    !["committed", "failed", "rejected", "retryable"].includes(current.status)
  ) {
    if (!current.id)
      throw {
        status: 500,
        code: "INVALID_RESPONSE",
        message: "目录操作响应缺少任务标识",
      } satisfies ApiError;
    if (Date.now() >= deadline)
      throw {
        status: 504,
        message: "目录仍在后台刷新，请稍后重试",
      } satisfies ApiError;
    await sleep(1000, signal);
    current = await requestJson(
      `/api/model-operations/${encodeURIComponent(current.id)}`,
      { signal },
    );
  }
  if (current.status !== "committed") {
    throw {
      status: 503,
      code: current.error_code,
      message: current.error_message ?? "工具目录刷新失败，请重试",
    } satisfies ApiError;
  }
  return current;
}

function accessKey(profile: ToolProfile): string {
  return [
    profile.adapterId,
    profile.modelId ?? "",
    profile.nativeConfigProfile ?? "",
    profile.executableRef ?? "",
    profile.providerConfigRef ?? "",
    profile.toolsetRef ?? "",
    JSON.stringify(profile.options ?? {}),
    profile.reasoning?.mode === "explicit" ? profile.reasoning.value : "",
  ].join(":");
}

function verifyCacheKey(profile: ToolProfile, force: boolean): string {
  return accessKey(profile) + (force ? ":force" : "");
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function waitWithSignal<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function jobAccessState(id: string, data: any): AccessState | null {
  const status = String(data?.status ?? data?.job?.status ?? "");
  if (status === "verified") {
    return { status: "verified", message: "已验证可访问", verificationId: id };
  }
  if (
    status === "failed" ||
    status === "cancelled" ||
    status === "temporary_error"
  ) {
    return {
      status: status === "temporary_error" ? "temporary_error" : "failed",
      message: String(data?.error_message || data?.message || "验证未通过"),
      verificationId: id,
    };
  }
  return null;
}

async function pollVerification(
  id: string,
  deadlineAt?: string,
  signal?: AbortSignal,
): Promise<AccessState> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const parsedDeadline = deadlineAt ? Date.parse(deadlineAt) : Number.NaN;
  const deadlineMs = Number.isNaN(parsedDeadline)
    ? Date.now() + VERIFY_JOB_TIMEOUT_MS + POLL_DEADLINE_MARGIN_MS
    : parsedDeadline + POLL_DEADLINE_MARGIN_MS;
  let elapsed = 0;
  let delay = POLL_FAST_MS;
  do {
    const data = await requestJson(
      `/api/model-access/verifications/${encodeURIComponent(id)}`,
      { signal },
    );
    const terminal = jobAccessState(id, data);
    if (terminal) return terminal;
    const remaining = deadlineMs - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining), signal);
    elapsed += delay;
    if (elapsed >= POLL_FAST_WINDOW_MS) delay = POLL_SLOW_MS;
  } while (Date.now() < deadlineMs);
  return {
    status: "checking",
    message: "验证仍在进行，请稍后重试",
    verificationId: id,
  };
}

async function startVerification(
  profile: ToolProfile,
  force: boolean,
  key: string,
  signal: AbortSignal,
): Promise<AccessState> {
  const previous = verificationJobs.get(key);
  if (previous) {
    const resumed = await pollVerification(
      previous.id,
      previous.deadline,
      signal,
    );
    if (resumed.status !== "checking") verificationJobs.delete(key);
    return resumed;
  }
  // Do not abort an accepted POST: retain its job ID so reopening subscribes to
  // the same server job. Only the HTTP polling belongs to panel subscribers.
  let pendingPost = verificationPosts.get(key);
  if (!pendingPost) {
    pendingPost = requestJson("/api/model-access/verify", {
      method: "POST",
      body: JSON.stringify({ request_id: newRequestId(), profile, force }),
    }).finally(() => verificationPosts.delete(key));
    verificationPosts.set(key, pendingPost);
  }
  const data = await pendingPost;
  const status =
    data.status ?? data.access?.status ?? data.verification?.status;
  const id = data.id ?? data.verification_id ?? data.verification?.id;
  if (status === "verified" || data.verified === true) {
    return {
      status: "verified",
      message: "已验证可访问",
      verificationId: id ? String(id) : undefined,
    };
  }
  if (id && (status === "checking" || status === "queued" || !status)) {
    const deadline =
      typeof data.deadline_at === "string" ? data.deadline_at : undefined;
    verificationJobs.set(key, { id: String(id), deadline });
    const result = await pollVerification(String(id), deadline, signal);
    if (result.status !== "checking") verificationJobs.delete(key);
    return result;
  }
  if (data.code || data.error?.code) {
    return {
      status: data.code || data.error.code,
      message: data.message || data.error?.message || "验证未通过",
      verificationId: id ? String(id) : undefined,
    };
  }
  return {
    status: status || "unverified",
    message: data.message || "尚未完成访问验证",
    verificationId: id ? String(id) : undefined,
  };
}

export async function verifyModelAccess(
  profile: ToolProfile,
  signal?: AbortSignal,
  force = false,
): Promise<AccessState> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const key = verifyCacheKey(profile, force);
  let shared = verifyInflight.get(key);
  if (!shared || shared.controller.signal.aborted) {
    const controller = new AbortController();
    const entry: VerificationSubscription = {
      controller,
      subscribers: 0,
      promise: Promise.resolve({ status: "checking", message: "正在验证" }),
    };
    entry.promise = startVerification(
      profile,
      force,
      key,
      controller.signal,
    ).finally(() => {
      if (verifyInflight.get(key) === entry) verifyInflight.delete(key);
    });
    shared = entry;
    verifyInflight.set(key, shared);
  }
  shared.subscribers += 1;
  try {
    return await waitWithSignal(shared.promise, signal);
  } finally {
    shared.subscribers -= 1;
    if (shared.subscribers === 0) shared.controller.abort();
  }
}

export function isVerifyAbort(error: unknown): boolean {
  return isAbortError(error);
}

export async function getExecutionSpec(
  workflowId: string,
  signal?: AbortSignal,
): Promise<ExecutionSpecPayload> {
  return requestJson(
    `/api/workflows/${encodeURIComponent(workflowId)}/execution-spec`,
    { signal },
  );
}

export async function postExecutionSpec(
  workflowId: string,
  body: {
    request_id: string;
    expected_spec_revision: number;
    planner_profile: ToolProfile;
    executor_profile: ToolProfile;
    role_overrides: RoleOverrides;
  },
): Promise<any> {
  return requestJson(
    `/api/workflows/${encodeURIComponent(workflowId)}/execution-spec`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function postModelSwitch(
  workflowId: string,
  body: {
    request_id: string;
    expected_spec_revision: number;
    expected_workflow_version: number;
    expected_run_id: string | null;
    planner_profile: ToolProfile;
    executor_profile: ToolProfile;
    role_overrides: RoleOverrides;
  },
): Promise<any> {
  return requestJson(
    `/api/workflows/${encodeURIComponent(workflowId)}/model-switch`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function postRepairAssignment(
  workflowId: string,
  body: {
    request_id: string;
    batch_id: string;
    expected_assignment_revision: number;
    expected_spec_revision: number;
    selection: RepairSelection;
    remember_for_task?: boolean;
  },
): Promise<any> {
  return requestJson(
    `/api/workflows/${encodeURIComponent(workflowId)}/repair-model-assignment`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

export async function confirmFunctionalIssue(
  workflowId: string,
  issueId: string,
  body: {
    request_id: string;
    expected_version: number;
    delivery_revision_id?: string;
    passed: boolean;
    feedback?: string;
    repair_model?: RepairSelection;
    remember_for_task?: boolean;
    batch_id?: string;
    expected_assignment_revision?: number;
    expected_spec_revision?: number;
  },
): Promise<any> {
  return requestJson(
    `/api/workflows/${encodeURIComponent(workflowId)}/functional-issues/${encodeURIComponent(issueId)}/confirm`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
  );
}

function asViewList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const record = data as { items?: unknown; views?: unknown };
    if (Array.isArray(record.items)) return record.items as T[];
    if (Array.isArray(record.views)) return record.views as T[];
  }
  return [];
}

export async function getFunctionalIssueViews(
  workflowId: string,
  signal?: AbortSignal,
): Promise<FunctionalIssueView[]> {
  const data = await requestJson(
    `/api/workflows/${encodeURIComponent(workflowId)}/functional-issue-views`,
    { signal },
  );
  return asViewList<FunctionalIssueView>(data);
}

export async function getRepairBatches(
  workflowId: string,
  signal?: AbortSignal,
): Promise<RepairBatchView[]> {
  const data = await requestJson(
    `/api/workflows/${encodeURIComponent(workflowId)}/repair-batches`,
    { signal },
  );
  return asViewList<RepairBatchView>(data);
}

export function profileFromRepairSelection(
  selection: RepairSelection,
  planner?: ToolProfile,
  executor?: ToolProfile,
): ToolProfile | undefined {
  if (selection.mode === "custom") return selection.profile;
  if (selection.mode === "planner") return planner;
  if (selection.mode === "executor") return executor;
  return undefined;
}

export function formatApiError(error: unknown): string {
  if (!error) return "请求失败";
  if (typeof error === "string") return error;
  const api = error as ApiError;
  if (api.message) {
    if (api.code && api.code !== "INVALID_RESPONSE") {
      return `${api.message}（${api.code}）`;
    }
    return api.message;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function accessStatusLabel(state?: AccessState | null): string {
  if (!state) return "未验证";
  switch (state.status) {
    case "verified":
      return "已验证可访问";
    case "checking":
    case "queued":
      return "正在验证访问";
    case "login_required":
    case "MODEL_LOGIN_REQUIRED":
      return "需要登录该工具";
    case "model_forbidden":
    case "MODEL_FORBIDDEN":
      return "当前账号不能使用该模型";
    case "unavailable":
    case "MODEL_UNAVAILABLE":
      return "模型当前不可用";
    case "environment_error":
    case "VERIFICATION_ENVIRONMENT_UNAVAILABLE":
      return "本机环境无法完成验证";
    case "temporary_error":
      return "验证暂时失败，可重试";
    default:
      return state.message || "未验证";
  }
}
