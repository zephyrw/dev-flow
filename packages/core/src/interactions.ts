import { z } from "zod";
import type { Engine } from "./engine.js";
import type { Principal } from "./auth.js";
import {
  Id,
  RelativePath,
  requireCondition,
  type Workspace,
} from "../../contracts/src/index.js";
import { id, now, objectHash } from "./util.js";
import { safePath } from "../../workspace/src/files.js";

export const OperationSchema = z
  .object({
    repo_id: Id,
    executable: z.string().min(1).max(2048),
    args: z.array(z.string().max(16000)).max(100),
    cwd: RelativePath.optional(),
    reason: z.string().min(5).max(4000),
    timeout_seconds: z.number().int().min(1).max(1800).default(300),
  })
  .strict();
export type Operation = z.infer<typeof OperationSchema>;
export interface OperationRequest {
  id: string;
  workflow_id: string;
  plan_revision: number;
  plan_hash: string;
  requested_run_id: string;
  operation: Operation;
  cwd: string;
  fingerprint: string;
  status:
    | "pending"
    | "approved"
    | "denied"
    | "running"
    | "completed"
    | "failed"
    | "cancelled";
  created_at: string;
  decided_at?: string;
  note?: string;
  result?: unknown;
}
export function requestOperation(
  engine: Engine,
  principal: Principal,
  workflow: string,
  input: unknown,
) {
  const w = engine.worker(principal, workflow, true);
  const operation = OperationSchema.parse(input);
  const ws = engine.store
    .list<Workspace>("workspace", workflow)
    .find((x) => x.repo_id === operation.repo_id);
  requireCondition(ws, "WORKSPACE_MISSING", "操作仓库没有绑定到当前任务");
  const cwd = operation.cwd ? safePath(ws.root, operation.cwd) : ws.root;
  const fingerprint = objectHash({
    operation,
    cwd,
    plan_revision: w.plan_revision,
    plan_hash: w.plan_hash,
  });
  const previous = engine.store
    .list<OperationRequest>("operation_request", workflow)
    .find(
      (x) =>
        x.fingerprint === fingerprint &&
        ["pending", "approved", "running"].includes(x.status),
    );
  if (previous) return previous;
  const request: OperationRequest = {
    id: id("operation"),
    workflow_id: workflow,
    plan_revision: w.plan_revision,
    plan_hash: w.plan_hash!,
    requested_run_id: principal.run_id!,
    operation,
    cwd,
    fingerprint,
    status: "pending",
    created_at: now(),
  };
  engine.store.transaction(() => {
    engine.store.put("operation_request", request.id, workflow, request);
    engine.transition(
      workflow,
      ["EXECUTING"],
      "WAITING_AUTHORIZATION",
      "authorization",
    );
    engine.store.event(
      workflow,
      w.project_id,
      "AuthorizationRequested",
      request,
      principal.run_id,
    );
  });
  // End this print turn and release the model slot. The persisted request and
  // explicit conversation ID survive both a delayed answer and a restart.
  setTimeout(
    () => void engine.runtime?.stop(principal.run_id!).catch(() => {}),
    100,
  );
  return {
    ...request,
    instruction:
      "等待用户在工作台授权。本轮结束；收到决定后系统续接同一会话，读取 operations 上下文。不要重复请求或绕过授权。",
  };
}
export function decideOperation(
  engine: Engine,
  workflow: string,
  requestId: string,
  approved: boolean,
  fingerprint: string,
  note = "",
) {
  const w = engine.get(workflow);
  const request = engine.store.must<OperationRequest>(
    "operation_request",
    requestId,
  );
  requireCondition(
    request.workflow_id === workflow && request.status === "pending",
    "AUTHORIZATION_STALE",
    "授权请求已经处理或不属于当前任务",
  );
  requireCondition(
    w.state === "WAITING_AUTHORIZATION" &&
      request.plan_revision === w.plan_revision &&
      request.plan_hash === w.plan_hash &&
      request.fingerprint === fingerprint,
    "AUTHORIZATION_STALE",
    "操作或计划已经变化，请重新查看待授权操作",
  );
  const next: OperationRequest = {
    ...request,
    status: approved ? "approved" : "denied",
    decided_at: now(),
    note: note.slice(0, 4000),
  };
  engine.store.transaction(() => {
    engine.store.put("operation_request", requestId, workflow, next);
    engine.store.event(workflow, w.project_id, "AuthorizationDecided", {
      request_id: requestId,
      approved,
      note: next.note,
    });
  });
  return next;
}
