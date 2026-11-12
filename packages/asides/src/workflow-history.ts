import type { Store } from "../../store/src/store.js";
import type { AsideSession } from "../../contracts/src/feedback.js";
import type { Workflow } from "../../contracts/src/index.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  FlowError,
  WorkflowAsideCursorSchema,
  WorkflowAsideIndexSchema,
  type WorkflowAsideCursor,
  type WorkflowAsideIndex,
} from "../../contracts/src/index.js";
import { now } from "../../core/src/util.js";
import {
  ASIDE_BACKFILL_BATCH,
  clampAsidePageLimit,
  compareAsideAsc,
  compareAsideDesc,
  computeAsidePosition,
  decodeScopedCursor,
  encodeScopedCursor,
  invalidAsideCursor,
  paginateScopedMembers,
  questionPreview,
  resolveSnapshotSeq,
  type AsideListQuery,
  type AsidePosition,
} from "./history-shared.js";

const INDEX_KIND = CONVERSATION_ENTITY.workflowAsideIndex;
const CURSOR_KIND = CONVERSATION_ENTITY.workflowAsideCursor;

export type WorkflowAsideListPage = {
  items: WorkflowAsideIndex[];
  total: number;
  next_cursor: string | null;
  snapshot_cursor: number;
};

export type WorkflowAsideUpdateItem = {
  id: string;
  status: WorkflowAsideIndex["status"];
  updated_seq: number;
};

export type WorkflowAsideUpdatePage = {
  items: WorkflowAsideUpdateItem[];
  snapshot_cursor: number;
};

export function encodeWorkflowAsideCursor(input: {
  workflow_id: string;
  created_at: string;
  id: string;
  snapshot: number;
}): string {
  return encodeScopedCursor("workflow_id", input.workflow_id, {
    created_at: input.created_at,
    id: input.id,
    snapshot: input.snapshot,
  });
}

export function decodeWorkflowAsideCursor(
  raw: string,
  expectedWorkflowId: string,
) {
  return decodeScopedCursor(
    raw,
    "workflow_id",
    expectedWorkflowId,
    "分页游标不属于当前任务",
  );
}

/**
 * 按任务（workflow_id）严格隔离的临时提问历史与增量游标服务。
 */
export class WorkflowAsideHistory {
  constructor(private store: Store) {}

  recordSession(session: AsideSession): WorkflowAsideIndex | undefined {
    const workflow = this.store.get<Workflow>("workflow", session.workflow_id);
    if (!workflow?.project_id) {
      console.error("跳过无归属任务提问索引", session.id, session.workflow_id);
      return undefined;
    }
    return this.writeIndex(workflow, session);
  }

  backfillWorkflow(
    workflowId: string,
    limit = ASIDE_BACKFILL_BATCH,
  ): number {
    const workflow = this.store.get<Workflow>("workflow", workflowId);
    if (!workflow?.project_id) return 0;
    const missing = this.store
      .list<AsideSession>("aside_session", workflowId)
      .filter(
        (session) =>
          session.workflow_id === workflowId &&
          !this.store.get(INDEX_KIND, session.id),
      )
      .sort(compareAsideAsc)
      .slice(0, Math.max(0, limit));
    let written = 0;
    for (const session of missing) {
      if (this.writeIndex(workflow, session)) written += 1;
    }
    return written;
  }

  listPage(
    workflowId: string,
    query: AsideListQuery = {},
  ): WorkflowAsideListPage {
    this.requireWorkflow(workflowId);
    this.backfillWorkflow(workflowId);
    const limit = clampAsidePageLimit(query.limit);
    const snapshot = this.resolveListSnapshot(workflowId, query);
    const members = this.snapshotMembers(workflowId, snapshot);
    return paginateScopedMembers({
      members,
      limit,
      snapshot,
      before: query.before,
      decodeCursor: (raw) => decodeWorkflowAsideCursor(raw, workflowId),
      encodeCursor: (last) =>
        encodeWorkflowAsideCursor({
          workflow_id: workflowId,
          created_at: last.created_at,
          id: last.id,
          snapshot,
        }),
    });
  }

  position(
    workflowId: string,
    asideId: string,
    snapshotCursor?: number,
  ): AsidePosition {
    this.requireWorkflow(workflowId);
    this.backfillWorkflow(workflowId);
    const item = this.requireWorkflowIndex(workflowId, asideId);
    const snapshot = this.resolveSnapshot(workflowId, snapshotCursor);
    if (item.created_seq > snapshot) {
      throw new FlowError(
        CONVERSATION_ERROR.NOT_FOUND,
        "提问不在当前历史快照中",
        404,
      );
    }
    return computeAsidePosition(this.snapshotMembers(workflowId, snapshot), asideId);
  }

  listUpdates(workflowId: string, after = 0): WorkflowAsideUpdatePage {
    this.requireWorkflow(workflowId);
    this.backfillWorkflow(workflowId);
    if (!Number.isInteger(after) || after < 0) {
      throw invalidAsideCursor("增量游标无效");
    }
    const snapshot = this.currentSnapshot(workflowId);
    const items = this.store
      .list<WorkflowAsideIndex>(INDEX_KIND, workflowId)
      .filter((row) => row.workflow_id === workflowId && row.updated_seq > after)
      .sort((a, b) => a.updated_seq - b.updated_seq)
      .map((row) => ({
        id: row.id,
        status: row.status,
        updated_seq: row.updated_seq,
      }));
    return { items, snapshot_cursor: snapshot };
  }

  getDetail(workflowId: string, asideId: string): AsideSession {
    this.requireWorkflow(workflowId);
    const session = this.store.get<AsideSession>("aside_session", asideId);
    if (!session || session.workflow_id !== workflowId) {
      throw new FlowError(
        CONVERSATION_ERROR.ASIDE_NOT_IN_WORKFLOW,
        "提问不属于该任务",
        404,
      );
    }
    return session;
  }

  currentSnapshot(workflowId: string): number {
    return this.loadCursor(workflowId)?.seq ?? 0;
  }

  private requireWorkflow(workflowId: string): Workflow {
    const workflow = this.store.get<Workflow>("workflow", workflowId);
    if (!workflow) {
      throw new FlowError(
        CONVERSATION_ERROR.NOT_FOUND,
        `工作流 ${workflowId} 不存在`,
        404,
      );
    }
    return workflow;
  }

  private resolveListSnapshot(
    workflowId: string,
    query: AsideListQuery,
  ): number {
    const fromCursor = query.before
      ? decodeWorkflowAsideCursor(query.before, workflowId).snapshot
      : undefined;
    if (
      fromCursor !== undefined &&
      query.snapshot_cursor !== undefined &&
      fromCursor !== query.snapshot_cursor
    ) {
      throw invalidAsideCursor("分页游标与快照不一致");
    }
    return this.resolveSnapshot(workflowId, fromCursor ?? query.snapshot_cursor);
  }

  private resolveSnapshot(workflowId: string, requested?: number): number {
    return resolveSnapshotSeq(this.currentSnapshot(workflowId), requested);
  }

  private snapshotMembers(
    workflowId: string,
    snapshot: number,
  ): WorkflowAsideIndex[] {
    return this.store
      .list<WorkflowAsideIndex>(INDEX_KIND, workflowId)
      .filter(
        (row) => row.workflow_id === workflowId && row.created_seq <= snapshot,
      )
      .sort(compareAsideDesc);
  }

  private requireWorkflowIndex(
    workflowId: string,
    asideId: string,
  ): WorkflowAsideIndex {
    const item = this.store.get<WorkflowAsideIndex>(INDEX_KIND, asideId);
    if (!item || item.workflow_id !== workflowId) {
      throw new FlowError(
        CONVERSATION_ERROR.ASIDE_NOT_IN_WORKFLOW,
        "提问不属于该任务",
        404,
      );
    }
    return item;
  }

  private writeIndex(
    workflow: Workflow,
    session: AsideSession,
  ): WorkflowAsideIndex | undefined {
    const existing = this.store.get<WorkflowAsideIndex>(INDEX_KIND, session.id);
    if (existing && existing.workflow_id !== workflow.id) {
      console.error("跳过跨任务提问索引", session.id, existing.workflow_id);
      return existing;
    }
    const cursor = this.bumpCursor(workflow.id);
    const item = WorkflowAsideIndexSchema.parse({
      id: session.id,
      project_id: workflow.project_id,
      workflow_id: workflow.id,
      workflow_title: workflow.title?.trim() || "未命名任务",
      question_preview: questionPreview(session.question),
      status: session.status,
      created_at: session.created_at,
      created_seq: existing?.created_seq ?? cursor.seq,
      updated_seq: cursor.seq,
    });
    this.store.put(INDEX_KIND, item.id, workflow.id, item);
    return item;
  }

  private bumpCursor(workflowId: string): WorkflowAsideCursor {
    const current = this.loadCursor(workflowId);
    const cursor = WorkflowAsideCursorSchema.parse({
      workflow_id: workflowId,
      seq: (current?.seq ?? 0) + 1,
      updated_at: now(),
    });
    this.store.put(CURSOR_KIND, workflowId, workflowId, cursor);
    return cursor;
  }

  private loadCursor(workflowId: string): WorkflowAsideCursor | undefined {
    const raw = this.store.get<WorkflowAsideCursor>(CURSOR_KIND, workflowId);
    if (!raw) return undefined;
    const parsed = WorkflowAsideCursorSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }
}
