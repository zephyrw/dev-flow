/** User-facing causes only; raw commands and diagnostics remain in details. */
export function failureSummary(code = "", detail = "") {
  if (code === "BASELINE_CHANGED")
    return "项目代码已更新，与制定计划时不同。请查看变化后选择继续方式。";
  if (code === "NATIVE_PERMISSION_DENIED")
    return detail || "AGY 拒绝了原生工具操作，已暂停等待处理，不会自动重试。";
  if (code === "TEST_PLACEHOLDER")
    return "测试仍是恒真占位断言，执行模型需要补齐真实业务检查。";
  if (/MODEL_QUOTA/.test(code))
    return "执行模型的可用额度已用完，暂时无法继续生成代码。";
  if (/MODEL_AUTH|UNAUTHORIZED/.test(code))
    return "模型登录已失效，需要恢复登录后继续。";
  if (/DIAGNOSIS/.test(code)) return "平台的故障诊断调用失败，尚未完成排查。";
  if (code === "HEALTH_IDENTITY_MISMATCH")
    return "服务已经响应，但返回的任务标识不正确，需要模型修复后再验证。";
  if (code === "HEALTH_CHECK_FAILED")
    return "服务未在配置时间内通过健康检查，需要模型继续排查。";
  if (/SERVICE_EXITED|SERVICE_START|ENVIRONMENT/.test(code))
    return /backend|后端/i.test(detail)
      ? "后端服务启动后提前退出，还未达到可测试状态。"
      : "测试服务没有成功启动。";
  if (/BUILD|COMPIL/.test(code)) return "代码未通过编译，需要修复后再启动。";
  if (/TIMEOUT/.test(code))
    return "本轮执行达到配置时限，已保留修改和检查记录。";
  if (/AUTHORIZATION/.test(code)) return "有操作需要通过工作台确认后继续。";
  if (/REPAIR_EXHAUSTED|REPAIR_NEEDS_GUIDANCE/.test(code))
    return detail.startsWith("规划模型接手后")
      ? detail
      : "多次自动排查仍未取得进展，已保留现场。";
  return detail.length <= 160 &&
    !/\b(?:FlowError|SERVICE_|DIAGNOSIS_|devflow_|[A-Z]:\\)/.test(detail)
    ? detail || "执行遇到技术问题，尚未完成验证。"
    : "执行遇到技术问题，尚未完成验证。";
}
