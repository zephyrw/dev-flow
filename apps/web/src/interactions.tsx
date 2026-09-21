import React, { useEffect, useState } from "react";
import { WorkflowActivity } from "./components/WorkflowActivity.js";
import { AgyRecoveryPanel } from "./components/AgyRecoveryPanel.js";
import {
  AsideHistoryDialog,
  readAsides,
  upsertAside,
} from "./components/AsideHistoryDialog.js";
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
    [isGuiding, setIsGuiding] = useState(() =>
      waitingForUserInput(detail.workflow),
    ),
    [showAsideHistory, setShowAsideHistory] = useState(false),
    [asides, setAsides] = useState<any[]>([]),
    [asideTick, setAsideTick] = useState(0),
    [interactionMode, setInteractionMode] = useState<"feedback" | "aside">(
      "feedback",
    ),
    [repair, setRepair] = useState<RepairPickerValue>(defaultRepairPicker()),
    [spec, setSpec] = useState<ExecutionSpecPayload | null>(null);

  const w = detail.workflow;
  const watchingAsides = isGuiding || showAsideHistory;
  useEffect(() => {
    if (waitingForUserInput(w)) setIsGuiding(true);
  }, [w.id, w.state, w.blocker?.code]);
  useEffect(() => {
    const open = () => setIsGuiding(true);
    window.addEventListener("devflow-open-guidance", open);
    return () => window.removeEventListener("devflow-open-guidance", open);
  }, []);
  useEffect(() => {
    if (!watchingAsides) return;
    const abort = new AbortController();
    readAsides(w.id, abort.signal)
      .then((list) => {
        if (!abort.signal.aborted) {
          setAsides(list);
          setError("");
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted)
          setError(String(e instanceof Error ? e.message : e));
      });
    return () => abort.abort();
  }, [w.id, w.version, watchingAsides, asideTick, interactionMode]);
  useEffect(() => {
    if (!watchingAsides) return;
    if (
      !showAsideHistory &&
      !asides.some((a) => ["active", "queued"].includes(a.status))
    )
      return;
    const timer = setTimeout(() => setAsideTick((t) => t + 1), 2000);
    return () => clearTimeout(timer);
  }, [watchingAsides, showAsideHistory, asides, asideTick]);
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
    return (
      <>
        <AgyRecoveryPanel workflowId={w.id} onRefresh={refresh} />
        <WorkflowActivity workflow={w} refresh={refresh} detail={detail} />
      </>
    );
  return (
    <section className="task-interaction" aria-label="指导或提问">
      <AgyRecoveryPanel workflowId={w.id} onRefresh={refresh} />
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
              指导或提问
            </button>
          </div>
        ) : (
          <GuidanceComposer
            detail={detail}
            pending={pending}
            interactionMode={interactionMode}
            setInteractionMode={setInteractionMode}
            onClose={() => setIsGuiding(false)}
            onOpenHistory={() => setShowAsideHistory(true)}
            hasAsideHistory={asides.length > 0}
            repairPicker={
              interactionMode === "feedback" &&
              w.state === "HUMAN_PENDING" &&
              detail.plan?.plan?.task_model === "native-v2" ? (
                <RepairModelPicker
                  value={repair}
                  onChange={setRepair}
                  disabled={pending}
                  plannerProfile={spec?.spec.plannerProfile}
                  executorProfile={spec?.spec.executorProfile}
                />
              ) : undefined
            }
            onSubmit={async (submittedText, submittedRefs) => {
              await act(async () => {
                if (interactionMode === "aside") {
                  const created = await send(`/workflows/${w.id}/asides`, {
                    question: submittedText,
                    refs: submittedRefs,
                  });
                  setAsides((list) => upsertAside(list, created));
                  setShowAsideHistory(true);
                  return;
                }
                const functional =
                  w.state === "HUMAN_PENDING" &&
                  detail.plan?.plan?.task_model === "native-v2";
                const body: Record<string, unknown> = {
                  request_id: crypto.randomUUID(),
                  text: submittedText,
                  refs: submittedRefs,
                  scope: "within_plan",
                  interrupt_requested: [
                    "EXECUTING",
                    "VERIFYING",
                    "QUEUED",
                  ].includes(w.state),
                };
                if (functional) {
                  body.repair_model = repair.selection;
                  body.remember_for_task = repair.rememberForTask;
                  if (
                    repair.rememberForTask ||
                    repair.selection.mode !== "task-default"
                  )
                    body.expected_spec_revision = spec?.spec_revision ?? 0;
                }
                await send(
                  `/workflows/${w.id}/${functional ? "functional-issues" : "feedback"}`,
                  body,
                );
                setIsGuiding(false);
                setRepair(defaultRepairPicker());
              }, true);
            }}
          />
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
      {showAsideHistory && asides.length > 0 && (
        <AsideHistoryDialog
          workflow={w}
          asides={asides}
          refresh={refresh}
          onClose={() => setShowAsideHistory(false)}
        />
      )}
    </section>
  );
}

function waitingForUserInput(workflow: any) {
  return (
    workflow.state === "WAITING_INPUT" &&
    ["NEED_USER", "REVIEW_NEEDS_USER"].includes(workflow.blocker?.code)
  );
}

function GuidanceComposer({
  detail,
  pending,
  interactionMode,
  setInteractionMode,
  onClose,
  onOpenHistory,
  hasAsideHistory,
  repairPicker,
  onSubmit,
}: {
  detail: any;
  pending: boolean;
  interactionMode: "feedback" | "aside";
  setInteractionMode: (mode: "feedback" | "aside") => void;
  onClose: () => void;
  onOpenHistory: () => void;
  hasAsideHistory: boolean;
  repairPicker?: React.ReactNode;
  onSubmit: (text: string, refs: ReferenceItem[]) => Promise<void>;
}) {
  const w = detail.workflow;
  return (
    <div className="guidance-form">
      <div className="guidance-form-header">
        <div
          className="guidance-mode-tabs"
          role="radiogroup"
          aria-label="输入方式"
        >
          <label className={interactionMode === "feedback" ? "active" : ""}>
            <input
              type="radio"
              name="interactionMode"
              value="feedback"
              checked={interactionMode === "feedback"}
              onChange={() => setInteractionMode("feedback")}
            />
            反馈并调整
          </label>
          <label className={interactionMode === "aside" ? "active" : ""}>
            <input
              type="radio"
              name="interactionMode"
              value="aside"
              checked={interactionMode === "aside"}
              onChange={() => setInteractionMode("aside")}
            />
            临时提问
          </label>
        </div>
        <button
          type="button"
          className="btn-composer-close"
          aria-label="关闭输入框"
          disabled={pending}
          onClick={onClose}
        >
          ×
        </button>
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
            ? "输入指导或调整内容，Enter 发送，Shift+Enter 换行。输入 @ 引用文件或目录"
            : "向模型提出只读问题，Enter 发送，Shift+Enter 换行。输入 @ 引用文件或目录"
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
        extraActions={
          interactionMode === "aside" && hasAsideHistory ? (
            <button
              type="button"
              className="btn-secondary"
              disabled={pending}
              onClick={onOpenHistory}
            >
              历史提问
            </button>
          ) : null
        }
        onSubmit={onSubmit}
      />
      {repairPicker}
    </div>
  );
}
