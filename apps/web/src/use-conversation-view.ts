import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ConversationAttempt,
  ConversationNode,
  ConversationStatus,
} from "../../../packages/contracts/src/conversation.js";
import { resolveConversationRuntimeDisplay } from "../../../packages/core/src/conversation-input.js";
import { runtimeToolNames } from "../../../packages/presentation/src/run-observation.js";
import type { LogEntry } from "./logs.js";

export const CONVERSATION_SEARCH_PARAM = "conversation";
export const CONVERSATION_INVALID_NOTICE =
  "会话不存在或已过期，已回到主会话";

export interface ConversationViewport {
  scrollTop: number;
  followLatest: boolean;
  beforeSeq?: number;
  readCursor: number;
}

export interface ConversationBreadcrumbItem {
  id: string;
  title: string;
  current: boolean;
}

export interface ConversationViewEntry extends Omit<LogEntry, "kind"> {
  kind?: LogEntry["kind"] | "separator";
  conversation_id?: string;
  attempt_id?: string;
  presentation?: "separator" | "continuation";
}

export interface ConversationDraftMarker {
  key: string;
  preserved: boolean;
}

export interface ResolveConversationViewInput {
  workflowId: string;
  nodes: ConversationNode[];
  attempts?: ConversationAttempt[];
  activeRootConversationId?: string;
  requestedConversationId?: string;
  search?: string;
  entries?: ConversationViewEntry[];
  previousSelectedId?: string;
}

export interface ConversationView {
  selectedConversationId: string;
  activeRootConversationId?: string;
  rootConversationId: string;
  isChildView: boolean;
  showInteraction: boolean;
  notice?: string;
  breadcrumb: ConversationBreadcrumbItem[];
  entries: ConversationViewEntry[];
  viewport: ConversationViewport;
  draft: ConversationDraftMarker;
  viewedRuntimeText?: string;
  nextSearch: string;
}

const viewports = new Map<string, ConversationViewport>();
const draftKeys = new Map<string, boolean>();

const STATUS_LABEL: Record<ConversationStatus, string> = {
  discovered: "已发现",
  starting: "正在启动",
  running: "正在工作",
  waiting: "等待中",
  pausing: "正在暂停",
  paused: "已暂停",
  completed: "已完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
  unknown: "状态待确认",
};

export function resetConversationViewStores() {
  viewports.clear();
  draftKeys.clear();
}

export function conversationViewportKey(
  workflowId: string,
  conversationId: string,
) {
  return `${workflowId}:${conversationId}`;
}

export function conversationDraftKey(
  workflowId: string,
  conversationId: string,
) {
  return `draft:${workflowId}:${conversationId}`;
}

export function defaultConversationViewport(): ConversationViewport {
  return {
    scrollTop: 0,
    followLatest: true,
    readCursor: 0,
  };
}

export function readConversationViewport(
  workflowId: string,
  conversationId: string,
): ConversationViewport {
  const key = conversationViewportKey(workflowId, conversationId);
  const saved = viewports.get(key);
  if (!saved) return defaultConversationViewport();
  return { ...saved };
}

export function writeConversationViewport(
  workflowId: string,
  conversationId: string,
  patch: Partial<ConversationViewport>,
): ConversationViewport {
  const current = readConversationViewport(workflowId, conversationId);
  const next = { ...current, ...patch };
  viewports.set(conversationViewportKey(workflowId, conversationId), next);
  return next;
}

export function markConversationDraftPreserved(
  workflowId: string,
  conversationId: string,
): ConversationDraftMarker {
  const key = conversationDraftKey(workflowId, conversationId);
  draftKeys.set(key, true);
  return { key, preserved: true };
}

export function readConversationDraftMarker(
  workflowId: string,
  conversationId: string,
): ConversationDraftMarker {
  const key = conversationDraftKey(workflowId, conversationId);
  return { key, preserved: draftKeys.get(key) === true };
}

export function shouldRenderConversationInteraction(isChildView: boolean) {
  return !isChildView;
}

export function readConversationSearchParam(search: string): string | undefined {
  const raw = new URLSearchParams(
    search.startsWith("?") ? search.slice(1) : search,
  ).get(CONVERSATION_SEARCH_PARAM);
  return raw?.trim() || undefined;
}

export function writeConversationSearchParam(
  href: string,
  conversationId: string | undefined,
  rootConversationId?: string,
): string {
  const url = new URL(href, "https://devflow.local");
  if (!conversationId || conversationId === rootConversationId) {
    url.searchParams.delete(CONVERSATION_SEARCH_PARAM);
  } else {
    url.searchParams.set(CONVERSATION_SEARCH_PARAM, conversationId);
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function conversationStatusLabel(status?: ConversationStatus) {
  if (!status) return undefined;
  return STATUS_LABEL[status];
}

function workflowNodes(
  nodes: ConversationNode[],
  workflowId: string,
): ConversationNode[] {
  return nodes.filter((node) => node.workflow_id === workflowId);
}

export function findConversationNode(
  nodes: ConversationNode[],
  workflowId: string,
  conversationId?: string,
): ConversationNode | undefined {
  if (!conversationId) return undefined;
  return workflowNodes(nodes, workflowId).find(
    (node) => node.id === conversationId,
  );
}

export function resolveRootConversationId(
  nodes: ConversationNode[],
  workflowId: string,
  activeRootConversationId?: string,
): string | undefined {
  const owned = workflowNodes(nodes, workflowId);
  if (
    activeRootConversationId &&
    owned.some((node) => node.id === activeRootConversationId)
  ) {
    return activeRootConversationId;
  }
  const main = owned.find((node) => node.kind === "main" && !node.parent_id);
  if (main) return main.id;
  return owned.find((node) => !node.parent_id)?.id;
}

export function buildConversationPath(
  nodes: ConversationNode[],
  workflowId: string,
  selectedId: string,
): ConversationBreadcrumbItem[] {
  const owned = workflowNodes(nodes, workflowId);
  const byId = new Map(owned.map((node) => [node.id, node]));
  const selected = byId.get(selectedId);
  if (!selected) return [];
  const chain: ConversationNode[] = [];
  const seen = new Set<string>();
  let cursor: ConversationNode | undefined = selected;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    chain.unshift(cursor);
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
  }
  return chain.map((node) => ({
    id: node.id,
    title: node.title,
    current: node.id === selectedId,
  }));
}

export function resolveConversationSelection(input: {
  workflowId: string;
  nodes: ConversationNode[];
  activeRootConversationId?: string;
  requestedConversationId?: string;
  search?: string;
}): {
  selectedConversationId: string;
  activeRootConversationId?: string;
  rootConversationId: string;
  isChildView: boolean;
  notice?: string;
} {
  const requested =
    input.requestedConversationId ??
    readConversationSearchParam(input.search ?? "");
  const rootConversationId =
    resolveRootConversationId(
      input.nodes,
      input.workflowId,
      input.activeRootConversationId,
    ) ?? "";
  const owned = requested
    ? findConversationNode(input.nodes, input.workflowId, requested)
    : undefined;
  if (requested && !owned) {
    return {
      selectedConversationId: rootConversationId,
      activeRootConversationId: input.activeRootConversationId,
      rootConversationId,
      isChildView: false,
      notice: CONVERSATION_INVALID_NOTICE,
    };
  }
  const selectedConversationId = owned?.id ?? rootConversationId;
  return {
    selectedConversationId,
    activeRootConversationId: input.activeRootConversationId,
    rootConversationId,
    isChildView:
      !!selectedConversationId && selectedConversationId !== rootConversationId,
  };
}

function entryConversationId(entry: ConversationViewEntry): string | undefined {
  if (entry.conversation_id) return entry.conversation_id;
  for (const raw of entry.raw ?? []) {
    const event = raw as {
      type?: string;
      payload?: { conversation_id?: string };
    };
    if (
      event?.type === "ConversationActivity" &&
      event.payload?.conversation_id
    ) {
      return event.payload.conversation_id;
    }
  }
  return undefined;
}

export function filterConversationEntries(
  entries: ConversationViewEntry[],
  selectedId: string,
  rootId: string,
): ConversationViewEntry[] {
  if (!selectedId) return entries;
  if (selectedId === rootId) {
    return entries.filter((entry) => {
      const owner = entryConversationId(entry);
      return !owner || owner === rootId;
    });
  }
  return entries.filter((entry) => entryConversationId(entry) === selectedId);
}

function continuationTitle(
  nodes: ConversationNode[],
  workflowId: string,
  node?: ConversationNode,
): string | undefined {
  const replacedId = node?.replaces_conversation_id;
  if (!replacedId) return undefined;
  const replaced = findConversationNode(nodes, workflowId, replacedId);
  return `接续自${replaced?.title ?? replacedId}`;
}

function attemptOrder(attempts: ConversationAttempt[], conversationId: string) {
  return attempts
    .filter((attempt) => attempt.conversation_id === conversationId)
    .slice()
    .sort((a, b) => a.generation - b.generation || a.id.localeCompare(b.id));
}

function attemptSeparator(
  selectedId: string,
  attempt: ConversationAttempt | undefined,
  sequence: number,
  createdAt: string,
  fallbackId: string | number,
): ConversationViewEntry {
  return {
    key: `separator:${selectedId}:${attempt?.id ?? fallbackId}`,
    sequence,
    created_at: attempt?.observed_at ?? createdAt,
    title: "新的运行尝试",
    text: "新的运行尝试",
    raw: [],
    kind: "separator",
    presentation: "separator",
    conversation_id: selectedId,
    attempt_id: attempt?.id,
  };
}

function withAttemptSeparators(
  entries: ConversationViewEntry[],
  selectedId: string,
  orderedAttempts: ConversationAttempt[],
): ConversationViewEntry[] {
  if (orderedAttempts.length <= 1) return entries;
  if (entries.length === 0) {
    return orderedAttempts.slice(1).map((attempt) =>
      attemptSeparator(
        selectedId,
        attempt,
        attempt.generation,
        attempt.observed_at,
        attempt.id,
      ),
    );
  }
  const attemptIndex = new Map(
    orderedAttempts.map((item, index) => [item.id, index]),
  );
  const decorated: ConversationViewEntry[] = [];
  let previousAttemptIndex = -1;
  for (const entry of entries) {
    const currentIndex =
      entry.attempt_id !== undefined
        ? (attemptIndex.get(entry.attempt_id) ?? previousAttemptIndex)
        : previousAttemptIndex;
    if (
      currentIndex > 0 &&
      currentIndex !== previousAttemptIndex &&
      previousAttemptIndex >= 0
    ) {
      decorated.push(
        attemptSeparator(
          selectedId,
          orderedAttempts[currentIndex],
          entry.sequence - 0.5,
          entry.created_at,
          currentIndex,
        ),
      );
    }
    decorated.push(entry);
    if (currentIndex >= 0) previousAttemptIndex = currentIndex;
  }
  return decorated;
}

export function decorateConversationEntries(
  entries: ConversationViewEntry[],
  input: {
    workflowId: string;
    selectedId: string;
    nodes: ConversationNode[];
    attempts: ConversationAttempt[];
  },
): ConversationViewEntry[] {
  const selected = findConversationNode(
    input.nodes,
    input.workflowId,
    input.selectedId,
  );
  const continued = continuationTitle(
    input.nodes,
    input.workflowId,
    selected,
  );
  const head: ConversationViewEntry[] = [];
  if (continued) {
    const firstSeq = entries[0]?.sequence ?? 1;
    head.push({
      key: `continuation:${input.selectedId}`,
      sequence: firstSeq - 1,
      created_at: selected?.created_at ?? "",
      title: continued,
      text: continued,
      raw: [],
      kind: "event",
      presentation: "continuation",
      conversation_id: input.selectedId,
    });
  }
  return [
    ...head,
    ...withAttemptSeparators(
      entries,
      input.selectedId,
      attemptOrder(input.attempts, input.selectedId),
    ),
  ];
}

export function publicConversationText(entries: ConversationViewEntry[]) {
  return entries
    .filter(
      (entry) =>
        entry.kind !== "diagnostic" && entry.presentation !== "separator",
    )
    .map((entry) =>
      [entry.title, entry.text, entry.resultText].filter(Boolean).join("\n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

export function viewedConversationRuntimeText(input: {
  title?: string;
  status?: ConversationStatus;
  adapterId?: string;
  actualModel?: string;
  requestedModel?: string;
  actualEffort?: string;
  requestedEffort?: string;
  supportsEffort?: boolean;
}): string | undefined {
  if (!input.title && !input.status && !input.adapterId) return undefined;
  const runtime = resolveConversationRuntimeDisplay({
    actual_model: input.actualModel,
    requested_model: input.requestedModel,
    actual_effort: input.actualEffort,
    requested_effort: input.requestedEffort,
    supports_effort: input.supportsEffort,
  });
  const tool = input.adapterId
    ? (runtimeToolNames[input.adapterId] ?? input.adapterId)
    : undefined;
  return [
    input.title,
    conversationStatusLabel(input.status),
    tool,
    runtime.model_label,
    runtime.effort_label,
  ]
    .filter(Boolean)
    .join(" · ");
}

function latestAttempt(
  attempts: ConversationAttempt[],
  conversationId: string,
): ConversationAttempt | undefined {
  return attemptOrder(attempts, conversationId).at(-1);
}

export function resolveConversationView(
  input: ResolveConversationViewInput,
): ConversationView {
  const selection = resolveConversationSelection(input);
  const attempts = input.attempts ?? [];
  const entries = decorateConversationEntries(
    filterConversationEntries(
      input.entries ?? [],
      selection.selectedConversationId,
      selection.rootConversationId,
    ),
    {
      workflowId: input.workflowId,
      selectedId: selection.selectedConversationId,
      nodes: input.nodes,
      attempts,
    },
  );
  if (
    input.previousSelectedId &&
    input.previousSelectedId !== selection.selectedConversationId
  ) {
    markConversationDraftPreserved(input.workflowId, input.previousSelectedId);
  }
  const selectedNode = findConversationNode(
    input.nodes,
    input.workflowId,
    selection.selectedConversationId,
  );
  const selectedAttempt = latestAttempt(
    attempts,
    selection.selectedConversationId,
  );
  const searchSource = input.search ?? "";
  const href = searchSource.includes("://")
    ? searchSource
    : `https://devflow.local/${searchSource.startsWith("?") ? searchSource : `?${searchSource}`}`;
  return {
    ...selection,
    showInteraction: shouldRenderConversationInteraction(selection.isChildView),
    breadcrumb: buildConversationPath(
      input.nodes,
      input.workflowId,
      selection.selectedConversationId,
    ),
    entries,
    viewport: readConversationViewport(
      input.workflowId,
      selection.selectedConversationId,
    ),
    draft: readConversationDraftMarker(
      input.workflowId,
      selection.selectedConversationId,
    ),
    viewedRuntimeText: viewedConversationRuntimeText({
      title: selectedNode?.title,
      status: selectedAttempt?.status,
      adapterId: selectedNode?.adapter_id,
      actualModel: selectedAttempt?.actual_model,
      requestedModel: selectedAttempt?.requested_model,
      actualEffort: selectedAttempt?.actual_effort,
      requestedEffort: selectedAttempt?.requested_effort,
    }),
    nextSearch: writeConversationSearchParam(
      href,
      selection.notice ? selection.rootConversationId : selection.selectedConversationId,
      selection.rootConversationId,
    ),
  };
}

export class ConversationRequestGuard {
  private generation = 0;
  private key = "";
  private controller?: AbortController;

  start(workflowId: string, conversationId: string) {
    this.controller?.abort();
    this.generation += 1;
    this.key = conversationViewportKey(workflowId, conversationId);
    const generation = this.generation;
    const key = this.key;
    const controller = new AbortController();
    this.controller = controller;
    return {
      signal: controller.signal,
      accept: () => this.generation === generation && this.key === key,
    };
  }
}

export function useConversationView(input: {
  workflowId: string;
  nodes: ConversationNode[];
  attempts?: ConversationAttempt[];
  activeRootConversationId?: string;
  entries?: ConversationViewEntry[];
  search?: string;
}) {
  const liveSearch = () =>
    input.search ??
    (typeof location === "undefined" ? "" : location.search);
  const [requestedId, setRequestedId] = useState(
    () => readConversationSearchParam(liveSearch()),
  );
  const previousSelected = useRef<string>("");
  useEffect(() => {
    if (input.search === undefined) return;
    setRequestedId(readConversationSearchParam(input.search));
  }, [input.search]);
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPopState = () => {
      setRequestedId(readConversationSearchParam(location.search));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const view = useMemo(
    () =>
      resolveConversationView({
        workflowId: input.workflowId,
        nodes: input.nodes,
        attempts: input.attempts,
        activeRootConversationId: input.activeRootConversationId,
        entries: input.entries,
        search: liveSearch(),
        requestedConversationId: requestedId,
        previousSelectedId: previousSelected.current,
      }),
    [
      input.workflowId,
      input.nodes,
      input.attempts,
      input.activeRootConversationId,
      input.entries,
      input.search,
      requestedId,
    ],
  );
  useEffect(() => {
    previousSelected.current = view.selectedConversationId;
  }, [view.selectedConversationId]);
  const selectConversation = (conversationId: string) => {
    setRequestedId(conversationId);
    if (typeof history === "undefined" || typeof location === "undefined") {
      return;
    }
    const next = writeConversationSearchParam(
      location.href,
      conversationId,
      view.rootConversationId,
    );
    history.pushState(null, "", next);
  };
  return { ...view, selectConversation };
}
