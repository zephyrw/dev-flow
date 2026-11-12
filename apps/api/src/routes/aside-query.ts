import { CONVERSATION_ERROR, FlowError } from "../../../../packages/contracts/src/index.js";

export function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "分页游标无效", 400);
  }
  return value;
}

export function parseOptionalInt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "分页游标无效", 400);
  }
  return parsed;
}

export function parseAfterCursor(value: unknown): number {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "增量游标无效", 400);
  }
  return parsed;
}
