// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { TaskInteraction } from "../../apps/web/src/interactions.js";
import { RuntimeFailureNotice } from "../../apps/web/src/components/RuntimeFailureNotice.js";
import * as api from "../../apps/web/src/components/user-interaction-api.js";
import type { UserInteractionRecord } from "../../packages/contracts/src/user-interaction.js";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const interaction: UserInteractionRecord = {
  id: "int-permission", workflow_id: "wf-permission", source_run_id: "run-source", source_plan_revision: 1,
  purpose: "execute", role: "executor", status: "pending", created_at: "2026-09-30T00:00:00Z",
  request: { kind: "question", title: "授权本次工具操作", message: "opentabs/browser_emulate_device，标签页 123，390×844",
    question: "是否允许执行上述操作？", allow_free_text: false, action_label: "提交授权决定",
    choices: [{ id: "allow_once", label: "允许本次操作" }, { id: "deny", label: "拒绝本次操作" }] },
};
const container = document.createElement("div");
document.body.append(container);
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; vi.restoreAllMocks(); });

it("automatically opens an authorization modal without a preselected decision and sends the source-bound choice", async () => {
  vi.spyOn(api, "getCurrentUserInteraction").mockResolvedValue(interaction);
  const respond = vi.spyOn(api, "respondUserInteraction").mockResolvedValue({ success: true, interaction: { ...interaction, status: "answered" } });
  const refresh = vi.fn(async () => {});
  root = createRoot(container);
  await act(async () => root!.render(<TaskInteraction detail={{ workflow: { id: interaction.workflow_id, state: "WAITING_INPUT", project_id: "p" }, operations: [] }}
    send={vi.fn()} refresh={refresh} />));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("授权本次工具操作");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("browser_emulate_device");
  const submit = document.querySelector(".btn-interaction-submit") as HTMLButtonElement;
  expect(submit.textContent).toBe("提交授权决定");
  expect(submit.disabled).toBe(true);
  await act(async () => (document.querySelector('input[value="allow_once"]') as HTMLInputElement).click());
  expect(submit.disabled).toBe(false);
  await act(async () => submit.click());
  expect(respond).toHaveBeenCalledWith(interaction.workflow_id, interaction.id, expect.objectContaining({ source_run_id: "run-source", action: "answer", choice_id: "allow_once" }));
});

it("an older blocked task requests a popup instead of claiming the user already fixed permissions", async () => {
  const send = vi.fn(async () => ({}));
  root = createRoot(container);
  await act(async () => root!.render(<RuntimeFailureNotice detail={{ workflow: { id: interaction.workflow_id, version: 9, state: "BLOCKED", blocker: { code: "NATIVE_PERMISSION_DENIED" } } }}
    send={send} refresh={vi.fn(async () => {})} />));
  const button = container.querySelector("button")!;
  expect(button.textContent).toBe("查看并处理授权");
  await act(async () => button.click());
  expect(send).toHaveBeenCalledExactlyOnceWith(`/workflows/${interaction.workflow_id}/native-permissions/request`, { expected_version: 9 });
});
