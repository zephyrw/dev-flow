import type { EventEmitter } from "node:events";
import type { SpawnOptions } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export interface TypecheckProcess extends Pick<EventEmitter, "once"> {
  stdout: Readable;
  stderr: Readable;
  kill?: () => boolean;
}

export interface TypecheckOptions {
  cwd?: string;
  stdout?: Writable;
  stderr?: Writable;
  spawn?: (command: string, args: string[], options: SpawnOptions) => TypecheckProcess;
}

export interface TypecheckSummary {
  status: "passed" | "failed";
  exit_code: number;
  signal: string | null;
  error: string | null;
  stdout_summary: string;
  stderr_summary: string;
  timestamp: string;
}

export declare function runTypecheck(options?: TypecheckOptions): Promise<TypecheckSummary>;
