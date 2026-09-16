import type { Store } from "../../store/src/store.js";
import { publicEvent, now } from "../../core/src/util.js";

/** Coalesce token/step updates, while retaining each completed step in raw JSONL. */
export class AgentTelemetry {
  private events = new Map<string, Record<string, any>>();
  private timer?: NodeJS.Timeout;
  constructor(
    private store: Store,
    private workflow: string,
    private project: string,
    private run: string,
  ) {}
  accept(event: Record<string, any>) {
    const step = event.step_update;
    const key = step ? "step:" + step.step_index : "event:" + event.event;
    this.events.set(key, event);
    if (event.event === "result")
      this.usage(event.result?.usage ?? event.usage);
    if (["init", "result"].includes(event.event) || this.events.size >= 100)
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
    if (events.length)
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
