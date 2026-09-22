import React, { useEffect, useState } from "react";
import { WorkflowActivity } from "./components/WorkflowActivity.js";
import { AsidePopover } from "./components/AsidePopover.js";
import { type ReferenceItem } from "./components/RequirementComposer.js";
import {
  ConversationComposer,
  type ConversationComposerSubmit,
} from "./components/ConversationComposer.js";
import {
  conversationComposerReadonlyReason,
  isConversationComposerReadonly,
  shouldRenderConversationComposer,
  showsRoundFeedbackEntry,
  useConversationDraft,
} from "./use-conversation-draft.js";
import {
  clearAsidePromoteDraft,
  peekAsidePromoteDraft,
  promoteDraftText,
  shouldHideAsidePopover,
  useProjectAsides,
  writeAsidePromoteDraft,
} from "./use-project-asides.js";
import "./components/aside-popover.css";

export function TaskInteraction({
  detail,
  send,
  refresh,
  selectedConversationId,
  rootConversationId,
  expectedGeneration,
}: {
  detail: any;
  send: (path: string, body: unknown) => Promise<any>;
  refresh: () => Promise<void>;
  selectedConversationId?: string;
  rootConversationId?: string;
  expectedGeneration?: number;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [authNote, setAuthNote] = useState("");
  const [asideOpen, setAsideOpen] = useState(false);
  const w = detail.workflow;
  const draftApi = useConversationDraft(w.id);
  const showComposer = shouldRenderConversationComposer({
    selectedConversationId,
    rootConversationId,
  });
  const hideAside = shouldHideAsidePopover({
    selectedConversationId,
    rootConversationId,
  });
  const readonly = isConversationComposerReadonly(w.state);
  const requests = (detail.operations ?? []).filter(
    (request: any) => request.status === "pending",
  );
  const asides = useProjectAsides({
    projectId: w.project_id,
    open: asideOpen && !hideAside,
    enabled: Boolean(w.project_id),
  });
  const asideSummary = asides.summary;
  const popoverVisible =
    asideOpen && !hideAside && showComposer && asideSummary;

  useEffect(() => {
    const focus = () => {
      document
        .getElementById(`conversation-composer-${w.id}`)
        ?.querySelector("textarea")
        ?.focus();
    };
    window.addEventListener("devflow-open-guidance", focus);
    return () => window.removeEventListener("devflow-open-guidance", focus);
  }, [w.id]);

  const act = async (
    fn: () => Promise<any>,
    propagateError = false,
    clearAuthNote = false,
  ) => {
    setPending(true);
    setError("");
    try {
      await fn();
      if (clearAuthNote) setAuthNote("");
      await refresh();
      window.dispatchEvent(new Event("devflow-activity"));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      if (propagateError) throw e;
    } finally {
      setPending(false);
    }
  };

  const submitComposer = async (payload: ConversationComposerSubmit) => {
    await act(async () => {
      if (payload.mode === "aside") {
        clearAsidePromoteDraft(w.id);
        const target = await resolveConversationMessageTarget(
          w.id,
          rootConversationId,
          expectedGeneration,
        );
        const created = await send(`/workflows/${w.id}/conversation-messages`, {
          request_id: payload.requestId,
          root_conversation_id: target.rootId,
          expected_generation: target.generation,
          text: payload.draftText,
          refs: payload.refs,
          attachment_ids: readyAttachmentIds(payload.attachments),
          client_mode: "aside",
        });
        asides.selectCreated(
          {
            id: created.aside_id ?? created.message_id,
            workflow_id: w.id,
            question: payload.sendText,
            status: "active",
            created_at: new Date().toISOString(),
          },
          w.title,
        );
        setAsideOpen(true);
        return;
      }
      const promote = peekAsidePromoteDraft(w.id);
      if (promote) {
        await send(
          `/workflows/${promote.workflowId}/asides/${promote.asideId}/promote`,
          {
            request_id: payload.requestId,
            text: payload.sendText,
            attachment_ids: readyAttachmentIds(payload.attachments),
          },
        );
        clearAsidePromoteDraft(w.id);
        return;
      }
      const target = await resolveConversationMessageTarget(
        w.id,
        rootConversationId,
        expectedGeneration,
      );
      await send(`/workflows/${w.id}/conversation-messages`, {
        request_id: payload.requestId,
        root_conversation_id: target.rootId,
        expected_generation: target.generation,
        text: payload.sendText,
        refs: payload.refs,
        attachment_ids: readyAttachmentIds(payload.attachments),
        client_mode: "formal",
      });
    }, true);
    draftApi.applySuccessfulSend(
      payload.draftText,
      payload.requestId,
      payload.mode === "formal",
    );
  };

  return (
    <section className="task-interaction" aria-label="会话输入">
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
      {requests.map((request: any) => (
        <AuthorizationCard
          key={request.id}
          request={request}
          pending={pending}
          onDecide={(approved) =>
            void act(
              () =>
                send(`/workflows/${w.id}/operations/${request.id}/decision`, {
                  approved,
                  fingerprint: request.fingerprint,
                  note: authNote,
                }),
              false,
              true,
            )
          }
        />
      ))}
      {requests.length > 0 && (
        <div className="authorization-note-form">
          <label htmlFor={`guidance-${w.id}`}>授权处理意见（可选）</label>
          <textarea
            id={`guidance-${w.id}`}
            rows={2}
            value={authNote}
            onChange={(event) => setAuthNote(event.target.value)}
            placeholder="可在此填写授权决定的补充说明…"
          />
        </div>
      )}
      {showComposer && (
        <div className="composer-anchor">
          {popoverVisible && asideSummary && (
            <AsidePopover
              currentWorkflowId={w.id}
              summary={asideSummary}
              detail={asides.detail}
              position={asides.position}
              error={asides.error}
              hasNew={asides.hasNew}
              busy={pending}
              onClose={() => setAsideOpen(false)}
              onPrev={asides.goPrev}
              onNext={asides.goNext}
              onCancel={() =>
                void cancelAside({
                  workflowId: asideSummary.workflow_id,
                  asideId: asideSummary.id,
                  act,
                  send,
                  reload: asides.reload,
                })
              }
              onPromote={() =>
                promoteAsideToDraft({
                  composerWorkflowId: w.id,
                  summary: asideSummary,
                  detail: asides.detail,
                  setText: draftApi.setText,
                })
              }
              onShowLatest={asides.goLatest}
            />
          )}
          {!asideOpen && !hideAside && asides.total > 0 && (
            <button
              type="button"
              className="aside-popover-entry"
              onClick={() => setAsideOpen(true)}
            >
              临时提问 {asides.total}
            </button>
          )}
          <ConversationComposer
            workflowId={w.id}
            draft={draftApi.draft}
            setText={draftApi.setText}
            setRefs={draftApi.setRefs}
            pending={pending}
            readonly={readonly}
            readonlyReason={conversationComposerReadonlyReason(w.state)}
            showRoundFeedback={showsRoundFeedbackEntry(w.state)}
            fetchReferences={(query) => fetchWorkflowReferences(w.id, query)}
            onSubmit={submitComposer}
            formalBlockedReason={
              requests.length > 0
                ? "先批准或拒绝待授权操作；可在授权卡片填写意见"
                : undefined
            }
          />
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <WorkflowActivity workflow={w} refresh={refresh} />
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

function readyAttachmentIds(
  attachments: ConversationComposerSubmit["attachments"],
) {
  return attachments
    .filter((item) => item.status === "ready" && item.supported && item.id)
    .map((item) => item.id);
}

async function resolveConversationMessageTarget(
  workflowId: string,
  rootConversationId?: string,
  expectedGeneration?: number,
): Promise<{ rootId: string; generation: number }> {
  const response = await fetch(
    "/api/workflows/" + encodeURIComponent(workflowId) + "/conversations",
    { credentials: "same-origin" },
  );
  if (!response.ok) {
    return {
      rootId: rootConversationId ?? workflowId,
      generation: expectedGeneration ?? 0,
    };
  }
  const tree = await response.json();
  const rootId =
    rootConversationId ?? tree.active_root_id ?? tree.roots?.[0]?.id ?? workflowId;
  const generation =
    tree.roots?.find((item: { id: string }) => item.id === rootId)
      ?.generation ??
    expectedGeneration ??
    0;
  return { rootId, generation };
}

async function fetchWorkflowReferences(
  workflowId: string,
  query: string,
): Promise<ReferenceItem[]> {
  const response = await fetch(
    "/api/workspaces/references?workflow_id=" +
      encodeURIComponent(workflowId) +
      "&query=" +
      encodeURIComponent(query),
  );
  if (!response.ok) throw new Error("无法读取工作区引用");
  return (await response.json()).items;
}

async function cancelAside(input: {
  workflowId: string;
  asideId: string;
  act: (
    fn: () => Promise<any>,
    propagateError?: boolean,
    clearAuthNote?: boolean,
  ) => Promise<void>;
  send: (path: string, body: unknown) => Promise<any>;
  reload: () => void;
}) {
  await input.act(() =>
    input.send(`/workflows/${input.workflowId}/asides/${input.asideId}/cancel`, {}),
  );
  input.reload();
}

function promoteAsideToDraft(input: {
  composerWorkflowId: string;
  summary: { id: string; workflow_id: string; workflow_title: string };
  detail: { question: string; answer?: string } | null;
  setText: (text: string) => void;
}) {
  const question = input.detail?.question ?? "";
  if (!question) return;
  writeAsidePromoteDraft(input.composerWorkflowId, {
    workflowId: input.summary.workflow_id,
    asideId: input.summary.id,
  });
  input.setText(
    promoteDraftText({
      question,
      answer: input.detail?.answer,
    }),
  );
}

function AuthorizationCard({
  request,
  pending,
  onDecide,
}: {
  request: any;
  pending: boolean;
  onDecide: (approved: boolean) => void;
}) {
  return (
    <article className="authorization-card">
      <h3>操作等待你的授权</h3>
      <p>{request.operation.reason}</p>
      <dl>
        <dt>工作目录</dt>
        <dd>{request.cwd}</dd>
        <dt>执行程序</dt>
        <dd>{request.operation.executable}</dd>
        <dt>完整参数</dt>
        <dd>
          <pre>{JSON.stringify(request.operation.args, null, 2)}</pre>
        </dd>
      </dl>
      <p>
        此次决定只适用于上面这一次操作。批准后续接原模型会话；拒绝后模型会收到你的意见。
      </p>
      <p>影响范围由命令及参数决定，工作目录本身不是沙箱边界。</p>
      <div className="actions">
        <button disabled={pending} onClick={() => onDecide(true)}>
          批准本次操作并继续
        </button>
        <button disabled={pending} onClick={() => onDecide(false)}>
          拒绝并告知模型
        </button>
      </div>
    </article>
  );
}
