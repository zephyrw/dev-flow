import React, { useEffect, useState } from "react";
import { WorkflowActivity } from "./components/WorkflowActivity.js";
import {
  RequirementComposer,
  type ReferenceItem,
} from "./components/RequirementComposer.js";
import {
  RepairModelPicker,
  defaultRepairPicker,
  type RepairPickerValue,
} from "./components/RepairModelPicker.js";
import {
  getExecutionSpec,
  type ExecutionSpecPayload,
} from "./components/model-api.js";

export function TaskInteraction({
  detail,
  send,
  refresh,
}: {
  detail: any;
  send: (path: string, body: unknown) => Promise<any>;
  refresh: () => Promise<void>;
}) {
  const [text, setText] = useState(""),
    [pending, setPending] = useState(false),
    [error, setError] = useState(""),
    [isGuiding, setIsGuiding] = useState(false),
    [interactionMode, setInteractionMode] = useState<"feedback" | "aside">(
      "feedback",
    ),
    [repair, setRepair] = useState<RepairPickerValue>(defaultRepairPicker()),
    [spec, setSpec] = useState<ExecutionSpecPayload | null>(null);

  const w = detail.workflow;
  const requests = (detail.operations ?? []).filter(
    (r: any) => r.status === "pending",
  );
  useEffect(() => {
    if (!isGuiding || interactionMode !== "feedback") return;
    const controller = new AbortController();
    getExecutionSpec(w.id, controller.signal)
      .then(setSpec)
      .catch(() => setSpec(null));
    return () => controller.abort();
  }, [isGuiding, interactionMode, w.id]);
  const act = async (fn: () => Promise<any>, propagateError = false) => {
    setPending(true);
    setError("");
    try {
      await fn();
      setText("");
      await refresh();
      window.dispatchEvent(new Event("devflow-activity"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      if (propagateError) throw e;
    } finally {
      setPending(false);
    }
  };
  const canGuide = [
    "PLANNING",
    "PLAN_PENDING",
    "REPAIR_PLAN_PENDING",
    "REVIEWING",
    "EXECUTING",
    "VERIFYING",
    "QUEUED",
    "HUMAN_PENDING",
    "BLOCKED",
    "STOPPED",
    "RECOVERY_REQUIRED",
    "WAITING_INPUT",
    "WAITING_AUTHORIZATION",
  ].includes(w.state);
  if (!requests.length && !canGuide)
    return <WorkflowActivity workflow={w} refresh={refresh} detail={detail} />;
  return (
    <section className="task-interaction" aria-label="指导执行模型">
      {w.state === "BLOCKED" &&
        w.blocker?.code === "MODEL_QUOTA" &&
        detail.attention?.category === "queue" && (
          <button
            disabled={pending}
            onClick={() => void act(() => send(`/workflows/${w.id}/stop`, {}))}
          >
            暂停自动继续
          </button>
        )}
      {!requests.length &&
        ["BLOCKED", "WAITING_INPUT"].includes(w.state) &&
        [
          "DIAGNOSIS_FAILED",
          "REPAIR_EXHAUSTED",
          "REPAIR_NEEDS_GUIDANCE",
        ].includes(w.blocker?.code) && (
          <button
            disabled={pending}
            onClick={() =>
              void act(() =>
                send(`/workflows/${w.id}/feedback`, {
                  text: "继续在原批准范围内自动排查。先核对上次真实错误与修复记录，运行诊断并验证改动效果，无需用户解释技术日志。",
                  scope: "within_plan",
                }),
              )
            }
          >
            继续自动排查
          </button>
        )}
      {requests.map((r: any) => (
        <article className="authorization-card" key={r.id}>
          <h3>操作等待你的授权</h3>
          <p>{r.operation.reason}</p>
          <dl>
            <dt>工作目录</dt>
            <dd>{r.cwd}</dd>
            <dt>执行程序</dt>
            <dd>{r.operation.executable}</dd>
            <dt>完整参数</dt>
            <dd>
              <pre>{JSON.stringify(r.operation.args, null, 2)}</pre>
            </dd>
          </dl>
          <p>
            此次决定只适用于上面这一次操作。批准后续接原模型会话；拒绝后模型会收到你的意见。
          </p>
          <p>影响范围由命令及参数决定，工作目录本身不是沙箱边界。</p>
          <div className="actions">
            <button
              disabled={pending}
              onClick={() =>
                void act(() =>
                  send(`/workflows/${w.id}/operations/${r.id}/decision`, {
                    approved: true,
                    fingerprint: r.fingerprint,
                    note: text,
                  }),
                )
              }
            >
              批准本次操作并继续
            </button>
            <button
              disabled={pending}
              onClick={() =>
                void act(() =>
                  send(`/workflows/${w.id}/operations/${r.id}/decision`, {
                    approved: false,
                    fingerprint: r.fingerprint,
                    note: text,
                  }),
                )
              }
            >
              拒绝并告知模型
            </button>
          </div>
        </article>
      ))}
      {requests.length > 0 && (
        <div className="authorization-note-form">
          <label htmlFor={`guidance-${w.id}`}>授权处理意见（可选）</label>
          <textarea
            id={`guidance-${w.id}`}
            rows={2}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="可在此填写授权决定的补充说明…"
          />
        </div>
      )}
      {canGuide &&
        !requests.length &&
        (!isGuiding ? (
          <div className="guidance-trigger-wrapper">
            <button
              type="button"
              className="btn-guidance-trigger"
              onClick={() => setIsGuiding(true)}
            >
              给执行模型补充指导
            </button>
          </div>
        ) : (
          <div
            className="guidance-form"
            style={{ display: "flex", flexDirection: "column", gap: "8px" }}
          >
            <div
              style={{
                display: "flex",
                gap: "12px",
                fontSize: "12px",
                borderBottom: "1px solid var(--color-border, #d0d7de)",
                paddingBottom: "4px",
              }}
            >
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  cursor: "pointer",
                  fontWeight: interactionMode === "feedback" ? 600 : 400,
                }}
              >
                <input
                  type="radio"
                  name="interactionMode"
                  value="feedback"
                  checked={interactionMode === "feedback"}
                  onChange={() => setInteractionMode("feedback")}
                />
                反馈并调整
              </label>
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "4px",
                  cursor: "pointer",
                  fontWeight: interactionMode === "aside" ? 600 : 400,
                }}
              >
                <input
                  type="radio"
                  name="interactionMode"
                  value="aside"
                  checked={interactionMode === "aside"}
                  onChange={() => setInteractionMode("aside")}
                />
                临时提问 (/btw 只读)
              </label>
            </div>

            <RequirementComposer
              fetchReferences={async (query) => {
                const response = await fetch(
                  "/api/workspaces/references?workflow_id=" +
                    encodeURIComponent(w.id) +
                    "&query=" +
                    encodeURIComponent(query),
                );
                if (!response.ok) throw new Error("无法读取工作区引用");
                return (await response.json()).items;
              }}
              placeholder={
                interactionMode === "feedback"
                  ? "输入指导或调整内容... 输入 @ 引用文件或目录"
                  : "向模型提出只读问题 (/btw)... 输入 @ 引用文件或目录"
              }
              disabled={pending}
              submitLabel={
                interactionMode === "feedback"
                  ? pending
                    ? "正在交接…"
                    : "发送指导并继续"
                  : pending
                    ? "正在提问…"
                    : "提交提问"
              }
              onSubmit={async (submittedText, submittedRefs) => {
                await act(async () => {
                  if (interactionMode === "aside") {
                    await send(`/workflows/${w.id}/asides`, {
                      question: submittedText,
                      refs: submittedRefs,
                    });
                  } else {
                    const functional =
                      w.state === "HUMAN_PENDING" &&
                      detail.plan?.plan?.task_model === "native-v2";
                    const body: Record<string, unknown> = {
                      request_id: crypto.randomUUID(),
                      text: submittedText,
                      refs: submittedRefs,
                      scope: "within_plan",
                    };
                    if (functional) {
                      body.repair_model = repair.selection;
                      body.remember_for_task = repair.rememberForTask;
                      if (
                        repair.rememberForTask ||
                        repair.selection.mode === "planner" ||
                        repair.selection.mode === "executor" ||
                        repair.selection.mode === "custom"
                      ) {
                        body.expected_spec_revision = spec?.spec_revision ?? 0;
                      }
                    }
                    await send(
                      `/workflows/${w.id}/${functional ? "functional-issues" : "feedback"}`,
                      body,
                    );
                  }
                  setIsGuiding(false);
                  setRepair(defaultRepairPicker());
                }, true);
              }}
            />
            {interactionMode === "feedback" &&
              w.state === "HUMAN_PENDING" &&
              detail.plan?.plan?.task_model === "native-v2" && (
                <RepairModelPicker
                  value={repair}
                  onChange={setRepair}
                  disabled={pending}
                  plannerProfile={spec?.spec?.plannerProfile}
                  executorProfile={spec?.spec?.executorProfile}
                />
              )}

            <div style={{ display: "flex", justifyContent: "flex-start" }}>
              <button
                type="button"
                className="btn-secondary"
                disabled={pending}
                onClick={() => {
                  setIsGuiding(false);
                }}
                style={{ fontSize: "11px", padding: "2px 8px" }}
              >
                收起指导
              </button>
            </div>
          </div>
        ))}

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <WorkflowActivity workflow={w} refresh={refresh} detail={detail} />
      {detail.queue?.owners?.length > 0 && (
        <p>
          占用任务：
          {detail.queue.owners
            .map((id: string) => (id === w.id ? "当前任务" : id))
            .join("、")}
        </p>
      )}
    </section>
  );
}
