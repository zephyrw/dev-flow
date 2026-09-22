import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, redact } from "../../../core/src/util.js";
import { AgyProtocol, JsonLines } from "./protocol.js";
import type { ManagedProcess } from "../../../process/src/manager.js";
import { requireCondition, FlowError } from "../../../contracts/src/index.js";
import { classifyFailure } from "../../../runtime/src/errors.js";
import { CurrentTurn } from "./current-turn.js";
import { BufferedEventSink } from "../../../core/src/buffered-sink.js";
export function writeAgyConfiguration(
  directory: string,
  node: string,
  bridge: string,
  hook: string,
  scopedHookAliases: string[] = [],
) {
  mkdirSync(join(directory, ".agents"), { recursive: true });
  atomicWrite(
    join(directory, ".agents", "mcp_config.json"),
    JSON.stringify(
      { mcpServers: { devflow_worker: { command: node, args: [bridge] } } },
      null,
      2,
    ),
  );
  // AGY invokes hooks through cmd.exe on Windows; embedded quoted executable
  // paths are escaped by that adapter. A fixed encoded PowerShell program has
  // no cmd metacharacters and preserves the JSON stdin unchanged.
  const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const script = `$ProgressPreference='SilentlyContinue'; $OutputEncoding=[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::In.ReadToEnd() | & ${quote(node)} ${quote(hook)}; exit $LASTEXITCODE`;
  const command =
    process.platform === "win32"
      ? `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`
      : `${JSON.stringify(node)} ${JSON.stringify(hook)}`;
  const policy = {
    enabled: true,
    PreToolUse: [
      { matcher: "*", hooks: [{ type: "command", command, timeout: 30 }] },
    ],
  };
  atomicWrite(
    join(directory, ".agents", "hooks.json"),
    JSON.stringify(
      Object.fromEntries(
        ["devflow-policy", ...scopedHookAliases].map((name) => [name, policy]),
      ),
      null,
      2,
    ),
  );
}
export function agyRunLogFile(directory: string, runId: string) {
  return join(directory, runId + ".agy-cli.log");
}

export function agyArguments(
  model: string,
  prompt: string,
  minutes: number,
  conversation?: string,
  project?: string,
  mode?: "accept-edits" | "plan",
  effortArgs?: string[],
  logFile?: string,
) {
  const effort = effortArgs ?? ["--effort", "high"];
  return [
    "--model",
    model,
    ...effort,
    "--output-format",
    "stream-json",
    "--print-timeout",
    `${minutes}m`,
    ...(mode ? ["--mode", mode] : []),
    "-p",
    prompt,
    ...(conversation
      ? ["--conversation", conversation]
      : project
        ? ["--project", project]
        : []),
    ...(logFile ? ["--log-file", logFile] : []),
  ];
}
export async function observeAgy(
  proc: ManagedProcess,
  options: {
    model: string;
    conversation?: string;
    cwd: string;
    log: string;
    idle_ms?: number;
    isWaiting?: () => boolean;
    previousErrors?: string[];
    onEvent: (event: Record<string, unknown>) => void;
    onDiagnostic: (text: string) => void;
  },
) {
  const protocol = new AgyProtocol(options.model, options.conversation);
  const currentTurn = new CurrentTurn();
  let failure: unknown;
  let diagnosticTail = "";
  const failedTools = new Map<number, { name: string; target?: string }>();
  let idleTimer: NodeJS.Timeout | undefined;
  const activity = () => {
    if (idleTimer) clearTimeout(idleTimer);
    if (options.idle_ms)
      idleTimer = setTimeout(() => {
        if (options.isWaiting?.()) {
          activity();
          return;
        }
        failure = new FlowError(
          "TIMEOUT",
          "AGY_IDLE_TIMEOUT: 长时间没有过程输出",
          422,
        );
        void proc.stop();
      }, options.idle_ms);
  };
  activity();
  const lines = new JsonLines((event) => {
    protocol.accept(event);
    currentTurn.accept(event);
    const step = event.step_update as any;
    if (
      event.event === "step_update" &&
      step?.step_type === "tool" &&
      step.state === "ERROR"
    ) {
      const parameters = step.tool_info?.parameters ?? {};
      failedTools.set(step.step_index, {
        name: step.tool_name ?? step.tool_info?.name ?? "unknown",
        target:
          parameters.TargetFile ?? parameters.AbsolutePath ?? parameters.path,
      });
    }
    if (event.event === "init") {
      const init = event.init as Record<string, unknown>;
      requireCondition(
        String(init.cwd).replaceAll("\\", "/").toLowerCase() ===
          options.cwd.replaceAll("\\", "/").toLowerCase(),
        "CWD_MISMATCH",
        "agy 工作目录与任务容器不一致",
      );
    }
    options.onEvent(event);
  });
  const logSink = new BufferedEventSink({
    maxBytes: 65536,
    flushIntervalMs: 500,
    onFlush: (chunk) => {
      appendFileSync(options.log, chunk);
    },
  });
  let outputDrain = Promise.resolve();
  proc.on("stdout", (b: Buffer) => {
    activity();
    try {
      proc.pauseOutput?.();
      outputDrain = outputDrain
        .then(() => logSink.writeAsync(b))
        .then(
          () => proc.resumeOutput?.(),
          (error) => {
            failure = error;
            void proc.stop();
          },
        );
      lines.push(b);
    } catch (e) {
      failure = e;
      void proc.stop();
    }
  });
  proc.on("stderr", (b: Buffer) => {
    activity();
    const text = redact(b.toString("utf8"));
    diagnosticTail = (diagnosticTail + text).slice(-16000);
    options.onDiagnostic(text);
  });
  proc.on("diagnostic", (text) => options.onDiagnostic(String(text)));
  const exit = await proc.completion.finally(() => {
    if (idleTimer) clearTimeout(idleTimer);
  });
  lines.finish();
  await outputDrain;
  await logSink.close();
  if (failure) throw failure;
  const reason = exit.termination_reason ?? proc.termination_reason;
  if (reason === "account_switch") throw new FlowError("AGY_ACCOUNT_WAIT", "账号切换暂停，等待继续原任务", 409);
  if (reason === "timeout") {
    throw new FlowError(
      "TIMEOUT",
      "本轮执行达到配置时限，现场已保留，可继续执行",
      422,
      {
        exit_code: exit.code,
        result: protocol.result,
        termination_reason: "timeout",
      },
    );
  }
  const historicalError =
    !reason &&
    !["MODEL_QUOTA", "MODEL_AUTH"].includes(
      classifyFailure(diagnosticTail).code,
    ) &&
    currentTurn.staleError(
      protocol.result,
      options.previousErrors ?? [],
      exit.code,
    );
  if (historicalError) {
    options.onDiagnostic(
      "已识别并保留历史会话错误；本轮按新的模型响应、工具结果与工作流证据判定。\n",
    );
    const currentFailure = currentTurn.reportedFailure(
      protocol.result?.response,
    );
    if (currentFailure)
      throw new FlowError(currentFailure.code, currentFailure.message, 422, {
        exit_code: exit.code,
        result: protocol.result,
        historical_error_ignored: true,
      });
  }
  if (!historicalError && !protocol.success(exit.code)) {
    const raw = redact(
      JSON.stringify({
        error: protocol.result?.error,
        denied_actions: protocol.result?.denied_actions,
      }) +
        " " +
        diagnosticTail,
    );
    const classification = classifyFailure(raw);
    const deniedActions = Array.isArray(protocol.result?.denied_actions)
      ? protocol.result.denied_actions
      : [];
    const deniedNames = new Set(
      deniedActions.map((a) =>
        String(a?.display_name ?? "")
          .replaceAll("_", "")
          .toLowerCase(),
      ),
    );
    const deniedTools = [...failedTools.values()].filter((t) =>
      deniedNames.has(t.name.replaceAll("_", "").toLowerCase()),
    );
    const deniedDetail =
      classification.code === "NATIVE_PERMISSION_DENIED"
        ? deniedTools
            .map((t) => `${t.name}${t.target ? `：${t.target}` : ""}`)
            .join("；")
        : "";
    throw new FlowError(
      classification.code,
      classification.message +
        (deniedDetail
          ? ` 被拒绝的操作：${redact(deniedDetail).slice(0, 1500)}`
          : ""),
      422,
      {
        exit_code: exit.code,
        result: protocol.result,
        ...(deniedTools.length ? { denied_tools: deniedTools } : {}),
        ...(reason ? { termination_reason: reason } : {}),
      },
    );
  }
  return {
    conversation: protocol.conversation!,
    result: protocol.result!,
    exit: exit.code,
  };
}
