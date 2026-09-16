import { z } from "zod";
export const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/);
export const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (p) =>
      !p.includes("\\") &&
      !p.includes(":") &&
      !p.startsWith("/") &&
      p.split("/").every((s) => s && s !== "." && s !== ".."),
    "必须是无穿越的相对路径",
  );
export const Layer = z.enum(["unit", "integration", "e2e", "opentabs"]);
export const States = [
  "RESEARCHING",
  "PLAN_PENDING",
  "QUEUED",
  "EXECUTING",
  "VERIFYING",
  "HUMAN_PENDING",
  "REVIEW_QUEUED",
  "REVIEWING",
  "REPAIR_PLAN_PENDING",
  "REPAIR_RESEARCH_REQUIRED",
  "COMMITTING",
  "COMMITTED",
  "COMMIT_PARTIAL",
  "STOPPING",
  "STOPPED",
  "BLOCKED",
  "RECOVERY_REQUIRED",
  "WAITING_AUTHORIZATION",
  "WAITING_INPUT",
] as const;
export type State = (typeof States)[number];
export const ScopeSchema = z
  .object({
    repository_paths: z.record(Id, z.array(RelativePath).min(1)).default({}),
    allowed_paths: z.array(RelativePath).min(1),
    protected_paths: z.array(z.string()).default([".git", ".agents", ".codex"]),
    allow_dependency_changes: z.boolean().default(false),
    allow_public_api_changes: z.boolean().default(false),
  })
  .strict();
export const TaskSchema = z
  .object({
    module_id: Id.optional(),
    completion_checks: z
      .array(
        z.object({ path: RelativePath, contains: z.string().min(5) }).strict(),
      )
      .min(1)
      .optional(),
    repo_id: Id.optional(),
    id: Id,
    title: z.string().min(1),
    requirements: z.array(Id).min(1),
    depends_on: z.array(Id).default([]),
    paths: z.array(RelativePath).min(1),
    inputs: z.string().min(1),
    implementation: z.string().min(10),
    preserve: z.string().min(1),
    completion: z.string().min(5),
    test_ids: z.array(Id).min(1),
    stop_conditions: z.string().min(1),
  })
  .strict();
export const TestSchema = z
  .object({
    id: Id,
    task_ids: z.array(Id).min(1),
    layer: Layer,
    command_id: Id.optional(),
    scene_id: Id.optional(),
    steps: z.array(z.string().min(1)).min(1),
    assertions: z.array(z.string().min(1)).min(1),
    expected_case_ids: z.array(z.string().min(1)).min(1),
    timeout_seconds: z.number().int().positive().max(7200).default(300),
  })
  .strict();
export const PlanSchema = z
  .object({
    task_model: z.enum(["legacy", "leaf-v1", "native-v2"]).optional(),
    modules: z
      .array(z.object({ id: Id, title: z.string().min(1) }).strict())
      .min(1)
      .optional(),
    markdown: z.string().min(80),
    complexity: z.enum(["simple", "complex"]),
    reason: z.string().min(1),
    decisions: z.array(
      z
        .object({
          question: z.string(),
          answer: z.string().min(1),
          source: z.string().min(1),
        })
        .strict(),
    ),
    unresolved_decisions: z.array(z.string()).length(0),
    scope: ScopeSchema,
    tasks: z.array(TaskSchema).min(1),
    tests: z.array(TestSchema).min(1),
    exemptions: z
      .array(z.object({ layer: Layer, reason: z.string().min(10) }).strict())
      .default([]),
    baselines: z.record(Id, z.string().regex(/^[a-f0-9]{40,64}$/)),
    project_config_hash: z.string().min(1),
  })
  .strict();
export type Plan = z.infer<typeof PlanSchema>;

export function resolveTaskModel(
  plan?: { task_model?: string } | null,
): "legacy" | "leaf-v1" | "native-v2" {
  if (plan?.task_model === "native-v2") return "native-v2";
  if (plan?.task_model === "leaf-v1") return "leaf-v1";
  return "legacy";
}
export const CommandSchema = z
  .object({
    repo_id: Id.optional(),
    id: Id,
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().default(""),
    env: z.record(z.string(), z.string()).default({}),
    timeout_seconds: z.number().positive().max(7200).default(300),
    lifecycle: z.enum(["check", "service", "fixture"]).default("check"),
    parser: z
      .enum(["vitest_json", "junit", "playwright_json", "none"])
      .default("none"),
    report_path: RelativePath.optional(),
    required_before_commit: z.boolean().default(false),
  })
  .strict();
export const ProjectSchema = z
  .object({
    id: Id,
    name: z.string().min(1),
    repositories: z
      .array(z.object({ id: Id, path: z.string().min(1) }).strict())
      .min(1),
    commands: z.array(CommandSchema).default([]),
    services: z
      .array(
        z
          .object({
            id: Id,
            repo_id: Id,
            command_id: Id,
            port_pool: z.enum(["frontend", "backend"]),
            health_path: z.string().startsWith("/"),
            backend_probe_path: z.string().startsWith("/").optional(),
            identity_header: z.string().default("x-devflow-identity"),
          })
          .strict(),
      )
      .default([]),
    data: z
      .object({
        mode: z.enum(["directory", "external_lock"]),
        resource_id: Id.optional(),
        fixture_command_id: Id.optional(),
      })
      .strict()
      .default({ mode: "directory" }),
    browser_scenes: z
      .array(
        z
          .object({
            id: Id,
            steps: z.array(z.string()).min(1),
            assertions: z.array(z.string()).min(1),
            allowed_tools: z.array(z.string()).min(1),
          })
          .strict(),
      )
      .default([]),
    browser_recipe_hashes: z.record(Id, z.string()).optional(),
    git: z
      .object({
        author_name: z.string().min(1),
        author_email: z.string().email(),
        signing_key: z.string().optional(),
        required_hooks: z.array(Id).default([]),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Project = z.infer<typeof ProjectSchema>;
export const ReviewSchema = z
  .object({
    schema_version: z.literal(1),
    review_request_id: Id,
    workflow_id: Id,
    plan_revision: z.number().int().positive(),
    snapshot_id: z.string(),
    verdict: z.enum(["pass", "findings", "incomplete"]),
    coverage: z
      .object({
        all_changed_files_reviewed: z.boolean(),
        all_requirements_checked: z.boolean(),
        upstream_downstream_checked: z.boolean(),
        security_checked: z.boolean(),
        tests_validity_checked: z.boolean(),
        files: z.array(z.string()),
      })
      .strict(),
    findings: z.array(
      z
        .object({
          id: Id,
          severity: z.enum(["P0", "P1", "P2", "P3"]),
          repo_id: Id,
          path: RelativePath,
          line: z.number().int().positive(),
          trigger: z.string().min(1),
          evidence: z.string().min(1),
          consequence: z.string().min(1),
          relation_to_change: z.enum([
            "introduced",
            "in_scope",
            "historical",
            "suggestion",
          ]),
          disposition: z.enum(["confirmed", "false_positive", "out_of_scope"]),
          reason: z.string().min(1),
        })
        .strict(),
    ),
    unresolved_questions: z.array(z.string()),
    repair_plan: PlanSchema.nullable(),
    commit_message: z.string().min(1).max(500),
  })
  .strict();
export type Review = z.infer<typeof ReviewSchema>;
export interface Workflow {
  id: string;
  project_id: string;
  title: string;
  request: string;
  complexity: "simple" | "complex";
  workspace_mode: "existing_workspace" | "new_worktree";
  state: State;
  stage: string;
  version: number;
  plan_revision: number;
  plan_hash?: string;
  snapshot_id?: string;
  environment_revision: number;
  run_id?: string;
  review_request_id?: string;
  blocker?: { code: string; message: string };
  created_at: string;
  updated_at: string;
  feedback: string[];
}
export interface Workspace {
  id: string;
  workflow_id: string;
  repo_id: string;
  root: string;
  common_dir: string;
  baseline: string;
  branch: string;
  owned: boolean;
}
export interface Run {
  id: string;
  workflow_id: string;
  plan_revision: number;
  adapter: "agy" | "codex";
  stage: string;
  status: string;
  conversation_id?: string;
  started_at: string;
  deadline_at?: number;
  ended_at?: string;
  result?: unknown;
  exit_code?: number | null;
  package_hash: string;
}
export interface Evidence {
  phase?: "development" | "delivery";
  source_hash?: string;
  plan_revision?: number;
  cases?: { id: string; status: "passed" | "failed" | "skipped" }[];
  id: string;
  workflow_id: string;
  run_id: string;
  snapshot_id: string;
  environment_revision: number;
  test_id: string;
  layer: z.infer<typeof Layer>;
  status: "passed" | "failed" | "stale";
  case_ids: string[];
  passed: number;
  failed: number;
  skipped: number;
  discovered: number;
  exit_code: number;
  files: { path: string; hash: string }[];
  created_at: string;
}
export interface Snapshot {
  id: string;
  workflow_id: string;
  environment_revision: number;
  created_at: string;
  repositories: {
    workspace_id: string;
    repo_id: string;
    baseline: string;
    branch: string;
    tree: string;
    files: { path: string; hash: string; mode: string }[];
    changed_paths: string[];
  }[];
}
export interface DomainEvent {
  workflow_id: string;
  project_id: string;
  run_id?: string;
  event_seq: number;
  type: string;
  payload: unknown;
  created_at: string;
}
export class FlowError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details: unknown = null,
  ) {
    super(message);
    this.name = "FlowError";
  }
}
export function requireCondition(
  value: unknown,
  code: string,
  message: string,
  status = 409,
): asserts value {
  if (!value) throw new FlowError(code, message, status);
}

export const DeliveryManifestSchema = z
  .object({
    schema_version: z.string().optional(),
    submission_id: z.string().optional(),
    workflow_id: z.string().optional(),
    run_id: z.string().optional(),
    conversation_id: z.string().optional(),
    plan_revision: z.number().int().optional(),
    plan_hash: z.string().optional(),
    implementations: z
      .array(
        z
          .object({
            repo_id: z.string().optional(),
            module_id: Id.optional(),
            task_id: Id.optional(),
            path: RelativePath,
            description: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
    test_executions: z
      .array(
        z
          .object({
            tool_call_id: z.string().min(1),
            command: z.string().min(1),
            cwd: z.string().default(""),
            repo_id: z.string().optional(),
            started_at: z.string().optional(),
            ended_at: z.string().optional(),
            exit_code: z.number().int().optional(),
            output_path: z.string().optional(),
            report_paths: z.array(RelativePath).default([]),
            format: z
              .enum(["vitest_json", "playwright_json", "junit", "auto"])
              .optional(),
          })
          .strict(),
      )
      .default([]),
    acceptance_mappings: z
      .array(
        z
          .object({
            requirement_id: z.string().min(1),
            scene_id: z.string().min(1),
            test_execution_id: z.string().min(1),
            report_path: RelativePath,
            case_id: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    unfinished_items: z
      .array(
        z
          .object({
            id: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .default([]),
    plan_conflicts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            description: z.string().min(1),
            proposed_change: z.string().optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export const NativeDeliveryManifestSchema = DeliveryManifestSchema.extend({
  schema_version: z.literal("v2"),
  submission_id: Id,
  workflow_id: Id,
  run_id: Id,
  conversation_id: Id,
  plan_revision: z.number().int().positive(),
  plan_hash: z.string().min(1),
});
export type DeliveryManifest = z.infer<typeof DeliveryManifestSchema>;

export interface Delivery {
  id: string;
  submission_id?: string;
  manifest_hash?: string;
  workflow_id: string;
  run_id: string;
  plan_revision: number;
  plan_hash?: string;
  status: "pending" | "passed" | "rejected";
  input_manifest_id?: string;
  report_hashes?: Record<string, string>;
  manifest: DeliveryManifest;
  submitted_at: string;
}

export interface DeliveryRevision {
  id: string;
  workflow_id: string;
  delivery_id: string;
  snapshot_id?: string;
  plan_revision: number;
  plan_hash: string;
  input_fingerprints: Record<string, string>; // repo_id -> fingerprint
  execution_finished: boolean;
  invalidated?: boolean;
  run_id?: string;
  conversation_id?: string;
  created_at: string;
}

export interface VerificationBatch {
  id: string;
  workflow_id: string;
  repo_id: string;
  input_manifest_id: string;
  fingerprint: string;
  started_at: string;
  ended_at?: string;
}

export interface TestExecution {
  delivery_id?: string;
  input_fingerprints?: Record<string, string>;
  report_hashes?: Record<string, string>;
  id: string;
  workflow_id: string;
  run_id: string;
  tool_call_id: string;
  command: string;
  cwd: string;
  repo_id?: string;
  started_at: string;
  ended_at: string;
  exit_code: number;
  output_path?: string;
  report_paths: string[];
}

export interface AcceptanceResult {
  id: string;
  workflow_id: string;
  delivery_id: string;
  requirement_id: string;
  scene_id: string;
  test_execution_id: string;
  case_id: string;
  status: "passed" | "failed" | "skipped";
  reason?: string;
}

export interface InputManifest {
  id: string;
  workflow_id: string;
  repo_id?: string;
  fingerprint: string;
  files: { path: string; hash: string }[];
  created_at: string;
}

export interface DeliveryIssue {
  id: string;
  issue_key?: string;
  workflow_id: string;
  delivery_id: string;
  code: string;
  message: string;
  module_id?: string;
  scene_id?: string;
  status: "open" | "resolved";
  first_seen_at?: string;
  resolved_at?: string;
  created_at: string;
}

export interface RunUsage {
  id: string;
  run_id: string;
  workflow_id: string;
  available?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  recorded_at: string;
}
