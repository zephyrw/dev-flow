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
/** This prefix is host-generated. Text after Stdout/Stderr is never parsed as
 * an exit code, even if the tested program prints a fake success footer. */
export function agyCommandExit(output: string): number | undefined {
  const match = output.match(
    /^\s*The command exited with code (-?\d+)\.\r?\nStdout:\r?\n/,
  );
  return match ? Number(match[1]) : undefined;
}
export class AgyNativeRecordSource {
  constructor(private profileRoot: string) {}
  read(conversation: string, index: number): AgyNativeStep | undefined {
    if (
      !/^[0-9a-f-]{36}$/i.test(conversation) ||
      !Number.isSafeInteger(index) ||
      index < 0
    )
      return;
    const base = join(this.profileRoot, ".gemini", "antigravity-cli");
    const path = join(base, "conversations", conversation + ".db");
    if (!existsSync(path)) return;
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
      const output = join(
        base,
        "brain",
        conversation,
        ".system_generated",
        "steps",
        String(index),
        "output.txt",
      );
      if (existsSync(output)) {
        if (statSync(output).size > 8 * 1024 * 1024)
          throw new Error("AGY output exceeds size limit");
        const data = readFileSync(output);
        if (data.length > 8 * 1024 * 1024)
          throw new Error("AGY command output exceeds limit");
        result.output = data.toString("utf8");
        result.exit_code = agyCommandExit(result.output);
      }
      return result;
    } finally {
      db?.close();
    }
  }
}
