import { useCallback, useEffect, useRef, useState } from "react";
import { shouldRenderConversationComposer } from "./use-conversation-draft.js";

export const ASIDE_UPDATE_POLL_MS = 2000;

export type AsideStatus =
  | "active"
  | "queued"
  | "completed"
  | "expired"
  | "cancelled";

export type ProjectAsideSummary = {
  id: string;
  project_id: string;
  workflow_id: string;
  workflow_title: string;
  question_preview: string;
  status: AsideStatus;
  created_at: string;
};

export type ProjectAsideListPage = {
  items: ProjectAsideSummary[];
  total: number;
  next_cursor: string | null;
  snapshot_cursor: number;
};

export type ProjectAsidePosition = {
  index: number;
  total: number;
  prev_id?: string;
  next_id?: string;
};

export type ProjectAsideUpdateItem = {
  id: string;
  status: AsideStatus;
  updated_project_seq: number;
};

export type ProjectAsideUpdatePage = {
  items: ProjectAsideUpdateItem[];
  snapshot_cursor: number;
};

export type AsideDetail = {
  id: string;
  workflow_id: string;
  question: string;
  answer?: string;
  status: AsideStatus;
  created_at: string;
  refs?: unknown[];
};

type ProjectAsideUi = {
  selectedId?: string;
  snapshotCursor?: number;
  updateCursor?: number;
};

type PromoteDraftTarget = {
  workflowId: string;
  asideId: string;
};

const uiByProject = new Map<string, ProjectAsideUi>();
const promoteByComposer = new Map<string, PromoteDraftTarget>();

export function readProjectAsideUi(projectId: string): ProjectAsideUi {
  return uiByProject.get(projectId) ?? {};
}

export function writeProjectAsideUi(
  projectId: string,
  patch: Partial<ProjectAsideUi>,
): ProjectAsideUi {
  const next = { ...readProjectAsideUi(projectId), ...patch };
  uiByProject.set(projectId, next);
  return next;
}

export function clearProjectAsideUi(projectId: string): void {
  uiByProject.delete(projectId);
}

export function resetProjectAsideUi(): void {
  uiByProject.clear();
  promoteByComposer.clear();
}

export function writeAsidePromoteDraft(
  composerWorkflowId: string,
  target: PromoteDraftTarget,
): void {
  promoteByComposer.set(composerWorkflowId, target);
}

export function peekAsidePromoteDraft(
  composerWorkflowId: string,
): PromoteDraftTarget | undefined {
  return promoteByComposer.get(composerWorkflowId);
}

export function clearAsidePromoteDraft(composerWorkflowId: string): void {
  promoteByComposer.delete(composerWorkflowId);
}

export function isPendingAsideStatus(status: string): boolean {
  return status === "active" || status === "queued";
}

export function asideStatusLabel(status: string): string {
  return (
    {
      active: "正在回答…",
      queued: "等待回答",
      completed: "已回答",
      cancelled: "已取消",
      expired: "未完成",
    } as Record<string, string>
  )[status] ?? status;
}

export function asidePositionLabel(
  position?: ProjectAsidePosition | null,
): string {
  const index = position?.index ?? 0;
  const total = position?.total ?? 0;
  return `${index}/${total}`;
}

export function isAsideNavDisabled(
  kind: "prev" | "next",
  position?: ProjectAsidePosition | null,
): boolean {
  if (!position || position.total <= 0) return true;
  if (kind === "prev") return !position.prev_id || position.index <= 1;
  return !position.next_id || position.index >= position.total;
}

export function shouldPollProjectAsideUpdates(input: {
  popoverOpen: boolean;
  hasPending: boolean;
}): boolean {
  return input.popoverOpen || input.hasPending;
}

export function shouldHideAsidePopover(input: {
  selectedConversationId?: string;
  rootConversationId?: string;
}): boolean {
  return !shouldRenderConversationComposer(input);
}

export function nextProjectAsideSelection(input: {
  previousProjectId?: string;
  nextProjectId?: string;
  previousSelectedId?: string;
}): string | undefined {
  if (!input.nextProjectId) return undefined;
  if (
    input.previousProjectId &&
    input.previousProjectId !== input.nextProjectId
  ) {
    return undefined;
  }
  return input.previousSelectedId;
}

export function snapshotAfterProjectSwitch(input: {
  previousProjectId?: string;
  nextProjectId?: string;
  previousSnapshot?: number;
}): number | undefined {
  if (!input.nextProjectId) return undefined;
  if (
    input.previousProjectId &&
    input.previousProjectId !== input.nextProjectId
  ) {
    return undefined;
  }
  return input.previousSnapshot;
}

export function defaultSelectedAsideId(
  items: Array<{ id: string }>,
): string | undefined {
  return items[0]?.id;
}

export function isViewingHistoricalAside(
  position?: Pick<ProjectAsidePosition, "index"> | null,
): boolean {
  return !!position && position.index > 1;
}

export function resolveBackgroundAsideArrival(input: {
  selectedId?: string;
  newIds: string[];
}): { selectedId?: string; notifyNew: boolean } {
  const strangers = input.newIds.filter((id) => id !== input.selectedId);
  return {
    selectedId: input.selectedId,
    notifyNew: strangers.length > 0,
  };
}

export function shouldRefreshAsideDetail(input: {
  selectedId?: string;
  updates: Array<{ id: string }>;
}): boolean {
  if (!input.selectedId) return false;
  return input.updates.some((item) => item.id === input.selectedId);
}

export function nextPendingIds(
  previous: string[],
  updates: Array<{ id: string; status: string }>,
): string[] {
  const pending = new Set(previous);
  for (const item of updates) {
    if (isPendingAsideStatus(item.status)) pending.add(item.id);
    else pending.delete(item.id);
  }
  return [...pending];
}

export function pendingIdsFromSummaries(
  items: Array<{ id: string; status: string }>,
): string[] {
  return items.filter((item) => isPendingAsideStatus(item.status)).map((item) => item.id);
}

export function showAsideSourceWorkflow(
  asideWorkflowId: string,
  currentWorkflowId: string,
): boolean {
  return asideWorkflowId !== currentWorkflowId;
}

export function promoteButtonLabel(workflowTitle: string): string {
  return `转为「${workflowTitle}」的正式反馈`;
}

export function promoteDraftText(aside: {
  question: string;
  answer?: string;
}): string {
  return aside.answer ? `${aside.question}\n${aside.answer}` : aside.question;
}

export function summaryFromCreatedAside(input: {
  session: {
    id: string;
    workflow_id: string;
    question: string;
    status: string;
    created_at: string;
  };
  projectId: string;
  workflowTitle: string;
}): ProjectAsideSummary {
  const question = input.session.question ?? "";
  return {
    id: input.session.id,
    project_id: input.projectId,
    workflow_id: input.session.workflow_id,
    workflow_title: input.workflowTitle.trim() || "未命名任务",
    question_preview: question.length <= 500 ? question : question.slice(0, 500),
    status: input.session.status as AsideStatus,
    created_at: input.session.created_at,
  };
}

export function upsertAside<T extends { id: string }>(list: T[], item: T): T[] {
  if (!item?.id) return list;
  return [...list.filter((aside) => aside.id !== item.id), item];
}

export async function readAsides(
  workflowId: string,
  signal?: AbortSignal,
): Promise<AsideDetail[]> {
  const response = await fetch("/api/workflows/" + workflowId + "/asides", {
    credentials: "same-origin",
    signal,
  });
  const value = await readApiJson(response, "无法读取临时提问");
  if (!Array.isArray(value)) throw new Error("临时提问响应格式无效");
  return value;
}

export async function readProjectAsidePage(
  projectId: string,
  query: { limit?: number; before?: string; snapshot_cursor?: number } = {},
  signal?: AbortSignal,
): Promise<ProjectAsideListPage> {
  const params = new URLSearchParams();
  if (query.limit !== undefined) params.set("limit", String(query.limit));
  if (query.before) params.set("before", query.before);
  if (query.snapshot_cursor !== undefined) {
    params.set("snapshot_cursor", String(query.snapshot_cursor));
  }
  const suffix = params.toString();
  const response = await fetch(
    "/api/projects/" + projectId + "/asides" + (suffix ? "?" + suffix : ""),
    { credentials: "same-origin", signal },
  );
  return readApiJson(response, "无法读取项目提问");
}

export async function readProjectAsidePosition(
  projectId: string,
  asideId: string,
  snapshotCursor?: number,
  signal?: AbortSignal,
): Promise<ProjectAsidePosition> {
  const params = new URLSearchParams();
  if (snapshotCursor !== undefined) {
    params.set("snapshot_cursor", String(snapshotCursor));
  }
  const suffix = params.toString();
  const response = await fetch(
    "/api/projects/" +
      projectId +
      "/asides/" +
      asideId +
      "/position" +
      (suffix ? "?" + suffix : ""),
    { credentials: "same-origin", signal },
  );
  return readApiJson(response, "无法读取提问位置");
}

export async function readProjectAsideUpdates(
  projectId: string,
  after = 0,
  signal?: AbortSignal,
): Promise<ProjectAsideUpdatePage> {
  const response = await fetch(
    "/api/projects/" + projectId + "/aside-updates?after=" + after,
    { credentials: "same-origin", signal },
  );
  return readApiJson(response, "无法读取提问更新");
}

export async function readAsideDetail(
  workflowId: string,
  asideId: string,
  signal?: AbortSignal,
): Promise<AsideDetail> {
  const response = await fetch(
    "/api/workflows/" + workflowId + "/asides/" + asideId,
    { credentials: "same-origin", signal },
  );
  if (response.status === 404) {
    return readAsideDetailFromList(workflowId, asideId, signal);
  }
  return readApiJson(response, "无法读取提问详情");
}

async function readAsideDetailFromList(
  workflowId: string,
  asideId: string,
  signal?: AbortSignal,
): Promise<AsideDetail> {
  const list = await readAsides(workflowId, signal);
  const found = list.find((item) => item.id === asideId);
  if (!found) throw new Error("提问不属于该任务");
  return found;
}

async function findProjectAsideSummary(
  projectId: string,
  asideId: string,
  snapshotCursor: number | undefined,
  signal?: AbortSignal,
): Promise<ProjectAsideSummary | undefined> {
  let before: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await readProjectAsidePage(
      projectId,
      { limit: 50, before, snapshot_cursor: snapshotCursor },
      signal,
    );
    const found = page.items.find((item) => item.id === asideId);
    if (found) return found;
    if (!page.next_cursor || seen.has(page.next_cursor)) return undefined;
    seen.add(page.next_cursor);
    before = page.next_cursor;
  }
}

export function useProjectAsides(input: {
  projectId?: string;
  open: boolean;
  enabled: boolean;
}) {
  const { projectId, open, enabled } = input;
  const [selectedId, setSelectedId] = useState<string | undefined>(
    () => (projectId ? readProjectAsideUi(projectId).selectedId : undefined),
  );
  const [snapshotCursor, setSnapshotCursor] = useState<number | undefined>(
    () => (projectId ? readProjectAsideUi(projectId).snapshotCursor : undefined),
  );
  const [updateCursor, setUpdateCursor] = useState(
    () => (projectId ? readProjectAsideUi(projectId).updateCursor : undefined),
  );
  const [summary, setSummary] = useState<ProjectAsideSummary | null>(null);
  const [detail, setDetail] = useState<AsideDetail | null>(null);
  const [position, setPosition] = useState<ProjectAsidePosition | null>(null);
  const [total, setTotal] = useState(0);
  const [pendingIds, setPendingIds] = useState<string[]>([]);
  const [hasNew, setHasNew] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);

  const summariesRef = useRef(new Map<string, ProjectAsideSummary>());
  const seenIdsRef = useRef(new Set<string>());
  const previousProjectId = useRef<string | undefined>(projectId);
  const selectedIdRef = useRef(selectedId);
  const snapshotRef = useRef(snapshotCursor);
  const updateCursorRef = useRef(updateCursor);
  const positionRef = useRef(position);
  selectedIdRef.current = selectedId;
  snapshotRef.current = snapshotCursor;
  updateCursorRef.current = updateCursor;
  positionRef.current = position;

  const rememberSummary = useCallback((item: ProjectAsideSummary) => {
    summariesRef.current.set(item.id, item);
    seenIdsRef.current.add(item.id);
  }, []);

  const persist = useCallback(
    (patch: Partial<ProjectAsideUi>) => {
      if (!projectId) return;
      writeProjectAsideUi(projectId, patch);
    },
    [projectId],
  );

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  const selectCreated = useCallback(
    (session: AsideDetail, workflowTitle: string) => {
      if (!projectId) return;
      const item = summaryFromCreatedAside({
        session,
        projectId,
        workflowTitle,
      });
      rememberSummary(item);
      if (isViewingHistoricalAside(positionRef.current)) {
        setHasNew(true);
        setPendingIds((ids) => nextPendingIds(ids, [item]));
        setReloadToken((value) => value + 1);
        return;
      }
      setSelectedId(item.id);
      setSummary(item);
      setDetail(session);
      setSnapshotCursor(undefined);
      setHasNew(false);
      setPendingIds((ids) => nextPendingIds(ids, [item]));
      persist({ selectedId: item.id, snapshotCursor: undefined });
      setReloadToken((value) => value + 1);
    },
    [persist, projectId, rememberSummary],
  );

  const goLatest = useCallback(() => {
    setSelectedId(undefined);
    setSnapshotCursor(undefined);
    setHasNew(false);
    persist({ selectedId: undefined, snapshotCursor: undefined });
    setReloadToken((value) => value + 1);
  }, [persist]);

  useEffect(() => {
    const previous = previousProjectId.current;
    previousProjectId.current = projectId;
    if (previous && previous !== projectId) {
      clearProjectAsideUi(previous);
      summariesRef.current.clear();
      seenIdsRef.current.clear();
      setSelectedId(undefined);
      setSnapshotCursor(undefined);
      setUpdateCursor(undefined);
      setSummary(null);
      setDetail(null);
      setPosition(null);
      setTotal(0);
      setPendingIds([]);
      setHasNew(false);
      setError("");
    }
  }, [projectId]);

  useEffect(() => {
    persist({ selectedId, snapshotCursor, updateCursor });
  }, [persist, selectedId, snapshotCursor, updateCursor]);

  useEffect(() => {
    if (!enabled || !projectId) return;
    const id = projectId;
    const abort = new AbortController();
    void loadList(abort.signal);
    return () => abort.abort();

    async function loadList(signal: AbortSignal) {
      try {
        const page = await readProjectAsidePage(
          id,
          { limit: 20, snapshot_cursor: snapshotRef.current },
          signal,
        );
        if (signal.aborted) return;
        for (const item of page.items) rememberSummary(item);
        setTotal(page.total);
        setUpdateCursor(page.snapshot_cursor);
        setPendingIds((ids) => {
          const fromPage = pendingIdsFromSummaries(page.items);
          return [...new Set([...ids, ...fromPage])];
        });
        setError("");
        const currentId = selectedIdRef.current;
        if (currentId && summariesRef.current.has(currentId)) return;
        if (currentId) {
          const found = await findProjectAsideSummary(
            id,
            currentId,
            snapshotRef.current,
            signal,
          );
          if (signal.aborted) return;
          if (found) {
            rememberSummary(found);
            return;
          }
        }
        const latest = defaultSelectedAsideId(page.items);
        if (latest) setSelectedId(latest);
      } catch (cause) {
        if (!signal.aborted && !isAbortError(cause)) {
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      }
    }
  }, [enabled, projectId, rememberSummary, reloadToken]);

  useEffect(() => {
    if (!enabled || !projectId || !selectedId) return;
    const id = projectId;
    const asideId = selectedId;
    const abort = new AbortController();
    void loadSelected(abort.signal);
    return () => abort.abort();

    async function loadSelected(signal: AbortSignal) {
      try {
        let item = summariesRef.current.get(asideId);
        if (!item) {
          item = await findProjectAsideSummary(
            id,
            asideId,
            snapshotRef.current,
            signal,
          );
          if (item) rememberSummary(item);
        }
        if (signal.aborted) return;
        if (!item) {
          setSummary(null);
          setDetail(null);
          return;
        }
        setSummary(item);
        const nextPosition = await readProjectAsidePosition(
          id,
          asideId,
          snapshotRef.current,
          signal,
        );
        if (signal.aborted) return;
        setPosition(nextPosition);
        setTotal(nextPosition.total);
        const nextDetail = await readAsideDetail(
          item.workflow_id,
          item.id,
          signal,
        );
        if (signal.aborted) return;
        setDetail(nextDetail);
        setPendingIds((ids) => nextPendingIds(ids, [nextDetail]));
        setError("");
      } catch (cause) {
        if (!signal.aborted && !isAbortError(cause)) {
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      }
    }
  }, [enabled, projectId, rememberSummary, selectedId, snapshotCursor, reloadToken]);

  const hasPending = pendingIds.length > 0;
  useEffect(() => {
    if (!enabled || !projectId) return;
    if (!shouldPollProjectAsideUpdates({ popoverOpen: open, hasPending })) {
      return;
    }
    const id = projectId;
    const abort = new AbortController();
    const timer = window.setInterval(() => {
      void pullUpdates(abort.signal);
    }, ASIDE_UPDATE_POLL_MS);
    return () => {
      abort.abort();
      window.clearInterval(timer);
    };

    async function pullUpdates(signal: AbortSignal) {
      try {
        const page = await readProjectAsideUpdates(
          id,
          updateCursorRef.current ?? 0,
          signal,
        );
        if (signal.aborted) return;
        const newIds = page.items
          .map((item) => item.id)
          .filter((id) => !seenIdsRef.current.has(id));
        for (const item of page.items) seenIdsRef.current.add(item.id);
        const arrival = resolveBackgroundAsideArrival({
          selectedId: selectedIdRef.current,
          newIds,
        });
        if (arrival.notifyNew) setHasNew(true);
        setPendingIds((ids) => nextPendingIds(ids, page.items));
        for (const item of page.items) {
          const cached = summariesRef.current.get(item.id);
          if (cached) {
            rememberSummary({ ...cached, status: item.status });
          }
        }
        setUpdateCursor(page.snapshot_cursor);
        if (
          shouldRefreshAsideDetail({
            selectedId: selectedIdRef.current,
            updates: page.items,
          })
        ) {
          setReloadToken((value) => value + 1);
        }
      } catch (cause) {
        if (!signal.aborted && !isAbortError(cause)) {
          setError(String(cause instanceof Error ? cause.message : cause));
        }
      }
    }
  }, [enabled, hasPending, open, projectId, rememberSummary]);

  const goPrev = useCallback(() => {
    if (isAsideNavDisabled("prev", position) || !position?.prev_id) return;
    setSelectedId(position.prev_id);
  }, [position]);

  const goNext = useCallback(() => {
    if (isAsideNavDisabled("next", position) || !position?.next_id) return;
    setSelectedId(position.next_id);
  }, [position]);

  return {
    selectedId,
    summary,
    detail,
    position,
    total,
    hasNew,
    hasPending,
    error,
    selectCreated,
    goPrev,
    goNext,
    goLatest,
    reload,
  };
}

async function readApiJson(response: Response, fallback: string) {
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(apiErrorMessage(value, fallback));
  }
  return value;
}

function apiErrorMessage(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const record = value as { message?: unknown; error?: { message?: unknown } };
  if (typeof record.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof record.error?.message === "string" && record.error.message.trim()) {
    return record.error.message;
  }
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
