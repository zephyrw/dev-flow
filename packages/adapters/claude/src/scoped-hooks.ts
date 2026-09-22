import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { atomicWrite } from "../../../core/src/util.js";
import type { PreparedInvocation } from "../../sdk/src/interface.js";

export const CLAUDE_READONLY_AGENT = "devflow-readonly";
export const CLAUDE_READONLY_TOOLS = ["Read", "Glob", "Grep"] as const;
export const CLAUDE_WRITE_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "PowerShell",
] as const;

export interface ClaudeAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  permissionMode?: string;
}

export interface ClaudeSessionScope {
  directory: string;
  settingsPath: string;
  eventsPath: string;
  appendScriptPath: string;
  agents: Record<string, ClaudeAgentDefinition>;
}

export function claudeReadonlyAgentDefinition(): ClaudeAgentDefinition {
  return {
    description:
      "DevFlow 只读检查子代理。工具名单由原生 agents 配置限制，不继承写入工具。",
    prompt:
      "使用当前子代理配置中的只读工具检查工作区。工具权限以配置为准，本说明不授予或扩大权限。",
    tools: [...CLAUDE_READONLY_TOOLS],
    disallowedTools: [...CLAUDE_WRITE_TOOLS],
    permissionMode: "plan",
  };
}

export function isClaudeWriteTool(name: string): boolean {
  return (CLAUDE_WRITE_TOOLS as readonly string[]).includes(name);
}

export function isClaudeReadTool(name: string): boolean {
  return (CLAUDE_READONLY_TOOLS as readonly string[]).includes(name);
}

export function proveReadonlyDelegation(definition?: ClaudeAgentDefinition): {
  status: "verified" | "unsupported" | "unknown";
  reason?: string;
} {
  if (!definition) return { status: "unknown", reason: "尚未配置只读子代理定义" };
  const tools = normalizeToolNames(definition.tools);
  if (!tools) {
    return {
      status: "unsupported",
      reason: "子代理未声明 tools，会继承父级写工具，不能用提示词代替权限",
    };
  }
  if (tools.some(isClaudeWriteTool)) {
    return {
      status: "unsupported",
      reason: "只读子代理 tools 含写入工具",
    };
  }
  if (!tools.every(isClaudeReadTool)) {
    return {
      status: "unsupported",
      reason: "只读子代理 tools 超出已证明的只读集合",
    };
  }
  const denied = normalizeToolNames(definition.disallowedTools);
  if (denied && denied.some(isClaudeWriteTool) === false) {
    return {
      status: "unsupported",
      reason: "只读子代理 disallowedTools 未覆盖写入工具",
    };
  }
  return { status: "verified" };
}

export function claudeSessionDirectory(input: {
  runId: string;
  outputPath?: string;
}): string {
  if (!input.outputPath) {
    throw new Error("缺少 Run 受控输出路径，不能写入会话级 Claude hooks");
  }
  return join(dirname(input.outputPath), "claude-session");
}

export function prepareClaudeSessionScope(directory: string): ClaudeSessionScope {
  const resolved = assertControlledSessionDir(directory);
  mkdirSync(resolved, { recursive: true });
  const eventsPath = join(resolved, "subagent-events.jsonl");
  const appendScriptPath = join(resolved, "append-hook.mjs");
  const settingsPath = join(resolved, "settings.json");
  const agents = {
    [CLAUDE_READONLY_AGENT]: claudeReadonlyAgentDefinition(),
  };
  writeHookAppendScript(appendScriptPath, eventsPath);
  atomicWrite(
    settingsPath,
    JSON.stringify(claudeSessionSettings(appendScriptPath), null, 2) + "\n",
  );
  return {
    directory: resolved,
    settingsPath,
    eventsPath,
    appendScriptPath,
    agents,
  };
}

export function claudeSessionSettings(appendScriptPath: string) {
  const hook = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: hookCommand(appendScriptPath),
        timeout: 5,
      },
    ],
  };
  return {
    hooks: {
      SubagentStart: [hook],
      SubagentStop: [hook],
    },
  };
}

export function applyClaudeSessionInvocation(
  inv: PreparedInvocation,
  scope: ClaudeSessionScope,
): PreparedInvocation {
  const args = [...inv.args];
  const extras: string[] = [];
  if (args.includes("--agents")) mergeAgentsArg(args, scope.agents);
  else extras.push("--agents", JSON.stringify(scope.agents));
  if (!args.includes("--settings")) extras.push("--settings", scope.settingsPath);
  if (!args.includes("--include-hook-events")) extras.push("--include-hook-events");
  if (!args.includes("--forward-subagent-text")) {
    extras.push("--forward-subagent-text");
  }
  return { ...inv, args: insertBeforePrompt(args, extras) };
}

export function parentAllowsAgentSpawn(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1] ?? "";
    if (flag === "--disallowedTools" || flag === "--disallowed-tools") {
      if (toolListContains(value, ["Agent", "Task"])) return false;
    }
    if (flag === "--tools") {
      const tools = splitToolList(value);
      if (
        tools.length &&
        value !== "default" &&
        !tools.includes("Agent") &&
        !tools.includes("Task")
      ) {
        return false;
      }
    }
  }
  return true;
}

export function userGlobalClaudeDirs(home = homedir()): string[] {
  return [join(home, ".claude"), join(home, ".config", "claude")];
}

function normalizeToolNames(tools?: string[]): string[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => tool.trim()).filter(Boolean);
}

function splitToolList(value: string): string[] {
  return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

function toolListContains(value: string, names: string[]): boolean {
  const tools = new Set(splitToolList(value));
  return names.some((name) => tools.has(name));
}

function mergeAgentsArg(
  args: string[],
  agents: Record<string, ClaudeAgentDefinition>,
) {
  const index = args.indexOf("--agents");
  if (index < 0) return;
  let current: Record<string, ClaudeAgentDefinition> = {};
  try {
    const parsed = JSON.parse(args[index + 1] ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      current = parsed as Record<string, ClaudeAgentDefinition>;
    }
  } catch {
    current = {};
  }
  args[index + 1] = JSON.stringify({ ...current, ...agents });
}

function insertBeforePrompt(args: string[], extras: string[]): string[] {
  const last = args.at(-1);
  if (last && !last.startsWith("-"))
    return [...args.slice(0, -1), ...extras, last];
  return [...args, ...extras];
}

function hookCommand(script: string): string {
  if (!isAbsolute(script) || /[\r\n"]/.test(script)) {
    throw new Error("非法 hook 脚本路径");
  }
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
}

function writeHookAppendScript(scriptPath: string, eventsPath: string) {
  if (!isAbsolute(eventsPath) || /[\r\n]/.test(eventsPath)) {
    throw new Error("非法 hook 事件文件路径");
  }
  const source = `import { appendFileSync } from "node:fs";
const target = ${JSON.stringify(eventsPath)};
const allowed = new Set(["SubagentStart", "SubagentStop"]);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8").trim();
if (!raw) process.exit(0);
let event;
try { event = JSON.parse(raw); } catch { process.exit(0); }
if (!allowed.has(event?.hook_event_name)) process.exit(0);
appendFileSync(target, JSON.stringify(event) + "\\n");
`;
  mkdirSync(dirname(scriptPath), { recursive: true });
  writeFileSync(scriptPath, source, { mode: 0o600 });
}

function assertControlledSessionDir(directory: string): string {
  const resolved = resolve(directory);
  if (!isAbsolute(resolved)) {
    throw new Error("会话级 hooks 目录必须是绝对路径");
  }
  if (resolved.split(/[\\/]/).includes("..")) {
    throw new Error("非法会话级 hooks 路径");
  }
  for (const banned of userGlobalClaudeDirs()) {
    const root = resolve(banned);
    if (resolved === root || resolved.startsWith(root + sep)) {
      throw new Error("禁止写入用户全局 Claude hooks 目录");
    }
  }
  return resolved;
}
