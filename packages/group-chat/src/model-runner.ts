import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { createDefaultAdapterRegistry } from "../../adapters/sdk/src/index.js";
import { resolveAdapterExecutable } from "../../adapters/sdk/src/registry.js";
import { nativeLaunch } from "../../adapters/sdk/src/launch.js";
import { selectionCapabilityFromCatalog } from "../../adapters/sdk/src/frozen-invocation.js";
import { confirmAgyQuotaFailure, extractAgyFailureFact, hasAgyPrintTimeout } from "../../adapters/agy/src/failure-fact.js";
import { classifyCodeBuddyQuotaFailure } from "../../adapters/codebuddy/src/provider-failure.js";
import type { ModelCatalog } from "../../contracts/src/model-catalog.js";
import { ProcessManager } from "../../process/src/manager.js";
import { modelReplyText } from "../../presentation/src/model-reply.js";
import { observeProcessRecord } from "../../process/src/process-protocol.js";
import type { AgyAccountService, AgyUsageRequest, UsagePermit } from "../../agy-accounts/src/service.js";
import { GroupAccountConsumer, GroupAccountFailure, type GroupAccountCall } from "./account-consumer.js";
import type { Model } from "./contracts.js";

export type RunModel = (input: {
  session: string; member: Model; cwd: string; scratch: string; prompt: string; execute: boolean; structured?: boolean;
  signal: AbortSignal; modelWorkspace?: string;
}) => Promise<string>;

const isAgyProbeTimeout = (error: unknown) =>
  error instanceof Error && ("code" in error ? error.code : error.message) === "agy_model_probe_timeout";
class GroupCatalogChanged extends Error {}

export async function acquireGroupAgyPermit(
  accounts: Pick<AgyAccountService, "acquireUsagePermit">,
  request: AgyUsageRequest,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  try {
    return await accounts.acquireUsagePermit(request);
  } catch (error) {
    if (isAgyProbeTimeout(error)) {
      signal.throwIfAborted();
      try {
        return await accounts.acquireUsagePermit(request);
      } catch (err2) {
        if (isAgyProbeTimeout(err2)) throw new Error("AGY 模型访问核验连续超时，回复尚未开始，可重试本成员", { cause: err2 });
        throw err2;
      }
    }
    throw error;
  }
}

export function createGroupModelRunner(
  getCatalog: (tool: string, cwd?: string) => ModelCatalog | Promise<ModelCatalog>,
  customCodex?: string, customAgy?: string, accountService?: AgyAccountService,
  verifyModel?: (member: Model, cwd: string, catalog: ModelCatalog, signal: AbortSignal) => Promise<void>,
) {
  const records = new Map<string, { path: string; permit?: UsagePermit }>();
  const accounts = accountService ? new GroupAccountConsumer(accountService) : undefined;

  const manager = new ProcessManager((spec, event) => {
    const record = records.get(spec.id);
    if (!record) return;
    writeFileSync(record.path, JSON.stringify(event), { mode: 0o600 });
    if (event.status === "running" && event.pid && record.permit)
      accountService?.attachUsageProcess(record.permit.permit_id, Number(event.pid));
  });
  const adapters = createDefaultAdapterRegistry();
  const runAttempt = async ({ session, member, cwd, scratch, prompt, execute, structured, signal, modelWorkspace }: Parameters<RunModel>[0], accountCall?: GroupAccountCall) => {
    const tool = (member.tool as string) === "codebuddy" ? "codebuddy-code" : member.tool;
    if (tool === "codebuddy-code" && !modelWorkspace) throw new Error("CodeBuddy 需要配置模型工作区，请编辑群配置后同步会话成员");
    const nativeCwd = tool === "codebuddy-code" ? modelWorkspace! : cwd;
    const managedAgy = tool === "agy" && Boolean(accountService?.isManaged());
    const findUsableEntry = (cat: ModelCatalog, targetId: string) =>
      cat.entries.find(item =>
        item.nativeId === targetId &&
        !item.hidden &&
        item.selectionKind === "fixed" &&
        item.availability !== "unavailable" &&
        (tool !== "agy" || item.availability === "listed"));

    let catalog = await getCatalog(tool, nativeCwd);
    let entry = findUsableEntry(catalog, member.model);
    if (!managedAgy) {
      if (!entry) {
        throw new Error("所选模型不在当前可用目录，请刷新工具模型目录");
      }
      if (member.effort && (entry.effort.status !== "supported" || !entry.effort.values.includes(member.effort))) {
        throw new Error("所选模型不支持当前配置的思考强度");
      }
    }
    if (execute && tool !== "codex") throw new Error("当前工具未启用隔离执行，可改为仅回答");
    signal.throwIfAborted();
    const executable = resolveAdapterExecutable(tool, tool === "codex" ? customCodex : tool === "agy" ? customAgy : undefined);
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
      if (tool === "codebuddy-code") await verifyModel?.(member, nativeCwd, catalog, signal);
      signal.throwIfAborted();
      if (managedAgy) {
        const targetModel = (member.effort ? entry?.effort.variants?.[member.effort] : undefined) ?? member.model;
        accountCall!.model = targetModel;
        permit = await accounts!.acquire(accountCall!, (request, abort) => acquireGroupAgyPermit(accountService!, request, abort));
        signal.throwIfAborted();
        // 基于最终落定账号的实际目录重新核验模型与思考强度（禁止静默降档）
        catalog = await getCatalog(tool, nativeCwd);
        if (catalog.status !== "fresh" || catalog.discoveryStatus === "missing") {
          throw new Error("当前 AGY 账号模型目录尚未确认，请刷新后重试");
        }
        entry = findUsableEntry(catalog, targetModel) ?? findUsableEntry(catalog, member.model);
        if (!entry) {
          throw new Error("当前落定 AGY 账号不支持所选模型，请切换支持账号或调整成员模型");
        }
        if (member.effort && (entry.effort.status !== "supported" || !entry.effort.values.includes(member.effort))) {
          throw new Error("当前落定 AGY 账号不支持所选思考强度");
        }
      }
      const resolvedModelId = (member.effort ? entry!.effort.variants?.[member.effort] : undefined) ?? member.model;
      if (tool === "agy" && entry && member.effort && entry.effort.variants?.[member.effort] && entry.effort.variants[member.effort] !== resolvedModelId) {
        throw new Error("模型变体与思考强度配置不一致");
      }
      const invocation = adapters.mustGet(tool).buildInvocation({
        workflowId: session, runId, stage: "group_chat", epoch: 0,
        purpose: execute ? "implement" : "aside",
        workspaceRoots: { group: nativeCwd }, allowedPaths: [nativeCwd],
        toolProfile: {
          id: member.id, revision: 1, adapterId: tool, modelSelection: "explicit",
          selectionKind: "fixed", modelId: resolvedModelId, options: {},
          reasoning: member.effort ? { mode: "explicit", value: member.effort } : undefined,
        },
        catalogEntry: entry!, selectionCapability: selectionCapabilityFromCatalog(catalog, entry!),
        promptKind: "user", prompt, timeoutMs: 300_000,
        ...(tool === "codex" ? { outputPath } : {}),
      }, executable);
      const launch = nativeLaunch(invocation.executable, tool);
      delete invocation.env.DEVFLOW_WORKFLOW_ID;
      delete invocation.env.DEVFLOW_STAGE;
      if (tool === "codebuddy-code") {
        delete invocation.env.DEVFLOW_WORKFLOW_ID;
        delete invocation.env.DEVFLOW_STAGE;
      }
      // Keep OpenCode's native providers and credentials. Group calls never grant tools.
      if (tool === "opencode") {
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
      if (tool === "agy") {
        invocation.args.splice(0, 0, "--disable-slash-commands", "--sandbox");
        if (permit) {
          accountService!.markUsageStarted(permit.permit_id);
        }
      }
      signal.throwIfAborted();
      records.set(runId, { path: record, permit });
      const task = manager.start({
        id: runId, ...invocation, executable: launch.executable,
        args: [...launch.prefix, ...invocation.args], timeout_ms: 300_000,
      });
      confirmed = false;
      const stop = () => { void task.stop().catch(() => {}); };
      signal.addEventListener("abort", stop, { once: true });
      let stdout = "";
      const decoder = new StringDecoder("utf8");
      let failure = false;
      let stderrTail = "";
      let providerError: string | undefined;
      let agyPrintTimedOut = false;
      if (tool === "opencode" || tool === "agy" || tool === "codebuddy-code") {
        task.on("stderr", (chunk: Buffer) => {
          if (providerError || agyPrintTimedOut) return;
          stderrTail = (stderrTail + chunk.toString("utf8")).slice(-8192);
          if (tool === "opencode") providerError = openCodeGroupFailure(stderrTail);
          else if (tool === "codebuddy-code") providerError = codeBuddyGroupFailure(stderrTail);
          else agyPrintTimedOut = hasAgyPrintTimeout(stderrTail);
        });
      }
      task.on("stdout", chunk => {
        if (stdout.length + chunk.length > 4_000_000) { failure = true; stop(); }
        else stdout += decoder.write(chunk);
      });
      try {
        const result = await task.completion;
        confirmed = true;
        signal.throwIfAborted();
        if (failure) throw new Error("模型输出超过运行限制");
        if (agyPrintTimedOut) throw new Error("AGY 模型回复超时，可重试本成员");
        if (tool === "agy" && permit && !result.termination_reason) {
          let offset = 0;
          for (const line of stdout.split("\n")) {
            let event: Record<string, unknown>;
            try { event = JSON.parse(line); } catch { offset += line.length + 1; continue; }
            if (!event || typeof event !== "object") continue;
            const fact = confirmAgyQuotaFailure(extractAgyFailureFact({
              realmId: permit.realm_id, accountId: permit.account_id, authEpoch: permit.auth_epoch,
              runId, event: { ...event, type: event.type ?? event.event }, eventOffset: offset, currentTurn: true,
            }), { exitCode: result.code, currentTurn: true, stderr: stderrTail, terminationReason: result.termination_reason });
            if (fact.can_switch_account) throw new GroupAccountFailure(fact);
            offset += line.length + 1;
          }
        }
        if (result.code !== 0 || result.termination_reason)
          throw new Error(providerError ?? (result.termination_reason === "timeout" ? "模型回复超时，可重试本成员"
            : result.code === -1 ? "模型工具未能启动，请检查本机 CLI 安装和可执行路径"
            : `模型工具退出（${result.code ?? "已终止"}），请检查模型或工具状态`));
        if (member.tool === "codex") {
          try {
            const reply = readFileSync(outputPath, "utf8").trim();
            if (reply) { successful = true; return reply; }
          } catch {}
        }
        try {
          const reply = parseGroupReply(tool, stdout + decoder.end(), structured);
          successful = true;
          return reply;
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
  const run: RunModel = async input => {
    const call = input.member.tool === "agy" ? accounts?.track(input.member.model, input.signal) : undefined;
    try {
      for (;;) {
        try { return await runAttempt(input, call); }
        catch (error) {
          if (error instanceof GroupCatalogChanged) continue;
          if (!(error instanceof GroupAccountFailure) || !call || !accounts) throw error;
          await accounts.recover(call, error.fact);
        }
      }
    } finally { if (call) accounts!.finish(call); }
  };
  return {
    run,
    close: async () => {
      accounts?.close();
      await manager.close();
      if (!records.size) accounts?.dispose();
    },
  };
}

export function openCodeGroupFailure(stderr: string): string | undefined {
  if (/\bfree usage limit reached\b/i.test(stderr))
    return "OpenCode 提供方报告免费额度限制，未返回回复";
  if (/\binsufficient_quota\b/i.test(stderr))
    return "OpenCode 当前提供方的额度不足，本轮已停止等待";
  return undefined;
}

export function codeBuddyGroupFailure(stderr: string): string | undefined {
  if (/no available credits|(?:insufficient|exhausted) credits|credits? (?:exhausted|depleted)|quota exhausted|额度已用尽|积分(?:不足|耗尽|已用尽)/i.test(stderr))
    return "CodeBuddy 额度不足，未返回回复";
  if (/\brate[ _-]limit(?:ed)?\b|too many requests|(?:请求|调用)(?:频率|速率)(?:超限|受限)|限流/i.test(stderr))
    return "CodeBuddy 调用频率超限，请稍后重试";
  if (/\b(?:auth(?:entication)? required|not logged in|unauthorized|登录已过期|未登录)\b/i.test(stderr))
    return "CodeBuddy 认证未通过或未登录，请先登录后重试";
  return undefined;
}

export function parseGroupReply(tool: Model["tool"] | string, stdout: string, structured = false): string {
  // The workflow prose extractor projects summary/notes; group JSON requires every field.
  const reply = (value: unknown) => (structured && typeof value === "string" ? value : modelReplyText(value)) ?? "";
  let answer = "";
  for (const line of stdout.split("\n")) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (!row || typeof row !== "object") continue;
    if (row.type === "error" || row.type === "turn.failed") throw new Error("工具报告本次模型调用失败");
    if (tool === "agy" && row.event === "result") {
      if (row.result?.status !== "SUCCESS") {
        const detail = row.result?.error;
        if (typeof detail === "string" && /\b(?:timeout|timed out|deadline exceeded)\b/i.test(detail))
          throw new Error("AGY 模型回复超时，可重试本成员");
        throw new Error("AGY 未能完成本次请求");
      }
      answer = reply(row.result.response);
    } else if (tool === "codex" && row.type === "item.completed" && row.item?.type === "agent_message") {
      answer = row.item.text ?? answer;
    } else if (tool === "opencode" && row.type === "text" && typeof row.part?.text === "string") {
      answer += row.part.text + "\n";
    } else if (tool === "claude-code" && row.type === "result") {
      if (row.is_error) throw new Error("Claude Code 未能完成本次请求");
      answer = reply(row.result);
    } else if ((tool === "codebuddy-code" || tool === "codebuddy") && (row.type === "result" || row.type === "assistant")) {
      const quotaFailure = classifyCodeBuddyQuotaFailure(row, false);
      if (quotaFailure === "MODEL_CREDITS_EXHAUSTED") throw new Error("CodeBuddy 额度不足，未返回回复");
      if (quotaFailure === "MODEL_RATE_LIMIT") throw new Error("CodeBuddy 调用频率超限，请稍后重试");
      if (row.type === "result") {
        if (row.is_error) throw new Error(row.result || (row.errors && row.errors.join("\n")) || "CodeBuddy 未能完成本次请求");
        if (row.result) answer = reply(row.result);
      } else if (row.type === "assistant") {
        const textParts = row.message?.content?.filter((c: any) => c.type === "text" && typeof c.text === "string").map((c: any) => c.text);
        if (textParts?.length) answer = textParts.join("\n");
      }
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
