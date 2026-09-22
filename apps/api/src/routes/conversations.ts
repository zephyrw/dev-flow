import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  FlowError,
  Id,
  requireCondition,
  type ConversationAttempt,
  type ConversationNode,
  ConversationActivityPayloadSchema,
  type ConversationTreeSnapshot,
  type DomainEvent,
  type Run,
  type SubagentCapabilities,
} from "../../../../packages/contracts/src/index.js";
import { resolveConversationRuntimeDisplay } from "../../../../packages/core/src/conversation-input.js";
import type { ConversationService } from "../../../../packages/core/src/conversation-service.js";
import { conversationActivityLogEntry } from "../../../../packages/presentation/src/conversation-activity.js";
import type { Store } from "../../../../packages/store/src/store.js";

export interface ConversationPluginOptions {
  conversations: ConversationService;
  store: Store;
  human: (request: FastifyRequest) => void;
}

const Params = z
  .object({
    id: Id,
    nodeId: Id.optional(),
  })
  .strict();

const ACTIVITY_LIMIT_DEFAULT = 100;
const ACTIVITY_LIMIT_MAX = 200;

export const conversationPlugin: FastifyPluginAsync<
  ConversationPluginOptions
> = async (app, opts) => {
  const { conversations, store, human } = opts;
  app.setErrorHandler((error, req, reply) => {
    sendRouteError(error, req, reply);
  });

  app.get("/api/workflows/:id/conversations", async (req) => {
    human(req);
    const workflowId = parseWorkflowId(req);
    requireWorkflow(store, workflowId);
    const rootId = parseOptionalRootId(req);
    return buildTreeResponse(conversations, store, workflowId, rootId);
  });

  app.get("/api/workflows/:id/conversations/:nodeId", async (req) => {
    human(req);
    const { workflowId, nodeId } = parseNodeParams(req);
    requireWorkflow(store, workflowId);
    return buildNodeResponse(conversations, store, workflowId, nodeId);
  });

  app.get(
    "/api/workflows/:id/conversations/:nodeId/activities",
    async (req) => {
      human(req);
      const { workflowId, nodeId } = parseNodeParams(req);
      requireWorkflow(store, workflowId);
      const query = parseActivityQuery(req);
      return buildActivityResponse(
        conversations,
        store,
        workflowId,
        nodeId,
        query,
      );
    },
  );
};

export default conversationPlugin;

function parseWorkflowId(req: FastifyRequest): string {
  return Params.parse(req.params).id;
}

function parseNodeParams(req: FastifyRequest): {
  workflowId: string;
  nodeId: string;
} {
  const params = Params.parse(req.params);
  requireCondition(params.nodeId, "NOT_FOUND", "缺少会话 ID", 404);
  return { workflowId: params.id, nodeId: params.nodeId };
}

function parseOptionalRootId(req: FastifyRequest): string | undefined {
  const query = (req.query || {}) as Record<string, unknown>;
  const raw = query.root_id;
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string") {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "根会话范围无效", 400);
  }
  const parsed = Id.safeParse(raw);
  if (!parsed.success) {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "根会话范围无效", 400);
  }
  return parsed.data;
}

function parseActivityQuery(req: FastifyRequest): {
  before_seq?: number;
  limit: number;
} {
  const query = (req.query || {}) as Record<string, unknown>;
  return {
    before_seq: parseSeqCursor(query.before_seq),
    limit: parseActivityLimit(query.limit),
  };
}

function parseSeqCursor(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "分页游标无效", 400);
  }
  return parsed;
}

function parseActivityLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") {
    return ACTIVITY_LIMIT_DEFAULT;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new FlowError(CONVERSATION_ERROR.INVALID_CURSOR, "分页游标无效", 400);
  }
  return Math.min(ACTIVITY_LIMIT_MAX, parsed);
}

function requireWorkflow(store: Store, workflowId: string) {
  store.must("workflow", workflowId);
}

function requireRootInWorkflow(
  store: Store,
  workflowId: string,
  rootId: string,
  snapshot: ConversationTreeSnapshot,
) {
  const stored = store.get<ConversationNode>(CONVERSATION_ENTITY.node, rootId);
  if (stored && stored.workflow_id !== workflowId) {
    throw new FlowError(
      CONVERSATION_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
      "会话不属于该任务",
      409,
    );
  }
  const root = snapshot.nodes.find(
    (node) => node.id === rootId && node.root_id === node.id,
  );
  if (!root) {
    throw new FlowError(CONVERSATION_ERROR.NOT_FOUND, "根会话不存在", 404);
  }
}

function buildTreeResponse(
  conversations: ConversationService,
  store: Store,
  workflowId: string,
  rootId?: string,
) {
  const snapshot = conversations.getTree(workflowId);
  if (rootId) requireRootInWorkflow(store, workflowId, rootId, snapshot);
  const current = scopedTree(snapshot, rootId ?? snapshot.active_root_id);
  return {
    roots: publicRoots(snapshot),
    nodes: current.nodes.map(publicNode),
    attempts: current.attempts.map(publicAttempt),
    active_root_id: snapshot.active_root_id,
    capabilities: publicCapabilities(snapshot.capabilities),
    cursor: snapshot.cursor,
  };
}

function scopedTree(
  snapshot: ConversationTreeSnapshot,
  rootId?: string,
): ConversationTreeSnapshot {
  if (!rootId) return snapshot;
  return {
    ...snapshot,
    nodes: snapshot.nodes.filter((node) => node.root_id === rootId),
    attempts: snapshot.attempts.filter((attempt) => attempt.root_id === rootId),
  };
}

function buildNodeResponse(
  conversations: ConversationService,
  store: Store,
  workflowId: string,
  nodeId: string,
) {
  const read = readOwnedNode(conversations, workflowId, nodeId);
  const attempts = listNodeAttempts(store, read.node, conversations, workflowId);
  const current =
    attempts.find((item) => item.id === read.node.current_attempt_id) ??
    read.attempt ??
    attempts[attempts.length - 1];
  return {
    node: publicNode(read.node),
    ancestors: read.ancestors.map(publicNode),
    attempts: attempts.map(publicAttempt),
    run: publicRun(store, current?.run_id),
    runtime: current ? resolveConversationRuntimeDisplay(current) : undefined,
  };
}

function buildActivityResponse(
  conversations: ConversationService,
  store: Store,
  workflowId: string,
  nodeId: string,
  query: { before_seq?: number; limit: number },
) {
  const read = readOwnedNode(conversations, workflowId, nodeId);
  if (!store.get<ConversationNode>(CONVERSATION_ENTITY.node, read.node.id)) {
    return { items: [], has_more: false };
  }
  const page = conversations.listActivities(workflowId, nodeId, query);
  return {
    items: page.items
      .map((event) => publicActivity(store, event))
      .filter((item) => item !== undefined),
    next_before_seq: page.next_before_seq,
    has_more: page.has_more,
  };
}

function readOwnedNode(
  conversations: ConversationService,
  workflowId: string,
  nodeId: string,
) {
  try {
    return conversations.readNode(workflowId, nodeId);
  } catch (error) {
    if (
      !(error instanceof FlowError) ||
      error.code !== CONVERSATION_ERROR.NOT_FOUND
    ) {
      throw error;
    }
    return readLegacyNode(conversations, workflowId, nodeId, error);
  }
}

function readLegacyNode(
  conversations: ConversationService,
  workflowId: string,
  nodeId: string,
  notFound: FlowError,
) {
  const tree = conversations.getTree(workflowId);
  const node = tree.nodes.find((item) => item.id === nodeId);
  if (!node || node.workflow_id !== workflowId) throw notFound;
  const attempt = tree.attempts.find((item) => item.conversation_id === nodeId);
  return { node, attempt, ancestors: [] as ConversationNode[] };
}

function listNodeAttempts(
  store: Store,
  node: ConversationNode,
  conversations: ConversationService,
  workflowId: string,
): ConversationAttempt[] {
  const stored = store
    .list<ConversationAttempt>(CONVERSATION_ENTITY.attempt, workflowId)
    .filter((attempt) => attempt.conversation_id === node.id)
    .sort((a, b) => a.generation - b.generation);
  if (stored.length) return stored;
  const tree = conversations.getTree(workflowId);
  return tree.attempts
    .filter((attempt) => attempt.conversation_id === node.id)
    .sort((a, b) => a.generation - b.generation);
}

function publicRoots(snapshot: ConversationTreeSnapshot) {
  const latest = new Map<string, ConversationAttempt>();
  for (const attempt of snapshot.attempts)
    latest.set(attempt.conversation_id, attempt);
  return snapshot.nodes
    .filter((node) => node.id === node.root_id)
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .map((node) => {
      const attempt = latest.get(node.id);
      return {
        id: node.id,
        title: node.title,
        kind: node.kind,
        purpose: node.purpose,
        created_at: node.created_at,
        updated_at: node.updated_at,
        replaces_conversation_id: node.replaces_conversation_id,
        status: attempt?.status,
        freshness: attempt?.freshness,
        generation: attempt?.generation,
      };
    });
}

function publicNode(node: ConversationNode) {
  return {
    id: node.id,
    project_id: node.project_id,
    workflow_id: node.workflow_id,
    root_id: node.root_id,
    parent_id: node.parent_id,
    kind: node.kind,
    adapter_id: node.adapter_id,
    native_session_id: node.native_session_id,
    native_agent_id: node.native_agent_id,
    native_parent_session_id: node.native_parent_session_id,
    spawn_call_id: node.spawn_call_id,
    title: node.title,
    task_summary: node.task_summary,
    purpose: node.purpose,
    lineage_id: node.lineage_id,
    current_attempt_id: node.current_attempt_id,
    replaces_conversation_id: node.replaces_conversation_id,
    created_at: node.created_at,
    updated_at: node.updated_at,
  };
}

function publicAttempt(attempt: ConversationAttempt) {
  return {
    id: attempt.id,
    conversation_id: attempt.conversation_id,
    root_id: attempt.root_id,
    workflow_id: attempt.workflow_id,
    run_id: attempt.run_id,
    generation: attempt.generation,
    status: attempt.status,
    reason: attempt.reason,
    requested_model: attempt.requested_model,
    actual_model: attempt.actual_model,
    requested_effort: attempt.requested_effort,
    actual_effort: attempt.actual_effort,
    model_source: attempt.model_source,
    activity_summary: attempt.activity_summary,
    observed_at: attempt.observed_at,
    activity_at: attempt.activity_at,
    terminal_at: attempt.terminal_at,
    freshness: attempt.freshness,
    stop_confirmation: attempt.stop_confirmation,
    recovery_id: attempt.recovery_id,
  };
}

function publicCapabilities(capabilities: SubagentCapabilities) {
  return {
    discovery: capabilities.discovery,
    activity: capabilities.activity,
    stop: capabilities.stop,
    resume: capabilities.resume,
    readonly_delegation: capabilities.readonly_delegation,
    file_input: capabilities.file_input,
    cli_version: capabilities.cli_version,
    reason: capabilities.reason,
  };
}

function publicRun(store: Store, runId?: string) {
  if (!runId) return undefined;
  const run = store.get<Run>("run", runId);
  if (!run) return undefined;
  return {
    id: run.id,
    workflow_id: run.workflow_id,
    adapter: run.adapter,
    purpose: run.purpose,
    stage: run.stage,
    status: run.status,
    started_at: run.started_at,
    ended_at: run.ended_at,
    exit_code: run.exit_code,
  };
}

function publicActivity(store: Store, event: DomainEvent) {
  const redacted = store.publicEvent(event);
  const parsed = ConversationActivityPayloadSchema.safeParse(redacted.payload);
  if (!parsed.success) return undefined;
  const entry = conversationActivityLogEntry({
    event_seq: redacted.event_seq,
    created_at: redacted.created_at,
    payload: parsed.data,
  });
  if (!entry) return undefined;
  return {
    key: entry.key,
    sequence: entry.sequence,
    created_at: entry.created_at,
    title: entry.title,
    text: entry.text,
    kind: entry.kind,
    status: entry.status,
    command: entry.command,
    conversation_id: parsed.data.conversation_id,
    attempt_id: parsed.data.attempt_id,
    activity_id: parsed.data.activity_id,
  };
}

function sendRouteError(
  error: unknown,
  req: FastifyRequest,
  reply: FastifyReply,
) {
  const known = error instanceof FlowError;
  const fastifyStatus = (error as { statusCode?: number }).statusCode;
  const status = known
    ? error.status
    : error instanceof z.ZodError
      ? 422
      : typeof fastifyStatus === "number" && fastifyStatus >= 400
        ? fastifyStatus
        : 500;
  const requestId =
    (req.body as { request_id?: string } | undefined)?.request_id ||
    (req.headers["x-request-id"] as string) ||
    null;
  reply.code(status).send({
    error: {
      code: known
        ? error.code
        : status === 422
          ? "VALIDATION_ERROR"
          : "INTERNAL_ERROR",
      message:
        known || error instanceof z.ZodError
          ? (error as Error).message
          : "操作失败，请检查本机服务日志",
      details: known
        ? error.details
        : error instanceof z.ZodError
          ? error.issues
          : undefined,
    },
    request_id: requestId,
  });
}
