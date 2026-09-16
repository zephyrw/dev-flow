import { it, expect } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeAgy } from "../../packages/adapters/agy/src/session.js";
import type { ManagedProcess } from "../../packages/process/src/manager.js";

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
) {
  const directory = mkdtempSync(join(tmpdir(), "devflow-current-turn-"));
  const proc = new EventEmitter() as ManagedProcess;
  proc.id = "test-current-turn";
  proc.stop = async () => {};
  let done!: (value: { code: number }) => void;
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
      },
    },
  ])
    proc.emit("stdout", Buffer.from(JSON.stringify(event) + "\n"));
  done({ code: 1 });
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
