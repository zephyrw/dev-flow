import type {
  NativeAgentAdapter,
  ProbeRequest,
  CapabilityReport,
  RunContext,
  PreparedInvocation,
  HostChunk,
  NormalizedEvent,
  FactCursor,
  ExecutionFactPage,
  ResumeContext,
  ProcessIdentity,
  StopResult,
} from "./interface.js";
import { resolveToolExecutable } from "./registry.js";
import { nativeLaunch } from "./launch.js";
import { clientInvocation } from "./invocation.js";
import { spawnSync, execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

type Fact = ExecutionFactPage["facts"][number];
export abstract class BaseNativeAgentAdapter implements NativeAgentAdapter {
  onExecutionFact?: (fact: Fact) => void;
  private contexts = new Map<string, RunContext>();
  private streams = new Map<
    string,
    { decoder: StringDecoder; buffer: string }
  >();
  private facts = new Map<string, Map<string, Fact>>();
  private conversations = new Map<string, string>();
  constructor(
    public readonly adapterId: string,
    public readonly defaultBinaryName: string,
    public readonly fallbackDirs: string[] = [],
  ) {}
  abstract getVersionArgs(): string[];
  abstract getProductFingerprint(): string;
  buildInvocation(input: RunContext, executable: string): PreparedInvocation {
    return clientInvocation(this.adapterId, input, executable);
  }
  private prefix(input: RunContext | ProbeRequest): string[] {
    const value = input.toolProfile.options.prefixArgs;
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
      throw new Error("prefixArgs 必须为字符串数组");
    return value as string[];
  }
  async probe(input: ProbeRequest): Promise<CapabilityReport> {
    const capabilities = {
      nativeEditing: false,
      terminal: false,
      browser: false,
      exactResume: false,
      readOnlySession: false,
      structuredToolFacts: false,
      asyncProcessFacts: false,
      usageReporting: false,
    };
    const path = resolveToolExecutable(
      this.defaultBinaryName,
      input.customPath ?? input.toolProfile.executableRef,
      this.fallbackDirs,
    );
    if (!path)
      return {
        adapterId: this.adapterId,
        available: false,
        capabilities,
        unsupportedReason: "未找到指定 CLI",
      };
    try {
      const launch = nativeLaunch(path, this.adapterId),
        prefix = [...launch.prefix, ...this.prefix(input)];
      const runCmd = (args: string[]) => {
        const res = spawnSync(launch.executable, [...prefix, ...args], {
          encoding: "utf8",
          timeout: 10000,
          windowsHide: true,
        });
        if (res.error) throw res.error;
        return ((res.stdout ?? "") + "\n" + (res.stderr ?? "")).trim();
      };
      const out = runCmd(this.getVersionArgs());
      const help = runCmd(["--help"]);
      // Versions may contain only a semver/date; identity also needs client-specific help.
      const identity = new RegExp(this.getProductFingerprint(), "i").test(
        out + "\n" + help,
      );
      if (!identity) throw new Error("版本与帮助未匹配产品身份");
      const headless = /--print|\bexec\b|\brun\b|--prompt/.test(help);
      capabilities.nativeEditing = headless;
      capabilities.terminal = headless;
      capabilities.exactResume =
        /--resume|--session|--conversation|\bresume\b/.test(help);
      capabilities.readOnlySession =
        /--sandbox|--permission-mode|--mode|--plan|--agent/.test(help);
      // Presence/version is not live capability certification. Optional browser/fact/usage claims stay false.
      return {
        adapterId: this.adapterId,
        available: headless,
        version: out.trim(),
        executablePath: path,
        capabilities,
        unsupportedReason: headless ? undefined : "该版本缺少所需非交互入口",
      };
    } catch (e) {
      return {
        adapterId: this.adapterId,
        available: false,
        executablePath: path,
        capabilities,
        unsupportedReason: String(e),
      };
    }
  }
  async prepare(input: RunContext): Promise<PreparedInvocation> {
    if (input.toolProfile.providerConfigRef || input.toolProfile.toolsetRef)
      throw new Error(
        "当前适配器未实现 providerConfigRef/toolsetRef 注入，请在所选原生客户端配置；不能静默忽略该引用",
      );
    const unknown = Object.keys(input.toolProfile.options).filter(
      (k) => k !== "prefixArgs",
    );
    if (unknown.length)
      throw new Error("不支持的工具配置项：" + unknown.join(", "));
    const path = resolveToolExecutable(
      this.defaultBinaryName,
      input.frozenInvocation?.executable ?? input.toolProfile.executableRef,
      this.fallbackDirs,
    );
    if (!path)
      throw new Error("找不到适配器 " + this.adapterId + " 的指定可执行文件");
    const launch = nativeLaunch(path, this.adapterId);
    this.contexts.set(input.runId, input);
    if (!this.facts.has(input.runId)) this.facts.set(input.runId, new Map());
    const inv = this.buildInvocation(input, launch.executable);
    inv.args = [...launch.prefix, ...this.prefix(input), ...inv.args];
    return inv;
  }
  async resume(input: ResumeContext) {
    return this.prepare({
      ...input,
      conversationId: input.previousConversationId,
    });
  }
  private observe(
    item: any,
    context: RunContext | undefined,
    timestamp: string,
  ) {
    if (!context) return;
    const facts = this.facts.get(context.runId)!;
    const conversation =
      item.thread_id ??
      item.session_id ??
      item.sessionId ??
      item.conversation_id ??
      item.init?.conversation_id;
    if (typeof conversation === "string")
      this.conversations.set(context.runId, conversation);
    const start = (call: unknown, command: unknown, cwd: unknown) => {
      if (
        typeof call !== "string" ||
        typeof command !== "string" ||
        !command ||
        facts.has(call)
      )
        return;
      facts.set(call, {
        tool_call_id: call,
        conversation_id:
          this.conversations.get(context.runId) ?? context.conversationId,
        command,
        cwd:
          typeof cwd === "string"
            ? cwd
            : Object.values(context.workspaceRoots)[0]!,
        started_at: timestamp,
        status: "RUNNING",
      });
      this.onExecutionFact?.({ ...facts.get(call)! });
    };
    const end = (call: unknown, code: unknown) => {
      if (
        typeof call !== "string" ||
        typeof code !== "number" ||
        !Number.isInteger(code)
      )
        return;
      const fact = facts.get(call);
      if (!fact || fact.ended_at) return;
      Object.assign(fact, {
        exit_code: code,
        ended_at: timestamp,
        status: "DONE",
      });
      this.onExecutionFact?.({ ...fact });
    };
    const type = item.type ?? item.event;
    if (type === "item.started" && item.item?.type === "command_execution")
      start(item.item.id, item.item.command, item.item.cwd);
    if (type === "item.completed" && item.item?.type === "command_execution")
      end(item.item.id, item.item.exit_code);
    if (type === "tool_call" || type === "tool_use") {
      const args = item.args ?? item.parameters ?? item.input ?? {};
      if (
        ["run_command", "terminal", "exec", "Bash", "bash", "shell"].includes(
          item.name ?? item.tool,
        )
      )
        start(
          item.tool_call_id ?? item.id,
          args.command ?? args.cmd ?? args.CommandLine,
          args.cwd ?? args.Cwd,
        );
    }
    if (type === "tool_result")
      end(
        item.tool_call_id ?? item.id,
        item.exit_code ?? item.result?.exit_code,
      );
    // Claude/Qoder use message blocks; accept only numeric host metadata, never completion prose.
    for (const block of item.message?.content ?? []) {
      if (
        block.type === "tool_use" &&
        ["Bash", "bash", "shell"].includes(block.name)
      )
        start(block.id, block.input?.command, block.input?.cwd);
      if (block.type === "tool_result")
        end(
          block.tool_use_id,
          block.exit_code ??
            item.tool_use_result?.exitCode ??
            item.tool_use_result?.exit_code,
        );
    }
    const part = item.part;
    if (part?.type === "tool" && ["bash", "shell"].includes(part.tool)) {
      if (part.state?.status === "running")
        start(part.callID, part.state.input?.command, part.state.input?.cwd);
      if (part.state?.status === "completed")
        end(
          part.callID,
          part.state.metadata?.exit ?? part.state.metadata?.exitCode,
        );
    }
    if (type === "command_started")
      start(item.tool_call_id, item.command, item.cwd);
    if (type === "command_completed") end(item.tool_call_id, item.exit_code);
  }
  decode(chunk: HostChunk): NormalizedEvent[] {
    const runId =
      chunk.runId ??
      (this.contexts.size === 1 ? [...this.contexts.keys()][0] : "unbound");
    const key = runId + ":" + chunk.stream;
    const stream = this.streams.get(key) ?? {
      decoder: new StringDecoder("utf8"),
      buffer: "",
    };
    this.streams.set(key, stream);
    stream.buffer +=
      typeof chunk.data === "string"
        ? chunk.data
        : stream.decoder.write(chunk.data);
    if (chunk.final) stream.buffer += stream.decoder.end() + "\n";
    if (Buffer.byteLength(stream.buffer) > 4 * 1024 * 1024)
      throw new Error("CLI 事件单行超出 4 MiB 限制");
    const lines = stream.buffer.split("\n");
    stream.buffer = lines.pop() ?? "";
    return lines
      .filter((s) => s.trim())
      .map((line) => {
        let raw: any;
        try {
          raw = JSON.parse(line);
        } catch {
          raw = line;
        }
        if (chunk.stream === "stdout" && raw && typeof raw === "object")
          this.observe(raw, this.contexts.get(runId!), chunk.timestamp);
        const t = raw?.type ?? raw?.event;
        const type: NormalizedEvent["type"] = [
          "tool_call",
          "tool_use",
        ].includes(t)
          ? "tool_call"
          : t === "tool_result"
            ? "tool_result"
            : t === "step_update"
              ? "step_update"
              : t === "error"
                ? "error"
                : raw?.usage
                  ? "usage"
                  : "message";
        return { type, raw, timestamp: chunk.timestamp };
      });
  }
  async readExecutionFacts(input: FactCursor): Promise<ExecutionFactPage> {
    const context = this.contexts.get(input.runId);
    if (!context || context.workflowId !== input.workflowId)
      return { facts: [] };
    return {
      facts: [...(this.facts.get(input.runId)?.values() ?? [])]
        .filter(
          (f) =>
            !input.afterTimestamp ||
            (f.ended_at ?? f.started_at ?? "") > input.afterTimestamp,
        )
        .map((f) => ({ ...f })),
    };
  }
  async stop(identity: ProcessIdentity): Promise<StopResult> {
    if (!identity.pid) return { stopped: false, reason: "缺少实际进程身份" };
    try {
      if (process.platform === "win32")
        execFileSync("taskkill", ["/F", "/T", "/PID", String(identity.pid)], {
          windowsHide: true,
          stdio: "ignore",
        });
      else process.kill(identity.pid, "SIGTERM");
      for (let n = 0; n < 30; n++) {
        try {
          process.kill(identity.pid, 0);
        } catch {
          return { stopped: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { stopped: false, reason: "进程仍存活" };
    } catch (e) {
      return { stopped: false, reason: String(e) };
    }
  }
}
