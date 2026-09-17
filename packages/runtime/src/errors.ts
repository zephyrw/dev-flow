import { FlowError } from "../../contracts/src/index.js";
import { runtimeFailureResolution } from "../../contracts/src/runtime-failure.js";
import { redact } from "../../core/src/util.js";

export function normalizeRuntimeFailure(error: unknown) {
  const code = error instanceof FlowError ? error.code : "INTERNAL_FAILURE";
  const diagnostic = redact(
    error instanceof Error ? error.message : String(error),
  );
  const resolution = runtimeFailureResolution(code, diagnostic);
  if (!resolution) return error;
  return new FlowError(
    resolution.code,
    resolution.message,
    error instanceof FlowError ? error.status : 422,
    {
      ...(error instanceof FlowError &&
      error.details &&
      typeof error.details === "object"
        ? error.details
        : {}),
      diagnostic: redact(
        String(
          (error instanceof FlowError
            ? (error.details as any)?.diagnostic
            : undefined) ?? diagnostic,
        ),
      ),
      resolution,
    },
  );
}

export function classifyFailure(text: string) {
  const lower = text.toLowerCase();
  if (/policy_default_deny/.test(lower))
    return {
      code: "AUTHORIZATION_ROUTING_REQUIRED",
      retry: "manual",
      message:
        "额外操作必须通过 devflow_request_operation 提交到工作台授权；读取工具合同后继续，不使用原生工具绕过。",
    };
  if (/denied_actions.*\[\s*\{/.test(lower))
    return {
      code: "NATIVE_PERMISSION_DENIED",
      retry: "manual",
      message:
        "AGY 拒绝了原生工具操作，执行已暂停并保留现场。核对客户端权限和具体操作后继续；不会自动重试或改用其他工具绕过拒绝。",
    };
  if (
    /bad record mac|local error:\s*tls:|streamGenerateContent.*(?:request failed|bad record mac)/i.test(
      lower,
    )
  ) {
    const res = runtimeFailureResolution("MODEL_CONNECTION_FAILED", text);
    return {
      code: "MODEL_CONNECTION_FAILED",
      retry: "auto",
      message:
        res?.message ??
        "模型通信底层网络/TLS 连接异常，属于偶发网络故障，已安排自动重试。",
    };
  }
  const resolution = runtimeFailureResolution("", text);
  if (resolution) return { ...resolution, retry: "manual" };
  if (/\b429\b|\bquota\b|rate.?limit|额度不足|配额耗尽/.test(lower))
    return {
      code: "MODEL_QUOTA",
      retry: "manual",
      message:
        "模型额度不足。保留现场，等待用户恢复额度后继续；不切换模型或计费方式。",
    };
  if (/policy_run_timeout/.test(lower))
    return {
      code: "TIMEOUT",
      retry: "manual",
      message: "运行超时，保留日志和现场等待处理。",
    };
  if (/policy_run_revoked/.test(lower))
    return {
      code: "RUN_REVOKED",
      retry: "manual",
      message: "执行轮次已结束或已被撤销。",
    };
  if (/policy_unauthorized/.test(lower))
    return {
      code: "UNAUTHORIZED",
      retry: "manual",
      message: "凭证无效或未授权。",
    };
  if (/policy_check_failed|policy_http_error/.test(lower))
    return {
      code: "POLICY_FAILED",
      retry: "manual",
      message: "策略检查失败。",
    };
  if (/model_auth|unauthenticated|please .*login|登录失效/.test(lower))
    return {
      code: "MODEL_AUTH",
      retry: "manual",
      message:
        "模型登录状态需要修复。请使用当前系统用户在对应 CLI 中完成登录。",
    };
  if (/enospc|disk full|磁盘空间不足/.test(lower))
    return {
      code: "DISK_FULL",
      retry: "manual",
      message: "磁盘空间不足，当前运行已停止。",
    };
  if (/timeout|timed out|超时/.test(lower))
    return {
      code: "TIMEOUT",
      retry: "manual",
      message: "运行超时，保留日志和现场等待处理。",
    };
  return {
    code: "EXECUTION_FAILED",
    retry: "manual",
    message: "执行失败；检查本轮日志后重试。",
  };
}
