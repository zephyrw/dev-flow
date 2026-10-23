import type { NativePermissionCall } from "../../core/src/native-permission.js";
import { objectHash } from "../../core/src/util.js";

export interface NativeDeniedObservation {
  native_call_id: string;
  session_id: string;
  call?: NativePermissionCall;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function completeCall(name: unknown, input: unknown): NativePermissionCall | undefined {
  const parameters = record(input);
  return nonempty(name) && parameters ? { name, parameters } : undefined;
}

// OpenCode v1.19.0 permission.ts defines these messages; processor.ts writes
// errorMessage(error) into the error ToolPart emitted by cli/cmd/run.ts.
// Do not search arbitrary command output for "permission denied".
// https://github.com/anomalyco/opencode/blob/v1.19.0/packages/core/src/v1/permission.ts
function isOpenCodePermissionError(error: unknown): boolean {
  if (typeof error !== "string") return false;
  if (error === "The user rejected permission to use this specific tool call.") return true;
  const corrected = "The user rejected permission to use this specific tool call with the following feedback: ";
  if (error.startsWith(corrected) && error.length > corrected.length) return true;
  const denied = "The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ";
  if (!error.startsWith(denied)) return false;
  try {
    const rules: unknown = JSON.parse(error.slice(denied.length));
    return Array.isArray(rules) && rules.every(value => {
      const rule = record(value);
      return rule && nonempty(rule.permission) && nonempty(rule.pattern) &&
        ["allow", "ask", "deny"].includes(String(rule.action));
    });
  } catch { return false; }
}

/** One instance per Run. Denial facts do not imply complete grantable metadata. */
export class NativeDeniedCalls {
  private deniedById = new Map<string, NativeDeniedObservation>();
  private claudeCalls = new Map<string, NativePermissionCall | undefined>();
  private unidentifiedDenial = false;
  immediate?: NativePermissionCall[];

  constructor(private adapter: "claude-code" | "opencode") {}

  get currentDenial(): boolean {
    return this.unidentifiedDenial || this.deniedById.size > 0;
  }

  get observations(): NativeDeniedObservation[] {
    return [...this.deniedById.values()];
  }

  get denied(): NativePermissionCall[] {
    // An incomplete denial must produce the non-authorizing action-required UI.
    if (this.unidentifiedDenial || this.observations.some(item => !item.call)) return [];
    return this.observations.map(item => item.call!);
  }

  get description(): string {
    return this.currentDenial
      ? `${this.adapter === "claude-code" ? "Claude Code" : "OpenCode"} 原生工具操作被拒绝`
      : "";
  }

  accept(raw: unknown, conversation?: string): void {
    this.immediate = undefined;
    const event = record(raw);
    if (!event || !conversation) return;
    if (this.adapter === "claude-code") {
      if (event.session_id !== conversation || event.parent_tool_use_id != null || event.agent_id != null) return;
      const content = record(event.message)?.content;
      if (event.type === "assistant" && Array.isArray(content)) {
        for (const value of content) {
          const block = record(value);
          if (block?.type !== "tool_use" || !nonempty(block.id)) continue;
          const key = `${conversation}\0${block.id}`;
          let call = completeCall(block.name, block.input);
          if (this.claudeCalls.has(key) && objectHash(this.claudeCalls.get(key) ?? null) !== objectHash(call ?? null))
            call = undefined;
          this.claudeCalls.set(key, call);
        }
        return;
      }
      // SDKPermissionDeniedMessage is an explicit native event, unlike the
      // error text in a tool_result. It has no input; pair only the exact ID.
      // https://unpkg.com/@anthropic-ai/claude-agent-sdk/sdk.d.ts
      if (event.type === "system" && event.subtype === "permission_denied") {
        const call = nonempty(event.tool_use_id)
          ? this.claudeCalls.get(`${conversation}\0${event.tool_use_id}`) : undefined;
        this.addDenial(event.tool_use_id, conversation, call?.name === event.tool_name ? call : undefined);
        this.immediate = this.denied;
        return;
      }
      // The CLI result's structured permission_denials is authoritative; a
      // tool_result's free-form error content is not a permission protocol.
      // https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/types.py
      if (event.type !== "result" || !Array.isArray(event.permission_denials)) return;
      this.deniedById.clear();
      this.unidentifiedDenial = false;
      for (const value of event.permission_denials) {
        const denial = record(value);
        this.addDenial(denial?.tool_use_id, conversation,
          completeCall(denial?.tool_name, denial?.tool_input));
      }
      if (this.currentDenial) this.immediate = this.denied;
      return;
    }

    const part = record(event.part);
    const state = record(part?.state);
    if (event.type !== "tool_use" || event.sessionID !== conversation ||
        part?.type !== "tool" || part.sessionID !== conversation || !state) return;
    if (state.status === "completed" && nonempty(part.callID)) {
      this.deniedById.delete(part.callID);
      return;
    }
    if (state.status !== "error" || !isOpenCodePermissionError(state.error)) return;
    this.addDenial(part.callID, conversation, completeCall(part.tool, state.input));
    this.immediate = this.denied;
  }

  private addDenial(id: unknown, session: string, call?: NativePermissionCall): void {
    if (!nonempty(id)) {
      this.unidentifiedDenial = true;
      return;
    }
    const prior = this.deniedById.get(id);
    // Conflicting metadata for one ID must never select an arbitrary operation.
    if (prior && objectHash(prior.call ?? null) !== objectHash(call ?? null)) call = undefined;
    this.deniedById.set(id, { native_call_id: id, session_id: session, call });
  }
}
