import { readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import type { PreparedInvocation } from "../../sdk/src/interface.js";
import { writePermissionArtifacts } from "../../sdk/src/permission-artifacts.js";

export interface ClaudePermissionGrant {
  calls: Array<{ name: string }>;
}

/** Run-local PreToolUse bridge. Never changes user/project permission settings. */
export function prepareClaudePermissionBridge(
  invocation: PreparedInvocation,
  runRoot: string,
  grant: ClaudePermissionGrant,
  readonly: boolean,
  expectedConversation: string,
): { invocation: PreparedInvocation; cleanup: () => void } {
  if (!isAbsolute(runRoot) || !expectedConversation) throw new Error("Claude permission bridge requires a bound Run");
  const args = [...invocation.args];
  const index = args.indexOf("--settings");
  if (index < 0 || !args[index + 1]) throw new Error("Claude permission bridge requires scoped settings");
  const originalPath = args[index + 1]!;
  const child = relative(runRoot, originalPath);
  if (isAbsolute(child) || child === ".." || child.startsWith("..\\") || child.startsWith("../"))
    throw new Error("Claude permission bridge cannot replace settings outside its Run");
  const original = JSON.parse(readFileSync(originalPath, "utf8"));
  if (!original || typeof original !== "object" || Array.isArray(original)) throw new Error("Invalid Claude scoped settings");
  const names = [...new Set(grant.calls.map(call => call.name))];
  if (!names.length || names.some(name => !/^[A-Za-z0-9_.:-]+$/.test(name))) throw new Error("Invalid Claude permission tools");
  const scriptPath = join(runRoot, "claude-permission-hook.mjs");
  const settingsPath = join(runRoot, "claude-permission-settings.json");
  const matcher = "^(?:" + names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")$";
  const hooks = original.hooks ?? {};
  const settings = JSON.stringify({ ...original, hooks: { ...hooks, PreToolUse: [
    ...(Array.isArray(hooks.PreToolUse) ? hooks.PreToolUse : []),
    { matcher, hooks: [{ type: "command", command: process.execPath, args: [scriptPath], timeout: 20, onFailure: "block" }] },
  ] } }, null, 2);
  const cleanup = writePermissionArtifacts([
    { path: scriptPath, content: claudePermissionHookSource(expectedConversation, readonly) },
    { path: settingsPath, content: settings },
  ]);
  args[index + 1] = settingsPath;
  return {
    invocation: { ...invocation, args },
    cleanup,
  };
}

export function claudePermissionHookSource(expectedConversation: string, readonly: boolean): string {
  return `const expectedConversation = ${JSON.stringify(expectedConversation)};
const readonly = ${JSON.stringify(readonly)};
const finish = (decision, reason) => process.stdout.write(JSON.stringify({ hookSpecificOutput: {
  hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason,
} }));
try {
  let raw = "";
  let event;
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (raw.length > 1048576) throw new Error("Oversized hook input");
    try { event = JSON.parse(raw); break; } catch {}
  }
  if (!event || event.hook_event_name !== "PreToolUse" || event.session_id !== expectedConversation ||
      typeof event.tool_name !== "string" || typeof event.tool_use_id !== "string" || !event.tool_use_id ||
      !event.tool_input || typeof event.tool_input !== "object" || Array.isArray(event.tool_input) || event.agent_id)
    throw new Error("Unbound native tool call");
  if (readonly && !["Read", "Glob", "Grep"].includes(event.tool_name)) throw new Error("Read-only role");
  // Interactive questions need actual answers, not an authorization boolean.
  if (["AskUserQuestion", "ExitPlanMode"].includes(event.tool_name)) throw new Error("Interactive tool needs its own answer");
  if (!process.env.DEVFLOW_RUN_TOKEN || !process.env.DEVFLOW_BASE_URL) throw new Error("Missing permission host");
  const response = await fetch(new URL("/api/worker/native-permission", process.env.DEVFLOW_BASE_URL), {
    method: "POST", headers: { Authorization: "Bearer " + process.env.DEVFLOW_RUN_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId: event.session_id, nativeCallId: event.tool_use_id, toolCall: { name: event.tool_name, args: event.tool_input } }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Permission host unavailable");
  const result = await response.json();
  if (result.decision === "allow") finish("allow", "USER_APPROVED_EXACT_CALL_ONCE");
  // No matching grant makes no policy decision: other calls using the same
  // tool still pass through the client's own permission rules.
  else if (result.decision === "ask") process.stdout.write("{}");
  else throw new Error("Invalid permission decision");
} catch {
  finish("deny", "DEVFLOW_PERMISSION_CHECK_FAILED");
}
`;
}
