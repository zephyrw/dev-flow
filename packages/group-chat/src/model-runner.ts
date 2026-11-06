import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createDefaultAdapterRegistry } from "../../adapters/sdk/src/index.js";
import { resolveAdapterExecutable } from "../../adapters/sdk/src/registry.js";
import { selectionCapabilityFromCatalog } from "../../adapters/sdk/src/frozen-invocation.js";
import type { ModelCatalog } from "../../contracts/src/model-catalog.js";
import { ProcessManager } from "../../process/src/manager.js";
import { modelReplyText } from "../../presentation/src/model-reply.js";
import { observeProcessRecord } from "../../process/src/process-protocol.js";
import type { AgyAccountService, UsagePermit } from "../../agy-accounts/src/service.js";
import type { Model } from "./contracts.js";

export type RunModel = (input: {
  session: string; member: Model; cwd: string; scratch: string; prompt: string; execute: boolean; structured?: boolean;
  signal: AbortSignal;
}) => Promise<string>;

export function createGroupModelRunner(getCatalog: (tool: string) => ModelCatalog, customCodex?: string, customAgy?: string, accountService?: AgyAccountService) {
  const records = new Map<string, { path: string; permit?: UsagePermit }>();
  const manager = new ProcessManager((spec, event) => {
    const record = records.get(spec.id);
    if (!record) return;
    writeFileSync(record.path, JSON.stringify(event), { mode: 0o600 });
    if (event.status === "running" && event.pid && record.permit)
      accountService?.attachUsageProcess(record.permit.permit_id, Number(event.pid));
  });
  const adapters = createDefaultAdapterRegistry();
  const run: RunModel = async ({ session, member, cwd, scratch, prompt, execute, structured, signal }) => {
    const catalog = getCatalog(member.tool);
    const entry = catalog.entries.find(item => item.nativeId === member.model && !item.hidden);
    if (!entry || entry.selectionKind !== "fixed" || entry.availability === "unavailable")
      throw new Error("所选模型不在当前可用目录，请刷新工具模型目录");
    if (execute && member.tool !== "codex") throw new Error("当前工具未启用隔离执行，可改为仅回答");
    const executable = resolveAdapterExecutable(member.tool, member.tool === "codex" ? customCodex : member.tool === "agy" ? customAgy : undefined);
    if (!executable) throw new Error("未找到模型工具");
    const runId = randomUUID();
    await assertCallsExited(scratch);
    const temp = mkdtempSync(join(scratch, "call-"));
    const outputPath = join(temp, "reply.md");
    const record = join(temp, "process.json");
    let permit: UsagePermit | undefined;
    let confirmed = true;
    let successful = false;
    try {
      const invocation = adapters.mustGet(member.tool).buildInvocation({
        workflowId: session, runId, stage: "group_chat", epoch: 0,
        purpose: execute ? "implement" : "aside",
        workspaceRoots: { group: cwd }, allowedPaths: [cwd],
        toolProfile: {
          id: member.id, revision: 1, adapterId: member.tool, modelSelection: "explicit",
          selectionKind: "fixed", modelId: member.model, options: {},
          reasoning: member.effort ? { mode: "explicit", value: member.effort } : undefined,
        },
        catalogEntry: entry, selectionCapability: selectionCapabilityFromCatalog(catalog, entry),
        promptKind: "user", prompt, timeoutMs: 300_000,
        ...(member.tool === "codex" ? { outputPath } : {}),
      }, executable);
      delete invocation.env.DEVFLOW_WORKFLOW_ID;
      delete invocation.env.DEVFLOW_STAGE;
      // Keep OpenCode's native providers and credentials. Group calls never grant tools.
      if (member.tool === "opencode") {
        const agent = invocation.args.indexOf("--agent");
        delete invocation.env.OPENCODE_CONFIG_CONTENT;
        invocation.env.OPENCODE_PERMISSION = JSON.stringify({ "*": "deny" });
        if (catalog.invocationCapability?.opencodeVariantEncoding === "flag" && /^opencode\/.+-free$/.test(member.model)) {
          // Zen Free can reject requests when all tools disappear from the native schema.
          // OpenCode v1 noninteractive run rejects every ask without --auto.
          const name = "devflow-group-reply";
          const permission = { "*": "ask", external_directory: "deny" };
          invocation.args[agent + 1] = name;
          invocation.args.splice(1, 0, "--pure");
          invocation.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ agent: { [name]: { mode: "primary", permission } } });
          invocation.env.OPENCODE_PERMISSION = JSON.stringify(permission);
        } else if (agent >= 0) {
          invocation.args.splice(agent, 2);
        }
        const logLevel = catalog.invocationCapability?.opencodeVariantEncoding === "hash" ? "error" : "ERROR";
        invocation.args.splice(1, 0, "--print-logs", "--log-level", logLevel, "--title", "DevFlow 群聊");
      }
      if (member.tool === "agy") {
        invocation.args.splice(0, 0, "--disable-slash-commands", "--sandbox");
        if (accountService?.isManaged()) {
          const model = (member.effort ? entry.effort.variants?.[member.effort] : undefined) ?? member.model;
          permit = await accountService.acquireUsagePermit({
            realm_id: "default-agy-realm", consumer_id: runId, usage_kind: "execution",
            required_pool_ids: [], required_model_ids: [model], model_id: model,
          });
          signal.throwIfAborted();
          accountService.markUsageStarted(permit.permit_id);
        }
      }
      signal.throwIfAborted();
      records.set(runId, { path: record, permit });
      const task = manager.start({ id: runId, ...invocation, timeout_ms: 300_000 });
      confirmed = false;
      const stop = () => { void task.stop().catch(() => {}); };
      signal.addEventListener("abort", stop, { once: true });
      let stdout = "";
      const decoder = new StringDecoder("utf8");
      let failure = false;
      let providerError: string | undefined;
      if (member.tool === "opencode") {
        let stderrTail = "";
        task.on("stderr", (chunk: Buffer) => {
          if (providerError) return;
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
          providerError = openCodeGroupFailure(stderrTail);
        });
      }
      task.on("stdout", chunk => {
        if (stdout.length + chunk.length > 4_000_000) { failure = true; stop(); }
        else stdout += decoder.write(chunk);
      });
      try {
        const result = await task.completion;
        confirmed = true;
        successful = result.code === 0;
        signal.throwIfAborted();
        if (failure) throw new Error("模型输出超过运行限制");
        if (result.code !== 0 || result.termination_reason)
          throw new Error(providerError ?? (result.termination_reason === "timeout" ? "模型响应超时" : `工具退出（${result.code ?? "已终止"}），请检查工具的模型与登录状态`));
        if (member.tool === "codex") {
          try { const reply = readFileSync(outputPath, "utf8").trim(); if (reply) return reply; } catch {}
        }
        try {
          return parseGroupReply(member.tool, stdout + decoder.end(), structured);
        } catch (error) {
          if (providerError) throw new Error(providerError);
          throw error;
        }
      } finally {
        signal.removeEventListener("abort", stop);
      }
    } finally {
      const retained = manager.get(runId);
      if (!retained) confirmed = true;
      if (confirmed) {
        records.delete(runId);
        rmSync(temp, { recursive: true, force: true });
        if (permit) await accountService!.releaseUsagePermit(permit.permit_id, {
          permit_id: permit.permit_id, success: successful, reason: successful ? "completed" : "group_chat_ended",
        });
      }
    }
  };
  return { run, close: () => manager.close() };
}

export function openCodeGroupFailure(stderr: string): string | undefined {
  if (/\bfree usage limit reached\b/i.test(stderr))
    return "OpenCode 提供方报告免费额度限制，未返回回复";
  if (/\binsufficient_quota\b/i.test(stderr))
    return "OpenCode 当前提供方的额度不足，本轮已停止等待";
  return undefined;
}

export function parseGroupReply(tool: Model["tool"], stdout: string, structured = false): string {
  // The workflow prose extractor projects summary/notes; group JSON requires every field.
  const reply = (value: unknown) => (structured && typeof value === "string" ? value : modelReplyText(value)) ?? "";
  let answer = "";
  for (const line of stdout.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    if (row.type === "error" || row.type === "turn.failed") throw new Error("工具报告本次模型调用失败");
    if (tool === "agy" && row.event === "result") {
      if (row.result?.status !== "SUCCESS") throw new Error("AGY 未能完成本次请求");
      answer = reply(row.result.response);
    } else if (tool === "codex" && row.type === "item.completed" && row.item?.type === "agent_message") {
      answer = row.item.text ?? answer;
    } else if (tool === "opencode" && row.type === "text" && typeof row.part?.text === "string") {
      answer += row.part.text + "\n";
    } else if (tool === "claude-code" && row.type === "result") {
      if (row.is_error) throw new Error("Claude Code 未能完成本次请求");
      answer = reply(row.result);
    }
  }
  if (!answer.trim()) throw new Error("工具没有返回可用的模型回复");
  return answer.trim();
}

/** Stale invocation directories are removable only after process-tree observation. */
export async function assertCallsExited(scratch: string) {
  if (!existsSync(scratch)) return;
  if (lstatSync(scratch).isSymbolicLink()) throw new Error("运行目录归属异常");
  for (const entry of readdirSync(scratch, { withFileTypes: true })) {
    if (!entry.name.startsWith("call-") || !entry.isDirectory()) continue;
    const path = join(scratch, entry.name, "process.json");
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error("无法确认上一轮进程已经退出");
    const record = JSON.parse(readFileSync(path, "utf8"));
    if ((await observeProcessRecord(record)).state !== "confirmed_exited")
      throw new Error("无法确认上一轮进程已经退出，暂不能继续或删除文件");
  }
}
