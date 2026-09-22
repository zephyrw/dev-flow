import type { Store } from "../../store/src/store.js";
import type { Run, Workflow } from "../../contracts/src/index.js";
import type {
  RunActivity,
  RunObservation,
  QuotaBucket,
} from "../../contracts/src/run-observation.js";
import { now, publicEvent } from "../../core/src/util.js";
import { AgentTelemetry } from "./agent-telemetry.js";
import { nativeActivities, quotaBuckets } from "./native-activity.js";
import { toolSummary } from "../../presentation/src/tool-summary.js";

/** One bounded batch per run; every item snapshot is independently replayable. */
export class RunTelemetry {
  private legacy: AgentTelemetry;
  private pending = new Map<string, RunActivity>();
  private active = new Map<string, RunActivity>();
  private timer?: NodeJS.Timeout;
  private dirty = true;
  private closed = false;
  readonly observation: RunObservation;
  constructor(
    private store: Store,
    private workflow: Workflow,
    private run: Run,
  ) {
    this.legacy = new AgentTelemetry(
      store,
      workflow.id,
      workflow.project_id,
      run.id,
    );
    this.observation = {
      run_id: run.id,
      adapter: run.profile?.adapterId ?? run.adapter,
      purpose: run.purpose,
      requested_model: run.profile?.modelId,
      status: "starting",
      started_at: run.started_at,
      updated_at: now(),
      active_tools: 0,
    };
    this.flush();
  }
  private schedule() {
    this.dirty = true;
    if (this.pending.size >= 100) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 500);
  }
  metadata(
    value: Partial<
      Pick<
        RunObservation,
        "actual_model" | "effort" | "model_source" | "conversation_id"
      >
    >,
  ) {
    if (this.closed) return;
    Object.assign(this.observation, value);
    this.schedule();
  }
  quota(
    raw: any,
    observedAt: string,
    source: "native_session" | "native_event",
  ) {
    if (this.closed || (this.observation.quota && Date.parse(this.observation.quota.observed_at) > Date.parse(observedAt))) return;
    const buckets = quotaBuckets(raw);
    if (!buckets.length) return;
    this.observation.quota = { source, observed_at: observedAt, buckets };
    this.schedule();
  }
  accountQuota(buckets: QuotaBucket[], observedAt: string) {
    if (this.closed || !buckets.length || (this.observation.quota && Date.parse(this.observation.quota.observed_at) > Date.parse(observedAt))) return;
    this.observation.quota = {
      source: "account_api",
      observed_at: observedAt,
      buckets,
    };
    this.schedule();
  }
  private activity(item: RunActivity, publish: boolean) {
    // Partial completion records inherit only the same run's live item.
    const previous = this.active.get(item.id) ?? this.pending.get(item.id);
    const full = {
      ...previous,
      ...Object.fromEntries(
        Object.entries(item).filter(([, v]) => v !== undefined && v !== ""),
      ),
    } as RunActivity;
    full.text = full.text?.slice(0, 16000) ?? "";
    if (full.command && full.command.length > 32000)
      full.command = full.command.slice(0, 32000) + "…";
    if (full.status === "active" && full.kind === "tool")
      this.active.set(full.id, full);
    else this.active.delete(full.id);
    if (publish) this.pending.set(full.id, publicEvent(full));
    this.observation.current_activity = [...this.active.values()].at(-1);
    this.observation.active_tools = this.active.size;
    this.observation.activity_at = now();
    this.observation.status =
      full.status === "error" && full.kind === "event"
        ? "error"
        : this.active.size
          ? "working"
          : "responding";
    this.schedule();
  }
  accept(raw: any) {
    if (this.closed || !raw || typeof raw !== "object") return;
    const conversation =
      raw.thread_id ??
      raw.session_id ??
      raw.conversation_id ??
      raw.init?.conversation_id;
    if (typeof conversation === "string")
      this.metadata({ conversation_id: conversation });
    const model =
      raw.init?.model ??
      (raw.event === "init" ||
      raw.type === "system" ||
      raw.type === "session.started"
        ? raw.model
        : undefined);
    if (typeof model === "string")
      this.metadata({ actual_model: model, model_source: "native_event" });
    if (raw.rate_limits || raw.rateLimits)
      this.quota(raw.rate_limits ?? raw, now(), "native_event");
    if (
      raw.event === "init" ||
      raw.type === "turn.started" ||
      raw.type === "thread.started"
    ) {
      this.observation.status = "responding";
      this.observation.activity_at = now();
      this.schedule();
    }
    if (
      this.observation.adapter === "agy" &&
      ["init", "step_update", "result"].includes(raw.event)
    ) {
      this.legacy.accept(raw);
      const step = raw.step_update;
      if (step && ["tool", "agent_response"].includes(step.step_type)) {
        const summary = toolSummary(
          step.tool_name ?? step.tool_info?.name,
          step.tool_info?.parameters ?? {},
        );
        this.activity(
          {
            id: String(step.step_index),
            kind: step.step_type === "tool" ? "tool" : "message",
            title: summary.title ?? "工具操作",
            text: summary.text,
            command: summary.command,
            cwd: summary.cwd,
            status:
              step.state === "ERROR"
                ? "error"
                : step.state === "DONE"
                  ? "done"
                  : "active",
          },
          false,
        );
      }
      return;
    }
    for (const activity of nativeActivities(raw)) this.activity(activity, true);
    // Token totals are distinct from provider quota windows.
    const usage = raw.usage ?? raw.result?.usage;
    if (usage && ["turn.completed", "result"].includes(raw.type ?? raw.event)) {
      const numeric = (v: any) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
      const input = numeric(usage.input_tokens),
        output = numeric(usage.output_tokens);
      this.store.put("run_usage", this.run.id, this.workflow.id, {
        run_id: this.run.id,
        available: input !== undefined && output !== undefined,
        input_tokens: input,
        output_tokens: output,
        cached_tokens: numeric(usage.cached_input_tokens),
        recorded_at: now(),
      });
    }
  }
  finish(failed = false) {
    if (this.closed) return;
    for (const item of [...this.active.values()])
      this.activity(
        { ...item, status: "interrupted" },
        this.observation.adapter !== "agy",
      );
    this.observation.status = failed ? "error" : "exited";
    this.observation.current_activity = undefined;
    this.observation.active_tools = 0;
    this.dirty = true;
    this.flush();
    this.legacy.flush();
    this.closed = true;
  }
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.dirty && !this.pending.size) return;
    if (!(this.store as any).db?.open) return;
    this.observation.updated_at = now();
    const snapshot = publicEvent(this.observation);
    const publish = this.run.purpose !== "aside";
    this.store.transaction(() => {
      if (publish) {
        for (const activity of this.pending.values())
          this.store.event(
            this.workflow.id,
            this.workflow.project_id,
            "NativeActivity",
            activity,
            this.run.id,
          );
      }
      this.store.put(
        "run_observation",
        this.run.id,
        this.workflow.id,
        snapshot,
      );
      if (publish) {
        this.store.event(
          this.workflow.id,
          this.workflow.project_id,
          "RunObserved",
          snapshot,
          this.run.id,
        );
      }
    });
    this.pending.clear();
    this.dirty = false;
  }
}
