import type { ToolProfile } from "../../../contracts/src/execution-spec.js";
import type {
  SubagentCapabilities,
} from "../../../contracts/src/conversation.js";
import type { ResolvedInputAttachment } from "../../../contracts/src/conversation-input.js";

export interface ProbeRequest {
  toolProfile: ToolProfile;
  customPath?: string;
}

export interface CapabilityReport {
  adapterId: string;
  available: boolean;
  version?: string;
  executablePath?: string;
  capabilities: {
    nativeEditing: boolean;
    terminal: boolean;
    browser: boolean;
    exactResume: boolean;
    readOnlySession: boolean;
    structuredToolFacts: boolean;
    asyncProcessFacts: boolean;
    usageReporting: boolean;
  };
  unsupportedReason?: string;
}

export interface RunContext {
  workflowId: string;
  runId: string;
  stage: string;
  epoch: number;
  workspaceRoots: Record<string, string>; // repo_id -> absolute path
  allowedPaths: string[];
  toolProfile: ToolProfile;
  handoffDocPath?: string;
  prompt?: string;
  outputPath?: string;
  schemaPath?: string;
  conversationId?: string;
  timeoutMs?: number;
  feedbackCursor?: number;
  inputAttachments?: ResolvedInputAttachment[];
  recoveryManifestRef?: string;
  purpose:
    | "planning"
    | "implement"
    | "plan_self_check"
    | "quality_review"
    | "planner_takeover"
    | "functional_fix"
    | "aside"
    | "merge_conflict";
}

export interface PreparedInvocation {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  conversationId?: string;
}

export interface HostChunk {
  stream: "stdout" | "stderr";
  data: Buffer | string;
  timestamp: string;
  runId?: string;
  final?: boolean;
}

export interface NormalizedEvent {
  type:
    | "tool_call"
    | "tool_result"
    | "step_update"
    | "message"
    | "usage"
    | "error";
  raw: unknown;
  timestamp: string;
}

export interface FactCursor {
  workflowId: string;
  runId: string;
  afterTimestamp?: string;
}

export interface ExecutionFactPage {
  facts: Array<{
    tool_call_id: string;
    conversation_id?: string;
    command: string;
    cwd: string;
    exit_code?: number;
    started_at?: string;
    ended_at?: string;
    status?: string;
  }>;
  nextCursor?: string;
}

export interface ResumeContext extends RunContext {
  previousConversationId: string;
  diffSummary?: string;
  unresolvedFeedback?: string[];
}

export interface ProcessIdentity {
  jobId: string;
  pid?: number;
}

export interface StopResult {
  stopped: boolean;
  reason?: string;
}

export interface NativeConversationEvent {
  source_id: string;
  source_seq: string;
  root_native_id: string;
  session_native_id?: string;
  agent_native_id?: string;
  parent_native_id?: string;
  kind: "discovered" | "state" | "activity" | "model" | "quota";
  occurred_at?: string;
  payload: unknown;
}

export interface ConversationSourceCursor {
  source_id: string;
  source_seq?: string;
  file_identity?: string;
}

export interface ConversationStopTarget {
  conversation_id: string;
  native_session_id?: string;
  native_agent_id?: string;
  job_id?: string;
}

export interface ConversationStopResult {
  conversation_id: string;
  confirmation: "native" | "owned_process_tree" | "unconfirmed";
  status?: string;
  reason?: string;
}

export interface PreparedInputAttachments {
  attachments: ResolvedInputAttachment[];
  extraReadRoots: string[];
  unsupported?: string;
}

export interface SessionIdentityResolutionInput {
  frozenProfile: ToolProfile;
  resolvedExecutable?: string;
  effectiveEnvironment?: Record<string, string>;
  workspace: {
    root: string;
    source_root?: string;
    repo_id?: string;
    common_dir?: string;
    all_workspaces?: Array<{
      repo_id?: string;
      root: string;
      source_root?: string;
      common_dir?: string;
    }>;
  };
}

export interface ResolvedSessionIdentity {
  adapter_id: string;
  host_id: string;
  client_scope_id: string;
  provider_account_scope: string;
  canonical_model_id: string;
  workspace_identity: string;
  missing_fields?: string[];
  resolved: boolean;
  unresolved_reason?: string;
}

export interface NativeAgentAdapter {
  onExecutionFact?: (fact: ExecutionFactPage["facts"][number]) => void;
  subagents?: SubagentCapabilities;
  probe(input: ProbeRequest): Promise<CapabilityReport>;
  resolveSessionIdentity?(
    input: SessionIdentityResolutionInput,
  ): Promise<ResolvedSessionIdentity> | ResolvedSessionIdentity;
  prepare(input: RunContext): Promise<PreparedInvocation>;
  buildInvocation(input: RunContext, executable: string): PreparedInvocation;
  decode(chunk: HostChunk): NormalizedEvent[];
  decodeConversation?(chunk: HostChunk): NativeConversationEvent[];
  readExecutionFacts(input: FactCursor): Promise<ExecutionFactPage>;
  readConversationEvents?(
    cursor: ConversationSourceCursor,
  ): Promise<NativeConversationEvent[]>;
  prepareInputAttachments?(
    attachments: ResolvedInputAttachment[],
  ): Promise<PreparedInputAttachments>;
  stopConversation?(
    target: ConversationStopTarget,
  ): Promise<ConversationStopResult>;
  resume(input: ResumeContext): Promise<PreparedInvocation>;
  stop(identity: ProcessIdentity): Promise<StopResult>;
}
