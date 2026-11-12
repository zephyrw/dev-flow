import type { Store } from "../../store/src/store.js";
import type { AsideSession } from "../../contracts/src/feedback.js";
import type { Workflow } from "../../contracts/src/index.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  CONVERSATION_EVENT,
  FlowError,
  ProjectAsideCursorSchema,
  ProjectAsideIndexSchema,
  type ProjectAsideCursor,
  type ProjectAsideIndex,
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

const INDEX_KIND = CONVERSATION_ENTITY.projectAsideIndex;
const CURSOR_KIND = CONVERSATION_ENTITY.projectAsideCursor;
export const PROJECT_ASIDE_BACKFILL_BATCH = ASIDE_BACKFILL_BATCH;

export type AsidePageCursor = {
  project_id: string;
  created_at: string;
  id: string;
  snapshot: number;
};

export type { AsideListQuery, AsidePosition };

export type AsideListPage = {
  items: ProjectAsideIndex[];
  total: number;
  next_cursor: string | null;
  snapshot_cursor: number;
};

export type AsideUpdateItem = {
  id: string;
  status: ProjectAsideIndex["status"];
  updated_project_seq: number;
};

export type AsideUpdatePage = {
  items: AsideUpdateItem[];
  snapshot_cursor: number;
};

export function encodeAsidePageCursor(cursor: AsidePageCursor): string {
  return encodeScopedCursor("project_id", cursor.project_id, {
    created_at: cursor.created_at,
    id: cursor.id,
    snapshot: cursor.snapshot,
  });
}

export function decodeAsidePageCursor(
  raw: string,
  expectedProjectId: string,
): AsidePageCursor {
  const parsed = decodeScopedCursor(
    raw,
    "project_id",
    expectedProjectId,
    "分页游标不属于当前项目",
  );
  return {
    project_id: parsed.scope,
    created_at: parsed.created_at,
    id: parsed.id,
    snapshot: parsed.snapshot,
  };
}

export { clampAsidePageLimit };

export class ProjectAsideHistory {
  constructor(private store: Store) {}

  recordSession(session: AsideSession): ProjectAsideIndex | undefined {
    const workflow = this.store.get<Workflow>("workflow", session.workflow_id);
    if (!workflow?.project_id || !workflow.title) {
      console.error("跳过无归属提问索引", session.id, session.workflow_id);
      return undefined;
    }
    return this.writeIndex(workflow.project_id, workflow, session);
  }

  backfillProject(
    projectId: string,
    limit = PROJECT_ASIDE_BACKFILL_BATCH,
  ): number {
    const missing = this.unindexedSessions(projectId);
    const batch = missing.slice(0, Math.max(0, limit));
    let written = 0;
    for (const { workflow, session } of batch) {
      if (this.writeIndex(projectId, workflow, session)) written += 1;
    }
    return written;
  }

  listPage(projectId: string, query: AsideListQuery = {}): AsideListPage {
    this.backfillProject(projectId);
    const limit = clampAsidePageLimit(query.limit);
    const snapshot = this.resolveListSnapshot(projectId, query);
    const members = this.snapshotMembers(projectId, snapshot);
    return paginateScopedMembers({
      members,
      limit,
      snapshot,
      before: query.before,
      decodeCursor: (raw) => decodeAsidePageCursor(raw, projectId),
      encodeCursor: (last) =>
        encodeAsidePageCursor({
          project_id: projectId,
          created_at: last.created_at,
          id: last.id,
          snapshot,
        }),
    });
  }

  position(
    projectId: string,
    asideId: string,
    snapshotCursor?: number,
  ): AsidePosition {
    this.backfillProject(projectId);
    const item = this.requireProjectIndex(projectId, asideId);
    const snapshot = this.resolveSnapshot(projectId, snapshotCursor);
    if (item.created_project_seq > snapshot) {
      throw new FlowError(
        CONVERSATION_ERROR.NOT_FOUND,
        "提问不在当前历史快照中",
        404,
      );
    }
    return computeAsidePosition(this.snapshotMembers(projectId, snapshot), asideId);
  }

  listUpdates(projectId: string, after = 0): AsideUpdatePage {
    this.backfillProject(projectId);
    if (!Number.isInteger(after) || after < 0) {
      throw invalidAsideCursor("增量游标无效");
    }
    const snapshot = this.currentSnapshot(projectId);
    const items = this.store
      .list<ProjectAsideIndex>(INDEX_KIND, projectId)
      .filter((row) => row.updated_project_seq > after)
      .sort((a, b) => a.updated_project_seq - b.updated_project_seq)
      .map((row) => ({
        id: row.id,
        status: row.status,
        updated_project_seq: row.updated_project_seq,
      }));
    return { items, snapshot_cursor: snapshot };
  }

  currentSnapshot(projectId: string): number {
    return this.loadCursor(projectId)?.seq ?? 0;
  }

  private resolveListSnapshot(projectId: string, query: AsideListQuery): number {
    const fromCursor = query.before
      ? decodeAsidePageCursor(query.before, projectId).snapshot
      : undefined;
    if (
      fromCursor !== undefined &&
      query.snapshot_cursor !== undefined &&
      fromCursor !== query.snapshot_cursor
    ) {
      throw invalidAsideCursor("分页游标与快照不一致");
    }
    return this.resolveSnapshot(projectId, fromCursor ?? query.snapshot_cursor);
  }

  private resolveSnapshot(projectId: string, requested?: number): number {
    return resolveSnapshotSeq(this.currentSnapshot(projectId), requested);
  }

  private snapshotMembers(
    projectId: string,
    snapshot: number,
  ): ProjectAsideIndex[] {
    return this.store
      .list<ProjectAsideIndex>(INDEX_KIND, projectId)
      .filter((row) => row.created_project_seq <= snapshot)
      .sort(compareAsideDesc);
  }

  private requireProjectIndex(
    projectId: string,
    asideId: string,
  ): ProjectAsideIndex {
    const item = this.store.get<ProjectAsideIndex>(INDEX_KIND, asideId);
    if (!item || item.project_id !== projectId) {
      throw new FlowError(
        CONVERSATION_ERROR.ASIDE_NOT_IN_PROJECT,
        "提问不属于该项目",
        404,
      );
    }
    return item;
  }

  private unindexedSessions(projectId: string): Array<{
    workflow: Workflow;
    session: AsideSession;
  }> {
    const missing: Array<{ workflow: Workflow; session: AsideSession }> = [];
    for (const workflow of this.store.list<Workflow>("workflow", projectId)) {
      if (workflow.project_id !== projectId) continue;
      for (const session of this.store.list<AsideSession>(
        "aside_session",
        workflow.id,
      )) {
        if (this.store.get(INDEX_KIND, session.id)) continue;
        missing.push({ workflow, session });
      }
    }
    missing.sort((a, b) => compareAsideAsc(a.session, b.session));
    return missing;
  }

  private writeIndex(
    projectId: string,
    workflow: Workflow,
    session: AsideSession,
  ): ProjectAsideIndex | undefined {
    const existing = this.store.get<ProjectAsideIndex>(INDEX_KIND, session.id);
    if (existing && existing.project_id !== projectId) {
      console.error("跳过跨项目提问索引", session.id, existing.project_id);
      return existing;
    }
    const cursor = this.bumpCursor(projectId);
    const item = ProjectAsideIndexSchema.parse({
      id: session.id,
      project_id: projectId,
      workflow_id: session.workflow_id,
      workflow_title: workflow.title,
      question_preview: questionPreview(session.question),
      status: session.status,
      created_at: session.created_at,
      created_project_seq: existing?.created_project_seq ?? cursor.seq,
      updated_project_seq: cursor.seq,
    });
    this.store.put(INDEX_KIND, item.id, projectId, item);
    this.store.event(
      session.workflow_id,
      projectId,
      CONVERSATION_EVENT.asideUpdated,
      {
        aside_id: item.id,
        project_id: projectId,
        status: item.status,
        created_project_seq: item.created_project_seq,
        updated_project_seq: item.updated_project_seq,
      },
    );
    return item;
  }

  private bumpCursor(projectId: string): ProjectAsideCursor {
    const current = this.loadCursor(projectId);
    const cursor = ProjectAsideCursorSchema.parse({
      project_id: projectId,
      seq: (current?.seq ?? 0) + 1,
      updated_at: now(),
    });
    this.store.put(CURSOR_KIND, projectId, projectId, cursor);
    return cursor;
  }

  private loadCursor(projectId: string): ProjectAsideCursor | undefined {
    const raw = this.store.get<ProjectAsideCursor>(CURSOR_KIND, projectId);
    if (!raw) return undefined;
    const parsed = ProjectAsideCursorSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  }
}
