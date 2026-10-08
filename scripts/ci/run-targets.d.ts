import type { DiagnosticStreamRedactor } from "../../packages/presentation/src/secret-redactor.js";

export interface Target {
  kind: "vitest" | "node" | "playwright";
  file: string;
}

export interface TargetResult extends Target {
  exit_code: number;
  signal: string | null;
  error: string | null;
  timed_out: boolean;
  sha?: string | null;
  platform?: string;
}

export interface SpawnTargetResult {
  exit_code: number;
  signal: string | null;
  error: string | null;
  timed_out: boolean;
}

export interface SpawnTargetOptions {
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdoutDest?: NodeJS.WritableStream;
  stderrDest?: NodeJS.WritableStream;
}

export interface RunTargetsOptions {
  targets?: Target[];
  timeoutMs?: number;
  cleanupTimeoutMs?: number;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  stdoutDest?: NodeJS.WritableStream;
  stderrDest?: NodeJS.WritableStream;
}

export interface RunTargetsSummary {
  targets: TargetResult[];
  coverage_merge_exit_code: number;
  coverage_merge_signal?: string | null;
  coverage_merge_error?: string | null;
  coverage_merge_timed_out?: boolean;
}

export declare function discoverTargets(): Target[];

export interface BrowserDiagnostics {
  status: "available" | "missing" | "invalid" | "read_failed" | "redaction_unavailable";
  failures: Array<{
    file?: string;
    line?: number;
    column?: number;
    titles: string[];
    tests: Array<{ status: string; errors: string[] }>;
  }>;
  errors: string[];
}

export declare function readBrowserDiagnostics(
  reportFile: string,
  projectDiagnostic?: (input: unknown) => unknown,
): BrowserDiagnostics;

export declare class RepeatedStatusFilter {
  constructor(writeFn: (text: string) => boolean);
  push(text: string): boolean;
  flush(): void;
}

export interface WritableDestination {
  write(chunk: string): boolean;
  once?(event: string, callback: () => void): void;
  off?(event: string, callback: () => void): void;
}

export declare function pipeStreamWithRedaction(
  readable: NodeJS.ReadableStream | null | undefined,
  writeDest: WritableDestination,
  redactor: DiagnosticStreamRedactor,
  statusFilter: RepeatedStatusFilter,
): Promise<void>;

export declare function spawnTarget(
  args: string[],
  env?: Record<string, string | undefined>,
  options?: SpawnTargetOptions,
): Promise<SpawnTargetResult>;

export declare function runTargets(options?: RunTargetsOptions): Promise<RunTargetsSummary>;
