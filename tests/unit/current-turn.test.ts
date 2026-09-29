import { it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeAgy } from "../../packages/adapters/agy/src/session.js";
import type { ManagedProcess, ProcessStopReason } from "../../packages/process/src/manager.js";

const oldError = "Individual quota reached. Resets in 2h49m37s.";
const step = (index: number, type: string, state = "DONE", extra = {}) => ({
  event: "step_update",
  step_update: {
    conversation_id: "same-conversation",
    step_index: index,
    step_type: type,
    state,
    ...extra,
  },
});
async function observe(
  events: any[],
  response: string,
  error: string | null = oldError,
  previousErrors = [oldError],
  stderr = "",
  outcome: { denied_actions?: { display_name: string }[]; termination_reason?: ProcessStopReason } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "devflow-current-turn-"));
  const proc = new EventEmitter() as ManagedProcess;
  proc.id = "test-current-turn";
  proc.stop = async () => {};
  let done!: (value: Awaited<ManagedProcess["completion"]>) => void;
  proc.completion = new Promise((resolve) => (done = resolve));
  const observed = observeAgy(proc, {
    model: "test-model",
    conversation: "same-conversation",
    cwd: directory,
    log: join(directory, "run.jsonl"),
    previousErrors,
    onEvent: () => {},
    onDiagnostic: () => {},
  });
  for (const event of [
    {
      event: "init",
      conversation_id: "same-conversation",
      init: { model: "test-model", cwd: directory },
    },
    ...events,
    {
      event: "result",
      result: {
        conversation_id: "same-conversation",
        status: "ERROR",
        error,
        response,
        ...(outcome.denied_actions ? { denied_actions: outcome.denied_actions } : {}),
      },
    },
  ])
    proc.emit("stdout", Buffer.from(JSON.stringify(event) + "\n"));
  if (stderr) proc.emit("stderr", Buffer.from(stderr));
  done({ code: 1, ...(outcome.termination_reason ? { termination_reason: outcome.termination_reason } : {}) });
  return observed;
}
it("resumed scope failure is not replaced by a historical quota footer", async () => {
  await expect(
    observe(
      [
        step(10, "user_input"),
        step(11, "tool", "ERROR", {
          tool_info: {
            output: JSON.stringify({
              code: "SCOPE_VIOLATION",
              message: "发现范围外修改 .reports/unit.json",
            }),
          },
        }),
        step(12, "agent_response"),
      ],
      "冻结遇到 SCOPE_VIOLATION，尚未完成。",
    ),
  ).rejects.toMatchObject({
    code: "SCOPE_VIOLATION",
    message: "发现范围外修改 .reports/unit.json",
  });
});
it("a completed new turn can finish transport despite a known historical error; task evidence is still engine-gated", async () => {
  await expect(
    observe(
      [step(20, "user_input"), step(21, "agent_response")],
      "已完成本轮调用",
    ),
  ).resolves.toMatchObject({ conversation: "same-conversation" });
});
it.each([
  { events: [step(30, "user_input"), step(31, "agent_response", "ACTIVE")] },
  {
    events: [
      step(30, "user_input"),
      step(31, "agent_response"),
      step(32, "error", "DONE"),
    ],
  },
  { events: [step(31, "agent_response")] },
  {
    events: [
      step(30, "user_input"),
      step(31, "agent_response"),
      step(32, "tool"),
    ],
  },
])(
  "a fresh provider failure or missing new-turn boundary still blocks on real quota",
  async ({ events }) => {
    await expect(
      observe(events, "上一条已完成的回复", oldError),
    ).rejects.toMatchObject({
      code: "MODEL_QUOTA",
    });
  },
);
it("a completed new turn overrides a changed quota footer even when old result events have fallen outside the history window", async () => {
  await expect(
    observe(
      [step(1, "user_input"), step(2, "agent_response")],
      "reply",
      "API error (attempt 6): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 1h36m57s.",
      [],
    ),
  ).resolves.toMatchObject({ conversation: "same-conversation" });
});
it("a model response discussing quota does not itself prove a quota failure", async () => {
  await expect(
    observe(
      [step(1, "user_input"), step(2, "agent_response")],
      "这不是 quota 问题，检查未通过。",
      null,
      [],
    ),
  ).rejects.toMatchObject({ code: "EXECUTION_FAILED" });
});

const tlsError = "API error: request failed: local error: tls: bad record MAC";
it("accepts the current completed turn despite a retained TLS footer", async () => {
  await expect(
    observe(
      [step(447, "user_input"), step(454, "tool"), step(455, "agent_response")],
      '{"status":"need_user"}',
      tlsError,
      [],
    ),
  ).resolves.toMatchObject({ conversation: "same-conversation" });
});
it("does not ignore a TLS failure reported by this process on stderr", async () => {
  await expect(
    observe(
      [step(447, "user_input"), step(454, "tool"), step(455, "agent_response")],
      '{"status":"completed"}',
      tlsError,
      [],
      tlsError,
    ),
  ).rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
});
it("preserves an init-only TLS failure without a completed new turn", async () => {
  await expect(observe([], "", tlsError, [])).rejects.toMatchObject({
    code: "MODEL_CONNECTION_FAILED",
  });
});

const finishedTurn = () => [
  step(480, "user_input"),
  step(486, "tool"),
  step(487, "agent_response"),
  step(488, "tool", "ACTIVE", { tool_name: "finish", tool_info: { name: "finish" } }),
  step(488, "finish", "DONE"),
];
it("accepts a completed finish step following the response despite a retained TLS footer", async () => {
  await expect(observe(finishedTurn(), '{"status":"completed"}', tlsError, []))
    .resolves.toMatchObject({ conversation: "same-conversation" });
});
it("a completed finish step does not hide this process's stderr connection failure", async () => {
  await expect(observe(finishedTurn(), '{"status":"completed"}', tlsError, [], tlsError))
    .rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
});
it("a completed finish step does not hide a current-turn provider error_message", async () => {
  const events = finishedTurn();
  events.splice(1, 0, step(485, "error_message", "DONE", { error_info: { message: tlsError } }));
  await expect(observe(events, '{"status":"need_user"}', tlsError, []))
    .rejects.toMatchObject({ code: "MODEL_CONNECTION_FAILED" });
});
it("a completed finish step does not hide a denied permission", async () => {
  await expect(observe(finishedTurn(), '{"status":"completed"}', tlsError, [], "", {
    denied_actions: [{ display_name: "run_command" }],
  })).rejects.toMatchObject({ code: "NATIVE_PERMISSION_DENIED" });
});
it.each([
  { reason: "manual", code: "MODEL_CONNECTION_FAILED" },
  { reason: "timeout", code: "TIMEOUT" },
  { reason: "account_switch", code: "AGY_ACCOUNT_WAIT" },
] as const)("a completed finish step cannot override $reason termination", async ({ reason, code }) => {
  await expect(observe(finishedTurn(), '{"status":"completed"}', tlsError, [], "", {
    termination_reason: reason,
  })).rejects.toMatchObject({ code, ...(reason === "manual" ? { details: { termination_reason: reason } } : {}) });
});
