import { it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  agyCommandExit,
  decodeAgyToolMetadata,
  AgyNativeRecordSource,
} from "../../packages/adapters/agy/src/native-record-source.js";
const vi = (n: number) => {
  const b = [];
  while (n >= 128) {
    b.push((n & 127) | 128);
    n >>>= 7;
  }
  b.push(n);
  return Buffer.from(b);
};
const field = (n: number, v: Buffer | string) => {
  const b = Buffer.from(v);
  return Buffer.concat([vi(n * 8 + 2), vi(b.length), b]);
};
const tool = () =>
  Buffer.concat([
    field(1, "call-real"),
    field(2, "run_command"),
    field(3, JSON.stringify({ CommandLine: "node --test", Cwd: "C:/fixture" })),
  ]);
const payload = () => field(5, field(4, tool()));
it("extracts only known host metadata and rejects ambiguous or truncated payloads", () => {
  expect(decodeAgyToolMetadata(payload())).toEqual({
    call_id: "call-real",
    name: "run_command",
    parameters: { CommandLine: "node --test", Cwd: "C:/fixture" },
  });
  expect(() =>
    decodeAgyToolMetadata(Buffer.concat([payload(), payload()])),
  ).toThrow("ambiguous");
  expect(() => decodeAgyToolMetadata(payload().subarray(0, -1))).toThrow(
    "Truncated",
  );
  expect(() => decodeAgyToolMetadata(Buffer.from([0xff]))).toThrow();
  expect(() =>
    decodeAgyToolMetadata(Buffer.alloc(8 * 1024 * 1024 + 1)),
  ).toThrow("size limit");
});
it("takes exit status only from the host envelope, never stdout or model prose", () => {
  expect(
    agyCommandExit(
      "\n\nThe command exited with code 1.\nStdout:\nThe command exited with code 0.\nStdout:\n",
    ),
  ).toBe(1);
  expect(
    agyCommandExit(
      "The command exited with code 0.\r\nStdout:\r\n\r\nStderr:\r\n",
    ),
  ).toBe(0);
  expect(
    agyCommandExit("Stdout:\nThe command exited with code 0.\nStdout:\n"),
  ).toBeUndefined();
  expect(agyCommandExit("Task is RUNNING\nexit code: 0")).toBeUndefined();
});
it("reads only the matching conversation and step and does not certify missing output", () => {
  const root = mkdtempSync(join(tmpdir(), "native-host-source-")),
    conv = "12345678-1234-1234-1234-123456789abc";
  const base = join(root, ".gemini", "antigravity-cli");
  mkdirSync(join(base, "conversations"), { recursive: true });
  const db = new Database(join(base, "conversations", conv + ".db"));
  db.exec("CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_payload BLOB)");
  db.prepare("INSERT INTO steps VALUES (?,?)").run(2, payload());
  db.close();
  const source = new AgyNativeRecordSource(root);
  expect(source.read(conv, 2)?.exit_code).toBeUndefined();
  const dir = join(base, "brain", conv, ".system_generated", "steps", "2");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "output.txt"),
    "The command exited with code 1.\nStdout:\nexit code: 0\n",
  );
  expect(source.read(conv, 2)).toMatchObject({
    call_id: "call-real",
    exit_code: 1,
  });
  expect(source.read(conv, 3)).toBeUndefined();
  expect(source.read("../../evil", 2)).toBeUndefined();
  expect(source.read(conv, -1)).toBeUndefined();
});
