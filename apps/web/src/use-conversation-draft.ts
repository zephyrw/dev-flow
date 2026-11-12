import { useCallback, useEffect, useState } from "react";
import {
  draftConversationAttachments, hydrateConversationAttachments, persistableAttachment,
  releaseConversationAttachments, restoreConversationAttachments,
  snapshotConversationAttachments, takeConversationAttachments,
  retainSubmissionAttachmentFiles, releaseSubmissionAttachmentFiles,
  type AttachmentRecord, type PersistedAttachment,
} from "./components/ConversationAttachments.js";
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
  unsupportedReason?: string;
}

export interface ConversationDraft {
  text: string;
  refs: ReferenceItem[];
  attachments: ConversationDraftAttachment[];
  requestId: string;
  receivedFormal: boolean;
  promoteTarget?: { workflowId: string; asideId: string };
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
        promoteTarget: draft.promoteTarget,
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
      promoteTarget: parsed.promoteTarget,
    };
  } catch {
    return undefined;
  }
}

function storedDraft(workflowId: string): ConversationDraft {
  const existing = drafts.get(workflowId);
  if (existing) return existing;
  const created = readPersistedDraft(workflowId) ?? emptyDraft();
  created.attachments = draftConversationAttachments(snapshotConversationAttachments(workflowId));
  drafts.set(workflowId, created);
  return created;
}

export function resetConversationDrafts(): void {
  drafts.clear();
  resetConversationSubmissions();
}

export type SubmissionStatus = "sending" | "uncertain" | "failed" | "saved";
export interface CommittedSubmission {
  workflowId: string;
  requestId: string;
  draftText: string;
  sendText: string;
  refs: ReferenceItem[];
  attachments: ConversationDraftAttachment[];
  attachmentRecords: AttachmentRecord[];
  mode: "formal" | "aside";
  committedAt: number;
  status: SubmissionStatus;
  acceptanceUncertain?: boolean;
  recoveryBlockedReason?: string;
  promoteTarget?: { workflowId: string; asideId: string };
  transport?: { path: string; body: Record<string, unknown> };
}

type SubmissionPayload = Pick<CommittedSubmission, "requestId" | "draftText" | "sendText" | "refs" | "attachments" | "mode" | "promoteTarget">;
const submissions = new Map<string, CommittedSubmission[]>();
const listeners = new Map<string, Set<() => void>>();

function notifyDraft(workflowId: string): void {
  for (const listener of listeners.get(workflowId) ?? []) listener();
}
function submissionStorageKey(workflowId: string): string {
  return `devflow.conversation-submissions.${workflowId}`;
}
function persistSubmissions(workflowId: string): void {
  try {
    localStorage.setItem(submissionStorageKey(workflowId), JSON.stringify(
      (submissions.get(workflowId) ?? []).map(item => ({
        ...item, attachmentRecords: item.attachmentRecords.map(persistableAttachment),
      })),
    ));
  } catch { /* Keep the in-memory recovery copy if storage is unavailable. */ }
  notifyDraft(workflowId);
}
function submissionList(workflowId: string): CommittedSubmission[] {
  const cached = submissions.get(workflowId);
  if (cached) return cached;
  const result: CommittedSubmission[] = [];
  try {
    const raw = localStorage.getItem(submissionStorageKey(workflowId));
    const records: unknown[] = raw ? JSON.parse(raw) : [
      ...["inflight", "failed"].flatMap(kind => {
        const legacy = localStorage.getItem(`devflow.conversation-${kind}.${workflowId}`);
        return legacy ? [{ ...JSON.parse(legacy), status: kind === "inflight" ? "uncertain" : "failed" }] : [];
      }),
    ];
    for (const value of records) {
      const item = value as Omit<Partial<CommittedSubmission>, "attachmentRecords"> & { attachmentRecords?: PersistedAttachment[] };
      if (!item || item.workflowId !== workflowId || typeof item.requestId !== "string" || typeof item.draftText !== "string") continue;
      if (result.some(saved => saved.requestId === item.requestId)) continue;
      result.push({
        workflowId, requestId: item.requestId, draftText: item.draftText,
        sendText: item.sendText ?? item.draftText, refs: item.refs ?? [],
        attachments: item.attachments ?? [],
        attachmentRecords: hydrateConversationAttachments(workflowId, item.attachmentRecords ?? []),
        mode: item.mode === "aside" ? "aside" : "formal",
        committedAt: item.committedAt ?? Date.now(),
        status: !raw && !item.transport ? "uncertain" :
          item.status === "failed" || item.status === "saved" ? item.status : "uncertain",
        acceptanceUncertain: item.acceptanceUncertain ||
          ((item.status === "sending" || item.status === "uncertain") && Boolean(item.transport)) || !raw,
        recoveryBlockedReason: item.recoveryBlockedReason ?? (!raw && !item.transport
          ? "旧提交未保存发送路由，无法安全重试。请先在执行过程中确认是否已接收；原文可在此查看。"
          : undefined),
        promoteTarget: item.promoteTarget, transport: item.transport,
      });
    }
  } catch { /* Malformed storage must not prevent use of the composer. */ }
  submissions.set(workflowId, result);
  for (const item of result) retainSubmissionAttachmentFiles(workflowId, item.requestId, item.attachmentRecords);
  return result;
}
export function listConversationSubmissions(workflowId: string): CommittedSubmission[] {
  return [...submissionList(workflowId)];
}
export function peekCommittedSubmission(workflowId: string): CommittedSubmission | undefined {
  return submissionList(workflowId).find(item => item.status === "sending" || item.status === "uncertain");
}
export function peekFailedSubmission(workflowId: string): CommittedSubmission | undefined {
  return submissionList(workflowId).find(item => item.status === "failed");
}
export function resetConversationSubmissions(): void {
  submissions.clear();
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
  promoteTarget?: { workflowId: string; asideId: string };
}): string | undefined {
  if (params.readonly || params.mode !== "formal") return undefined;
  if (params.receivedFormal) return "指导已保存，具体执行与回应见执行过程";
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
  const sendText = parsed.text;
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

function sameSubmissionContent(current: ConversationDraft, submission: SubmissionPayload): boolean {
  return current.text === submission.draftText &&
    JSON.stringify(current.refs) === JSON.stringify(submission.refs) &&
    JSON.stringify(current.attachments.map(item => item.id)) === JSON.stringify(submission.attachments.map(item => item.id));
}
function hasDraftContent(current: ConversationDraft): boolean {
  return Boolean(current.text || current.refs.length || current.attachments.length);
}
function clearSubmittedDraft(workflowId: string, submission: CommittedSubmission): void {
  const current = storedDraft(workflowId);
  if (current.requestId !== submission.requestId || !sameSubmissionContent(current, submission)) return;
  takeConversationAttachments(workflowId, current.attachments.map(item => item.id));
  Object.assign(current, emptyDraft());
  current.promoteTarget = undefined;
  persistDraft(workflowId, current);
}
export function commitConversationSubmission(workflowId: string, payload: SubmissionPayload): CommittedSubmission {
  const list = submissionList(workflowId);
  const previous = list.find(item => item.requestId === payload.requestId);
  const current = storedDraft(workflowId);
  if (previous && sameSubmissionContent(current, previous)) {
    return beginConversationSubmission(workflowId, previous);
  }
  const requestId = previous ? newRequestId() : payload.requestId;
  const submission: CommittedSubmission = {
    ...payload, workflowId, requestId, refs: [...payload.refs], attachments: [...payload.attachments],
    attachmentRecords: snapshotConversationAttachments(workflowId).filter(item => payload.attachments.some(file => file.id === (item.fileId ?? item.clientId))),
    committedAt: Date.now(), status: "sending",
    promoteTarget: payload.promoteTarget ?? current.promoteTarget,
  };
  list.push(submission);
  retainSubmissionAttachmentFiles(workflowId, submission.requestId, submission.attachmentRecords);
  // Persist the complete recovery copy before clearing editable content.
  persistSubmissions(workflowId);
  if (current.requestId === payload.requestId && sameSubmissionContent(current, payload)) {
    current.requestId = requestId;
    clearSubmittedDraft(workflowId, submission);
  }
  notifyDraft(workflowId);
  return submission;
}
export function beginConversationSubmission(workflowId: string, submission: CommittedSubmission): CommittedSubmission {
  if (submission.recoveryBlockedReason) throw new Error(submission.recoveryBlockedReason);
  if (submission.status === "uncertain" && submission.transport) submission.acceptanceUncertain = true;
  const current = storedDraft(workflowId);
  if (current.requestId === submission.requestId && !sameSubmissionContent(current, submission)) {
    current.requestId = newRequestId();
    persistDraft(workflowId, current);
  }
  submission.status = "sending";
  persistSubmissions(workflowId);
  clearSubmittedDraft(workflowId, submission);
  notifyDraft(workflowId);
  return submission;
}
export function setConversationSubmissionTransport(workflowId: string, submission: CommittedSubmission, transport: NonNullable<CommittedSubmission["transport"]>): void {
  submission.transport = transport;
  persistSubmissions(workflowId);
}
function releaseUnusedAttachmentPreviews(workflowId: string, submission: CommittedSubmission): void {
  const retained = [
    ...snapshotConversationAttachments(workflowId),
    ...submissionList(workflowId).flatMap(item => item.attachmentRecords),
  ];
  releaseConversationAttachments(submission.attachmentRecords.filter(item =>
    !retained.some(other => other.previewUrl && other.previewUrl === item.previewUrl),
  ));
}
export function resolveConversationSubmissionSuccess(workflowId: string, submission: CommittedSubmission): void {
  submissions.set(workflowId, submissionList(workflowId).filter(item => item.requestId !== submission.requestId));
  releaseSubmissionAttachmentFiles(workflowId, submission.requestId);
  releaseUnusedAttachmentPreviews(workflowId, submission);
  const current = storedDraft(workflowId);
  if (current.requestId === submission.requestId) current.requestId = newRequestId();
  if (!hasDraftContent(current)) {
    current.receivedFormal = submission.mode === "formal";
  }
  persistDraft(workflowId, current);
  persistSubmissions(workflowId);
}
export function isDefiniteSubmissionRejection(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status;
  // A timeout or server failure may occur after acceptance. Retry its frozen request.
  return typeof status === "number" && status >= 400 && status < 500 && status !== 408;
}
function putSubmissionInDraft(workflowId: string, submission: CommittedSubmission): void {
  const current = storedDraft(workflowId);
  Object.assign(current, {
    text: submission.draftText, refs: [...submission.refs], attachments: [...submission.attachments],
    requestId: submission.requestId, receivedFormal: false, promoteTarget: submission.promoteTarget,
  });
  restoreConversationAttachments(workflowId, submission.attachmentRecords);
  // The actual attachment queue is the source of truth, including restored metadata.
  if (submission.attachmentRecords.length) current.attachments = draftConversationAttachments(submission.attachmentRecords);
  persistDraft(workflowId, current);
}
export function resolveConversationSubmissionFailure(workflowId: string, submission: CommittedSubmission, error?: unknown): void {
  // A later rejection cannot prove that an earlier attempt was never accepted.
  // In particular, an idempotency conflict must not unlock editing of an uncertain request.
  submission.acceptanceUncertain = submission.acceptanceUncertain ||
    (Boolean(submission.transport) && !isDefiniteSubmissionRejection(error));
  submission.status = submission.acceptanceUncertain ? "uncertain" : "failed";
  const current = storedDraft(workflowId);
  if (submission.status === "failed" && !hasDraftContent(current)) putSubmissionInDraft(workflowId, submission);
  persistSubmissions(workflowId);
}
export function restoreFailedConversationSubmission(workflowId: string, requestId?: string): boolean {
  const list = submissionList(workflowId);
  const submission = requestId ? list.find(item => item.requestId === requestId) : peekFailedSubmission(workflowId);
  if (!submission || submission.recoveryBlockedReason || (submission.status !== "failed" && submission.status !== "saved")) return false;
  const current = storedDraft(workflowId);
  const records = snapshotConversationAttachments(workflowId);
  if (records.some(item => item.status === "pending" || item.status === "uploading")) return false;
  current.attachments = draftConversationAttachments(records);
  if (hasDraftContent(current) && !sameSubmissionContent(current, submission)) {
    const parsed = parseConversationInput(current.text);
    // Preserve edits independently; an unchanged failed request already has a copy.
    if (!list.some(item => item.requestId === current.requestId && sameSubmissionContent(current, item))) {
      const saved: CommittedSubmission = {
        workflowId, requestId: newRequestId(), draftText: current.text, sendText: parsed.text,
        refs: [...current.refs], attachments: [...current.attachments], attachmentRecords: records,
        mode: parsed.mode, committedAt: Date.now(), status: "saved", promoteTarget: current.promoteTarget,
      };
      list.push(saved);
      retainSubmissionAttachmentFiles(workflowId, saved.requestId, saved.attachmentRecords);
      persistSubmissions(workflowId);
    }
    takeConversationAttachments(workflowId, current.attachments.map(item => item.id));
  }
  putSubmissionInDraft(workflowId, submission);
  // Keep failed requests for exact retries; a saved draft now lives in the composer.
  if (submission.status === "saved") {
    submissions.set(workflowId, list.filter(item => item !== submission));
    releaseSubmissionAttachmentFiles(workflowId, submission.requestId);
  }
  persistSubmissions(workflowId);
  return true;
}
export function discardFailedConversationSubmission(workflowId: string, requestId?: string): void {
  const submission = requestId ? submissionList(workflowId).find(item => item.requestId === requestId) : peekFailedSubmission(workflowId);
  if (!submission || submission.status === "sending") return;
  submissions.set(workflowId, submissionList(workflowId).filter(item => item !== submission));
  releaseSubmissionAttachmentFiles(workflowId, submission.requestId);
  releaseUnusedAttachmentPreviews(workflowId, submission);
  persistSubmissions(workflowId);
}

export function useConversationDraft(workflowId: string) {
  const [, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const draft = storedDraft(workflowId);
  useEffect(() => {
    const set = listeners.get(workflowId) ?? new Set<() => void>();
    set.add(refresh);
    listeners.set(workflowId, set);
    return () => { set.delete(refresh); };
  }, [workflowId, refresh]);

  const replace = useCallback(
    (patch: Partial<ConversationDraft>) => {
      const current = storedDraft(workflowId);
      Object.assign(current, patch);
      const source = submissionList(workflowId).find(item => item.requestId === current.requestId);
      if (source && !sameSubmissionContent(current, source)) current.requestId = newRequestId();
      persistDraft(workflowId, current);
      notifyDraft(workflowId);
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

  const commitSubmission = useCallback((payload: SubmissionPayload) => commitConversationSubmission(workflowId, payload), [workflowId]);
  const beginSubmission = useCallback((submission: CommittedSubmission) => beginConversationSubmission(workflowId, submission), [workflowId]);
  const setSubmissionTransport = useCallback((submission: CommittedSubmission, transport: NonNullable<CommittedSubmission["transport"]>) => setConversationSubmissionTransport(workflowId, submission, transport), [workflowId]);
  const resolveSubmissionSuccess = useCallback((submission: CommittedSubmission) => resolveConversationSubmissionSuccess(workflowId, submission), [workflowId]);
  const resolveSubmissionFailure = useCallback((submission: CommittedSubmission, error?: unknown) => resolveConversationSubmissionFailure(workflowId, submission, error), [workflowId]);
  const restoreFailedSubmission = useCallback((requestId?: string) => restoreFailedConversationSubmission(workflowId, requestId), [workflowId]);
  const discardFailedSubmission = useCallback((requestId?: string) => discardFailedConversationSubmission(workflowId, requestId), [workflowId]);

  return {
    draft, setText, setRefs, setAttachments, applySuccessfulSend,
    commitSubmission, beginSubmission, setSubmissionTransport,
    resolveSubmissionSuccess, resolveSubmissionFailure,
    restoreFailedSubmission, discardFailedSubmission,
    submissions: listConversationSubmissions(workflowId),
    failedSubmission: peekFailedSubmission(workflowId),
  };
}
