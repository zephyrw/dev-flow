import { highRiskDiagnostic } from "../../presentation/src/secret-redactor.js";
import type { Store } from "../../store/src/store.js";
import { publicEvent, now } from "../../core/src/util.js";

/** Coalesce token/step updates, while retaining each completed step in raw JSONL. */
export class AgentTelemetry {
  private events = new Map<string, Record<string, any>>();
  private timer?: NodeJS.Timeout;
  // Retained independently of timed flushes; never persist an unframed delta.
  private textFragments = new Map<string, string | null>();
  private sensitiveSteps = new Set<string>();
  private sensitiveSaturated = false;
  private fragmentsSaturated = false;
  constructor(
    private store: Store,
    private workflow: string,
    private project: string,
    private run: string,
  ) {}
  accept(event: Record<string, any>) {
    const step = event.step_update;
    const conversation =
      (typeof step?.conversation_id === "string" && step.conversation_id) ||
      (typeof event.conversation_id === "string" && event.conversation_id) ||
      (typeof event.session_id === "string" && event.session_id) ||
      "root";
    const key = step
      ? `step:${conversation}:${this.run}:${step.step_index}`
      : `event:${conversation}:${this.run}:${event.event}`;
    if (step && highRiskDiagnostic(`${step.tool_name ?? ""} ${JSON.stringify(step.tool_info ?? {})}`)) {
      if (this.sensitiveSteps.size < 128) this.sensitiveSteps.add(key);
      else this.sensitiveSaturated = true;
    }
    if (step && (this.sensitiveSteps.has(key) || this.sensitiveSaturated)) {
      event = { event: "step_update", step_update: {
        conversation_id: conversation, step_index: step.step_index,
        step_type: step.step_type, state: step.state,
        text: "敏感认证操作：仅保留状态",
      } };
      this.events.set(key, event);
      if (!this.timer) this.timer = setTimeout(() => this.flush(), 500);
      return;
    }
    if (step && typeof step.text_delta === "string") {
      const prior = this.textFragments.get(key);
      if (prior !== null && (this.textFragments.has(key) || !this.fragmentsSaturated)) {
        if (this.textFragments.size >= 128 && !this.textFragments.has(key)) this.fragmentsSaturated = true;
        else {
          const combined = (prior ?? "") + step.text_delta;
          this.textFragments.set(key, combined.length <= 65536 ? combined : null);
        }
      }
    }
    if (step) {
      const { text_delta: _delta, ...withoutDelta } = step;
      const complete = ["DONE", "ERROR"].includes(step.state);
      event = { ...event, step_update: { ...withoutDelta,
        ...(complete && this.textFragments.has(key)
          ? { text: this.textFragments.get(key) ?? "[分片诊断超过安全缓冲上限，已省略]" } : {}),
      } };
      // Keep the bounded prefix for repeated DONE deltas from the same native step.
    }
    const previous = this.events.get(key)?.step_update;
    if (step && previous)
      event = {
        ...event,
        step_update: {
          ...previous,
          ...event.step_update,
          ...(previous.tool_info || step.tool_info
            ? {
                tool_info: {
                  ...previous.tool_info,
                  ...step.tool_info,
                  parameters: {
                    ...previous.tool_info?.parameters,
                    ...step.tool_info?.parameters,
                  },
                },
              }
            : {}),
        },
      };
    this.events.set(key, event);
    if (event.event === "result")
      this.usage(event.result?.usage ?? event.usage);
    if (["init", "result"].includes(event.event) || this.events.size >= 100 || (event.step_update?.text_delta?.length ?? 0) >= 16000)
      this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 500);
  }
  private usage(raw: any) {
    const numeric = (...values: unknown[]) =>
      values.find(
        (v) => typeof v === "number" && Number.isFinite(v) && v >= 0,
      ) as number | undefined;
    const input = numeric(raw?.input_tokens, raw?.prompt_tokens);
    const output = numeric(raw?.output_tokens, raw?.completion_tokens);
    this.store.put("run_usage", this.run, this.workflow, {
      id: this.run,
      workflow_id: this.workflow,
      run_id: this.run,
      available: input !== undefined && output !== undefined,
      input_tokens: input,
      output_tokens: output,
      cached_tokens: numeric(
        raw?.cached_tokens,
        raw?.cache_read_tokens,
        raw?.prompt_tokens_details?.cached_tokens,
        raw?.input_tokens_details?.cached_tokens,
      ),
      reasoning_tokens: numeric(
        raw?.reasoning_tokens,
        raw?.thinking_tokens,
        raw?.completion_tokens_details?.reasoning_tokens,
        raw?.output_tokens_details?.reasoning_tokens,
      ),
      recorded_at: now(),
    });
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const events = [...this.events.values()];
    this.events.clear();
    if (events.length && !this.run.startsWith("aside-run"))
      this.store.transaction(() => {
        for (const event of events)
          this.store.event(
            this.workflow,
            this.project,
            "AgentEvent",
            publicEvent(event),
            this.run,
          );
      });
  }
}
