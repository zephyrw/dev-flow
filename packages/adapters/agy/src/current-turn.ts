/** AGY's resumed result can retain an error from an earlier conversation turn.
 * Only disregard it when a new user boundary and a completed model response
 * prove the current turn completed after its last tool. Error wording and reset
 * countdowns in the conversation footer are not reliable turn identifiers.
 * Workflow completion remains the engine's responsibility. */
export class CurrentTurn {
  private userStep?: number;
  private modelState?: string;
  private modelStep = -1;
  private toolStep = -1;
  private runtimeFailed = false;
  private toolFailures: { code: string; message: string }[] = [];
  accept(event: Record<string, any>) {
    const step = event.event === "step_update" ? event.step_update : undefined;
    if (!step) return;
    if (step.step_type === "user_input" && step.state === "DONE") {
      if (this.userStep !== undefined && step.step_index <= this.userStep)
        return;
      this.userStep = step.step_index;
      this.modelState = undefined;
      this.modelStep = this.toolStep = -1;
      this.runtimeFailed = false;
      this.toolFailures = [];
      return;
    }
    if (this.userStep === undefined || step.step_index <= this.userStep) return;
    if (
      step.step_type !== "tool" &&
      (/error|failure/i.test(step.step_type) || step.error || step.error_info)
    )
      this.runtimeFailed = true;
    if (
      step.step_type === "agent_response" &&
      step.step_index >= this.modelStep
    ) {
      this.modelState = step.state;
      this.modelStep = step.step_index;
    }
    if (step.step_type === "tool")
      this.toolStep = Math.max(this.toolStep, step.step_index);
    if (step.state !== "ERROR") return;
    if (step.step_type !== "tool") {
      this.runtimeFailed = true;
      return;
    }
    try {
      const value = JSON.parse(step.tool_info?.output);
      const failure = value.error ?? value;
      if (
        typeof failure.code === "string" &&
        typeof failure.message === "string"
      )
        this.toolFailures.push({
          code: failure.code,
          message: failure.message,
        });
    } catch {
      /* An unstructured tool output cannot supply a platform cause. */
    }
  }
  staleError(
    result: Record<string, any> | undefined,
    _previousErrors: string[],
    exit: number | null,
  ) {
    return (
      !!result &&
      [0, 1].includes(exit!) &&
      typeof result.error === "string" &&
      typeof result.response === "string" &&
      result.response.trim().length > 0 &&
      result.status === "ERROR" &&
      this.userStep !== undefined &&
      this.modelState === "DONE" &&
      this.modelStep > this.toolStep &&
      !this.runtimeFailed &&
      !(Array.isArray(result.denied_actions) && result.denied_actions.length)
    );
  }
  reportedFailure(response: unknown) {
    return [...this.toolFailures]
      .reverse()
      .find((f) => typeof response === "string" && response.includes(f.code));
  }
}
