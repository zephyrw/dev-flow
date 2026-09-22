import {
  type SessionBindingResumeInstructions,
  SessionBindingResumeInstructionsSchema,
  type SessionBindingState,
} from "../../../contracts/src/session-binding.js";

export const INJECTED_DEVFLOW_ENV_VARS = [
  "DEVFLOW_RUN_TOKEN",
  "DEVFLOW_BASE_URL",
  "DEVFLOW_RUN_ID",
  "DEVFLOW_MCP_PORT",
  "DEVFLOW_SESSION_TOKEN",
  "DEVFLOW_TOKEN",
  "DEVFLOW_API_URL",
];

export interface GenerateResumeOptions {
  bindingId: string;
  workflowId: string;
  adapterId: string;
  conversationId: string;
  cwd: string;
  bindingRevision?: number;
  bindingState?: SessionBindingState;
  managedWriterState?: "idle" | "active" | "unknown";
  dispatchEnabled?: boolean;
  modelId?: string;
  executablePath?: string;
  safeEnv?: Record<string, string>;
  activeRunnerOccupied?: boolean;
  migrationInProgress?: boolean;
  cliLaunch?: any;
}

/**
 * Windows 命令行参数规范编码器 (MSDN / VC++ argv 解析规则)
 * 紧邻双引号前的 n 个反斜杠编码为 2n+1 个
 * 参数尾部的 n 个反斜杠编码为 2n 个
 * 整个参数外层包裹双引号
 */
export function encodeWindowsArgv(arg: string): string {
  if (arg.length === 0) return '""';
  if (/[\x00\r\n]/.test(arg)) {
    throw new Error("参数包含非法控制字符");
  }
  let encoded = '"';
  let backslashes = 0;
  for (let i = 0; i < arg.length; i++) {
    const char = arg[i];
    if (char === "\\") {
      backslashes++;
    } else if (char === '"') {
      encoded += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
    } else {
      if (backslashes > 0) {
        encoded += "\\".repeat(backslashes);
        backslashes = 0;
      }
      encoded += char;
    }
  }
  if (backslashes > 0) {
    encoded += "\\".repeat(backslashes * 2);
  }
  encoded += '"';
  return encoded;
}

/**
 * 将字符串转为 PowerShell 单引号字面量（内部单引号双写）
 */
export function toPowerShellSingleQuoted(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

/**
 * 组装符合 Windows PowerShell 安全规范的手动续接执行脚本
 * 严格使用 .NET ProcessStartInfo 启动子进程，不修改父终端 cwd/env，设置 $global:LASTEXITCODE，不退出父 shell
 */
export function buildPowerShellScript(
  executable: string,
  cwd: string,
  args: string[],
  safeEnv: Record<string, string> = {},
): string {
  const lines: string[] = [];
  const fullArguments = args.map(encodeWindowsArgv).join(" ");

  lines.push("$psi = New-Object System.Diagnostics.ProcessStartInfo");
  lines.push(`$psi.FileName = ${toPowerShellSingleQuoted(executable)}`);
  lines.push(`$psi.WorkingDirectory = ${toPowerShellSingleQuoted(cwd)}`);
  lines.push(`$psi.Arguments = ${toPowerShellSingleQuoted(fullArguments)}`);
  lines.push("$psi.UseShellExecute = $false");

  // 清除内部受管环境注入（仅在子进程环境中移除，不修改父终端环境变量）
  for (const varName of INJECTED_DEVFLOW_ENV_VARS) {
    lines.push(`[void]$psi.EnvironmentVariables.Remove(${toPowerShellSingleQuoted(varName)})`);
  }

  // 写入安全独立执行环境变量（仅在子进程环境中设置，不污染父终端）
  for (const [k, v] of Object.entries(safeEnv)) {
    if (!INJECTED_DEVFLOW_ENV_VARS.includes(k)) {
      lines.push(`$psi.EnvironmentVariables[${toPowerShellSingleQuoted(k)}] = ${toPowerShellSingleQuoted(v)}`);
    }
  }

  // 启动子进程并等待其退出，设置 $global:LASTEXITCODE，保护父 PowerShell 会话
  lines.push("$proc = [System.Diagnostics.Process]::Start($psi)");
  lines.push("$proc.WaitForExit()");
  lines.push("$global:LASTEXITCODE = $proc.ExitCode");

  return lines.join("\n");
}

/**
 * 为不同 CLI 工具生成真实工作目录下的精确手动续接说明 (CW2-D07 / CW3-F22 / CW4-F02)
 * 必须接收已核验 bound binding、ResolvedCliLaunch、当前控制/迁移/占用事实，删除默认放行猜测
 */
export function generateResumeInstructions(
  options: GenerateResumeOptions,
): SessionBindingResumeInstructions {
  const {
    bindingId,
    workflowId,
    adapterId,
    conversationId,
    cwd,
    bindingRevision = 1,
    bindingState,
    managedWriterState = "unknown",
    dispatchEnabled = false,
    modelId,
    executablePath,
    safeEnv = {},
    migrationInProgress = false,
    cliLaunch,
  } = options;

  let executable: string | undefined = executablePath || cliLaunch?.executablePath;
  let args: string[] = [];
  let status: "supported" | "unsupported" | "identity_unverified" = "supported";
  let reason: string | undefined;

  // 前缀参数优先（如 node 启动脚本所需的 js 文件等）
  if (cliLaunch?.prefixArgs && cliLaunch.prefixArgs.length > 0) {
    args.push(...cliLaunch.prefixArgs);
  }

  switch (adapterId) {
    case "agy": {
      args.push("--conversation", conversationId);
      if (modelId) {
        args.push("--model", modelId);
      }
      break;
    }
    case "codex": {
      args.push("resume", conversationId);
      if (modelId) {
        args.push("-m", modelId);
      }
      break;
    }
    case "claude-code":
    case "kimi-code":
    case "cursor-agent":
    case "qoder":
    case "opencode": {
      status = "unsupported";
      reason = `适配器 ${adapterId} 暂不支持手动 CLI 续接命令导出`;
      break;
    }
    default: {
      status = "unsupported";
      reason = `未知或不受支持的适配器: ${adapterId}`;
      break;
    }
  }

  // 手动启动安全门禁逐层核验 (CW3-F22 / CW4-F02)
  let copyScript: string | undefined;
  if (migrationInProgress) {
    status = "unsupported";
    reason = "任务工作区资产迁移尚未完成或正在进行中，禁止手动续接";
  } else if (bindingState === "retired" || bindingState === "unavailable") {
    status = "unsupported";
    reason = `当前会话绑定处于 ${bindingState} 状态，禁止手动续接`;
  } else if (status === "unsupported") {
    // 工具不受支持，保留对应 reason
  } else if (dispatchEnabled) {
    reason = "工作流自动调度当前处于开启状态。必须先停用自动调度方可执行手动续接。";
  } else if (managedWriterState !== "idle") {
    reason = `当前存在受管调用写者 (状态: ${managedWriterState})。必须确认受管调用已退出方可执行手动续接。`;
  } else if (!cwd) {
    status = "unsupported";
    reason = "工作区工作目录未指定，禁止手动续接";
  } else if (!executable) {
    // CW4-F02: 入口信息缺失时明确不给出可执行脚本，删除 PATH 猜测默认值
    status = "unsupported";
    reason = "未找到可用的原 CLI 启动入口，禁止手动续接";
  } else {
    // 全部门禁通过且存在有效 CLI 入口，生成安全 PowerShell 脚本
    copyScript = buildPowerShellScript(executable, cwd, args, safeEnv);
  }

  return SessionBindingResumeInstructionsSchema.parse({
    workflow_id: workflowId,
    binding_id: bindingId,
    binding_revision: bindingRevision,
    conversation_id: conversationId,
    cwd,
    target_shell: "powershell-windows",
    status,
    reason,
    executable,
    args,
    safe_env: safeEnv,
    copy_script: copyScript,
    managed_writer_state: managedWriterState,
    dispatch_enabled: dispatchEnabled,
    observed_at: new Date().toISOString(),
  });
}
