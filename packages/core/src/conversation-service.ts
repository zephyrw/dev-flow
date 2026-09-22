import type { Store } from "../../store/src/store.js";
import type { NativeConversationEvent } from "../../adapters/sdk/src/interface.js";
import {
  conversationBindingHash,
  conversationCursorHash,
} from "../../adapters/sdk/src/conversation-source.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  CONVERSATION_EVENT,
  ConversationActivityPayloadSchema,
  ConversationAttemptReasonSchema,
  ConversationAttemptSchema,
  ConversationBindingSchema,
  ConversationCursorSchema,
  ConversationNodeSchema,
  ConversationStatusSchema,
  ConversationTreeSnapshotSchema,
  conversationParentIssue,
  isTerminalConversationStatus,
  isWorkingConversationStatus,
  unknownSubagentCapabilities,
  type ConversationActivityPayload,
  type ConversationAttempt,
  type ConversationBinding,
  type ConversationCursor,
  type ConversationKind,
  type ConversationNode,
  type ConversationParentIssue,
  type ConversationStatus,
  type ConversationTreeSnapshot,
  type SubagentCapabilities,
} from "../../contracts/src/conversation.js";
import {
  FlowError,
  type DomainEvent,
  type Run,
  type Workflow,
} from "../../contracts/src/index.js";
import { id, now } from "./util.js";

export interface ConversationApplyContext {
  project_id: string;
  workflow_id: string;
  run_id: string;
  adapter_id: string;
  scope: string;
  lineage_id: string;
  purpose: string;
  root_native_id?: string;
  conversation_id?: string;
}

export interface ConversationDiagnostic {
  code: string;
  message: string;
  source_id?: string;
  conversation_id?: string;
}

export interface ConversationApplyResult {
  node?: ConversationNode;
  attempt?: ConversationAttempt;
  discovered: boolean;
  updated: boolean;
  skipped: boolean;
  diagnostics: ConversationDiagnostic[];
  cursor: number;
}

export interface ConversationNodeRead {
  node: ConversationNode;
  attempt?: ConversationAttempt;
  ancestors: ConversationNode[];
}

export interface ConversationActivityPage {
  items: DomainEvent[];
  next_before_seq?: number;
  has_more: boolean;
}

const TITLE_MAX = 200;
const SUMMARY_MAX = 500;
const PUBLIC_TEXT_MAX = 16000;
const COMMAND_MAX = 32000;
const DIAGNOSTIC_LIMIT = 200;
const LEGACY_REASON = "历史未记录子会话";

type PayloadRecord = Record<string, unknown>;

interface NativeIds {
  session?: string;
  agent?: string;
  parent?: string;
  spawn?: string;
}

interface IdentityResolution {
  unattributed: boolean;
  node?: ConversationNode;
  ids: NativeIds;
}

export class ConversationService {
  private diagnostics: ConversationDiagnostic[] = [];
  private capabilities = new Map<string, SubagentCapabilities>();

  constructor(private store: Store) {}

  setCapabilities(workflowId: string, capabilities: SubagentCapabilities) {
    this.capabilities.set(workflowId, capabilities);
  }

  getDiagnostics(): ConversationDiagnostic[] {
    return this.diagnostics.slice();
  }

  getTree(workflowId: string, rootId?: string): ConversationTreeSnapshot {
    const nodes = this.store.list<ConversationNode>(
      CONVERSATION_ENTITY.node,
      workflowId,
    );
    if (!nodes.length) return this.legacyTree(workflowId);
    const scoped = rootId
      ? this.store.conversationNodesByRoot<ConversationNode>(rootId).filter(
          (node) => node.workflow_id === workflowId,
        )
      : nodes;
    const attempts = this.store
      .list<ConversationAttempt>(CONVERSATION_ENTITY.attempt, workflowId)
      .filter((attempt) => scoped.some((node) => node.id === attempt.conversation_id))
      .sort((a, b) => a.generation - b.generation);
    const active = resolveActiveRootId(scoped, attempts, rootId);
    return ConversationTreeSnapshotSchema.parse({
      nodes: scoped,
      attempts,
      active_root_id: active,
      capabilities:
        this.capabilities.get(workflowId) ?? unknownSubagentCapabilities(),
      cursor: this.store.eventCursor(workflowId),
    });
  }

  readNode(workflowId: string, conversationId: string): ConversationNodeRead {
    const node = this.store.get<ConversationNode>(
      CONVERSATION_ENTITY.node,
      conversationId,
    );
    if (!node)
      throw new FlowError(CONVERSATION_ERROR.NOT_FOUND, "会话不存在", 404);
    if (node.workflow_id !== workflowId)
      throw new FlowError(
        CONVERSATION_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
        "会话不属于该任务",
        409,
      );
    const attempt = node.current_attempt_id
      ? this.store.get<ConversationAttempt>(
          CONVERSATION_ENTITY.attempt,
          node.current_attempt_id,
        )
      : undefined;
    return { node, attempt, ancestors: collectAncestors(this.store, node) };
  }

  listActivities(
    workflowId: string,
    conversationId: string,
    options?: { before_seq?: number; limit?: number },
  ): ConversationActivityPage {
    this.readNode(workflowId, conversationId);
    return this.store.conversationActivities(
      workflowId,
      conversationId,
      options,
    );
  }

  readCursor(
    adapterId: string,
    sourceId: string,
    conversationId?: string,
  ): ConversationCursor | undefined {
    return this.store.get<ConversationCursor>(
      CONVERSATION_ENTITY.cursor,
      conversationCursorHash({ adapterId, sourceId, conversationId }),
    );
  }

  recordSourceCursor(cursor: ConversationCursor) {
    const parsed = ConversationCursorSchema.parse(cursor);
    this.store.put(
      CONVERSATION_ENTITY.cursor,
      parsed.id,
      parsed.workflow_id,
      parsed,
    );
  }

  applyEvent(
    ctx: ConversationApplyContext,
    event: NativeConversationEvent,
  ): ConversationApplyResult {
    return this.store.transaction(() => this.applyEventTx(ctx, event));
  }

  applyEvents(
    ctx: ConversationApplyContext,
    events: NativeConversationEvent[],
  ): ConversationApplyResult[] {
    return this.store.transaction(() =>
      events.map((event) => this.applyEventTx(ctx, event)),
    );
  }

  private applyEventTx(
    ctx: ConversationApplyContext,
    event: NativeConversationEvent,
  ): ConversationApplyResult {
    const diagnostics: ConversationDiagnostic[] = [];
    const payload = asRecord(event.payload);
    const ids = detachSpawnPlaceholderSession(
      ctx,
      event,
      nativeIds(event, payload),
    );
    if (alreadyApplied(this.store, ctx, event, ids)) {
      return emptyResult(this.store.eventCursor(ctx.workflow_id), true);
    }
    const identity = resolveIdentity(this.store, ctx, event, ids);
    if (identity.unattributed) {
      const diagnostic = {
        code: "unattributed_source",
        message: "来源身份不明确，未写入猜测的主会话",
        source_id: event.source_id,
      };
      diagnostics.push(diagnostic);
      this.pushDiagnostic(diagnostic);
      persistEventCursor(this.store, ctx, event);
      return {
        discovered: false,
        updated: false,
        skipped: true,
        diagnostics,
        cursor: this.store.eventCursor(ctx.workflow_id),
      };
    }
    const child = isChildEvent(ctx, event, ids);
    const root = ensureRoot(this.store, ctx, event, ids, child);
    const ensured = ensureNode(
      this.store,
      ctx,
      event,
      payload,
      ids,
      root,
      child,
    );
    const parentIssue = bindParent(
      this.store,
      ensured.node,
      ids.parent,
      diagnostics,
    );
    if (parentIssue) this.pushDiagnostic(diagnostics[diagnostics.length - 1]!);
    const attempt = ensureAttempt(
      this.store,
      ctx,
      event,
      payload,
      ensured.node,
    );
    const applied = applyKind(
      event,
      payload,
      ids,
      ensured.node,
      attempt,
      diagnostics,
    );
    if (diagnostics.length) {
      for (const diagnostic of diagnostics) this.pushDiagnostic(diagnostic);
    }
    persistSnapshot(this.store, ctx, event, applied.node, applied.attempt, ids);
    interruptOwnedDescendants(
      this.store,
      ctx,
      event,
      payload,
      applied.node,
      applied.attempt,
    );
    emitConversationEvents(
      this.store,
      ctx,
      event,
      payload,
      applied,
      ensured.created,
    );
    completePendingParents(this.store, ctx, applied.node, diagnostics);
    return {
      node: applied.node,
      attempt: applied.attempt,
      discovered: ensured.created,
      updated: !ensured.created,
      skipped: false,
      diagnostics,
      cursor: this.store.eventCursor(ctx.workflow_id),
    };
  }

  private legacyTree(workflowId: string): ConversationTreeSnapshot {
    const workflow = this.store.get<Workflow>("workflow", workflowId);
    const run = workflow?.run_id
      ? this.store.get<Run>("run", workflow.run_id)
      : undefined;
    if (!workflow || !run) {
      return ConversationTreeSnapshotSchema.parse({
        nodes: [],
        attempts: [],
        capabilities: unknownSubagentCapabilities(LEGACY_REASON),
        cursor: this.store.eventCursor(workflowId),
      });
    }
    return projectLegacyRoot(workflow, run, this.store.eventCursor(workflowId));
  }

  private pushDiagnostic(diagnostic: ConversationDiagnostic) {
    this.diagnostics.push(diagnostic);
    if (this.diagnostics.length > DIAGNOSTIC_LIMIT)
      this.diagnostics.splice(0, this.diagnostics.length - DIAGNOSTIC_LIMIT);
  }
}

function emptyResult(cursor: number, skipped: boolean): ConversationApplyResult {
  return {
    discovered: false,
    updated: false,
    skipped,
    diagnostics: [],
    cursor,
  };
}

function asRecord(value: unknown): PayloadRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as PayloadRecord;
}

function readString(payload: PayloadRecord, key: string): string | undefined {
  const value = payload[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function nativeIds(
  event: NativeConversationEvent,
  payload: PayloadRecord,
): NativeIds {
  return {
    session: event.session_native_id ?? readString(payload, "native_session_id"),
    agent: event.agent_native_id ?? readString(payload, "native_agent_id"),
    parent:
      event.parent_native_id ?? readString(payload, "native_parent_session_id"),
    spawn: readString(payload, "spawn_call_id"),
  };
}

function detachSpawnPlaceholderSession(
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  ids: NativeIds,
): NativeIds {
  const rootNative = ctx.root_native_id ?? event.root_native_id;
  if (!ids.spawn || !ids.session || !rootNative) return ids;
  if (ids.session !== rootNative) return ids;
  return { ...ids, session: undefined };
}

function bindingKey(
  ctx: ConversationApplyContext,
  session?: string,
  agent?: string,
): string {
  return conversationBindingHash({
    adapterId: ctx.adapter_id,
    scope: ctx.scope,
    workflowId: ctx.workflow_id,
    lineageId: ctx.lineage_id,
    nativeSessionId: session,
    nativeAgentId: agent,
  });
}

function alreadyApplied(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  ids: NativeIds,
): boolean {
  const conversationId = lookupBoundId(store, ctx, ids);
  const cursorId = conversationCursorHash({
    adapterId: ctx.adapter_id,
    sourceId: event.source_id,
    conversationId,
  });
  const cursor = store.get<ConversationCursor>(
    CONVERSATION_ENTITY.cursor,
    cursorId,
  );
  if (!cursor) return false;
  return seqNotNewer(cursor.source_seq, event.source_seq);
}

function seqNotNewer(stored: string, incoming: string): boolean {
  if (stored === incoming) return true;
  if (/^\d+$/.test(stored) && /^\d+$/.test(incoming)) {
    try {
      return BigInt(incoming) <= BigInt(stored);
    } catch {
      return false;
    }
  }
  return false;
}

function lookupBoundId(
  store: Store,
  ctx: ConversationApplyContext,
  ids: NativeIds,
): string | undefined {
  const keys = [
    bindingKey(ctx, ids.session, ids.agent),
    ids.session ? bindingKey(ctx, ids.session, undefined) : undefined,
    ids.agent ? bindingKey(ctx, undefined, ids.agent) : undefined,
  ];
  for (const key of keys) {
    if (!key) continue;
    const binding = store.get<ConversationBinding>(
      CONVERSATION_ENTITY.binding,
      key,
    );
    if (binding?.conversation_id) return binding.conversation_id;
  }
  if (ids.spawn) {
    const bySpawn = store
      .list<ConversationNode>(CONVERSATION_ENTITY.node, ctx.workflow_id)
      .find(
        (node) =>
          node.spawn_call_id === ids.spawn &&
          node.adapter_id === ctx.adapter_id &&
          node.lineage_id === ctx.lineage_id,
      )?.id;
    if (bySpawn) return bySpawn;
  }
  if (ctx.conversation_id && !isChildIdentity(ctx, ids))
    return ctx.conversation_id;
  return undefined;
}

function isChildIdentity(
  ctx: ConversationApplyContext,
  ids: NativeIds,
  eventRoot?: string,
): boolean {
  if (ids.parent || ids.spawn) return true;
  const rootNative = ctx.root_native_id ?? eventRoot;
  if (ids.session && ids.session !== rootNative) return true;
  if (ids.agent && ids.agent !== rootNative && ids.agent !== ids.session)
    return true;
  return false;
}

function isChildEvent(
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  ids: NativeIds,
): boolean {
  return isChildIdentity(ctx, ids, event.root_native_id);
}

function resolveIdentity(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  ids: NativeIds,
): IdentityResolution {
  const boundId = lookupBoundId(store, ctx, ids);
  if (boundId) {
    const node = store.get<ConversationNode>(CONVERSATION_ENTITY.node, boundId);
    if (node) return { unattributed: false, node, ids };
  }
  if (ids.session || ids.agent || ids.spawn || ctx.conversation_id) {
    return { unattributed: false, ids };
  }
  if (!isChildEvent(ctx, event, ids) && (ctx.root_native_id || event.root_native_id)) {
    if (event.kind === "discovered" || event.kind === "state") {
      return {
        unattributed: false,
        ids: {
          ...ids,
          session: ids.session ?? ctx.root_native_id ?? event.root_native_id,
        },
      };
    }
  }
  return { unattributed: true, ids };
}

function lineageRoot(
  store: Store,
  ctx: ConversationApplyContext,
): ConversationNode | undefined {
  return store
    .list<ConversationNode>(CONVERSATION_ENTITY.node, ctx.workflow_id)
    .find(
      (node) =>
        node.lineage_id === ctx.lineage_id &&
        node.adapter_id === ctx.adapter_id &&
        !node.parent_id &&
        (node.kind === "main" || node.kind === "aside"),
    );
}

function ensureRoot(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  ids: NativeIds,
  child: boolean,
): ConversationNode | undefined {
  const existing = lineageRoot(store, ctx);
  if (existing) return existing;
  if (!child) return undefined;
  const nativeRoot = ctx.root_native_id ?? event.root_native_id;
  const rootIds: NativeIds = { session: nativeRoot };
  const created = createNode(ctx, event, {}, rootIds, undefined, true);
  const attempt = ConversationAttemptSchema.parse({
    id: id("cva"),
    conversation_id: created.id,
    root_id: created.id,
    workflow_id: ctx.workflow_id,
    run_id: ctx.run_id,
    generation: 0,
    status: "discovered",
    observed_at: created.created_at,
    freshness: "fresh",
  });
  created.current_attempt_id = attempt.id;
  persistSnapshot(store, ctx, event, created, attempt, rootIds);
  store.event(
    ctx.workflow_id,
    ctx.project_id,
    CONVERSATION_EVENT.discovered,
    { node: created, attempt },
    ctx.run_id,
  );
  return created;
}

function ensureNode(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  payload: PayloadRecord,
  ids: NativeIds,
  root: ConversationNode | undefined,
  child: boolean,
): { node: ConversationNode; created: boolean } {
  const replaces = readString(payload, "replaces_conversation_id");
  if (!replaces) {
    const existingId = lookupBoundId(store, ctx, ids);
    if (existingId) {
      const existing = store.get<ConversationNode>(
        CONVERSATION_ENTITY.node,
        existingId,
      );
      if (existing) {
        return {
          node: mergeNodeIdentity(existing, payload, ids, event.kind),
          created: false,
        };
      }
    }
  }
  const created = createNode(
    ctx,
    event,
    payload,
    ids,
    child ? root : undefined,
    !child,
  );
  if (replaces) created.replaces_conversation_id = replaces;
  return { node: created, created: true };
}

function createNode(
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  payload: PayloadRecord,
  ids: NativeIds,
  root: ConversationNode | undefined,
  asRoot: boolean,
): ConversationNode {
  const timestamp = event.occurred_at ?? now();
  const kind = resolveKind(ctx, payload, asRoot);
  const nodeId = id("cnv");
  return ConversationNodeSchema.parse({
    id: nodeId,
    project_id: ctx.project_id,
    workflow_id: ctx.workflow_id,
    root_id: asRoot || !root ? nodeId : root.id,
    kind,
    adapter_id: ctx.adapter_id,
    native_session_id: ids.session,
    native_agent_id: ids.agent,
    native_parent_session_id: ids.parent,
    spawn_call_id: ids.spawn,
    title: clip(readString(payload, "title") ?? defaultTitle(kind, ids), TITLE_MAX),
    task_summary: clipOptional(readString(payload, "task_summary"), SUMMARY_MAX),
    purpose: ctx.purpose,
    lineage_id: ctx.lineage_id,
    created_at: timestamp,
    updated_at: timestamp,
  });
}

function clipOptional(
  value: string | undefined,
  max: number,
): string | undefined {
  return value ? clip(value, max) : undefined;
}

function defaultTitle(kind: ConversationKind, ids: NativeIds): string {
  if (kind === "subagent")
    return clip(ids.session ?? ids.agent ?? ids.spawn ?? "子会话", TITLE_MAX);
  if (kind === "aside") return "临时提问";
  return "主会话";
}

function resolveKind(
  ctx: ConversationApplyContext,
  payload: PayloadRecord,
  asRoot: boolean,
): ConversationKind {
  const declared = payload.kind;
  if (declared === "main" || declared === "subagent" || declared === "aside")
    return declared;
  if (!asRoot) return "subagent";
  return ctx.purpose === "aside" ? "aside" : "main";
}

function mergeNodeIdentity(
  node: ConversationNode,
  payload: PayloadRecord,
  ids: NativeIds,
  kind: NativeConversationEvent["kind"],
): ConversationNode {
  const allowIdentity = kind === "discovered" || kind === "state";
  const title = allowIdentity ? readString(payload, "title") : undefined;
  const summary = allowIdentity
    ? readString(payload, "task_summary")
    : undefined;
  return {
    ...node,
    native_session_id: node.native_session_id ?? ids.session,
    native_agent_id: node.native_agent_id ?? ids.agent,
    native_parent_session_id: node.native_parent_session_id ?? ids.parent,
    spawn_call_id: node.spawn_call_id ?? ids.spawn,
    title: title ? clip(title, TITLE_MAX) : node.title,
    task_summary: summary ? clip(summary, SUMMARY_MAX) : node.task_summary,
    updated_at: now(),
  };
}

function bindParent(
  store: Store,
  node: ConversationNode,
  parentNativeId: string | undefined,
  diagnostics: ConversationDiagnostic[],
): ConversationParentIssue | undefined {
  if (!parentNativeId) return undefined;
  if (parentNativeId === node.native_session_id || parentNativeId === node.native_agent_id) {
    diagnostics.push({
      code: "self_reference",
      message: "拒绝自引用父节点",
      conversation_id: node.id,
    });
    return "self_reference";
  }
  const parent = findParentNode(store, node, parentNativeId);
  if (!parent) return undefined;
  return assignParent(store, node, parent, diagnostics);
}

function findParentNode(
  store: Store,
  node: ConversationNode,
  parentNativeId: string,
): ConversationNode | undefined {
  return store
    .list<ConversationNode>(CONVERSATION_ENTITY.node, node.workflow_id)
    .find(
      (candidate) =>
        candidate.id !== node.id &&
        candidate.adapter_id === node.adapter_id &&
        (candidate.native_session_id === parentNativeId ||
          candidate.native_agent_id === parentNativeId),
    );
}

function assignParent(
  store: Store,
  node: ConversationNode,
  parent: ConversationNode,
  diagnostics: ConversationDiagnostic[],
): ConversationParentIssue | undefined {
  const trial = { ...node, parent_id: parent.id };
  const known = store
    .conversationNodesByRoot<ConversationNode>(parent.root_id)
    .filter((item) => item.id !== node.id);
  known.push(trial);
  const issue = conversationParentIssue(trial, known);
  if (!issue) {
    node.parent_id = parent.id;
    node.root_id = parent.root_id;
    return undefined;
  }
  if (issue === "missing_parent") return undefined;
  diagnostics.push({
    code: issue,
    message: parentIssueMessage(issue),
    conversation_id: node.id,
  });
  return issue;
}

function parentIssueMessage(issue: ConversationParentIssue): string {
  if (issue === "self_reference") return "拒绝自引用父节点";
  if (issue === "cross_root") return "拒绝跨根父节点";
  if (issue === "cycle") return "拒绝环形父链";
  return "父节点尚未到达";
}

function completePendingParents(
  store: Store,
  ctx: ConversationApplyContext,
  parent: ConversationNode,
  diagnostics: ConversationDiagnostic[],
) {
  const nativeIdsForParent = [
    parent.native_session_id,
    parent.native_agent_id,
  ].filter(Boolean) as string[];
  if (!nativeIdsForParent.length) return;
  const pending = store
    .list<ConversationNode>(CONVERSATION_ENTITY.node, parent.workflow_id)
    .filter(
      (node) =>
        node.id !== parent.id &&
        !node.parent_id &&
        node.root_id === parent.root_id &&
        node.native_parent_session_id &&
        nativeIdsForParent.includes(node.native_parent_session_id),
    );
  for (const child of pending) {
    const issue = assignParent(store, child, parent, diagnostics);
    if (issue) continue;
    child.updated_at = now();
    store.put(CONVERSATION_ENTITY.node, child.id, child.workflow_id, child);
    const attempt = child.current_attempt_id
      ? store.get<ConversationAttempt>(
          CONVERSATION_ENTITY.attempt,
          child.current_attempt_id,
        )
      : undefined;
    store.event(
      ctx.workflow_id,
      ctx.project_id,
      CONVERSATION_EVENT.updated,
      { node: child, attempt },
      ctx.run_id,
    );
  }
}

function ensureAttempt(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  payload: PayloadRecord,
  node: ConversationNode,
): ConversationAttempt {
  const current = node.current_attempt_id
    ? store.get<ConversationAttempt>(
        CONVERSATION_ENTITY.attempt,
        node.current_attempt_id,
      )
    : undefined;
  const incoming = readStatus(payload);
  if (current && !shouldOpenAttempt(current, ctx, event, incoming))
    return current;
  const timestamp = event.occurred_at ?? now();
  const generation = current ? current.generation + 1 : 0;
  const attempt = ConversationAttemptSchema.parse({
    id: id("cva"),
    conversation_id: node.id,
    root_id: node.root_id,
    workflow_id: ctx.workflow_id,
    run_id: ctx.run_id,
    generation,
    status: incoming ?? (event.kind === "discovered" ? "discovered" : "starting"),
    observed_at: timestamp,
    freshness: "fresh",
  });
  node.current_attempt_id = attempt.id;
  node.updated_at = timestamp;
  return attempt;
}

function shouldOpenAttempt(
  current: ConversationAttempt,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  incoming: ConversationStatus | undefined,
): boolean {
  if (current.run_id === ctx.run_id) return false;
  if (event.kind === "discovered" || incoming === "starting") return true;
  return !isTerminalConversationStatus(current.status);
}

function readStatus(payload: PayloadRecord): ConversationStatus | undefined {
  const parsed = ConversationStatusSchema.safeParse(payload.status);
  return parsed.success ? parsed.data : undefined;
}

function applyKind(
  event: NativeConversationEvent,
  payload: PayloadRecord,
  ids: NativeIds,
  node: ConversationNode,
  attempt: ConversationAttempt,
  diagnostics: ConversationDiagnostic[],
): { node: ConversationNode; attempt: ConversationAttempt } {
  const timestamp = event.occurred_at ?? now();
  const nextAttempt = { ...attempt, observed_at: timestamp };
  if (event.kind === "discovered") applyDiscoveredSummary(nextAttempt, payload);
  if (event.kind === "model") applyModel(nextAttempt, payload);
  if (event.kind === "state") applyState(nextAttempt, payload);
  if (event.kind === "activity") applyActivityState(nextAttempt, payload);
  if (ids.parent && !node.parent_id && !diagnostics.some((item) => item.conversation_id === node.id)) {
    diagnostics.push({
      code: "pending_parent",
      message: "父节点尚未到达，关系待补全",
      conversation_id: node.id,
      source_id: event.source_id,
    });
  }
  nextAttempt.source_cursor = event.source_seq;
  node.updated_at = timestamp;
  return { node, attempt: nextAttempt };
}

function applyDiscoveredSummary(
  attempt: ConversationAttempt,
  payload: PayloadRecord,
) {
  const summary =
    readString(payload, "task_summary") ?? readString(payload, "title");
  if (summary && !attempt.activity_summary)
    attempt.activity_summary = clip(summary, SUMMARY_MAX);
}

function applyModel(
  attempt: ConversationAttempt,
  payload: PayloadRecord,
) {
  attempt.requested_model =
    readString(payload, "requested_model") ?? attempt.requested_model;
  attempt.actual_model =
    readString(payload, "actual_model") ?? attempt.actual_model;
  attempt.requested_effort =
    readString(payload, "requested_effort") ?? attempt.requested_effort;
  attempt.actual_effort =
    readString(payload, "actual_effort") ?? attempt.actual_effort;
  const source = payload.model_source;
  if (source === "native_event" || source === "native_session")
    attempt.model_source = source;
}

function applyState(
  attempt: ConversationAttempt,
  payload: PayloadRecord,
) {
  const incoming = readStatus(payload);
  if (!incoming) return;
  attempt.status = nextStatus(attempt.status, incoming);
  if (isTerminalConversationStatus(attempt.status) && !attempt.terminal_at)
    attempt.terminal_at = now();
  const reason = ConversationAttemptReasonSchema.safeParse(
    readString(payload, "reason"),
  );
  if (reason.success) attempt.reason = reason.data;
}

function applyActivityState(
  attempt: ConversationAttempt,
  payload: PayloadRecord,
) {
  const incoming = readStatus(payload);
  if (incoming) applyState(attempt, payload);
  else if (!isTerminalConversationStatus(attempt.status)) {
    if (attempt.status === "discovered" || attempt.status === "starting")
      attempt.status = "running";
  }
  const summary = readString(payload, "activity_summary");
  if (summary) attempt.activity_summary = clip(summary, SUMMARY_MAX);
  attempt.activity_at = now();
}

function nextStatus(
  current: ConversationStatus,
  incoming: ConversationStatus,
): ConversationStatus {
  if (current === incoming) return current;
  if (isTerminalConversationStatus(current)) return current;
  return incoming;
}

function persistSnapshot(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  node: ConversationNode,
  attempt: ConversationAttempt,
  ids: NativeIds,
) {
  store.put(CONVERSATION_ENTITY.node, node.id, node.workflow_id, node);
  store.put(CONVERSATION_ENTITY.attempt, attempt.id, attempt.workflow_id, attempt);
  persistBinding(store, ctx, node, ids);
  persistEventCursor(store, ctx, event, node.id);
}

function interruptOwnedDescendants(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  payload: PayloadRecord,
  node: ConversationNode,
  attempt: ConversationAttempt,
) {
  if (!shouldInterruptOwnedDescendants(event, payload, node, attempt)) return;
  const reason =
    attempt.reason === "quota" ? "quota" : "parent_exit";
  const nodes = store.list<ConversationNode>(
    CONVERSATION_ENTITY.node,
    ctx.workflow_id,
  );
  const timestamp = now();
  for (const child of nodes) {
    if (child.id === node.id || child.root_id !== node.root_id) continue;
    const current = child.current_attempt_id
      ? store.get<ConversationAttempt>(
          CONVERSATION_ENTITY.attempt,
          child.current_attempt_id,
        )
      : undefined;
    if (!current || current.run_id !== ctx.run_id) continue;
    if (!canInterruptOwned(current.status)) continue;
    current.status = "interrupted";
    current.reason = reason;
    current.terminal_at = current.terminal_at ?? timestamp;
    current.observed_at = timestamp;
    store.put(
      CONVERSATION_ENTITY.attempt,
      current.id,
      current.workflow_id,
      current,
    );
  }
}

function shouldInterruptOwnedDescendants(
  event: NativeConversationEvent,
  payload: PayloadRecord,
  node: ConversationNode,
  attempt: ConversationAttempt,
) {
  if (event.kind !== "state") return false;
  if (node.id !== node.root_id) return false;
  if (attempt.status !== "failed" && attempt.status !== "interrupted")
    return false;
  return (
    payload.root_process_exit === true ||
    attempt.reason === "quota" ||
    attempt.reason === "process_exit" ||
    attempt.reason === "native_error"
  );
}

function canInterruptOwned(status: ConversationStatus) {
  return (
    status === "discovered" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting" ||
    status === "pausing" ||
    status === "unknown"
  );
}

function persistBinding(
  store: Store,
  ctx: ConversationApplyContext,
  node: ConversationNode,
  ids: NativeIds,
) {
  const keys = [
    [ids.session, ids.agent],
    [ids.session, undefined],
    [undefined, ids.agent],
  ] as const;
  const timestamp = now();
  for (const [session, agent] of keys) {
    if (!session && !agent) continue;
    const binding = ConversationBindingSchema.parse({
      id: bindingKey(ctx, session, agent),
      workflow_id: ctx.workflow_id,
      adapter_id: ctx.adapter_id,
      scope: ctx.scope,
      lineage_id: ctx.lineage_id,
      native_session_id: session,
      native_agent_id: agent,
      conversation_id: node.id,
      created_at: timestamp,
    });
    store.put(CONVERSATION_ENTITY.binding, binding.id, binding.workflow_id, binding);
  }
}

function persistEventCursor(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  conversationId?: string,
) {
  const cursor = ConversationCursorSchema.parse({
    id: conversationCursorHash({
      adapterId: ctx.adapter_id,
      sourceId: event.source_id,
      conversationId,
    }),
    workflow_id: ctx.workflow_id,
    adapter_id: ctx.adapter_id,
    source_id: event.source_id,
    conversation_id: conversationId,
    source_seq: event.source_seq,
    applied_at: now(),
  });
  store.put(CONVERSATION_ENTITY.cursor, cursor.id, cursor.workflow_id, cursor);
}

function emitConversationEvents(
  store: Store,
  ctx: ConversationApplyContext,
  event: NativeConversationEvent,
  payload: PayloadRecord,
  applied: { node: ConversationNode; attempt: ConversationAttempt },
  created: boolean,
) {
  const type = created
    ? CONVERSATION_EVENT.discovered
    : CONVERSATION_EVENT.updated;
  if (created || event.kind === "state" || event.kind === "model") {
    store.event(
      ctx.workflow_id,
      ctx.project_id,
      type,
      { node: applied.node, attempt: applied.attempt },
      ctx.run_id,
    );
  } else if (!created) {
    store.event(
      ctx.workflow_id,
      ctx.project_id,
      CONVERSATION_EVENT.updated,
      { node: applied.node, attempt: applied.attempt },
      ctx.run_id,
    );
  }
  if (event.kind !== "activity") return;
  const activity = toActivityPayload(event, payload, applied.node, applied.attempt);
  if (!activity) return;
  store.event(
    ctx.workflow_id,
    ctx.project_id,
    CONVERSATION_EVENT.activity,
    activity,
    ctx.run_id,
  );
}

function toActivityPayload(
  event: NativeConversationEvent,
  payload: PayloadRecord,
  node: ConversationNode,
  attempt: ConversationAttempt,
): ConversationActivityPayload | undefined {
  const activityId =
    readString(payload, "activity_id") ?? `${event.source_id}:${event.source_seq}`;
  const sourceEventId =
    readString(payload, "source_event_id") ??
    `${event.source_id}:${event.source_seq}`;
  const kind = payload.kind;
  const parsed = ConversationActivityPayloadSchema.safeParse({
    conversation_id: node.id,
    attempt_id: attempt.id,
    root_id: node.root_id,
    activity_id: activityId,
    source_event_id: sourceEventId,
    public_text: clipOptional(readString(payload, "public_text"), PUBLIC_TEXT_MAX),
    title: clipOptional(readString(payload, "title"), TITLE_MAX),
    status: readStatus(payload),
    kind:
      kind === "tool" ||
      kind === "message" ||
      kind === "event" ||
      kind === "separator"
        ? kind
        : undefined,
    command: clipOptional(readString(payload, "command"), COMMAND_MAX),
    replaces_conversation_id: readString(payload, "replaces_conversation_id"),
  });
  return parsed.success ? parsed.data : undefined;
}

function collectAncestors(
  store: Store,
  node: ConversationNode,
): ConversationNode[] {
  const ancestors: ConversationNode[] = [];
  const seen = new Set<string>([node.id]);
  let cursor = node.parent_id;
  while (cursor) {
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const parent = store.get<ConversationNode>(CONVERSATION_ENTITY.node, cursor);
    if (!parent) break;
    ancestors.push(parent);
    cursor = parent.parent_id;
  }
  return ancestors;
}

function resolveActiveRootId(
  nodes: ConversationNode[],
  attempts: ConversationAttempt[],
  rootId?: string,
): string | undefined {
  if (rootId) return rootId;
  const roots = nodes.filter((node) => node.id === node.root_id);
  const latest = new Map<string, ConversationAttempt>();
  for (const attempt of attempts) latest.set(attempt.conversation_id, attempt);
  const working = roots.find((root) => {
    const attempt = latest.get(root.id);
    return attempt && !isTerminalConversationStatus(attempt.status);
  });
  if (working) return working.id;
  return roots.sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0]?.id;
}

function projectLegacyRoot(
  workflow: Workflow,
  run: Run,
  cursor: number,
): ConversationTreeSnapshot {
  const timestamp = run.started_at;
  const nodeId = `leg-${run.id}`.slice(0, 96);
  const purpose = run.purpose ?? run.stage ?? "implement";
  const node = ConversationNodeSchema.parse({
    id: nodeId,
    project_id: workflow.project_id,
    workflow_id: workflow.id,
    root_id: nodeId,
    kind: purpose === "aside" ? "aside" : "main",
    adapter_id: run.adapter,
    native_session_id: run.conversation_id,
    title: clip(workflow.title || "主会话", TITLE_MAX),
    purpose,
    lineage_id: `legacy:${run.id}`,
    created_at: timestamp,
    updated_at: run.ended_at ?? timestamp,
  });
  const attempt = ConversationAttemptSchema.parse({
    id: `cva-${run.id}`.slice(0, 96),
    conversation_id: node.id,
    root_id: node.id,
    workflow_id: workflow.id,
    run_id: run.id,
    generation: 0,
    status: legacyStatus(run.status),
    observed_at: run.ended_at ?? timestamp,
    freshness: "unavailable",
  });
  return ConversationTreeSnapshotSchema.parse({
    nodes: [node],
    attempts: [attempt],
    active_root_id: node.id,
    capabilities: unknownSubagentCapabilities(LEGACY_REASON),
    cursor,
  });
}

function legacyStatus(status: string): ConversationStatus {
  if (status === "running" || status === "starting") return "running";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "interrupted") return "interrupted";
  if (status === "paused") return "paused";
  if (status === "cancelled") return "cancelled";
  return "unknown";
}

export function hasWorkingConversationDescendants(
  snapshot: ConversationTreeSnapshot,
): boolean {
  const latest = new Map<string, ConversationAttempt>();
  for (const attempt of snapshot.attempts)
    latest.set(attempt.conversation_id, attempt);
  const rootId = snapshot.active_root_id;
  for (const node of snapshot.nodes) {
    if (rootId && node.root_id !== rootId) continue;
    const attempt = latest.get(node.id);
    if (!attempt) continue;
    if (
      isWorkingConversationStatus(attempt.status) ||
      attempt.status === "waiting" ||
      attempt.status === "pausing"
    )
      return true;
  }
  return false;
}
