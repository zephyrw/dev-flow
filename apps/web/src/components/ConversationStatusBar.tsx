import React, { useEffect, useMemo, useState } from "react";
import { resolveConversationRuntimeDisplay } from "../../../../packages/core/src/conversation-input.js";
import type { ConversationRuntimeDisplay } from "../../../../packages/contracts/src/conversation-input.js";
import {
  visibleRunObservation,
  runtimePurposeNames,
  runtimeToolNames,
} from "../../../../packages/presentation/src/run-observation.js";
import type { RunObservation } from "../../../../packages/contracts/src/run-observation.js";
import { CONVERSATION_SEARCH_PARAM } from "../use-conversation-view.js";
import type { FileInputCapability } from "./ConversationAttachments.js";

export const DEFAULT_ADAPTER_FILE_INPUT: Record<string, FileInputCapability> = {
  codex: { text: true, image: true, binary: false },
  "claude-code": { text: true, image: true, binary: false },
  "kimi-code": { text: true, image: true, binary: false },
  opencode: { text: true, image: true, binary: false },
  "mimo-code": { text: true, image: false, binary: false },
  qoder: { text: true, image: false, binary: false },
  "cursor-agent": { text: false, image: true, binary: false },
  "grok-build": { text: false, image: false, binary: false },
  agy: { text: false, image: false, binary: false },
};

const UNKNOWN_FILE_INPUT: FileInputCapability = {
  text: false,
  image: false,
  binary: false,
};

const WAITING_PLAN_STATES = new Set([
  "PLAN_PENDING",
  "RESEARCHING",
  "REPAIR_PLAN_PENDING",
]);

const ACTIVE_WORKFLOW_STATES = new Set([
  "PLANNING",
  "EXECUTING",
  "VERIFYING",
  "REVIEWING",
  "QUEUED",
  "REVIEW_QUEUED",
  "INTEGRATING",
  "COMMITTING",
  "PLANNER_TAKEOVER",
]);

const ACTIVE_OBSERVATION = new Set(["starting", "responding", "working"]);
const ACTIVE_ATTEMPT = new Set(["starting", "running"]);
const PAUSED_ATTEMPT = new Set(["paused", "pausing", "interrupted"]);
const EXITED_OBSERVATION = new Set(["exited", "error"]);

export type StatusBarAttempt = {
  conversation_id: string;
  status?: string;
  actual_model?: string;
  requested_model?: string;
  actual_effort?: string;
  requested_effort?: string;
  activity_summary?: string;
  generation?: number;
};

export type StatusBarNode = {
  id: string;
  kind?: string;
  adapter_id?: string;
  purpose?: string;
  parent_id?: string;
};

export type ComposerRuntimeModel = {
  workText: string;
  modelButtonText: string;
  idleCaption?: string;
  runtime: ConversationRuntimeDisplay;
  toolLabel?: string;
  adapter?: string;
  fileInput?: FileInputCapability;
  workflowState?: string;
  workflowId?: string;
};

export function readViewedConversationId(search?: string): string | undefined {
  if (typeof location === "undefined" && !search) return undefined;
  const source = search ?? location.search;
  const params = new URLSearchParams(
    source.startsWith("?") ? source.slice(1) : source,
  );
  return params.get(CONVERSATION_SEARCH_PARAM) ?? undefined;
}

export function observationBelongsToViewed(params: {
  observation?: { conversation_id?: string } | null;
  viewedConversationId?: string;
  rootConversationId?: string;
}): boolean {
  if (!params.observation) return false;
  const viewed = params.viewedConversationId;
  if (!viewed) return true;
  if (params.observation.conversation_id) {
    return params.observation.conversation_id === viewed;
  }
  if (!params.rootConversationId) return true;
  return viewed === params.rootConversationId;
}

export function resolveFileInputCapability(
  adapter?: string,
  explicit?: FileInputCapability,
  discovery?: string,
): FileInputCapability | undefined {
  const fallback = adapter
    ? (DEFAULT_ADAPTER_FILE_INPUT[adapter] ?? UNKNOWN_FILE_INPUT)
    : undefined;
  if (explicit && discovery && discovery !== "unknown") return explicit;
  return fallback ?? explicit;
}

export function isConversationRuntimeActive(input: {
  workflowState?: string;
  observationStatus?: string;
  attemptStatus?: string;
}): boolean {
  if (input.attemptStatus && ACTIVE_ATTEMPT.has(input.attemptStatus)) {
    return true;
  }
  if (input.attemptStatus && PAUSED_ATTEMPT.has(input.attemptStatus)) {
    return false;
  }
  if (
    input.observationStatus &&
    ACTIVE_OBSERVATION.has(input.observationStatus)
  ) {
    return true;
  }
  if (
    input.observationStatus &&
    EXITED_OBSERVATION.has(input.observationStatus)
  ) {
    return false;
  }
  if (input.workflowState === "STOPPED") return false;
  if (input.workflowState && ACTIVE_WORKFLOW_STATES.has(input.workflowState)) {
    return true;
  }
  return false;
}

export function conversationIdleCaption(input: {
  active: boolean;
  workflowState?: string;
  lastModelLabel?: string;
  nextConfigLabel?: string;
}): string | undefined {
  if (input.active || !input.workflowState) return undefined;
  const last = input.lastModelLabel || "工具默认，实际未报告";
  const next = input.nextConfigLabel || "工具默认，实际未报告";
  if (WAITING_PLAN_STATES.has(input.workflowState)) {
    return `等待规划 · 下一轮配置 ${next}`;
  }
  return `已暂停 · 上次模型 ${last}`;
}

export function latestAttemptFor(
  attempts: StatusBarAttempt[] | undefined,
  conversationId?: string,
): StatusBarAttempt | undefined {
  if (!conversationId || !attempts?.length) return undefined;
  return attempts
    .filter((item) => item.conversation_id === conversationId)
    .slice()
    .sort((left, right) => (left.generation ?? 0) - (right.generation ?? 0))
    .at(-1);
}

export function selectViewedRuntimeFacts(input: {
  viewedConversationId?: string;
  rootConversationId?: string;
  viewedAttempt?: StatusBarAttempt | null;
  observation?: Pick<
    RunObservation,
    | "actual_model"
    | "requested_model"
    | "actual_effort"
    | "requested_effort"
    | "effort"
    | "conversation_id"
  > | null;
  requestedModel?: string;
  requestedEffort?: string;
  supportsEffort?: boolean;
}): {
  actual_model?: string;
  requested_model?: string;
  actual_effort?: string;
  requested_effort?: string;
  supports_effort?: boolean;
} {
  const belongs = observationBelongsToViewed({
    observation: input.observation,
    viewedConversationId: input.viewedConversationId,
    rootConversationId: input.rootConversationId,
  });
  const observed = belongs ? input.observation : undefined;
  return {
    actual_model: input.viewedAttempt?.actual_model ?? observed?.actual_model,
    requested_model:
      input.viewedAttempt?.requested_model ??
      observed?.requested_model ??
      (belongs ? input.requestedModel : undefined),
    actual_effort:
      input.viewedAttempt?.actual_effort ??
      observed?.actual_effort ??
      observed?.effort,
    requested_effort:
      input.viewedAttempt?.requested_effort ??
      observed?.requested_effort ??
      (belongs ? input.requestedEffort : undefined),
    supports_effort: input.supportsEffort,
  };
}

function conversationTree(detail: any): {
  nodes: StatusBarNode[];
  attempts: StatusBarAttempt[];
  capabilities?: {
    file_input?: FileInputCapability;
    discovery?: string;
  };
  activeRootId?: string;
} {
  const tree = detail?.conversation_tree ?? detail?.conversations ?? {};
  return {
    nodes: tree.nodes ?? detail?.conversation_nodes ?? [],
    attempts: tree.attempts ?? detail?.conversation_attempts ?? [],
    capabilities: tree.capabilities,
    activeRootId: tree.active_root_id,
  };
}

function adapterFromDetail(
  detail: any,
  node?: StatusBarNode,
  observation?: RunObservation | null,
  belongs?: boolean,
): string | undefined {
  if (node?.adapter_id) return node.adapter_id;
  if (belongs) return observation?.adapter;
  const run = detail?.runs?.find(
    (item: any) => item.id === detail?.workflow?.run_id,
  );
  return (
    run?.profile?.adapterId ??
    run?.adapter ??
    detail?.spec?.executorProfile?.adapterId ??
    detail?.execution_spec?.executorProfile?.adapterId
  );
}

function requestedConfigModel(detail: any): string | undefined {
  const run = detail?.runs?.find(
    (item: any) => item.id === detail?.workflow?.run_id,
  );
  return (
    run?.profile?.modelId ??
    detail?.spec?.executorProfile?.modelId ??
    detail?.execution_spec?.executorProfile?.modelId
  );
}

export function buildComposerRuntime(
  detail: any,
  viewedConversationId?: string,
): ComposerRuntimeModel {
  if (!detail?.workflow) {
    return {
      workText: "",
      modelButtonText: "",
      runtime: resolveConversationRuntimeDisplay({}),
    };
  }
  const observation = visibleRunObservation(detail);
  const tree = conversationTree(detail);
  const rootId =
    tree.activeRootId ??
    tree.nodes.find((node) => node.kind === "main" && !node.parent_id)?.id;
  const viewedId = viewedConversationId ?? rootId;
  const node = tree.nodes.find((item) => item.id === viewedId);
  const viewedAttempt = latestAttemptFor(tree.attempts, viewedId);
  const belongs = observationBelongsToViewed({
    observation,
    viewedConversationId: viewedId,
    rootConversationId: rootId,
  });
  const adapter = adapterFromDetail(detail, node, observation, belongs);
  const facts = selectViewedRuntimeFacts({
    viewedConversationId: viewedId,
    rootConversationId: rootId,
    viewedAttempt,
    observation,
    requestedModel: belongs ? requestedConfigModel(detail) : undefined,
  });
  const runtime = resolveConversationRuntimeDisplay(facts);
  const purposeKey = node?.purpose ?? (belongs ? observation?.purpose : undefined);
  const purpose = purposeKey
    ? (runtimePurposeNames[purposeKey] ?? purposeKey)
    : undefined;
  const activity =
    viewedAttempt?.activity_summary ??
    (belongs
      ? observation?.current_activity?.title || observation?.current_activity?.text
      : undefined);
  const workText = [purpose, activity].filter(Boolean).join(" · ");
  const toolLabel = adapter
    ? (runtimeToolNames[adapter] ?? adapter)
    : undefined;
  const active = isConversationRuntimeActive({
    workflowState: detail?.workflow?.state,
    observationStatus: belongs ? observation?.status : undefined,
    attemptStatus: viewedAttempt?.status,
  });
  const lastModel =
    runtime.model_source === "actual"
      ? runtime.model_label
      : facts.actual_model;
  const nextConfig =
    facts.requested_model ||
    (runtime.model_source === "requested" ? facts.requested_model : undefined) ||
    requestedConfigModel(detail);
  const idleCaption = conversationIdleCaption({
    active,
    workflowState: detail?.workflow?.state,
    lastModelLabel: lastModel,
    nextConfigLabel: nextConfig,
  });
  const modelLine = [toolLabel, runtime.model_label, runtime.effort_label]
    .filter(Boolean)
    .join(" · ");
  return {
    workText,
    modelButtonText: idleCaption ?? modelLine,
    idleCaption,
    runtime,
    toolLabel,
    adapter,
    fileInput: resolveFileInputCapability(
      adapter,
      tree.capabilities?.file_input,
      tree.capabilities?.discovery,
    ),
    workflowState: detail?.workflow?.state,
    workflowId: detail?.workflow?.id,
  };
}

export function useWorkflowComposerRuntime(workflowId: string): ComposerRuntimeModel {
  const [detail, setDetail] = useState<any>(null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(
          `/api/workflows/${encodeURIComponent(workflowId)}`,
          { credentials: "same-origin" },
        );
        if (!response.ok || cancelled) return;
        const data = await response.json();
        if (!cancelled) setDetail(data);
      } catch {
        // 保留上一次成功结果。
      }
    };
    void load();
    const onActivity = () => {
      void load();
    };
    window.addEventListener("devflow-activity", onActivity);
    const timer = window.setInterval(() => {
      void load();
    }, 4000);
    return () => {
      cancelled = true;
      window.removeEventListener("devflow-activity", onActivity);
      window.clearInterval(timer);
    };
  }, [workflowId]);
  const viewedId = readViewedConversationId();
  return useMemo(
    () => buildComposerRuntime(detail, viewedId),
    [detail, viewedId],
  );
}

export function ConversationStatusBar({
  model,
}: {
  workflowId: string;
  model: ComposerRuntimeModel;
}) {
  if (!model.workText) return null;
  return (
    <div className="conversation-composer-status-bar">
      <p className="conversation-composer-work" title={model.workText}>
        {model.workText}
      </p>
    </div>
  );
}
