import React, { useEffect, useRef } from "react";
import {
  countConversationWork,
  emptyConversationWorkCounts,
  type ConversationAttempt,
  type ConversationFreshness,
  type ConversationNode,
  type ConversationStatus,
  type ConversationWorkCounts,
  type SubagentCapabilities,
} from "../../../../packages/contracts/src/conversation.js";
import "./subagent-work-card.css";

export const SUMMARY_MAX_CHARS = 500;
export const COLLAPSE_WORK_CARD_LABEL = "收起子 Agent 工作卡";
export const PAUSE_ALL_LABEL = "暂停当前主工作会话及全部子 Agent";
export const WORK_CARD_PREFERENCE_PREFIX = "devflow.subagent-work-card.";

export type WorkCardPreference = "expanded" | "collapsed";
export type WorkCardVisibility = "hidden" | "capability" | "complete" | "active";

export type WorkCardNode = Pick<
  ConversationNode,
  | "id"
  | "root_id"
  | "parent_id"
  | "kind"
  | "title"
  | "task_summary"
  | "workflow_id"
  | "created_at"
>;

export type WorkCardAttempt = Pick<
  ConversationAttempt,
  | "id"
  | "conversation_id"
  | "status"
  | "freshness"
  | "generation"
  | "activity_summary"
  | "observed_at"
  | "activity_at"
  | "actual_model"
  | "requested_model"
  | "actual_effort"
  | "requested_effort"
>;

export type SubagentWorkRow = {
  conversationId: string;
  name: string;
  summary: string;
  parentPath: string;
  statusLabel: string;
  secondaryTitle: string;
  stale: boolean;
};

export type WorkCardChip = {
  key: string;
  label: string;
};

export type SubagentWorkCardModel = {
  visibility: WorkCardVisibility;
  headline: string;
  counts: ConversationWorkCounts;
  rows: SubagentWorkRow[];
  historyRows: SubagentWorkRow[];
  chips: WorkCardChip[];
  capabilityNotice?: string;
  hasActiveWork: boolean;
};

export type SubagentWorkCardProps = {
  workflowId: string;
  rootConversationId: string;
  expanded: boolean;
  nodes: WorkCardNode[];
  attempts: WorkCardAttempt[];
  capabilities: SubagentCapabilities;
  onToggle: () => void;
  onSelect: (conversationId: string) => void;
  onPauseAll: () => void;
  onCollapse: () => void;
};

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

export function workCardPreferenceKey(
  workflowId: string,
  rootConversationId: string,
): string {
  return `${WORK_CARD_PREFERENCE_PREFIX}${workflowId}:${rootConversationId}`;
}

export function readWorkCardPreference(
  workflowId: string,
  rootConversationId: string,
  storage: PreferenceStorage | undefined = browserStorage(),
): WorkCardPreference | undefined {
  const raw = storage?.getItem(
    workCardPreferenceKey(workflowId, rootConversationId),
  );
  if (raw === "expanded" || raw === "collapsed") return raw;
  return undefined;
}

export function writeWorkCardPreference(
  workflowId: string,
  rootConversationId: string,
  preference: WorkCardPreference,
  storage: PreferenceStorage | undefined = browserStorage(),
): void {
  storage?.setItem(
    workCardPreferenceKey(workflowId, rootConversationId),
    preference,
  );
}

export function shouldAutoExpandWorkCard(
  preference: WorkCardPreference | undefined,
  hasActiveWork: boolean,
  expanded: boolean,
): boolean {
  if (expanded || !hasActiveWork) return false;
  return preference !== "collapsed";
}

export function clipWorkSummary(text: string | undefined): string {
  if (!text) return "";
  const trimmed = text.trim();
  if (trimmed.length <= SUMMARY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, SUMMARY_MAX_CHARS);
}

export function shortConversationId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

export function conversationDisplayName(node: WorkCardNode): string {
  const title = node.title.trim();
  if (title && title !== node.id) return title;
  const task = node.task_summary?.trim();
  if (task) return clipWorkSummary(task);
  return `子 Agent · ${shortConversationId(node.id)}`;
}

export function conversationStatusLabel(status: ConversationStatus): string {
  if (status === "starting") return "正在启动";
  if (status === "running") return "正在工作";
  if (status === "waiting") return "等待中";
  if (status === "pausing") return "暂停中";
  if (status === "paused") return "已暂停";
  if (status === "failed") return "失败";
  if (status === "interrupted") return "已中断";
  if (status === "unknown") return "状态未知";
  if (status === "discovered") return "已发现";
  if (status === "completed") return "已完成";
  if (status === "cancelled") return "已取消";
  return status;
}

export function isUnconfirmedFreshness(freshness: ConversationFreshness): boolean {
  return freshness === "stale" || freshness === "unavailable";
}

export function isSettledConversationStatus(status: ConversationStatus): boolean {
  return status === "completed" || status === "cancelled";
}

export function subagentCapabilityNotice(
  capabilities: SubagentCapabilities,
): string | undefined {
  const discovery = capabilities.discovery;
  if (discovery === "native" || discovery === "scoped-record") return undefined;
  const reason = capabilities.reason?.trim();
  if (reason) return reason;
  if (discovery === "unavailable") {
    return "当前工具无法读取子 Agent，不能据此认为没有子 Agent。";
  }
  return "当前工具尚未报告子 Agent 能力，不能据此认为没有子 Agent。";
}

export function latestAttemptByConversation(
  attempts: WorkCardAttempt[],
): WorkCardAttempt[] {
  const latest = new Map<string, WorkCardAttempt>();
  for (const attempt of attempts) {
    const previous = latest.get(attempt.conversation_id);
    if (!previous || isNewerAttempt(attempt, previous)) {
      latest.set(attempt.conversation_id, attempt);
    }
  }
  return [...latest.values()];
}

export function buildSubagentWorkCardModel(input: {
  rootConversationId: string;
  nodes: WorkCardNode[];
  attempts: WorkCardAttempt[];
  capabilities: SubagentCapabilities;
}): SubagentWorkCardModel {
  const nodes = subagentNodesForRoot(input.nodes, input.rootConversationId);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const attempts = latestAttemptByConversation(input.attempts).filter((attempt) =>
    byId.has(attempt.conversation_id),
  );
  const counts =
    attempts.length > 0
      ? countConversationWork(attempts)
      : emptyConversationWorkCounts();
  const { rows, historyRows } = splitWorkRows(nodes, attempts, byId);
  const hasActiveWork = counts.working > 0;
  const visibility = workCardVisibility(
    nodes.length,
    counts,
    attempts,
    input.capabilities,
  );
  return {
    visibility,
    headline: workCardHeadline(visibility, counts),
    counts,
    rows,
    historyRows,
    chips: workCardChips(counts),
    capabilityNotice: subagentCapabilityNotice(input.capabilities),
    hasActiveWork,
  };
}

export function SubagentWorkCard(props: SubagentWorkCardProps) {
  const model = buildSubagentWorkCardModel(props);
  useAutoExpandWorkCard(props, model.hasActiveWork);
  if (model.visibility === "hidden") return null;
  if (model.visibility === "capability") {
    return (
      <section className="subagent-work-card" aria-label="子 Agent 工作卡">
        <p className="subagent-work-card-capability">{model.capabilityNotice}</p>
      </section>
    );
  }
  if (model.visibility === "complete") {
    return (
      <CompleteWorkCard
        model={model}
        expanded={props.expanded}
        onToggle={() => toggleCompleteHistory(props)}
        onSelect={props.onSelect}
      />
    );
  }
  if (props.expanded) {
    return (
      <ExpandedWorkCard
        model={model}
        onSelect={props.onSelect}
        onPauseAll={props.onPauseAll}
        onCollapse={() => collapseCard(props)}
      />
    );
  }
  return (
    <CollapsedWorkCard
      model={model}
      onExpand={() => expandCard(props)}
      onPauseAll={props.onPauseAll}
    />
  );
}

function browserStorage(): PreferenceStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

function isNewerAttempt(attempt: WorkCardAttempt, previous: WorkCardAttempt): boolean {
  if (attempt.generation !== previous.generation) {
    return attempt.generation > previous.generation;
  }
  return attempt.observed_at >= previous.observed_at;
}

function uniqueNodes(nodes: WorkCardNode[]): WorkCardNode[] {
  const unique = new Map<string, WorkCardNode>();
  for (const node of nodes) {
    if (!unique.has(node.id)) unique.set(node.id, node);
  }
  return [...unique.values()];
}

function subagentNodesForRoot(
  nodes: WorkCardNode[],
  rootConversationId: string,
): WorkCardNode[] {
  return uniqueNodes(nodes).filter(
    (node) =>
      node.kind === "subagent" &&
      node.root_id === rootConversationId &&
      node.id !== rootConversationId,
  );
}

function splitWorkRows(
  nodes: WorkCardNode[],
  attempts: WorkCardAttempt[],
  byId: Map<string, WorkCardNode>,
): { rows: SubagentWorkRow[]; historyRows: SubagentWorkRow[] } {
  const attemptByConversation = new Map(
    attempts.map((attempt) => [attempt.conversation_id, attempt]),
  );
  const ordered = nodes
    .map((node, index) => ({ node, index }))
    .sort(compareWorkNodeOrder)
    .map((item) => item.node);
  const rows: SubagentWorkRow[] = [];
  const historyRows: SubagentWorkRow[] = [];
  for (const node of ordered) {
    const attempt = attemptByConversation.get(node.id);
    if (!attempt) continue;
    const row = toWorkRow(node, attempt, byId);
    if (isSettledConversationStatus(attempt.status) && !row.stale) {
      historyRows.push(row);
    } else {
      rows.push(row);
    }
  }
  return { rows, historyRows };
}

function compareWorkNodeOrder(
  left: { node: WorkCardNode; index: number },
  right: { node: WorkCardNode; index: number },
): number {
  if (left.node.created_at !== right.node.created_at) {
    return left.node.created_at < right.node.created_at ? -1 : 1;
  }
  return left.index - right.index;
}

function toWorkRow(
  node: WorkCardNode,
  attempt: WorkCardAttempt,
  byId: Map<string, WorkCardNode>,
): SubagentWorkRow {
  const stale = isUnconfirmedFreshness(attempt.freshness);
  return {
    conversationId: node.id,
    name: conversationDisplayName(node),
    summary: clipWorkSummary(attempt.activity_summary),
    parentPath: parentPathLabel(node, byId),
    statusLabel: stale ? "状态待确认" : conversationStatusLabel(attempt.status),
    secondaryTitle: rowSecondaryTitle(attempt),
    stale,
  };
}

function parentPathLabel(
  node: WorkCardNode,
  byId: Map<string, WorkCardNode>,
): string {
  const parts: string[] = [];
  let cursor = node.parent_id;
  while (cursor) {
    const parent = byId.get(cursor);
    if (!parent) break;
    if (parent.kind !== "main") parts.unshift(conversationDisplayName(parent));
    cursor = parent.parent_id;
  }
  return parts.join(" / ");
}

function rowSecondaryTitle(attempt: WorkCardAttempt): string {
  const model = attempt.actual_model ?? attempt.requested_model;
  const effort = attempt.actual_effort ?? attempt.requested_effort;
  const time = formatWorkTime(attempt.activity_at ?? attempt.observed_at);
  return [model, effort, time].filter(Boolean).join(" · ");
}

function formatWorkTime(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("zh-CN");
}

function workCardVisibility(
  subagentCount: number,
  counts: ConversationWorkCounts,
  attempts: WorkCardAttempt[],
  capabilities: SubagentCapabilities,
): WorkCardVisibility {
  if (subagentCount === 0) {
    const discovery = capabilities.discovery;
    if (discovery === "native" || discovery === "scoped-record") return "hidden";
    return "capability";
  }
  if (isAllComplete(counts, attempts)) return "complete";
  return "active";
}

function isAllComplete(
  counts: ConversationWorkCounts,
  attempts: WorkCardAttempt[],
): boolean {
  if (attempts.length === 0) return false;
  if (
    counts.working > 0 ||
    counts.waiting > 0 ||
    counts.pausing > 0 ||
    counts.paused > 0 ||
    counts.failed > 0 ||
    counts.interrupted > 0 ||
    counts.unknown > 0
  ) {
    return false;
  }
  return attempts.every(
    (attempt) =>
      isSettledConversationStatus(attempt.status) &&
      !isUnconfirmedFreshness(attempt.freshness),
  );
}

function workCardHeadline(
  visibility: WorkCardVisibility,
  counts: ConversationWorkCounts,
): string {
  if (visibility === "complete") return `子 Agent · 已完成 ${counts.completed}`;
  if (counts.working === 0 && counts.stale > 0) return "状态待确认";
  return `Working ${counts.working}`;
}

function workCardChips(counts: ConversationWorkCounts): WorkCardChip[] {
  const exception = counts.failed + counts.interrupted + counts.unknown;
  const paused = counts.pausing + counts.paused;
  const chips: WorkCardChip[] = [
    { key: "working", label: `Working ${counts.working}` },
  ];
  if (counts.waiting > 0) {
    chips.push({ key: "waiting", label: `等待 ${counts.waiting}` });
  }
  if (paused > 0) {
    chips.push({ key: "paused", label: `暂停 ${paused}` });
  }
  if (exception > 0) {
    chips.push({ key: "exception", label: `异常 ${exception}` });
  }
  if (counts.stale > 0) {
    chips.push({ key: "stale", label: `状态待确认 ${counts.stale}` });
  }
  return chips;
}

function expandCard(props: SubagentWorkCardProps): void {
  writeWorkCardPreference(props.workflowId, props.rootConversationId, "expanded");
  props.onToggle();
}

function collapseCard(props: SubagentWorkCardProps): void {
  writeWorkCardPreference(props.workflowId, props.rootConversationId, "collapsed");
  props.onCollapse();
}

function toggleCompleteHistory(props: SubagentWorkCardProps): void {
  if (props.expanded) collapseCard(props);
  else expandCard(props);
}

function useAutoExpandWorkCard(
  props: SubagentWorkCardProps,
  hasActiveWork: boolean,
): void {
  const attemptedKey = useRef("");
  const key = workCardPreferenceKey(
    props.workflowId,
    props.rootConversationId,
  );
  useEffect(() => {
    if (attemptedKey.current && attemptedKey.current !== key) {
      attemptedKey.current = "";
    }
    if (attemptedKey.current === key) return;
    const preference = readWorkCardPreference(
      props.workflowId,
      props.rootConversationId,
    );
    if (!shouldAutoExpandWorkCard(preference, hasActiveWork, props.expanded)) {
      return;
    }
    attemptedKey.current = key;
    writeWorkCardPreference(
      props.workflowId,
      props.rootConversationId,
      "expanded",
    );
    props.onToggle();
  }, [
    key,
    hasActiveWork,
    props.expanded,
    props.workflowId,
    props.rootConversationId,
    props.onToggle,
  ]);
}

function CompleteWorkCard({
  model,
  expanded,
  onToggle,
  onSelect,
}: {
  model: SubagentWorkCardModel;
  expanded: boolean;
  onToggle: () => void;
  onSelect: (conversationId: string) => void;
}) {
  return (
    <section
      className="subagent-work-card"
      aria-label="子 Agent 工作卡"
      aria-expanded={expanded}
    >
      <header className="subagent-work-card-header">
        <button
          type="button"
          className="subagent-work-card-history"
          onClick={onToggle}
        >
          {model.headline}
        </button>
        {expanded ? (
          <button
            type="button"
            className="subagent-work-card-collapse"
            aria-label={COLLAPSE_WORK_CARD_LABEL}
            title={COLLAPSE_WORK_CARD_LABEL}
            onClick={onToggle}
          >
            ×
          </button>
        ) : null}
      </header>
      {expanded ? (
        <WorkRowList rows={model.historyRows} onSelect={onSelect} />
      ) : null}
    </section>
  );
}

function ExpandedWorkCard({
  model,
  onSelect,
  onPauseAll,
  onCollapse,
}: {
  model: SubagentWorkCardModel;
  onSelect: (conversationId: string) => void;
  onPauseAll: () => void;
  onCollapse: () => void;
}) {
  return (
    <section
      className="subagent-work-card is-expanded"
      aria-label="子 Agent 工作卡"
      aria-expanded="true"
    >
      <header className="subagent-work-card-header">
        <p className="subagent-work-card-headline">{model.headline}</p>
        <div className="subagent-work-card-actions">
          <PauseAllButton onPauseAll={onPauseAll} collapsed={false} />
          <button
            type="button"
            className="subagent-work-card-collapse"
            aria-label={COLLAPSE_WORK_CARD_LABEL}
            title={COLLAPSE_WORK_CARD_LABEL}
            onClick={onCollapse}
          >
            ×
          </button>
        </div>
      </header>
      <WorkRowList rows={model.rows} onSelect={onSelect} />
    </section>
  );
}

function CollapsedWorkCard({
  model,
  onExpand,
  onPauseAll,
}: {
  model: SubagentWorkCardModel;
  onExpand: () => void;
  onPauseAll: () => void;
}) {
  return (
    <section
      className="subagent-work-card is-collapsed"
      aria-label="子 Agent 工作卡"
      aria-expanded="false"
    >
      <div className="subagent-work-card-chips">
        {model.chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className={`subagent-work-card-chip is-${chip.key}`}
            onClick={onExpand}
          >
            <span aria-hidden="true">◌ </span>
            {chip.label}
          </button>
        ))}
      </div>
      <PauseAllButton onPauseAll={onPauseAll} collapsed={true} />
    </section>
  );
}

function PauseAllButton({
  onPauseAll,
  collapsed,
}: {
  onPauseAll: () => void;
  collapsed: boolean;
}) {
  return (
    <button
      type="button"
      className="subagent-work-card-pause"
      title={PAUSE_ALL_LABEL}
      aria-label={PAUSE_ALL_LABEL}
      onClick={onPauseAll}
    >
      {collapsed ? "暂停" : "暂停全部"}
    </button>
  );
}

function WorkRowList({
  rows,
  onSelect,
}: {
  rows: SubagentWorkRow[];
  onSelect: (conversationId: string) => void;
}) {
  return (
    <ul className="subagent-work-card-list">
      {rows.map((row) => (
        <li key={row.conversationId}>
          <button
            type="button"
            className="subagent-work-card-row"
            title={row.secondaryTitle}
            onClick={() => onSelect(row.conversationId)}
          >
            <span aria-hidden="true" className="subagent-work-card-dot">
              ◌
            </span>
            <span className="subagent-work-card-body">
              <span className="subagent-work-card-name">{row.name}</span>
              {row.parentPath ? (
                <span className="subagent-work-card-path">{row.parentPath}</span>
              ) : null}
              {row.summary ? (
                <span className="subagent-work-card-summary">{row.summary}</span>
              ) : null}
              <span className="subagent-work-card-status">{row.statusLabel}</span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
