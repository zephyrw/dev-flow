import type { Store } from "../../store/src/store.js";
import {
  CONVERSATION_ENTITY,
  CONVERSATION_ERROR,
  ConversationMessageRequestSchema,
  ConversationMessageSchema,
  FlowError,
  Id,
  ToolProfileSchema,
  isWorkingConversationStatus,
  requireCondition,
  type FunctionalIssue,
  type ConversationAttempt,
  type ConversationFile,
  type ConversationInputMode,
  type ConversationMessage,
  type ConversationMessageRequest,
  type Run,
  type State,
  type ToolProfile,
  type Workflow,
  type WorkspaceReference,
} from "../../contracts/src/index.js";
import type { ConversationControlRequest } from "./conversation-control.js";
import { ConversationFileService } from "./conversation-files.js";
import { parseConversationInput } from "./conversation-input.js";
import {
  deliveredConversationText,
  prepareConversationInputMaterials,
} from "./conversation-input-materials.js";
import { FeedbackService } from "./feedback-service.js";
import { FunctionalIssueService } from "./functional-issues.js";
import { id, now } from "./util.js";
import type { ConversationService } from "./conversation-service.js";
import type { AsideSessionService } from "../../asides/src/service.js";
import {
  CONVERSATION_INPUT_ERROR,
  type FileInputCapability,
} from "../../runtime/src/conversation-inputs.js";

export const CONVERSATION_MESSAGE_ERROR = {
  EMPTY_MESSAGE: CONVERSATION_ERROR.EMPTY_MESSAGE,
  EMPTY_QUESTION: CONVERSATION_ERROR.EMPTY_QUESTION,
  INPUT_UNSUPPORTED: CONVERSATION_ERROR.INPUT_UNSUPPORTED,
  FILE_NOT_READY: CONVERSATION_ERROR.FILE_NOT_READY,
  FILE_SCOPE_MISMATCH: CONVERSATION_ERROR.FILE_SCOPE_MISMATCH,
  FILE_TOO_LARGE: CONVERSATION_ERROR.FILE_TOO_LARGE,
  TOO_MANY_FILES: "TOO_MANY_FILES",
  CLIENT_MODE_MISMATCH: "CLIENT_MODE_MISMATCH",
  SEND_DISABLED: "SEND_DISABLED",
  CONVERSATION_NOT_IN_WORKFLOW: CONVERSATION_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
  STALE_ROOT: CONVERSATION_ERROR.STALE_ROOT,
  VERSION_CONFLICT: CONVERSATION_ERROR.VERSION_CONFLICT,
  NOT_FOUND: CONVERSATION_ERROR.NOT_FOUND,
  PROFILE_NOT_FOUND: CONVERSATION_INPUT_ERROR.PROFILE_NOT_FOUND,
} as const;

export type ConversationMessageErrorCode =
  (typeof CONVERSATION_MESSAGE_ERROR)[keyof typeof CONVERSATION_MESSAGE_ERROR];

export type ConversationMessageResult = {
  message_id: string;
  mode: ConversationInputMode;
  target_workflow_id: string;
  accepted: boolean;
  aside_id?: string;
};

export interface ConversationControlPort {
  pauseTree(
    workflowId: string,
    request: ConversationControlRequest,
  ): Promise<unknown>;
}

export interface ConversationMessageDeps {
  store: Store;
  files: ConversationFileService;
  feedback: FeedbackService;
  asides: AsideSessionService;
  issues: FunctionalIssueService;
  conversations: ConversationService;
  storageRoot: string;
  control: ConversationControlPort;
}

export interface LegacyConversationInput {
  request_id: string;
  text: string;
  refs?: WorkspaceReference[];
  attachment_ids?: string[];
  root_conversation_id?: string;
  expected_generation?: number;
}

type MessageRoute =
  | "aside"
  | "planning"
  | "execution"
  | "functional"
  | "supplement"
  | "recover";

export interface FunctionalMessageOptions {
  idempotencyContext: unknown;
  onIssueCreated: (issue: FunctionalIssue) => void;
}

interface PreparedMessage {
  functionalOptions?: FunctionalMessageOptions;
  workflow: Workflow;
  request: ConversationMessageRequest;
  mode: ConversationInputMode;
  route: MessageRoute;
  deliveredText: string;
  files: ConversationFile[];
  shouldPause: boolean;
}

const PLANNING_STATES = new Set<State>([
  "PLANNING",
  "PLAN_PENDING",
  "REPAIR_PLAN_PENDING",
  "RESEARCHING",
  "REPAIR_RESEARCH_REQUIRED",
  "PLANNER_TAKEOVER",
]);

const RECOVER_STATES = new Set<State>([
  "STOPPED",
  "RECOVERY_REQUIRED",
  "BLOCKED",
  "WAITING_INPUT",
  "PAUSED",
]);

const DISABLED_STATES = new Set<State>([
  "COMPLETED",
  "COMMITTED",
  "CLEANUP_PENDING",
  "COMMIT_PARTIAL",
  "COMMITTING",
  "INTEGRATING",
  "STOPPING",
]);

export class ConversationMessageService {
  constructor(private deps: ConversationMessageDeps) {}

  async submit(
    workflowId: string,
    body: unknown,
  ): Promise<ConversationMessageResult> {
    const request = ConversationMessageRequestSchema.parse(body);
    return this.accept(workflowId, request, "auto");
  }

  async submitFormal(
    workflowId: string,
    input: LegacyConversationInput,
  ): Promise<ConversationMessageResult> {
    return this.accept(
      workflowId,
      this.completeLegacy(workflowId, input, "formal"),
      "formal",
    );
  }

  async submitAside(
    workflowId: string,
    input: LegacyConversationInput,
  ): Promise<ConversationMessageResult> {
    return this.accept(
      workflowId,
      this.completeLegacy(workflowId, input, "aside"),
      "aside",
    );
  }

  async submitFunctional(
    workflowId: string,
    input: LegacyConversationInput,
    options?: FunctionalMessageOptions,
  ): Promise<ConversationMessageResult> {
    return this.accept(
      workflowId,
      this.completeLegacy(workflowId, input, "formal"),
      "functional",
      options,
    );
  }

  private async accept(
    workflowId: string,
    request: ConversationMessageRequest,
    entry: "auto" | "formal" | "aside" | "functional",
    functionalOptions?: FunctionalMessageOptions,
  ): Promise<ConversationMessageResult> {
    const prepared = this.prepare(workflowId, request, entry);
    prepared.functionalOptions = functionalOptions;
    const saved = this.persist(prepared);
    await this.pauseIfNeeded(prepared);
    return toResult(saved);
  }

  private prepare(
    workflowId: string,
    request: ConversationMessageRequest,
    entry: "auto" | "formal" | "aside" | "functional",
  ): PreparedMessage {
    const workflow = this.deps.store.must<Workflow>(
      "workflow",
      Id.parse(workflowId),
    );
    const parsed = parseConversationInput(request.text);
    assertClientMode(request.client_mode, parsed.mode, entry);
    const mode = resolveMode(entry, parsed.mode);
    const route = classifyRoute(workflow.state, mode, entry);
    const bodyText = entry === "auto" ? parsed.text : request.text;
    const emptyQuestion =
      entry === "auto" ? parsed.empty_question : bodyText.trim().length === 0;
    assertSendable(mode, bodyText, emptyQuestion, request.attachment_ids);
    this.assertRoot(workflow.id, request);
    const files = this.loadReadyFiles(workflow.id, request.attachment_ids);
    this.assertAttachments(workflow, files, mode);
    const deliveredText = deliveredConversationText(bodyText, files.length);
    const live = this.rootIsWorking(workflow.id, request.root_conversation_id);
    return {
      workflow,
      request,
      mode,
      route,
      deliveredText,
      files,
      shouldPause: shouldPauseRoot(route, live),
    };
  }

  private persist(prepared: PreparedMessage): ConversationMessage {
    const key = idempotencyKey(
      prepared.workflow.id,
      prepared.request.request_id,
    );
    return this.deps.store.deduplicate(key, persistPayload(prepared), () =>
      this.writeAccepted(prepared),
    );
  }

  private writeAccepted(prepared: PreparedMessage): ConversationMessage {
    const messageId = id("cmsg");
    const draft = ConversationMessageSchema.parse({
      id: messageId,
      workflow_id: prepared.workflow.id,
      request_id: prepared.request.request_id,
      root_conversation_id: prepared.request.root_conversation_id,
      expected_generation: prepared.request.expected_generation,
      mode: prepared.mode,
      text: prepared.deliveredText,
      refs: prepared.request.refs,
      attachment_ids: prepared.request.attachment_ids,
      target_workflow_id: prepared.workflow.id,
      created_at: now(),
    });
    this.saveMessage(draft);
    for (const file of prepared.files) {
      this.deps.files.referenceMessage(
        prepared.workflow.id,
        file.id,
        messageId,
      );
    }
    return this.saveMessage(this.bindDomain(draft, prepared));
  }

  private bindDomain(
    message: ConversationMessage,
    prepared: PreparedMessage,
  ): ConversationMessage {
    if (prepared.route === "aside") {
      const aside = this.deps.asides.submitQuestion(
        prepared.workflow.id,
        prepared.deliveredText,
        prepared.request.refs,
        "1",
        undefined,
        prepared.request.attachment_ids,
      );
      return {
        ...message,
        aside_id: aside.id,
      };
    }
    if (prepared.route === "functional") {
      const issue = this.deps.issues.createIssue(
        prepared.workflow.id,
        prepared.deliveredText,
        prepared.request.refs,
        {},
        prepared.request.attachment_ids,
      );
      prepared.functionalOptions?.onIssueCreated(issue);
      const feedback = this.deps.feedback.submitFeedback({
        request_id: prepared.request.request_id,
        workflow_id: prepared.workflow.id,
        kind: "functional",
        text: prepared.deliveredText,
        refs: prepared.request.refs,
        attachment_ids: prepared.request.attachment_ids,
      });
      return {
        ...message,
        functional_issue_id: issue.issue_id,
        feedback_message_id: feedback.message_id,
      };
    }
    const feedback = this.deps.feedback.submitFeedback({
      request_id: prepared.request.request_id,
      workflow_id: prepared.workflow.id,
      kind: feedbackKind(prepared.route),
      text: prepared.deliveredText,
      refs: prepared.request.refs,
      attachment_ids: prepared.request.attachment_ids,
    });
    return {
      ...message,
      feedback_message_id: feedback.message_id,
    };
  }

  private async pauseIfNeeded(prepared: PreparedMessage): Promise<void> {
    if (!prepared.shouldPause) return;
    await this.deps.control.pauseTree(prepared.workflow.id, {
      request_id: pauseRequestId(prepared.request.request_id),
      action: "pause",
      root_id: prepared.request.root_conversation_id,
      expected_generation: prepared.request.expected_generation,
    });
  }

  private assertRoot(workflowId: string, request: ConversationMessageRequest) {
    const tree = this.deps.conversations.getTree(workflowId);
    const root = tree.nodes.find(
      (node) => node.id === request.root_conversation_id,
    );
    requireCondition(
      root && root.workflow_id === workflowId,
      CONVERSATION_MESSAGE_ERROR.CONVERSATION_NOT_IN_WORKFLOW,
      "会话不属于当前工作流",
      404,
    );
    requireCondition(
      root.id === root.root_id,
      CONVERSATION_MESSAGE_ERROR.STALE_ROOT,
      "会话根已切换",
      409,
    );
    const latest = latestRootAttempt(tree.attempts, root.id);
    requireCondition(
      latest && latest.generation === request.expected_generation,
      CONVERSATION_MESSAGE_ERROR.VERSION_CONFLICT,
      "会话代数已变化",
      409,
    );
  }

  private loadReadyFiles(
    workflowId: string,
    attachmentIds: string[],
  ): ConversationFile[] {
    return attachmentIds.map((fileId) =>
      this.deps.files.requireFileInWorkflow(workflowId, fileId),
    );
  }

  private assertAttachments(
    workflow: Workflow,
    files: ConversationFile[],
    mode: ConversationInputMode,
  ) {
    if (files.length === 0) return;
    const tree = this.deps.conversations.getTree(workflow.id);
    const materials = prepareConversationInputMaterials({
      text: "",
      mode,
      files,
      storageRoot: this.deps.storageRoot,
      workflowId: workflow.id,
      profile: frozenProfile(this.deps.store, workflow),
      fileInput: tree.capabilities.file_input as FileInputCapability,
    });
    if (materials.resolved.ok) return;
    throw new FlowError(
      materials.resolved.code,
      materials.resolved.message,
      statusForCode(materials.resolved.code),
    );
  }

  private rootIsWorking(workflowId: string, rootId: string): boolean {
    const tree = this.deps.conversations.getTree(workflowId, rootId);
    const latest = latestRootAttempt(tree.attempts, rootId);
    return !!latest && isWorkingConversationStatus(latest.status);
  }

  private completeLegacy(
    workflowId: string,
    input: LegacyConversationInput,
    clientMode: ConversationInputMode,
  ): ConversationMessageRequest {
    const tree = this.deps.conversations.getTree(Id.parse(workflowId));
    const rootId =
      input.root_conversation_id ?? tree.active_root_id ?? Id.parse(workflowId);
    const generation =
      input.expected_generation ??
      latestRootAttempt(tree.attempts, rootId)?.generation ??
      0;
    return ConversationMessageRequestSchema.parse({
      request_id: input.request_id,
      root_conversation_id: rootId,
      expected_generation: generation,
      text: input.text,
      refs: input.refs ?? [],
      attachment_ids: input.attachment_ids ?? [],
      client_mode: clientMode,
    });
  }

  private saveMessage(message: ConversationMessage): ConversationMessage {
    const publicMessage = ConversationMessageSchema.parse(message);
    this.deps.store.put(
      CONVERSATION_ENTITY.message,
      publicMessage.id,
      publicMessage.workflow_id,
      publicMessage,
    );
    return publicMessage;
  }
}

function classifyRoute(
  state: State,
  mode: ConversationInputMode,
  entry: "auto" | "formal" | "aside" | "functional",
): MessageRoute {
  if (entry === "aside" || mode === "aside") return "aside";
  if (entry === "functional" || state === "HUMAN_PENDING") {
    requireCondition(
      state === "HUMAN_PENDING",
      "INVALID_STATE",
      "功能核验阶段才能提交功能问题",
      409,
    );
    return "functional";
  }
  if (DISABLED_STATES.has(state)) {
    throw new FlowError(
      CONVERSATION_MESSAGE_ERROR.SEND_DISABLED,
      disabledReason(state),
      409,
    );
  }
  if (state === "WAITING_AUTHORIZATION") return "supplement";
  if (PLANNING_STATES.has(state)) return "planning";
  if (RECOVER_STATES.has(state)) return "recover";
  return "execution";
}

function shouldPauseRoot(route: MessageRoute, live: boolean): boolean {
  if (!live) return false;
  return route === "planning" || route === "execution";
}

function assertClientMode(
  clientMode: ConversationInputMode | undefined,
  parsedMode: ConversationInputMode,
  entry: "auto" | "formal" | "aside" | "functional",
) {
  if (entry !== "auto") return;
  if (!clientMode) return;
  requireCondition(
    clientMode === parsedMode,
    CONVERSATION_MESSAGE_ERROR.CLIENT_MODE_MISMATCH,
    "客户端模式与正文命令不一致",
    409,
  );
}

function resolveMode(
  entry: "auto" | "formal" | "aside" | "functional",
  parsedMode: ConversationInputMode,
): ConversationInputMode {
  if (entry === "aside") return "aside";
  if (entry === "formal" || entry === "functional") return "formal";
  return parsedMode;
}

function assertSendable(
  mode: ConversationInputMode,
  text: string,
  emptyQuestion: boolean,
  attachmentIds: string[],
) {
  if (mode === "aside") {
    requireCondition(
      !emptyQuestion && text.trim().length > 0,
      CONVERSATION_MESSAGE_ERROR.EMPTY_QUESTION,
      "请输入临时问题",
      400,
    );
    return;
  }
  requireCondition(
    text.trim().length > 0 || attachmentIds.length > 0,
    CONVERSATION_MESSAGE_ERROR.EMPTY_MESSAGE,
    "请输入内容或添加附件",
    400,
  );
}

function feedbackKind(
  route: Exclude<MessageRoute, "aside" | "functional">,
): "planning" | "execution" {
  return route === "planning" ? "planning" : "execution";
}

function disabledReason(state: State): string {
  if (state === "COMMITTING" || state === "INTEGRATING" || state === "STOPPING")
    return "任务正在提交，不能发送普通指导";
  if (state === "CLEANUP_PENDING" || state === "COMMIT_PARTIAL")
    return "任务正在收尾，不能发送普通指导";
  return "任务已结束，不能发送普通指导";
}

function frozenProfile(store: Store, workflow: Workflow): ToolProfile {
  const run = workflow.run_id
    ? store.get<Run>("run", workflow.run_id)
    : undefined;
  const parsed = ToolProfileSchema.safeParse(run?.profile);
  if (parsed.success) return parsed.data;
  const fallback = ToolProfileSchema.safeParse({
    id: "profile-default",
    revision: 1,
    adapterId: run?.adapter ?? "codex",
    modelSelection: "native-config",
    options: {},
  });
  requireCondition(
    fallback.success,
    CONVERSATION_MESSAGE_ERROR.PROFILE_NOT_FOUND,
    "缺少可用的冻结工具配置",
    409,
  );
  return fallback.data;
}

function latestRootAttempt(
  attempts: ConversationAttempt[],
  rootId: string,
): ConversationAttempt | undefined {
  return attempts
    .filter((item) => item.conversation_id === rootId)
    .sort((a, b) => a.generation - b.generation)
    .at(-1);
}

function persistPayload(prepared: PreparedMessage) {
  return {
    text: prepared.request.text,
    refs: prepared.request.refs,
    attachment_ids: prepared.request.attachment_ids,
    root_conversation_id: prepared.request.root_conversation_id,
    expected_generation: prepared.request.expected_generation,
    mode: prepared.mode,
    route: prepared.route,
    functional_context: prepared.functionalOptions?.idempotencyContext,
  };
}

function idempotencyKey(workflowId: string, requestId: string): string {
  return `conversation-message:${workflowId}:${requestId}`;
}

function pauseRequestId(requestId: string): string {
  return `msg-pause:${requestId}`;
}

function toResult(message: ConversationMessage): ConversationMessageResult {
  return {
    message_id: message.id,
    mode: message.mode,
    target_workflow_id: message.target_workflow_id,
    accepted: true,
    aside_id: message.aside_id,
  };
}

function statusForCode(code: string): number {
  if (code === CONVERSATION_ERROR.FILE_TOO_LARGE) return 413;
  if (code === CONVERSATION_ERROR.FILE_NOT_READY) return 409;
  if (code === CONVERSATION_ERROR.FILE_SCOPE_MISMATCH) return 409;
  if (code === "TOO_MANY_FILES") return 422;
  return 409;
}

export function publicConversationMessageResponse(
  result: ConversationMessageResult,
) {
  return result.aside_id
    ? {
        message_id: result.message_id,
        mode: result.mode,
        target_workflow_id: result.target_workflow_id,
        accepted: result.accepted,
        aside_id: result.aside_id,
      }
    : {
        message_id: result.message_id,
        mode: result.mode,
        target_workflow_id: result.target_workflow_id,
        accepted: result.accepted,
      };
}
