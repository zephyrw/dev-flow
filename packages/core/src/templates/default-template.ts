import { parse } from "yaml";

export const DEFAULT_TEMPLATE_YAML = `
id: native-development
revision: 6
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
  - quality_before_human
  - human_functional_verification
  - quality_after_human
  - commit_and_integrate
  - cleanup_owned_workspace
quality:
  max_executor_rejections: 3
  first_failed_delivery_counts: false
  takeover: planner
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
  quality: {
    max_executor_rejections: number;
    first_failed_delivery_counts: boolean;
    takeover: string;
    takeover_self_review?: string;
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
