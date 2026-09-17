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
  expect(error.message).toContain("证据不足");
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
