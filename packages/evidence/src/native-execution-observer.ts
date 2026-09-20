import type { AgyNativeStep } from "../../adapters/agy/src/native-record-source.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { Workspace } from "../../contracts/src/index.js";
import { WorkspaceFingerprintService } from "../../workspace/src/fingerprint.js";
import { safePath } from "../../workspace/src/files.js";
import {
  NativeRunRecordReader,
  type HostToolExecutionFact,
} from "./native-run-records.js";

export const reportKey = (repo: string, call: string, path: string) =>
  JSON.stringify([repo, call, path]);
export const reportSourceKey = (repo: string, path: string) =>
  JSON.stringify([repo, path]);
const sha = (bytes: Buffer | string) =>
  createHash("sha256").update(bytes).digest("hex");

export function captureInputs(workspaces: Workspace[]): Record<string, string> {
  return Object.fromEntries(
    workspaces.map((w) => [
      w.repo_id,
      WorkspaceFingerprintService.compute(w.root).fingerprint,
    ]),
  );
}
const reportCache = new Map<string, { hash: string; version: string }>();

function collectExecutionAliases(
  stepIndex: unknown,
  call: string,
  hostCallId: string | undefined,
  output: string,
): string[] {
  const ids = new Set<string>();
  const add = (value?: string) => {
    if (value && value.trim()) ids.add(value.trim());
  };
  add(call);
  add(hostCallId);
  if (typeof stepIndex === "number" && Number.isSafeInteger(stepIndex)) {
    add("step-" + stepIndex);
    add("task-" + stepIndex);
  }
  for (const match of output.matchAll(/Command ID:\s*([\w-]+)/gi)) add(match[1]);
  for (const match of output.matchAll(/Task ID:\s*[`"]?([\w/-]+)/gi))
    add(match[1]);
  for (const match of output.matchAll(/task id[:\s]+["`]?([\w/-]+)/gi))
    add(match[1]);
  return [...ids];
}

function resolveCommandCwd(
  params: Record<string, unknown>,
  workspaces: Workspace[],
): string | undefined {
  const raw = params.Cwd ?? params.cwd;
  if (typeof raw === "string" && raw.trim()) return raw;
  return workspaces[0]?.root;
}
export function captureReports(
  workspaces: Workspace[],
  configured: { repo_id?: string; report_path?: string }[] = [],
) {
  const results: Record<string, { hash: string; version: string }> = {};
  for (const ws of workspaces) {
    const paths = new Set<string>();
    let entries = 0;
    const walk = (dir: string, depth = 0) => {
      if (depth > 12) throw new Error("Report directory depth exceeds limit");
      if (!existsSync(dir)) return;
      for (const ent of readdirSync(dir, { withFileTypes: true })) {
        if (++entries > 4096)
          throw new Error("Report directory entry limit exceeded");
        const full = join(dir, ent.name);
        if (ent.isSymbolicLink())
          throw new Error("Report links are not allowed");
        if (ent.isDirectory()) walk(full, depth + 1);
        else if (ent.isFile())
          paths.add(relative(ws.root, full).replaceAll("\\", "/"));
      }
    };
    // Executor chooses report names within these artifact directories.
    for (const dir of [".reports", "reports"]) {
      const full = safePath(ws.root, dir);
      if (existsSync(full)) walk(full);
    }
    for (const c of configured)
      if (c.report_path && (c.repo_id ?? workspaces[0]?.repo_id) === ws.repo_id)
        paths.add(c.report_path);
    for (const path of paths) {
      const full = safePath(ws.root, path);
      if (!existsSync(full)) continue;
      const before = statSync(full, { bigint: true });
      if (!before.isFile() || before.size > 32n * 1024n * 1024n)
        throw new Error("Report exceeds 32 MiB limit");
      const version = (s: typeof before) =>
        [s.size, s.mtimeNs, s.ctimeNs, s.ino].join(":");
      const cached = reportCache.get(full);
      const hash =
        cached?.version === version(before)
          ? cached.hash
          : sha(readFileSync(full));
      const after = statSync(full, { bigint: true });
      if (version(before) !== version(after))
        throw new Error("Report changed while reading");
      if (reportCache.size > 10000) reportCache.clear();
      const result = { hash, version: version(after) };
      reportCache.set(full, result);
      results[reportSourceKey(ws.repo_id, path)] = result;
    }
  }
  return results;
}

/** Passive consumer of host events. Never launches a test or sends a model prompt.
 * DONE-only/replayed calls have no start receipt and cannot certify a delivery. */
export class NativeExecutionObserver {
  private boundary = -1;
  private conversation?: string;
  private pending = new Map<string, { fact: HostToolExecutionFact }>();
  private commands = new Map<string, string>();
  constructor(
    private options: {
      workflow_id: string;
      run_id: string;
      plan_hash: string;
      workspaces: Workspace[];
      reports?: { repo_id?: string; report_path?: string }[];
      save: (fact: HostToolExecutionFact) => void;
      readHostStep?: (
        conversation: string,
        index: number,
      ) => AgyNativeStep | undefined;
    },
  ) {}
  accept(event: Record<string, any>) {
    if (event.event === "init") {
      this.conversation = event.conversation_id;
      return;
    }
    const step = event.step_update;
    if (!step || step.conversation_id !== this.conversation) return;
    if (step.step_type === "user_input" && step.state === "DONE") {
      this.boundary = Math.max(this.boundary, step.step_index ?? -1);
      return;
    }
    if (this.boundary < 0 || step.step_index <= this.boundary) return;
    const rawInfo = step.tool_info ?? {};
    const name = step.tool_name ?? rawInfo.name;
    if (!["run_command", "terminal", "exec", "command_status"].includes(name))
      return;
    let host: AgyNativeStep | undefined;
    try {
      host = this.options.readHostStep?.(this.conversation!, step.step_index);
    } catch {
      /* Missing metadata cannot certify a test. */
    }
    if (host && host.name !== name) {
      if (Object.keys(host.parameters).length) return;
      host = { ...host, name };
    }
    const info = {
      ...rawInfo,
      ...(host
        ? {
            parameters: {
              ...(rawInfo.parameters ?? rawInfo.args ?? {}),
              ...host.parameters,
            },
            output: host.output ?? rawInfo.output,
            exit_code:
              typeof host.exit_code === "number"
                ? host.exit_code
                : rawInfo.exit_code,
          }
        : {}),
    };
    const params = info.parameters ?? info.args ?? {};
    const call = String(
      step.tool_call_id ??
        info.id ??
        info.tool_call_id ??
        step.step_id ??
        (step.step_index != null ? "step-" + step.step_index : ""),
    );
    const timestamp = new Date().toISOString();
    if (name === "command_status") {
      const original = this.commands.get(
        String(params.CommandId ?? params.command_id ?? params.id),
      );
      if (!original) return;
      const observed = NativeRunRecordReader.fromString(
        JSON.stringify({
          type: "tool_call",
          id: original,
          name: "exec",
          args: { command: this.pending.get(original)?.fact.command },
        }) +
          "\n" +
          JSON.stringify({
            type: "tool_result",
            id: original,
            output: info.output,
            exit_code: info.exit_code,
          }),
      ).getFact(original);
      const code =
        typeof host?.exit_code === "number"
          ? host.exit_code
          : observed?.exit_code;
      if (code !== undefined) this.finish(original, code, timestamp);
      return;
    }
    if (!["run_command", "terminal", "exec"].includes(name) || !call) return;
    const command = params.CommandLine ?? params.command ?? params.cmd;
    const cwd = resolveCommandCwd(params, this.options.workspaces);
    if (typeof command !== "string" || typeof cwd !== "string") return;
    if (
      ["ACTIVE", "RUNNING", "IN_PROGRESS", "STARTED"].includes(step.state) &&
      !this.pending.has(call)
    ) {
      const fact: HostToolExecutionFact = {
        tool_call_id: call,
        command,
        cwd,
        conversation_id: this.conversation,
        workflow_id: this.options.workflow_id,
        run_id: this.options.run_id,
        plan_hash: this.options.plan_hash,
        started_at: timestamp,
      };
      try {
        this.pending.set(call, { fact });
      } catch (error) {
        fact.evidence_error = String(error);
        this.pending.set(call, { fact });
      }
    }
    if (!this.pending.has(call)) return;
    const output = typeof info.output === "string" ? info.output : "";
    const pending = this.pending.get(call)!;
    if (host) pending.fact.tool_call_id = host.call_id;
    pending.fact.aliases = collectExecutionAliases(
      step.step_index,
      call,
      host?.call_id,
      output,
    );
    const cmdId = output.match(/Command ID:\s*([\w-]+)/i)?.[1];
    if (cmdId) this.commands.set(cmdId, call);
    const fact = NativeRunRecordReader.fromString(
      JSON.stringify({ ...event, timestamp }),
    ).getFact(call);
    const code =
      typeof host?.exit_code === "number"
        ? host.exit_code
        : typeof info.exit_code === "number"
          ? info.exit_code
          : this.options.readHostStep
            ? undefined
            : fact?.exit_code;
    if (step.state === "DONE" && code !== undefined)
      this.finish(call, code, timestamp);
  }
  private finish(call: string, code: number, ended_at: string) {
    const pending = this.pending.get(call);
    if (!pending) return;
    this.pending.delete(call);
    const fact = { ...pending.fact, exit_code: code, status: "DONE", ended_at };
    this.options.save(fact);
  }
}
