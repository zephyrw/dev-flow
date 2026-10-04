import type { NativePermissionCall } from "../../../core/src/native-permission.js";
import { objectHash } from "../../../core/src/util.js";

/** Preserve only complete tool metadata belonging to the most recent user turn. */
export class AgyDeniedCalls {
  private calls = new Map<number, NativePermissionCall>();
  private permissionSteps = new Set<number>();
  private userStep?: number;
  currentDenial = false;
  immediate?: NativePermissionCall[];
  denied: NativePermissionCall[] = [];
  description = "";
  constructor(private readCall?: (conversation: string, index: number) => NativePermissionCall | undefined) {}
  currentResult(result: Record<string, any> | undefined) {
    if (!result || this.userStep === undefined || this.currentDenial || !Array.isArray(result.denied_actions) || !result.denied_actions.length) return result;
    const { denied_actions: _historical, ...current } = result;
    return current;
  }
  accept(event: Record<string, any>, conversation?: string) {
    this.immediate = undefined;
    const step = event.event === "step_update" ? event.step_update : undefined;
    if (step && (step.conversation_id && step.conversation_id !== conversation ||
        !Number.isSafeInteger(step.step_index) || step.step_index < 0)) return;
    if (step?.step_type === "user_input" && step.state === "DONE") {
      if (this.userStep !== undefined && step.step_index <= this.userStep) return;
      this.calls.clear();
      this.permissionSteps.clear();
      this.userStep = step.step_index;
      this.currentDenial = false;
      this.denied = [];
    }
    if (step?.step_type === "tool" && step.state === "ERROR" &&
        (this.userStep === undefined || step.step_index > this.userStep)) {
      let native;
      try { if (conversation) native = this.readCall?.(conversation, step.step_index); } catch { /* Public stream metadata remains usable. */ }
      const name = native?.name ?? step.tool_info?.name ?? step.tool_name;
      const parameters = native?.parameters ?? step.tool_info?.parameters;
      if (typeof name === "string" && /^[a-z][a-z0-9_]*$/.test(name) && parameters && typeof parameters === "object" && !Array.isArray(parameters))
        this.calls.set(step.step_index, { name, parameters });
      const error = step.tool_info?.error;
      const permissionDenied = error?.type === "TOOL_ERROR" && typeof error.message === "string" &&
        /^permission check failed for .+: user denied permission for /i.test(error.message);
      if (permissionDenied) this.permissionSteps.add(step.step_index);
      if (this.userStep !== undefined && step.step_index > this.userStep && permissionDenied) {
        const call = this.calls.get(step.step_index);
        this.immediate = call ? [call] : [];
        this.currentDenial = true;
        this.denied = this.immediate;
      }
    }
    if (event.event === "result" && Array.isArray(event.result?.denied_actions) && event.result.denied_actions.length) {
      // AGY resumes include cumulative denied_actions from older turns, even
      // after the current call succeeds. Only current errors can confirm those.
      if (this.userStep !== undefined && this.permissionSteps.size === 0) return;
      this.description = JSON.stringify(event.result.denied_actions);
      this.currentDenial = true;
      const names = new Set(event.result.denied_actions.map((action: any) =>
        String(action.display_name ?? action.tool_name ?? "").replaceAll("_", "").toLowerCase()));
      this.denied = [...new Map([...this.calls.entries()]
        .filter(([index]) => this.permissionSteps.has(index)).map(([, call]) => call)
        .filter(call => names.has(call.name.replaceAll("_", "").toLowerCase()))
        .map(call => [objectHash(call), call])).values()];
    }
  }
}
