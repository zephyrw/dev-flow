export interface AccountOperationView {
  created_at?: string;
  before_account_id?: string;
  target_account_id?: string;
  operation_id: string;
  revision: number;
  phase: string;
  kind?: string;
  trigger?: string;
  error?: string;
  result?: { status?: string; message?: string };
  deadline_at?: string;
  external_processes?: Array<{
    pid: number;
    executable?: string;
    path?: string;
    exe_path?: string;
  }>;
}
export const terminalOperation = (phase: string) =>
  [
    "completed",
    "failed",
    "cancelled",
    "blocked",
    "consumer_unavailable",
  ].includes(phase);
export async function agyApi<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api/agy-accounts${path}`, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) {
    const message =
      typeof data.error === "string"
        ? data.error
        : (data.error?.message ?? data.message);
    throw new Error(message ?? `请求失败 (${response.status})`);
  }
  return data as T;
}
export function requestBody(value: object) {
  return JSON.stringify({ request_id: crypto.randomUUID(), ...value });
}
export const serviceLabels: Record<string, string> = {
  stopped: "已停止",
  starting: "启动中",
  running: "运行中",
  stopping: "正在安全停止",
  blocked: "需要处理",
};
export const operationLabels: Record<string, string> = {
  pending: "等待执行",
  queued: "等待执行",
  started: "准备中",
  quiescing: "等待旧身份退出",
  capturing: "保存凭据",
  selecting: "选择账号",
  install_intent: "准备激活",
  installed_unverified: "等待核验",
  verifying: "核验身份和额度",
  committing: "提交身份",
  committed: "身份已切换",
  recovering: "恢复受管工作",
  completed: "操作完成",
  failed: "操作失败",
  cancelled: "已取消",
  cancellation_requested: "正在安全取消",
  waiting_external_exit: "等待外部 AGY 退出",
  blocked: "需要处理",
  consumer_unavailable: "请在完整服务中继续",
};

export async function setAutomationEnabled(
  enabled: boolean,
  expectedRevision?: number,
) {
  return agyApi<{ enabled: boolean; service_state: string; revision: number }>(
    "/automation",
    {
      method: "PUT",
      body: requestBody({
        enabled,
        ...(expectedRevision !== undefined
          ? { expected_revision: expectedRevision }
          : {}),
      }),
    },
  );
}
