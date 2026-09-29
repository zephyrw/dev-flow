// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PlanApprovalDialog } from "../../apps/web/src/components/PlanApprovalDialog.js";
import { PlanReviewDialog } from "../../apps/web/src/components/PlanReviewDialog.js";
import * as modelApi from "../../apps/web/src/components/model-api.js";
import * as approvalApi from "../../apps/web/src/components/plan-approval-api.js";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  sessionStorage.clear();
  vi.spyOn(modelApi, "getExecutionSpec").mockResolvedValue({ spec: {
    revision: 3, executorProfile: { adapterId: "agy", modelId: "fixture-model", reasoningEffort: "high" },
  } } as any);
  vi.spyOn(approvalApi, "computeInstructionsHash").mockResolvedValue("instructions-hash");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const button = (text: string) => Array.from(document.querySelectorAll("button")).find(b => b.textContent === text)!;
const approvalProps = { isOpen: true, onClose: vi.fn(), workflowId: "wf-current", workflowVersion: 8,
  planRevision: 2, planHash: "internal-plan-identity", snapshotId: null, environmentRevision: 1,
  planTitle: "项目当前计划", onApprove: vi.fn(async () => {}) };

it("restores execution-instruction drafts without document revision UI while retaining approval identity", async () => {
  sessionStorage.setItem("devflow_approval_draft_wf-current", JSON.stringify({ planRevision: 1, planHash: "old", text: "保留用户执行要求" }));
  const onApprove = vi.fn(async () => {});
  await act(async () => root.render(<PlanApprovalDialog {...approvalProps} onApprove={onApprove} />));
  expect((document.querySelector("textarea") as HTMLTextAreaElement).value).toBe("保留用户执行要求");
  expect(document.body.textContent).not.toMatch(/计划版本|修订版|哈希/);
  expect(button("批准并开始执行").disabled).toBe(false);
  await act(async () => button("批准并开始执行").click());
  expect(onApprove).toHaveBeenCalledWith(expect.objectContaining({ workflowId: "wf-current", workflowVersion: 8,
    planRevision: 2, planHash: "internal-plan-identity" }), "保留用户执行要求", "instructions-hash", expect.any(String));
});

it("still blocks approval when the task concurrency version changes", async () => {
  const onApprove = vi.fn(async () => {});
  await act(async () => root.render(<PlanApprovalDialog {...approvalProps} onApprove={onApprove} />));
  await act(async () => root.render(<PlanApprovalDialog {...approvalProps} workflowVersion={9} onApprove={onApprove} />));
  expect(button("批准并开始执行").disabled).toBe(true);
  expect(document.body.textContent).toContain("任务状态已变化");
  await act(async () => button("批准并开始执行").click());
  expect(onApprove).not.toHaveBeenCalled();
});

it.each(["question", "reject"] as const)("%s hides document version labels while retaining request identity", async mode => {
  const requests: { url: string; body?: any }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    requests.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return { ok: true, json: async () => init?.method === "POST" ? { id: "q-1", status: "completed", answer: "当前计划答案" } : [] };
  }));
  const onRejected = vi.fn();
  await act(async () => root.render(<PlanReviewDialog target={{ workflow_id: "wf-current", expected_version: 8, plan_revision: 2, plan_hash: "internal-plan-identity", mode }} onClose={() => {}} onRejected={onRejected} />));
  expect(document.body.textContent).not.toMatch(/第 \d+ 版|提交新版/);
  const input = document.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, "核对当前文件");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => document.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  const submitted = requests.find(r => r.body)!;
  expect(submitted.body).toEqual({ plan_revision: 2, plan_hash: "internal-plan-identity", text: "核对当前文件", request_id: expect.any(String), ...(mode === "reject" ? { expected_version: 8 } : {}) });
  if (mode === "question") expect(requests[0]?.url).toBe("/api/workflows/wf-current/plan/questions?plan_revision=2");
  if (mode === "reject") expect(onRejected).toHaveBeenCalledOnce();
});
