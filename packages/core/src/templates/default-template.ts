import { parse } from "yaml";

export const DEFAULT_TEMPLATE_YAML = `
id: native-development
revision: 7
task_model: native-v2
quality_policy_version: 2
roles:
  planner: task.plannerProfile
  executor: task.executorProfile
  tester: task.executorProfile
  quality_reviewer: task.plannerProfile
  quality_repair: task.plannerProfile
  executor_test: task.executorProfile
  planner_commit: task.plannerProfile
flow:
  - planning
  - plan_approval
  - native_implementation_and_self_test
  - quality_before_human
  - human_functional_verification
  - quality_after_human
  - planner_commit
  - cleanup_owned_workspace
quality:
  quality_policy_version: 2
  executor_quality_repairs: 1
  planner_repairs_after_executor: true
  planner_repair_runs_tests: false
  executor_test_may_patch: true
  test_patch_requires_review: false
  after_test_routes: phase_direct
  final_review_gates_commit: true
  planner_commits: true
feedback:
  functional_repair_owner: executor
  human_closes_issues: true
  functional_fix_returns_to_human: true
  auto_reconfirm_after_final_test: false
  references: files_and_directories
  aside: isolated_readonly
resources:
  foreground_ai_slots: 1
  live_environments: 1
  aside_slots: 1
`;

export interface WorkflowTemplate {
  id: string;
  revision: number;
  task_model: string;
  quality_policy_version?: number;
  roles: Record<string, string>;
  flow: string[];
  quality: {
    quality_policy_version?: number;
    /** 历史策略：执行质量整改最多次数；策略 2 改用 executor_quality_repairs。 */
    max_executor_rejections?: number;
    first_failed_delivery_counts?: boolean;
    takeover?: string;
    takeover_self_review?: string;
    /** 策略 2：唯一执行质量整改轮数。 */
    executor_quality_repairs?: number;
    planner_repairs_after_executor?: boolean;
    planner_repair_runs_tests?: boolean;
    executor_test_may_patch?: boolean;
    test_patch_requires_review?: boolean;
    after_test_routes?: "phase_direct" | "legacy_review";
    final_review_gates_commit?: boolean;
    planner_commits?: boolean;
  };
  feedback: {
    functional_repair_owner: string;
    human_closes_issues: boolean;
    functional_fix_returns_to_human?: boolean;
    auto_reconfirm_after_final_test?: boolean;
    references: string;
    aside: string;
  };
  resources: {
    foreground_ai_slots: number;
    live_environments: number;
    aside_slots: number;
  };
}

export const DEFAULT_QUALITY_POLICY_VERSION = 2;

export function getDefaultTemplate(): WorkflowTemplate {
  return parse(DEFAULT_TEMPLATE_YAML) as WorkflowTemplate;
}
