import type {
  ReasoningSelection,
  ToolProfile,
} from "../../../contracts/src/execution-spec.js";
import type {
  EffortTransport,
  ModelCatalog,
  ModelEntry,
} from "../../../contracts/src/model-catalog.js";
import type {
  NonSecretIdentity,
  ProbeTerminal,
} from "../../../contracts/src/model-access.js";

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
  purpose:
    | "planning"
    | "implement"
    | "plan_self_check"
    | "quality_review"
    | "planner_takeover"
    | "functional_fix"
    | "aside"
    | "merge_conflict"
    | "diagnose";
  frozenInvocation?: import("../../../contracts/src/model-routing.js").FrozenInvocation;
  catalogEntry?: ModelEntry;
  selectionCapability?: ModelSelectionCapability;
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

export interface NativeAgentAdapter {
  onExecutionFact?: (fact: ExecutionFactPage["facts"][number]) => void;
  probe(input: ProbeRequest): Promise<CapabilityReport>;
  prepare(input: RunContext): Promise<PreparedInvocation>;
  buildInvocation(input: RunContext, executable: string): PreparedInvocation;
  decode(chunk: HostChunk): NormalizedEvent[];
  readExecutionFacts(input: FactCursor): Promise<ExecutionFactPage>;
  resume(input: ResumeContext): Promise<PreparedInvocation>;
  stop(identity: ProcessIdentity): Promise<StopResult>;
}

export interface DiscoveryContext {
  adapterId: string;
  executablePath?: string;
  cliVersion?: string;
  nativeConfigScope?: string;
  timeoutMs?: number;
}

export interface IdentityContext {
  adapterId: string;
  executablePath?: string;
  nativeConfigScope?: string;
}

export interface ProbeContext {
  workspaceRoot: string;
  timeoutMs?: number;
}

export interface ProbeTerminalInput {
  adapterId?: string;
  selectionKind?: "fixed" | "native-router";
  cancelled?: boolean;
  truncated?: boolean;
  launchFailed?: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut?: boolean;
  selectedModel?: string | null;
}

export interface ModelSelectionCapability {
  cliVersion?: string;
  opencodeVariantEncoding?: "flag" | "hash";
  kimiSupportEfforts?: string[];
  kimiProvider?: string;
}

export interface ModelSelectionFingerprint {
  adapterId: string;
  executable?: string;
  nativeConfigProfile?: string;
  modelId: string | null;
  effortTransport: EffortTransport;
  effortValue: string | null;
}

export interface ResolvedSelection {
  adapterId: string;
  /** Derived from the matched native catalog, never the caller profile flag. */
  selectionKind?: "fixed" | "native-router";
  modelToken: string | null;
  effortArgs: string[];
  effortEnv: Record<string, string>;
  reasoning: ReasoningSelection;
  transport: EffortTransport;
  fingerprint: ModelSelectionFingerprint;
}

export interface ModelConfigurationAdapter {
  discoverModels(context: DiscoveryContext): Promise<ModelCatalog>;
  readIdentity(context: IdentityContext): Promise<NonSecretIdentity>;
  resolveSelection(
    profile: ToolProfile,
    catalog: ModelCatalog,
  ): ResolvedSelection;
  prepareAccessProbe(
    selection: ResolvedSelection,
    context: ProbeContext,
  ): PreparedInvocation;
  parseProbeTerminal(input: ProbeTerminalInput): ProbeTerminal;
}
