import { parse } from "yaml";

export const DEFAULT_TEMPLATE_YAML = `
id: native-development
revision: 4
task_model: native-v2
roles:
  planner: task.plannerProfile
  executor: task.executorProfile
  tester: task.executorProfile
  quality_reviewer: task.plannerProfile
  quality_takeover: task.plannerProfile
flow:
  - planning
  - plan_approval
  - native_implementation_and_self_test
  - delivery_validation
  - executor_plan_self_check
  - quality_before_human
  - human_functional_verification
  - quality_after_human
  - commit_and_integrate
  - cleanup_owned_workspace
plan_self_check:
  owner: executor
  trigger: every_successful_implementation_or_repair
  authority: approved_original_and_repair_plans
  require_current_delivery_and_successful_exit: true
  unresolved_findings: repair_and_retest_before_quality_review
  counts_as_quality_rejection: false
quality:
  max_executor_rejections: 3
  first_failed_delivery_counts: true
  takeover: planner
  takeover_self_review: fresh_readonly_session
feedback:
  functional_repair_owner: executor
  human_closes_issues: true
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
  roles: Record<string, string>;
  flow: string[];
  plan_self_check: {
    owner: string;
    trigger: string;
    authority: string;
    require_current_delivery_and_successful_exit: boolean;
    unresolved_findings: string;
    counts_as_quality_rejection: boolean;
  };
  quality: {
    max_executor_rejections: number;
    first_failed_delivery_counts: boolean;
    takeover: string;
    takeover_self_review: string;
  };
  feedback: {
    functional_repair_owner: string;
    human_closes_issues: boolean;
    references: string;
    aside: string;
  };
  resources: {
    foreground_ai_slots: number;
    live_environments: number;
    aside_slots: number;
  };
}

export function getDefaultTemplate(): WorkflowTemplate {
  return parse(DEFAULT_TEMPLATE_YAML) as WorkflowTemplate;
}
