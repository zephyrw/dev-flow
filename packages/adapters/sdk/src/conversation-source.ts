import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type {
  ConversationSourceCursor,
  NativeConversationEvent,
} from "./interface.js";
import type { SubagentCapabilities } from "../../../contracts/src/conversation.js";
import { unknownSubagentCapabilities } from "../../../contracts/src/conversation.js";

export const CONVERSATION_SOURCE_LIMITS = {
  maxBytesPerRound: 1024 * 1024,
  maxLineBytes: 4 * 1024 * 1024,
  pollIntervalMs: 2000,
  maxParallelReads: 4,
} as const;

export interface ConversationRecordSource {
  adapterId: string;
  capabilities(): SubagentCapabilities;
  readEvents(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]>;
}

export function defaultUnknownCapabilities(reason?: string): SubagentCapabilities {
  return unknownSubagentCapabilities(reason);
}

export function conversationBindingHash(parts: {
  adapterId: string;
  scope: string;
  workflowId: string;
  lineageId: string;
  nativeSessionId?: string;
  nativeAgentId?: string;
}): string {
  return createHash("sha256")
    .update(
      [
        parts.adapterId,
        parts.scope,
        parts.workflowId,
        parts.lineageId,
        parts.nativeSessionId ?? "",
        parts.nativeAgentId ?? "",
      ].join("\0"),
    )
    .digest("hex");
}

export function conversationCursorHash(parts: {
  adapterId: string;
  sourceId: string;
  conversationId?: string;
}): string {
  return createHash("sha256")
    .update(
      [parts.adapterId, parts.sourceId, parts.conversationId ?? ""].join("\0"),
    )
    .digest("hex");
}

export interface JsonlReadResult {
  lines: string[];
  nextSeq: string;
  truncatedLine: boolean;
  fileIdentity: string;
  bytesRead: number;
}

export async function readJsonlSlice(params: {
  filePath: string;
  offsetBytes: number;
  fileIdentity?: string;
  maxBytes?: number;
  maxLineBytes?: number;
}): Promise<JsonlReadResult> {
  const maxBytes = params.maxBytes ?? CONVERSATION_SOURCE_LIMITS.maxBytesPerRound;
  const maxLineBytes =
    params.maxLineBytes ?? CONVERSATION_SOURCE_LIMITS.maxLineBytes;
  const handle = await open(params.filePath, "r");
  try {
    const stat = await handle.stat();
    const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    if (params.fileIdentity && fileRotated(params.fileIdentity, identity)) {
      return {
        lines: [],
        nextSeq: "0",
        truncatedLine: false,
        fileIdentity: identity,
        bytesRead: 0,
      };
    }
    const start = Math.max(0, params.offsetBytes);
    if (start >= stat.size) {
      return {
        lines: [],
        nextSeq: String(stat.size),
        truncatedLine: false,
        fileIdentity: identity,
        bytesRead: 0,
      };
    }
    const length = Math.min(maxBytes, stat.size - start);
    const buffer = Buffer.alloc(length);
    const read = await handle.read(buffer, 0, length, start);
    return splitJsonlBuffer(buffer.subarray(0, read.bytesRead), start, identity, maxLineBytes);
  } finally {
    await handle.close();
  }
}

function fileRotated(previous: string, current: string): boolean {
  const prev = previous.split(":");
  const next = current.split(":");
  return prev[0] !== next[0] || prev[1] !== next[1];
}

function splitJsonlBuffer(
  buffer: Buffer,
  start: number,
  identity: string,
  maxLineBytes: number,
): JsonlReadResult {
  const lines: string[] = [];
  let offset = 0;
  let cursor = 0;
  let truncatedLine = false;
  while (cursor < buffer.length) {
    const next = buffer.indexOf(0x0a, cursor);
    if (next < 0) break;
    const lineBytes = next - cursor;
    if (lineBytes > maxLineBytes) truncatedLine = true;
    else {
      const line = buffer.subarray(cursor, next).toString("utf8").trimEnd();
      if (line) lines.push(line);
    }
    cursor = next + 1;
    offset = start + cursor;
  }
  return {
    lines,
    nextSeq: String(offset || start + buffer.length),
    truncatedLine,
    fileIdentity: identity,
    bytesRead: buffer.length,
  };
}

export function parseJsonLine(line: string): unknown | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}
