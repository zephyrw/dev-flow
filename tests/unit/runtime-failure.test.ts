import { expect, it } from "vitest";
import { FlowError } from "../../packages/contracts/src/index.js";
import { runtimeFailureResolution } from "../../packages/contracts/src/runtime-failure.js";
import {
  classifyFailure,
  normalizeRuntimeFailure,
} from "../../packages/runtime/src/errors.js";
import { failureSummary } from "../../packages/presentation/src/failure.js";
import { readableLogs } from "../../packages/presentation/src/activity.js";

const versionError =
  "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.";
const interruptedStream = "The stream was interrupted. Please continue the task you were working on.";

it.each([
  interruptedStream,
  `CLI 返回错误：${JSON.stringify({ error: interruptedStream })}`,
  JSON.stringify({ message: JSON.stringify({ error: interruptedStream }) }),
])("classifies the current Codex stream interruption as retryable without losing its diagnostic: %s", diagnostic => {
  expect(classifyFailure(diagnostic)).toMatchObject({ code: "MODEL_CONNECTION_FAILED", retry: "auto" });
  const error = normalizeRuntimeFailure(new FlowError("NATIVE_RUN_FAILED", diagnostic, 422,
    { exit_code: 0, diagnostic })) as FlowError;
  expect(error.code).toBe("MODEL_CONNECTION_FAILED");
  expect(error.details).toMatchObject({ exit_code: 0, diagnostic });
  expect(classifyFailure(JSON.stringify({ error: diagnostic, denied_actions: [{ display_name: "run_command" }] })))
    .toMatchObject({ code: "NATIVE_PERMISSION_DENIED", retry: "manual" });
});

it.each(["NATIVE_PERMISSION_DENIED", "RUN_REVOKED", "DELIVERY_REJECTED", "MODEL_AUTH"])(
  "does not replace an explicit %s decision with stream recovery", code => {
    const error = normalizeRuntimeFailure(new FlowError(code, interruptedStream)) as FlowError;
    expect(error.code).toBe(code);
  },
);

it.each(["The stream was interrupted.", "业务视频 stream interrupted", "Please continue the task you were working on."])(
  "does not make a generic interrupted stream or continuation request retryable: %s", diagnostic => {
    expect(classifyFailure(diagnostic)).toMatchObject({ code: "EXECUTION_FAILED", retry: "manual" });
  },
);

it("keeps a model verification environment failure distinct from a test service failure", () => {
  const error = normalizeRuntimeFailure(new FlowError(
    "VERIFICATION_ENVIRONMENT_UNAVAILABLE", "本机环境无法完成模型访问验证", 503,
  )) as FlowError;
  expect(error.code).toBe("VERIFICATION_ENVIRONMENT_UNAVAILABLE");
  expect(error.status).toBe(503);
  expect((error.details as any).diagnostic).toBe("本机环境无法完成模型访问验证");
  const summary = failureSummary(error.code, error.message);
  expect(summary).toContain("模型访问验证环境不可用");
  expect(summary).toContain("重新验证本轮模型");
  expect(summary).not.toContain("测试服务");
});

it.each([
  "error: the connection to the agent was interrupted before the response finished: subscriber fell behind updates, stalled for 10s",
  "API error (attempt 1): INTERNAL (code 500): Internal error encountered.",
])("classifies the current AGY transport failure for automatic recovery: %s", diagnostic => {
  expect(classifyFailure(diagnostic)).toMatchObject({ code: "MODEL_CONNECTION_FAILED", retry: "auto" });
  expect(runtimeFailureResolution("NATIVE_RUN_FAILED", diagnostic)?.code).toBe("MODEL_CONNECTION_FAILED");
  const combined = `Individual quota reached. Resets in 2h27m12s. ${diagnostic}`;
  expect(classifyFailure(combined).code).toBe("MODEL_CONNECTION_FAILED");
  expect(runtimeFailureResolution("", combined)?.code).toBe("MODEL_CONNECTION_FAILED");
  expect(classifyFailure(JSON.stringify({ error: diagnostic, denied_actions: [{ display_name: "run_command" }] })).code)
    .toBe("NATIVE_PERMISSION_DENIED");
});

it.each(["业务接口返回 500", "INTERNAL (code 500)", "subscriber count: 500", "connection count: 500"])(
  "does not promote an ordinary application diagnostic to model transport failure: %s", diagnostic => {
    expect(classifyFailure(diagnostic).code).toBe("EXECUTION_FAILED");
  },
);

const agyClosedConnection =
  'API error (attempt 2): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": write tcp 198.18.0.1:60000->198.18.0.95:443: wsasend: An existing connection was forcibly closed by the remote host.';

it("routes the current AGY provider connection closure to finite automatic network retry with a visible cause", () => {
  expect(classifyFailure(agyClosedConnection)).toMatchObject({ code: "MODEL_CONNECTION_FAILED", retry: "auto" });
  const failure = normalizeRuntimeFailure(new FlowError("NATIVE_RUN_FAILED", agyClosedConnection)) as FlowError;
  expect(failure.code).toBe("MODEL_CONNECTION_FAILED");
  expect((failure.details as any).diagnostic).toBe(agyClosedConnection);
  expect((failure.details as any).resolution.title).toBe("模型服务连接失败");
  expect(failureSummary(failure.code, failure.message)).toContain("模型服务连接失败");
});

it("does not treat an ordinary application wsasend error without the model endpoint as model transport failure", () => {
  const text = "业务上传组件记录 wsasend: An existing connection was forcibly closed by the remote host.";
  expect(classifyFailure(text)).toMatchObject({ code: "EXECUTION_FAILED", retry: "manual" });
  expect(runtimeFailureResolution("", text)).toBeUndefined();
});

it("keeps denied native actions ahead of a provider connection closure", () => {
  const text = JSON.stringify({ error: agyClosedConnection, denied_actions: [{ display_name: "run_command" }] });
  const classified = classifyFailure(text);
  expect(classified).toMatchObject({ code: "NATIVE_PERMISSION_DENIED", retry: "manual" });
  const failure = normalizeRuntimeFailure(new FlowError(classified.code, text)) as FlowError;
  expect(failure.code).toBe("NATIVE_PERMISSION_DENIED");
});

it.each([
  [versionError, "CLI_VERSION_UNSUPPORTED"],
  ["error: unexpected argument '--json' found", "CLI_VERSION_UNSUPPORTED"],
  ["找不到适配器 codex 的指定可执行文件", "CLI_NOT_FOUND"],
  ["spawn /missing/cli ENOENT", "CLI_NOT_FOUND"],
  ["failed to parse config.toml", "CLI_CONFIG_INVALID"],
  ["model_not_found: model requested does not exist", "MODEL_UNAVAILABLE"],
  ["Please run agy login to continue (unauthenticated)", "MODEL_AUTH"],
  [
    JSON.stringify({
      message: JSON.stringify({ status: 401, error: "invalid credentials" }),
    }),
    "MODEL_AUTH",
  ],
  ["quota exceeded, HTTP 429", "MODEL_QUOTA"],
  ["connect ECONNREFUSED 127.0.0.1:443", "MODEL_CONNECTION_FAILED"],
  [
    JSON.stringify({
      message: JSON.stringify({ status: 503, error: "upstream unavailable" }),
    }),
    "MODEL_CONNECTION_FAILED",
  ],
  ["certificate verify failed", "MODEL_CONNECTION_FAILED"],
  [
    'API error (attempt 1): request failed: Post "https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse": local error: tls: bad record MAC',
    "MODEL_CONNECTION_FAILED",
  ],
  ["AuthRequired(AuthRequiredError)", "MCP_AUTH_REQUIRED"],
  ["ENOSPC: no space left on device", "DISK_FULL"],
  ["EACCES: permission denied", "RUNTIME_ACCESS_DENIED"],
  ["request timed out", "TIMEOUT"],
])("preserves runtime cause for %s", (text, code) => {
  const failure = normalizeRuntimeFailure(
    new FlowError("NATIVE_RUN_FAILED", text),
  ) as FlowError;
  expect(failure.code).toBe(code);
  expect((failure.details as any).diagnostic).toBe(text);
  expect((failure.details as any).resolution.steps.length).toBeGreaterThan(1);
  const summary = failureSummary(failure.code, failure.message);
  expect(summary).toContain("处理方法");
  expect(summary).not.toContain("模型修改失败");
});

it.each([
  "review login.ts",
  "read disk usage guide",
  "line 14290",
  "changed retry handling in login.ts",
])("does not classify ordinary text as an environment failure: %s", (text) => {
  expect(classifyFailure(text).code).toBe("EXECUTION_FAILED");
});

it("does not reinterpret a delivery rejection quoting an old environment error", () => {
  const error = new FlowError("DELIVERY_REJECTED", versionError);
  expect(normalizeRuntimeFailure(error)).toBe(error);
  expect(runtimeFailureResolution(error.code, error.message)).toBeUndefined();
});

it("unknown native failures request diagnosis rather than a model repair", () => {
  const error = normalizeRuntimeFailure(
    new FlowError("NATIVE_RUN_FAILED", "process exited 17"),
  ) as FlowError;
  expect(error.code).toBe("NATIVE_RUN_FAILED");
  expect(error.message).toContain("原因待确认");
  expect((error.details as any).diagnostic).toBe("process exited 17");
});

it("blocked timeline shows the concrete runtime cause and recovery steps", () => {
  const rows = readableLogs(
    [
      {
        workflow_id: "w",
        event_seq: 1,
        type: "StateChanged",
        created_at: new Date().toISOString(),
        payload: {
          from: "EXECUTING",
          to: "BLOCKED",
          blocker: { code: "CLI_VERSION_UNSUPPORTED", message: versionError },
        },
      },
    ],
    "w",
  );
  expect(rows[0]?.title).toBe("工具版本不兼容");
  expect(rows[0]?.text).toContain("--version");
  expect(rows[0]?.text).toContain("继续原任务");
});
