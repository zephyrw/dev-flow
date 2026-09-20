import { describe, expect, it } from "vitest";
import { parseStructuredProbeTerminal } from "../../packages/adapters/sdk/src/probe-terminal.js";
import { parseProbeTerminal as parseCoreTerminal } from "../../packages/core/src/model-access-service.js";
import type { ProbeTerminalInput } from "../../packages/adapters/sdk/src/interface.js";

function parse(records: unknown[], patch: Partial<ProbeTerminalInput> = {}) {
  const input = {
    stdout: records.map((record) => JSON.stringify(record)).join("\n"),
    stderr: "", exitCode: 0, selectedModel: "chosen", ...patch,
  };
  const terminal = parseStructuredProbeTerminal(input);
  expect(parseCoreTerminal({ ...input, timedOut: input.timedOut ?? false,
    cancelled: input.cancelled ?? false, truncated: input.truncated ?? false,
  }, input.selectedModel ?? null, input.adapterId)).toEqual(terminal);
  return terminal;
}

describe("访问验证的整轮终态", () => {
  it.each(["item.completed", "message.completed", "tool.completed", "completed", "complete", "stop"])(
    "%s 不能证明整轮成功", (type) => {
      expect(parse([{ type, item: { type: "agent_message", text: "OK" } }]).success).toBe(false);
    },
  );

  it.each(["result", "turn.completed", "response.completed", "agent_end"])(
    "%s 是已知整轮完成事件", (type) => {
      expect(parse([{ type, model: "chosen", result: "OK" }])).toMatchObject({ success: true, observedModelStatus: "matched" });
    },
  );

  it.each([
    { type: "error", message: "denied" },
    { type: "turn.failed" },
    { type: "result", subtype: "error_max_turns" },
    { type: "result", is_error: true },
    { type: "tool_use", part: { state: { status: "error", error: "denied" } } },
    { type: "result", response: { status: "failed", error: { code: "unauthorized" } } },
  ])("任一错误不能被后续成功覆盖：%j", (failure) => {
    expect(parse([failure, { type: "result", model: "chosen" }]).success).toBe(false);
  });

  it("init 中模型不一致不能被后面的正确模型覆盖", () => {
    expect(parse([{ type: "system", init: { model: "other" } }, { type: "result", model: "chosen" }]))
      .toMatchObject({ success: false, observedModel: "other", observedModelStatus: "mismatch" });
  });

  it("仅初始化里提供模型时仍记录 matched", () => {
    expect(parse([{ type: "system", init: { model: "chosen" } }, { type: "result" }]))
      .toMatchObject({ success: true, observedModel: "chosen", observedModelStatus: "matched" });
  });

  it("stderr 的错误也会使 stdout 的成功失败", () => {
    expect(parse([{ type: "turn.completed" }], { stderr: '{"type":"error","error":"denied"}' }).success).toBe(false);
    expect(parse([], { stdout: "OK\n", stderr: "Error: denied" }).success).toBe(false);
    expect(parse([], { stderr: '{"type":"turn.completed"}' }).success).toBe(false);
  });

  it("OpenCode 只有 stop 的 step_finish 可完成，工具步骤和截断不能", () => {
    expect(parse([{ type: "step_finish", part: { reason: "stop" } }], { adapterId: "opencode" }).success).toBe(true);
    for (const reason of ["tool-calls", "length", "unknown"]) {
      expect(parse([{ type: "step_finish", part: { reason } }], { adapterId: "opencode" }).success).toBe(false);
    }
  });

  it("OpenCode 观测基础模型与 hash 强度编码可匹配，但其他 provider 仍失败", () => {
    const patch = { adapterId: "opencode", selectedModel: "openai/chosen#high" };
    expect(parse([{ type: "result", model: { providerID: "openai", modelID: "chosen" } }], patch).success).toBe(true);
    expect(parse([{ type: "result", model: { providerID: "other", modelID: "chosen" } }], patch).observedModelStatus).toBe("mismatch");
  });

  it("plain 客户端只有正常结束、最后独立 OK 且无 JSON 流时才通过", () => {
    expect(parse([], { stdout: "OK\n", stderr: "model: chosen\n", selectedModel: "chosen" })).toMatchObject({ success: true, observedModelStatus: "matched" });
    expect(parse([], { stdout: "some log\nOK\n" }).success).toBe(true);
    expect(parse([], { stdout: "OK\nfailed to complete" }).success).toBe(false);
    expect(parse([], { stdout: '{"type":"message","text":"OK"}\nOK' }).success).toBe(false);
    expect(parse([], { stdout: '{broken\nOK' }).success).toBe(false);
    expect(parse([], { stdout: "OK\n", stderr: "using model other" }).observedModelStatus).toBe("mismatch");
    expect(parse([], { stdout: "OK\n", stderr: "falling back to other" }).success).toBe(false);
  });

  it.each([{ exitCode: null }, { exitCode: 1 }, { cancelled: true }, { truncated: true }])(
    "不完整调用不能被成功事件掩盖：%j", (patch) => {
      expect(parse([{ type: "turn.completed" }], patch).success).toBe(false);
    },
  );

  it("超时错误码保持可重试，启动失败不成功", () => {
    expect(parse([{ type: "turn.completed" }], { timedOut: true }).errorCode).toBe("MODEL_PROBE_TIMEOUT");
    expect(parseStructuredProbeTerminal({ stdout: "OK", stderr: "", exitCode: 0, launchFailed: true }).success).toBe(false);
  });
});
