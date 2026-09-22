/**
 * D02 整合点：decode → adapter 会话分流 → 根身份校验 → ConversationObserver → 根/子 telemetry。
 * D02 的 ConversationService 通过 bindConversationObserver 接入；未接入时本文件 route 纯函数仍按原生身份分流。
 */
import type { NativeConversationEvent } from "../../adapters/sdk/src/interface.js";
import type { Store } from "../../store/src/store.js";
import type { Run, Workflow } from "../../contracts/src/index.js";
import {
  CONVERSATION_EVENT,
  conversationActivityKey,
  type ConversationActivityPayload,
  type ConversationStatus,
} from "../../contracts/src/conversation.js";
import type {
  RunActivity,
  RunObservation,
  QuotaBucket,
} from "../../contracts/src/run-observation.js";
import { now, publicEvent } from "../../core/src/util.js";
import { AgentTelemetry } from "./agent-telemetry.js";
import {
  agyStepActivity,
  conversationEventActivities,
  inferConversationEventKind,
  isNativeConversationEvent,
  nativeActivities,
  nativeEventIdentity,
  quotaBuckets,
  type NativeEventScopeIdentity,
} from "./native-activity.js";

export type ConversationTelemetryBound = {
  nativeRootId?: string;
  conversationId?: string;
  attemptId?: string;
  rootConversationId?: string;
};

export type ConversationTelemetryRoute = {
  scope: "root" | "child";
  applyRootIdentity: boolean;
  applyRootModel: boolean;
  applyRootQuota: boolean;
  identityGap?: "undifferentiated_session";
  nativeConversationId?: string;
  nativeRootId?: string;
  nativeParentId?: string;
  conversationId: string;
  attemptId: string;
  rootId: string;
};

/** D02 整合点：树服务接入后由 observer 把原生事件落到 conversation_node/attempt。 */
export interface ConversationEventSink {
  applyConversationEvent(
    event: NativeConversationEvent,
    route: ConversationTelemetryRoute,
  ): void;
}

export function telemetryScopeId(value: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 96);
  if (!cleaned) return "root";
  if (!/^[a-zA-Z0-9]/.test(cleaned)) return ("c_" + cleaned).slice(0, 96);
  return cleaned;
}

function routeIdentity(
  identity: NativeEventScopeIdentity,
  kind: NativeConversationEvent["kind"],
  bound: ConversationTelemetryBound,
  fallbackAttemptId: string,
): ConversationTelemetryRoute {
  const nativeRoot = identity.rootNativeId ?? bound.nativeRootId;
  const nativeSession = identity.sessionNativeId;
  const nativeAgent = identity.agentNativeId;
  const nativeParent = identity.parentNativeId;
  const attemptId = bound.attemptId ?? fallbackAttemptId;
  const childByParent = Boolean(
    nativeParent && nativeParent !== (nativeSession ?? nativeAgent),
  );
  const childBySession = Boolean(
    nativeRoot && nativeSession && nativeSession !== nativeRoot,
  );
  const isChild = identity.structured && (childByParent || childBySession);
  const nativeConversationId = nativeSession ?? nativeAgent ?? nativeRoot;
  const rootId =
    bound.rootConversationId ??
    bound.conversationId ??
    (nativeRoot ? telemetryScopeId(nativeRoot) : "root");
  if (isChild) {
    const conversationId = nativeConversationId
      ? telemetryScopeId(nativeConversationId)
      : "child";
    return {
      scope: "child",
      applyRootIdentity: false,
      applyRootModel: false,
      applyRootQuota: false,
      nativeConversationId,
      nativeRootId: nativeRoot,
      nativeParentId: nativeParent,
      conversationId,
      attemptId,
      rootId,
    };
  }
  const identityGap =
    !identity.structured &&
    nativeSession &&
    bound.nativeRootId &&
    nativeSession !== bound.nativeRootId
      ? "undifferentiated_session"
      : undefined;
  const identityKind = kind === "discovered" || kind === "state";
  return {
    scope: "root",
    applyRootIdentity: Boolean(
      nativeSession &&
        (identityKind || identityGap || !bound.nativeRootId),
    ),
    applyRootModel: true,
    applyRootQuota: true,
    identityGap,
    nativeConversationId: nativeSession ?? nativeRoot,
    nativeRootId: nativeRoot ?? nativeSession,
    nativeParentId: nativeParent,
    conversationId:
      bound.conversationId ??
      (nativeSession
        ? telemetryScopeId(nativeSession)
        : nativeRoot
          ? telemetryScopeId(nativeRoot)
          : "root"),
    attemptId,
    rootId,
  };
}

export function routeNativeConversationEvent(
  event: NativeConversationEvent,
  bound: ConversationTelemetryBound = {},
  fallbackAttemptId: string,
): ConversationTelemetryRoute {
  return routeIdentity(
    nativeEventIdentity(event),
    event.kind,
    bound,
    fallbackAttemptId,
  );
}

export function routeRawTelemetryEvent(
  raw: any,
  bound: ConversationTelemetryBound = {},
  fallbackAttemptId: string,
): ConversationTelemetryRoute {
  return routeIdentity(
    nativeEventIdentity(raw),
    inferConversationEventKind(raw),
    bound,
    fallbackAttemptId,
  );
}

export function shouldApplyRootSessionIdentity(
  route: ConversationTelemetryRoute,
): boolean {
  return route.scope === "root" && route.applyRootIdentity;
}

function conversationStatusFromActivity(
  status: RunActivity["status"],
): ConversationStatus {
  if (status === "active") return "running";
  if (status === "done") return "completed";
  if (status === "error") return "failed";
  return "interrupted";
}

/** One bounded batch per run; every item snapshot is independently replayable. */
export class RunTelemetry {
  private legacy: AgentTelemetry;
  private pending = new Map<string, RunActivity>();
  private active = new Map<string, RunActivity>();
  private childPending = new Map<string, ConversationActivityPayload>();
  private childActive = new Map<string, ConversationActivityPayload>();
  private timer?: NodeJS.Timeout;
  private dirty = true;
  private closed = false;
  private nativeRootId?: string;
  private streamSeq = 0;
  private observer?: ConversationEventSink;
  readonly identityGaps: Array<{
    reason: "undifferentiated_session";
    nativeSessionId?: string;
  }> = [];
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
  bindConversationObserver(observer: ConversationEventSink) {
    this.observer = observer;
  }
  bindConversationContext(
    ids: Pick<
      RunObservation,
      "conversation_id" | "conversation_attempt_id" | "root_conversation_id"
    >,
  ) {
    this.metadata(ids);
  }
  private boundIdentity(): ConversationTelemetryBound {
    return {
      nativeRootId: this.nativeRootId,
      conversationId: this.observation.conversation_id,
      attemptId: this.observation.conversation_attempt_id ?? this.run.id,
      rootConversationId:
        this.observation.root_conversation_id ??
        this.observation.conversation_id,
    };
  }
  private schedule() {
    this.dirty = true;
    if (this.pending.size + this.childPending.size >= 100) this.flush();
    else if (!this.timer) this.timer = setTimeout(() => this.flush(), 500);
  }
  metadata(
    value: Partial<
      Pick<
        RunObservation,
        | "actual_model"
        | "effort"
        | "model_source"
        | "conversation_id"
        | "conversation_attempt_id"
        | "root_conversation_id"
        | "actual_effort"
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
  private publishesMainLog() {
    return this.run.purpose !== "aside";
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
  private recordIdentityGap(route: ConversationTelemetryRoute) {
    if (!route.identityGap) return;
    this.identityGaps.push({
      reason: route.identityGap,
      nativeSessionId: route.nativeConversationId,
    });
  }
  private bindRootFromRoute(route: ConversationTelemetryRoute) {
    const nativeId = route.nativeConversationId ?? route.nativeRootId;
    if (!nativeId) return;
    if (!this.nativeRootId) this.nativeRootId = nativeId;
    this.metadata({
      conversation_id: nativeId,
      root_conversation_id:
        this.observation.root_conversation_id ?? nativeId,
      conversation_attempt_id:
        this.observation.conversation_attempt_id ?? this.run.id,
    });
  }
  private asConversationEvent(
    raw: any,
    route: ConversationTelemetryRoute,
  ): NativeConversationEvent {
    if (isNativeConversationEvent(raw)) return raw;
    this.streamSeq += 1;
    return {
      source_id: "run-stream",
      source_seq: String(this.streamSeq),
      root_native_id: route.nativeRootId ?? route.rootId,
      session_native_id: route.nativeConversationId,
      agent_native_id: nativeEventIdentity(raw).agentNativeId,
      parent_native_id: route.nativeParentId,
      kind: inferConversationEventKind(raw),
      payload: raw,
    };
  }
  private notifyObserver(
    event: NativeConversationEvent,
    route: ConversationTelemetryRoute,
  ) {
    this.observer?.applyConversationEvent(event, route);
  }
  private queueConversationActivity(
    route: ConversationTelemetryRoute,
    item: RunActivity,
    sourceEventId: string,
  ) {
    if (!this.publishesMainLog()) return;
    const key = conversationActivityKey(
      route.conversationId,
      route.attemptId,
      item.id,
    );
    const previous = this.childActive.get(key) ?? this.childPending.get(key);
    const merged = {
      ...previous,
      conversation_id: route.conversationId,
      attempt_id: route.attemptId,
      root_id: route.rootId,
      activity_id: item.id,
      source_event_id: sourceEventId,
      public_text: (item.text ?? previous?.public_text ?? "").slice(0, 16000),
      title: item.title || previous?.title,
      status: conversationStatusFromActivity(item.status),
      kind: item.kind,
      command:
        item.command && item.command.length > 32000
          ? item.command.slice(0, 32000) + "…"
          : item.command || previous?.command,
    } satisfies ConversationActivityPayload;
    if (item.status === "active" && item.kind === "tool")
      this.childActive.set(key, merged);
    else this.childActive.delete(key);
    this.childPending.set(key, publicEvent(merged));
    this.schedule();
  }
  private applyRootModel(raw: any) {
    const model =
      raw.init?.model ??
      (raw.event === "init" ||
      raw.type === "system" ||
      raw.type === "session.started"
        ? raw.model
        : undefined);
    if (typeof model === "string")
      this.metadata({ actual_model: model, model_source: "native_event" });
  }
  private applyRootUsage(raw: any) {
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
  private applyAgyRoot(raw: any) {
    this.legacy.accept(raw);
    const step = agyStepActivity(raw.step_update);
    if (step) this.activity(step, false);
  }
  private applyRootRaw(raw: any, route: ConversationTelemetryRoute) {
    if (route.applyRootIdentity) this.bindRootFromRoute(route);
    if (route.applyRootModel) this.applyRootModel(raw);
    if (route.applyRootQuota && (raw.rate_limits || raw.rateLimits))
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
      this.applyAgyRoot(raw);
      return;
    }
    for (const activity of nativeActivities(raw)) this.activity(activity, true);
    this.applyRootUsage(raw);
  }
  private applyChildRaw(raw: any, route: ConversationTelemetryRoute) {
    const sourceId = `run-stream:${this.streamSeq}`;
    if (
      this.observation.adapter === "agy" &&
      ["init", "step_update", "result"].includes(raw.event)
    ) {
      const step = agyStepActivity(raw.step_update);
      if (step) this.queueConversationActivity(route, step, sourceId);
      return;
    }
    for (const activity of nativeActivities(raw))
      this.queueConversationActivity(route, activity, sourceId);
  }
  private applyRootConversation(
    event: NativeConversationEvent,
    route: ConversationTelemetryRoute,
  ) {
    if (route.applyRootIdentity) this.bindRootFromRoute(route);
    const payload = event.payload as any;
    if (event.kind === "model" && route.applyRootModel) {
      const model = payload?.actual_model ?? payload?.model;
      if (typeof model === "string")
        this.metadata({
          actual_model: model,
          effort:
            typeof payload?.effort === "string" ? payload.effort : undefined,
          actual_effort:
            typeof payload?.actual_effort === "string"
              ? payload.actual_effort
              : undefined,
          model_source:
            payload?.model_source === "native_session"
              ? "native_session"
              : "native_event",
        });
    }
    if (event.kind === "quota" && route.applyRootQuota)
      this.quota(payload, event.occurred_at ?? now(), "native_event");
    if (event.kind !== "activity") return;
    const sourceId = `${event.source_id}:${event.source_seq}`;
    for (const activity of conversationEventActivities(event)) {
      this.activity(activity, true);
      this.queueConversationActivity(route, activity, sourceId);
    }
  }
  private applyChildConversation(
    event: NativeConversationEvent,
    route: ConversationTelemetryRoute,
  ) {
    if (event.kind !== "activity") return;
    const sourceId = `${event.source_id}:${event.source_seq}`;
    for (const activity of conversationEventActivities(event))
      this.queueConversationActivity(route, activity, sourceId);
  }
  accept(raw: any) {
    if (this.closed || !raw || typeof raw !== "object") return;
    if (isNativeConversationEvent(raw)) {
      this.acceptConversationEvent(raw);
      return;
    }
    const route = routeRawTelemetryEvent(
      raw,
      this.boundIdentity(),
      this.run.id,
    );
    this.recordIdentityGap(route);
    this.notifyObserver(this.asConversationEvent(raw, route), route);
    if (route.scope === "child") {
      this.applyChildRaw(raw, route);
      return;
    }
    this.applyRootRaw(raw, route);
  }
  acceptConversationEvent(event: NativeConversationEvent) {
    if (this.closed) return;
    const route = routeNativeConversationEvent(
      event,
      this.boundIdentity(),
      this.run.id,
    );
    this.recordIdentityGap(route);
    this.notifyObserver(event, route);
    if (route.scope === "child") {
      this.applyChildConversation(event, route);
      return;
    }
    this.applyRootConversation(event, route);
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
    if (!this.dirty && !this.pending.size && !this.childPending.size) return;
    if (!(this.store as any).db?.open) return;
    this.observation.updated_at = now();
    const snapshot = publicEvent(this.observation);
    const publish = this.publishesMainLog();
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
        for (const activity of this.childPending.values())
          this.store.event(
            this.workflow.id,
            this.workflow.project_id,
            CONVERSATION_EVENT.activity,
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
    this.childPending.clear();
    this.dirty = false;
  }
}
