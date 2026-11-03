import type { Store } from "../../store/src/store.js";
import type { Workflow } from "../../contracts/src/index.js";

/** Keep user-edited names independent of asynchronous execution state writes. */
export function withWorkflowDisplayName(store: Store, workflow: Workflow): Workflow {
  const display = store.get<{ title: string }>("workflow_display", workflow.id);
  return display ? { ...workflow, title: display.title } : workflow;
}
