import { useCallback, useState } from "react";
import {
  evaluateConversationSend,
  parseConversationInput,
  type AsideCommand,
} from "../../../packages/core/src/conversation-input.js";
import type { ReferenceItem } from "./components/RequirementComposer.js";

export const COMPOSER_MAX_HEIGHT_PX = 240;
export const COMPOSER_TEXTAREA_ROWS = 3;

export const CONVERSATION_ENDED_STATES = [
  "COMMITTED",
  "COMPLETED",
  "CLEANUP_PENDING",
] as const;

export const CONVERSATION_UNINTERRUPTIBLE_STATES = [
  "COMMITTING",
  "INTEGRATING",
  "COMMIT_PARTIAL",
  "STOPPING",
] as const;

export interface ConversationDraftAttachment {
  id: string;
  status: string;
  supported: boolean;
}

export interface ConversationDraft {
  text: string;
  refs: ReferenceItem[];
  attachments: ConversationDraftAttachment[];
  requestId: string;
  receivedFormal: boolean;
}

const drafts = new Map<string, ConversationDraft>();

function newRequestId(): string {
  return crypto.randomUUID();
}

function emptyDraft(): ConversationDraft {
  return {
    text: "",
    refs: [],
    attachments: [],
    requestId: newRequestId(),
    receivedFormal: false,
  };
}

function draftStorageKey(workflowId: string): string {
  return `devflow.conversation-draft.${workflowId}`;
}

function persistDraft(workflowId: string, draft: ConversationDraft): void {
  try {
    localStorage.setItem(
      draftStorageKey(workflowId),
      JSON.stringify({
        text: draft.text,
        refs: draft.refs,
        requestId: draft.requestId,
        receivedFormal: draft.receivedFormal,
      }),
    );
  } catch {
    // 私密模式或配额满时仍保留内存草稿。
  }
}

function readPersistedDraft(workflowId: string): ConversationDraft | undefined {
  try {
    const raw = localStorage.getItem(draftStorageKey(workflowId));
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<ConversationDraft>;
    return {
      text: typeof parsed.text === "string" ? parsed.text : "",
      refs: Array.isArray(parsed.refs) ? parsed.refs : [],
      attachments: [],
      requestId:
        typeof parsed.requestId === "string" ? parsed.requestId : newRequestId(),
      receivedFormal: Boolean(parsed.receivedFormal),
    };
  } catch {
    return undefined;
  }
}

function storedDraft(workflowId: string): ConversationDraft {
  const existing = drafts.get(workflowId);
  if (existing) return existing;
  const created = readPersistedDraft(workflowId) ?? emptyDraft();
  drafts.set(workflowId, created);
  return created;
}

export function resetConversationDrafts(): void {
  drafts.clear();
}

export function peekConversationDraft(workflowId: string): ConversationDraft {
  return storedDraft(workflowId);
}

export function shouldRenderConversationComposer(params: {
  selectedConversationId?: string;
  rootConversationId?: string;
}): boolean {
  if (!params.selectedConversationId || !params.rootConversationId) return true;
  return params.selectedConversationId === params.rootConversationId;
}

export function isConversationComposerReadonly(state: string): boolean {
  return (
    CONVERSATION_ENDED_STATES.includes(state as (typeof CONVERSATION_ENDED_STATES)[number]) ||
    CONVERSATION_UNINTERRUPTIBLE_STATES.includes(
      state as (typeof CONVERSATION_UNINTERRUPTIBLE_STATES)[number],
    )
  );
}

export function conversationComposerReadonlyReason(state: string): string {
  if (
    CONVERSATION_ENDED_STATES.includes(
      state as (typeof CONVERSATION_ENDED_STATES)[number],
    )
  ) {
    return "任务已结束。这里不会重新启动已完成的任务。";
  }
  return "当前阶段不能中断或发送指导。";
}

export function showsRoundFeedbackEntry(state: string): boolean {
  return CONVERSATION_ENDED_STATES.includes(
    state as (typeof CONVERSATION_ENDED_STATES)[number],
  );
}

export function applyConversationCommandSuggestion(
  text: string,
  command: AsideCommand,
): string {
  const trimmedStart = text.trimStart();
  const leading = text.slice(0, text.length - trimmedStart.length);
  const withoutToken = trimmedStart.replace(/^\/[A-Za-z]*/, "");
  const body = withoutToken.replace(/^\s*/, "");
  return body ? `${leading}/${command} ${body}` : `${leading}/${command} `;
}

export function removeConversationAsideCommand(text: string): string {
  const parsed = parseConversationInput(text);
  if (parsed.mode !== "aside") return text;
  return parsed.text;
}

export function composerTextareaHeight(
  scrollHeight: number,
  minHeight: number,
): number {
  return Math.min(COMPOSER_MAX_HEIGHT_PX, Math.max(minHeight, scrollHeight));
}

export function shouldSubmitComposerKey(params: {
  key: string;
  shiftKey: boolean;
  composing: boolean;
  keyCode?: number;
  skipEnterAfterComposition?: boolean;
}): boolean {
  if (params.composing || params.keyCode === 229 || params.skipEnterAfterComposition)
    return false;
  return params.key === "Enter" && !params.shiftKey;
}

export function conversationHandoverHint(params: {
  mode: "formal" | "aside";
  readonly: boolean;
  receivedFormal: boolean;
}): string | undefined {
  if (params.readonly || params.mode !== "formal") return undefined;
  if (params.receivedFormal) return "指导已接收，正在交接";
  return undefined;
}

export function resolveComposerSendPayload(params: {
  text: string;
  attachments?: ConversationDraftAttachment[];
}): {
  canSend: boolean;
  reason?: string;
  mode: "formal" | "aside";
  sendText: string;
  draftText: string;
  parsedMode: "formal" | "aside";
} {
  const parsed = parseConversationInput(params.text);
  const send = evaluateConversationSend({
    text: params.text,
    attachments: params.attachments,
    parsed,
  });
  const sendText =
    parsed.mode === "formal" && !parsed.text.trim() && send.default_text
      ? send.default_text
      : parsed.text;
  return {
    canSend: send.can_send,
    reason: send.reason,
    mode: parsed.mode,
    sendText,
    draftText: params.text,
    parsedMode: parsed.mode,
  };
}

export function draftAfterSuccessfulSend(params: {
  currentText: string;
  sentText: string;
  currentRequestId: string;
  sentRequestId: string;
}): { clear: boolean; rotateRequestId: boolean } {
  if (params.currentRequestId !== params.sentRequestId) {
    return { clear: false, rotateRequestId: false };
  }
  if (params.currentText !== params.sentText) {
    return { clear: false, rotateRequestId: true };
  }
  return { clear: true, rotateRequestId: true };
}

export function useConversationDraft(workflowId: string) {
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const draft = storedDraft(workflowId);

  const replace = useCallback(
    (patch: Partial<ConversationDraft>) => {
      Object.assign(storedDraft(workflowId), patch);
      persistDraft(workflowId, storedDraft(workflowId));
      refresh();
    },
    [refresh, workflowId],
  );

  const setText = useCallback(
    (text: string) => {
      replace({ text, receivedFormal: false });
    },
    [replace],
  );

  const setRefs = useCallback(
    (refs: ReferenceItem[]) => {
      replace({ refs });
    },
    [replace],
  );

  const setAttachments = useCallback(
    (attachments: ConversationDraftAttachment[]) => {
      replace({ attachments });
    },
    [replace],
  );

  const applySuccessfulSend = useCallback(
    (sentText: string, sentRequestId: string, formal: boolean) => {
      const current = storedDraft(workflowId);
      const result = draftAfterSuccessfulSend({
        currentText: current.text,
        sentText,
        currentRequestId: current.requestId,
        sentRequestId,
      });
      if (result.clear) {
        current.text = "";
        current.refs = [];
        current.attachments = [];
      }
      if (result.rotateRequestId) current.requestId = newRequestId();
      current.receivedFormal = formal && result.clear;
      persistDraft(workflowId, current);
      refresh();
    },
    [refresh, workflowId],
  );

  return {
    draft,
    setText,
    setRefs,
    setAttachments,
    applySuccessfulSend,
  };
}
