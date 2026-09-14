export function classifyFailure(text: string) {
  const lower = text.toLowerCase();
  if (/429|quota|rate.?limit|额度|配额/.test(lower))
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
  if (/model_auth|unauthenticated|login|登录/.test(lower))
    return {
      code: "MODEL_AUTH",
      retry: "manual",
      message: "模型登录状态需要修复。请在对应受管身份下完成登录。",
    };
  if (/enospc|disk full|磁盘/.test(lower))
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
