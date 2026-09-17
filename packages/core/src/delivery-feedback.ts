import type { Store } from "../../store/src/store.js";
import type {
  Delivery,
  DeliveryIssue,
  Workflow,
} from "../../contracts/src/index.js";

/** Only the latest submission for this approved plan is relevant to a retry. */
export function rejectedDeliveryFeedback(store: Store, workflow: Workflow) {
  const delivery = store
    .list<Delivery>("delivery", workflow.id)
    .filter(
      (d) =>
        d.plan_revision === workflow.plan_revision &&
        d.plan_hash === workflow.plan_hash,
    )
    .at(-1);
  if (!delivery || delivery.status !== "rejected") return null;
  return {
    delivery_id: delivery.id,
    run_id: delivery.run_id,
    issues: store
      .list<DeliveryIssue>("delivery_issue", workflow.id)
      .filter((i) => i.delivery_id === delivery.id && i.status === "open"),
  };
}
