import type { AsideSession } from "../../contracts/src/feedback.js";
import { CONVERSATION_ERROR, FlowError } from "../../contracts/src/index.js";

export const DEFAULT_ASIDE_PAGE_LIMIT = 20;
export const MAX_ASIDE_PAGE_LIMIT = 50;
export const ASIDE_BACKFILL_BATCH = 200;

export type AsideListQuery = {
  limit?: number;
  before?: string;
  snapshot_cursor?: number;
};

export type AsidePosition = {
  index: number;
  total: number;
  prev_id?: string;
  next_id?: string;
};

export type AsideCursorPayload = {
  scope: string;
  created_at: string;
  id: string;
  snapshot: number;
};

export function invalidAsideCursor(message: string): FlowError {
  return new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, message, 400);
}

export function clampAsidePageLimit(raw?: number): number {
  if (raw === undefined || Number.isNaN(raw)) return DEFAULT_ASIDE_PAGE_LIMIT;
  if (!Number.isInteger(raw) || raw < 1) {
    throw invalidAsideCursor("分页条数无效");
  }
  return Math.min(MAX_ASIDE_PAGE_LIMIT, raw);
}

export function questionPreview(question: string): string {
  return question.length <= 500 ? question : question.slice(0, 500);
}

export function compareAsideDesc(
  a: { created_at: string; id: string },
  b: { created_at: string; id: string },
): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? 1 : -1;
  }
  return a.id < b.id ? 1 : -1;
}

export function compareAsideAsc(
  a: Pick<AsideSession, "created_at" | "id">,
  b: Pick<AsideSession, "created_at" | "id">,
): number {
  if (a.created_at !== b.created_at) {
    return a.created_at < b.created_at ? -1 : 1;
  }
  return a.id < b.id ? -1 : 1;
}

export function isOlderThanAsideCursor(
  item: { created_at: string; id: string },
  cursor: Pick<AsideCursorPayload, "created_at" | "id">,
): boolean {
  if (item.created_at !== cursor.created_at) {
    return item.created_at < cursor.created_at;
  }
  return item.id < cursor.id;
}

export function resolveSnapshotSeq(
  current: number,
  requested?: number,
): number {
  if (requested === undefined) return current;
  if (!Number.isInteger(requested) || requested < 0) {
    throw invalidAsideCursor("快照游标无效");
  }
  return Math.min(requested, current);
}

export function encodeScopedCursor(
  scopeField: string,
  scopeValue: string,
  payload: Omit<AsideCursorPayload, "scope">,
): string {
  return Buffer.from(
    JSON.stringify({
      [scopeField]: scopeValue,
      created_at: payload.created_at,
      id: payload.id,
      snapshot: payload.snapshot,
    }),
    "utf8",
  ).toString("base64url");
}

export function decodeScopedCursor(
  raw: string,
  scopeField: string,
  expectedScope: string,
  mismatchMessage: string,
): AsideCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw invalidAsideCursor("分页游标无效");
  }
  if (!parsed || typeof parsed !== "object") {
    throw invalidAsideCursor("分页游标无效");
  }
  const value = parsed as Record<string, unknown>;
  if (
    typeof value[scopeField] !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.id !== "string" ||
    typeof value.snapshot !== "number" ||
    !Number.isInteger(value.snapshot) ||
    value.snapshot < 0
  ) {
    throw invalidAsideCursor("分页游标无效");
  }
  if (value[scopeField] !== expectedScope) {
    throw invalidAsideCursor(mismatchMessage);
  }
  return {
    scope: value[scopeField],
    created_at: value.created_at,
    id: value.id,
    snapshot: value.snapshot,
  };
}

export function paginateScopedMembers<
  T extends { created_at: string; id: string },
>(input: {
  members: T[];
  limit: number;
  snapshot: number;
  before?: string;
  decodeCursor: (raw: string) => Pick<AsideCursorPayload, "created_at" | "id">;
  encodeCursor: (last: T) => string;
}): { items: T[]; total: number; next_cursor: string | null; snapshot_cursor: number } {
  const remaining = input.before
    ? input.members.filter((row) =>
        isOlderThanAsideCursor(row, input.decodeCursor(input.before!)),
      )
    : input.members;
  const page = remaining.slice(0, input.limit);
  const last = page[page.length - 1];
  const hasMore = remaining.length > input.limit && last !== undefined;
  return {
    items: page,
    total: input.members.length,
    next_cursor: hasMore ? input.encodeCursor(last) : null,
    snapshot_cursor: input.snapshot,
  };
}

export function computeAsidePosition(
  members: Array<{ id: string }>,
  asideId: string,
): AsidePosition {
  const offset = members.findIndex((row) => row.id === asideId);
  if (offset < 0) {
    throw new FlowError(
      CONVERSATION_ERROR.NOT_FOUND,
      "提问不在当前历史快照中",
      404,
    );
  }
  return {
    index: offset + 1,
    total: members.length,
    prev_id: members[offset - 1]?.id,
    next_id: members[offset + 1]?.id,
  };
}
