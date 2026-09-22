import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/** Minimal bounded protobuf wire reader for AGY's local Step metadata.
 * Unknown formats fail closed; encrypted provider payloads are never decoded. */
function fields(bytes: Buffer): Map<number, (Buffer | number)[]> {
  if (bytes.length > 8 * 1024 * 1024)
    throw new Error("AGY step exceeds size limit");
  let offset = 0;
  const result = new Map<number, (Buffer | number)[]>();
  const varint = () => {
    let value = 0n,
      shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= bytes.length) throw new Error("Truncated AGY metadata");
      const b = bytes[offset++]!;
      value |= BigInt(b & 127) << shift;
      if (b < 128) {
        if (value > BigInt(Number.MAX_SAFE_INTEGER))
          throw new Error("Oversized AGY metadata");
        return Number(value);
      }
      shift += 7n;
    }
    throw new Error("Invalid AGY metadata");
  };
  while (offset < bytes.length) {
    const tag = varint(),
      field = Math.floor(tag / 8),
      wire = tag % 8;
    if (!field) throw new Error("Invalid AGY field");
    let value: Buffer | number;
    if (wire === 0) value = varint();
    else if (wire === 2) {
      const len = varint();
      if (offset + len > bytes.length) throw new Error("Truncated AGY field");
      value = bytes.subarray(offset, offset + len);
      offset += len;
    } else if (wire === 1 || wire === 5) {
      const len = wire === 1 ? 8 : 4;
      if (offset + len > bytes.length) throw new Error("Truncated AGY field");
      value = bytes.subarray(offset, offset + len);
      offset += len;
    } else throw new Error("Unsupported AGY wire format");
    result.set(field, [...(result.get(field) ?? []), value]);
  }
  return result;
}
const message = (source: Map<number, (Buffer | number)[]>, key: number) => {
  const value = source.get(key);
  if (value?.length !== 1 || !Buffer.isBuffer(value[0]))
    throw new Error("Missing or ambiguous AGY metadata");
  return fields(value[0]);
};
const text = (source: Map<number, (Buffer | number)[]>, key: number) => {
  const value = source.get(key);
  if (value?.length !== 1 || !Buffer.isBuffer(value[0]))
    throw new Error("Missing AGY text");
  return value[0].toString("utf8");
};
export interface AgyNativeStep {
  call_id: string;
  name: string;
  parameters: Record<string, unknown>;
  output?: string;
  exit_code?: number;
}
export function decodeAgyToolMetadata(payload: Buffer) {
  const step = fields(payload);
  const meta = message(step, 5);
  const call = message(meta, 4);
  const parameters = JSON.parse(text(call, 3));
  if (
    !parameters ||
    typeof parameters !== "object" ||
    Array.isArray(parameters)
  )
    throw new Error("Invalid AGY arguments");
  return { call_id: text(call, 1), name: text(call, 2), parameters };
}

export const AGY_DELEGATION_TOOL = "invoke_subagent";
const AGY_CONVERSATION_ID = /^[0-9a-f-]{36}$/i;
const PUBLIC_METADATA_FIELDS = ["call_id", "name", "parameters", "output"];

export interface AgyStepIdentity {
  conversation_id: string;
  step_index: number;
}

export interface AgyChildAssociation {
  parent_conversation_id: string;
  parent_step_index: number;
  spawn_call_id?: string;
  child_conversation_id?: string;
  agent_native_id?: string;
  title?: string;
  unread_fields: string[];
  unread_reason?: string;
}

export function isAgyConversationId(value: unknown): value is string {
  return typeof value === "string" && AGY_CONVERSATION_ID.test(value);
}

export function isAgyDelegationTool(name: unknown): name is string {
  return name === AGY_DELEGATION_TOOL;
}

export function agyStepSourceId(identity: AgyStepIdentity): string {
  return `agy:${identity.conversation_id}:step:${identity.step_index}`;
}

export function tryDecodeAgyToolMetadata(
  payload: Buffer,
):
  | { ok: true; value: ReturnType<typeof decodeAgyToolMetadata> }
  | { ok: false; unread_fields: string[]; reason: string } {
  try {
    return { ok: true, value: decodeAgyToolMetadata(payload) };
  } catch {
    return {
      ok: false,
      unread_fields: [...PUBLIC_METADATA_FIELDS],
      reason: "unreadable_metadata",
    };
  }
}

function publicJsonObject(text: string | undefined): Record<string, unknown> | undefined {
  if (!text?.trim()) return;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    return value as Record<string, unknown>;
  } catch {
    return;
  }
}

function publicConversationId(source: Record<string, unknown> | undefined): string | undefined {
  if (!source) return;
  const value = source.ConversationId ?? source.conversationId ?? source.conversation_id;
  return isAgyConversationId(value) ? value : undefined;
}

export function childAssociationFromPublicStep(
  identity: AgyStepIdentity,
  step: AgyNativeStep,
): AgyChildAssociation | undefined {
  if (!isAgyDelegationTool(step.name)) return;
  const typeName = step.parameters.TypeName;
  const role = step.parameters.Role;
  const fromParams = publicConversationId(step.parameters);
  const fromOutput = publicConversationId(publicJsonObject(step.output));
  const childId = fromParams ?? fromOutput;
  const unread_fields: string[] = [];
  if (!childId) unread_fields.push("ConversationId");
  return {
    parent_conversation_id: identity.conversation_id,
    parent_step_index: identity.step_index,
    spawn_call_id: step.call_id || agyStepSourceId(identity),
    child_conversation_id: childId,
    agent_native_id: typeof typeName === "string" && typeName ? typeName : undefined,
    title: typeof role === "string" && role ? role : undefined,
    unread_fields,
    unread_reason: childId ? undefined : "child_identity_not_in_public_metadata",
  };
}

/** This prefix is host-generated. Text after Stdout/Output/Stderr is never parsed as
 * an exit code, even if the tested program prints a fake success footer. */
export function agyCommandExit(output: string): number | undefined {
  const match = output.match(
    /^\s*The command exited with code (-?\d+)\.\r?\n(?:Stdout|Output|Stderr):\r?\n/,
  );
  return match ? Number(match[1]) : undefined;
}

function readAgyStepOutput(
  base: string,
  conversation: string,
  index: number,
): { output: string; exit_code?: number } | undefined {
  const output = join(
    base,
    "brain",
    conversation,
    ".system_generated",
    "steps",
    String(index),
    "output.txt",
  );
  if (!existsSync(output)) return;
  if (statSync(output).size > 8 * 1024 * 1024)
    throw new Error("AGY output exceeds size limit");
  const data = readFileSync(output);
  if (data.length > 8 * 1024 * 1024)
    throw new Error("AGY command output exceeds limit");
  const text = data.toString("utf8");
  return { output: text, exit_code: agyCommandExit(text) };
}

export class AgyNativeRecordSource {
  constructor(private profileRoot: string) {}
  readIdentifiedStep(identity: AgyStepIdentity): AgyNativeStep | undefined {
    return this.read(identity.conversation_id, identity.step_index);
  }
  readChildAssociation(
    identity: AgyStepIdentity,
  ): AgyChildAssociation | undefined {
    if (
      !isAgyConversationId(identity.conversation_id) ||
      !Number.isSafeInteger(identity.step_index) ||
      identity.step_index < 0
    )
      return;
    try {
      const step = this.readIdentifiedStep(identity);
      if (!step) return;
      return childAssociationFromPublicStep(identity, step);
    } catch {
      return {
        parent_conversation_id: identity.conversation_id,
        parent_step_index: identity.step_index,
        unread_fields: [...PUBLIC_METADATA_FIELDS],
        unread_reason: "unreadable_metadata",
      };
    }
  }
  read(conversation: string, index: number): AgyNativeStep | undefined {
    if (
      !isAgyConversationId(conversation) ||
      !Number.isSafeInteger(index) ||
      index < 0
    )
      return;
    const base = join(this.profileRoot, ".gemini", "antigravity-cli");
    const recorded = readAgyStepOutput(base, conversation, index);
    const path = join(base, "conversations", conversation + ".db");
    if (!existsSync(path)) {
      if (typeof recorded?.exit_code !== "number") return;
      return {
        call_id: "step-" + index,
        name: "run_command",
        parameters: {},
        output: recorded.output,
        exit_code: recorded.exit_code,
      };
    }
    let db: Database.Database | undefined;
    try {
      db = new Database(path, {
        readonly: true,
        fileMustExist: true,
        timeout: 1000,
      });
      const row = db
        .prepare("SELECT step_payload FROM steps WHERE idx=?")
        .get(index) as { step_payload: Buffer } | undefined;
      if (!row?.step_payload) return;
      const result: AgyNativeStep = decodeAgyToolMetadata(row.step_payload);
      if (recorded) {
        result.output = recorded.output;
        result.exit_code = recorded.exit_code;
      }
      return result;
    } finally {
      db?.close();
    }
  }
}
