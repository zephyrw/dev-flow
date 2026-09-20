import type { AgyAccountRepository } from "./repository.js";
import type {
  SwitchOperationExecutor,
  SwitchResult,
} from "./switch-operation.js";
import type { ClockPort } from "./ports.js";

export interface ManualSwitchRequest {
  realmId: string;
  selection: { mode: "auto" } | { mode: "explicit"; account_id: string };
  modelId?: string;
  requestId: string;
  expectedEpoch?: number;
  requiredPoolIds?: string[];
}

export class AgyManualSwitchService {
  constructor(
    private repository: AgyAccountRepository,
    private switchExecutor: SwitchOperationExecutor,
    private clock: ClockPort,
  ) {}

  async executeManualSwitch(req: ManualSwitchRequest): Promise<SwitchResult> {
    const realm = this.repository.getRealm(req.realmId);
    const op = realm?.pending_operation_id
      ? this.repository.getOperation(realm.pending_operation_id)
      : undefined;
    if (
      !op ||
      op.request_id !== req.requestId ||
      op.kind !== "switch" ||
      !op.trigger.startsWith("manual")
    ) {
      throw new Error("submit_manual_switch_through_account_service");
    }
    return this.switchExecutor.execute({
      operationId: op.operation_id,
      realmId: op.realm_id,
      selection: op.selection,
      trigger: op.trigger,
      requiredPoolIds: op.required_pool_ids,
      modelId: op.model_id,
      requestId: op.request_id,
      expectedEpoch: op.before_auth_epoch,
    });
  }
}
