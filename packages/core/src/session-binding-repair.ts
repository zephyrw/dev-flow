import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { isAbsolute, normalize } from "node:path";
import type { Store } from "../../store/src/store.js";
import { ExecutionSessionStore } from "./execution-session-store.js";
import {
  type SessionBinding,
  type SessionBindingKey,
  computeSessionBindingKey,
  computeSessionOwnerKey,
} from "../../contracts/src/session-binding.js";
import type { Workflow, Workspace, Run, WorkflowDispatchControl } from "../../contracts/src/index.js";
import { FlowError, requireCondition } from "../../contracts/src/index.js";
import { resolveClientScope, resolveWorkspaceIdentity, readLocalAccountScope } from "../../adapters/sdk/src/identity.js";
import { id, now } from "./util.js";

function legacyClientScope(adapterId: string, recordedScope: unknown): string | undefined {
  return typeof recordedScope === "string" && isAbsolute(recordedScope)
    ? normalize(recordedScope).toLowerCase()
    : resolveClientScope(adapterId);
}

export interface SessionRepairCandidate {
  candidate_id: string;
  source_ref: "conversation" | "native_conversation" | "agy_project" | "run_init";
  conversation_id: string;
  adapter_id: string;
  host_id: string;
  client_scope_id: string;
  provider_account_scope: string;
  canonical_model_id: string;
  workspace_identity: string;
  workspace_root: string;
  source_root: string;
  repo_id: string;
  status:
    | "verified"
    | "ambiguous"
    | "unverifiable"
    | "missing_session"
    | "already_bound"
    | "conflict";
  reason?: string;
  expected_binding_revision: number;
}

export interface SessionBindingRepairPreviewResult {
  workflow_id: string;
  workflow_version: number;
  control_revision: number;
  source_digest: string;
  candidates: SessionRepairCandidate[];
  writer_state: "idle" | "active" | "unknown";
  requires_dispatch_disabled: boolean;
}

export interface SessionBindingRepairApplyInput {
  request_id: string;
  expected_workflow_version: number;
  expected_control_revision?: number;
  source_digest: string;
  selections: Array<{
    candidate_id: string;
    expected_binding_revision: number;
  }>;
}

export interface SessionBindingRepairApplyResult {
  migration_id: string;
  operation: "session_binding_repair";
  status: "completed";
  replayed: boolean;
  affected_binding_ids: string[];
  workflow_version: number;
  control_revision: number;
}

export interface SessionBindingRepairRollbackInput {
  request_id: string;
  migration_id: string;
  expected_workflow_version: number;
  expected_control_revision?: number;
  expected_binding_revisions: Array<{
    binding_id: string;
    revision: number;
  }>;
}

export interface MigrationPatchRecord {
  id: string;
  workflow_id: string;
  request_id: string;
  affected_binding_ids: string[];
  previous_bindings: Array<{
    keyStr: string;
    binding: SessionBinding | null;
  }>;
  created_at: string;
  status: "applied" | "rolled_back";
}

export class SessionBindingRepairService {
  private sessionStore: ExecutionSessionStore;

  constructor(private store: Store) {
    this.sessionStore = new ExecutionSessionStore(store);
  }

  /**
   * 依据 CW2-D06 / §9.2 规范：只读清点与预览历史会话候选
   */
  previewRepair(
    workflowId: string,
    expectedWorkflowVersion?: number,
  ): SessionBindingRepairPreviewResult {
    const workflow = this.store.must<Workflow>("workflow", workflowId);
    if (expectedWorkflowVersion !== undefined) {
      requireCondition(
        workflow.version === expectedWorkflowVersion,
        "WORKFLOW_VERSION_CONFLICT",
        `工作流版本冲突: 期望 v${expectedWorkflowVersion}, 实际 v${workflow.version}`,
        409,
      );
    }

    const control = this.store.get<WorkflowDispatchControl>("workflow_dispatch_control", workflowId);
    const controlRevision = control?.revision ?? 1;

    // CW3-F18: 严密识别 prepared / needs_reconcile / starting / running / stopping 及旧 process_record
    const activeRuns = this.store
      .list<Run>("run", workflowId)
      .filter((r) => {
        const s = (r.status || "").toLowerCase();
        return ["running", "executing", "starting"].includes(s);
      });
    const activeDispatches = this.store
      .list<any>("cli_dispatch_record", workflowId)
      .filter((d: any) =>
        ["prepared", "starting", "running", "stopping", "needs_reconcile"].includes(
          (d.state || "").toLowerCase(),
        ),
      );
    const unconfirmedProcesses = this.store
      .list<any>("process_record", workflowId)
      .filter((p: any) => p.status !== "exited" && !p.confirmed);

    let writerState: "idle" | "active" | "unknown" = "idle";
    if (activeRuns.length > 0 || activeDispatches.length > 0) {
      writerState = "active";
    } else if (unconfirmedProcesses.length > 0) {
      writerState = "unknown";
    } else if (control?.writer_state && control.writer_state !== "idle") {
      writerState = control.writer_state;
    }

    const workspaces = this.store.list<Workspace>("workspace", workflowId);
    const primaryWs = workspaces.find((ws: any) => ws.primary || ws.is_primary) || workspaces[0];
    const normRoot = primaryWs ? primaryWs.root.replaceAll("\\", "/").toLowerCase() : "";
    const sourceRoot = primaryWs?.source_root || primaryWs?.root || "";
    const repoId = primaryWs?.repo_id || "main";

    const hostId = process.env.DEVFLOW_HOST_ID || hostname().trim().toLowerCase();

    const candidates: SessionRepairCandidate[] = [];

    // 1. 已有 session_binding
    const existingBindings = this.sessionStore.listBindings(workflowId);
    for (const b of existingBindings) {
      if (b.conversation_id) {
        candidates.push({
          candidate_id: `cand:binding:${b.id}`,
          source_ref: "run_init",
          conversation_id: b.conversation_id,
          adapter_id: b.adapter_id,
          host_id: b.host_id,
          client_scope_id: b.client_scope_id,
          provider_account_scope: b.provider_account_scope,
          canonical_model_id: b.canonical_model_id,
          workspace_identity: b.workspace_identity,
          workspace_root: b.workspace_root || primaryWs?.root || "",
          source_root: b.source_root || sourceRoot,
          repo_id: b.repo_id || repoId,
          status: "already_bound",
          expected_binding_revision: b.revision,
        });
      }
    }

    // 2. 清点旧 conversation 记录 (关联自身 Run/profile，禁止使用最后Run代替历史来源，禁止猜account)
    const legacyConvList = this.store.list<any>("conversation", workflowId);
    const directConv = this.store.get<any>("conversation", workflowId);
    if (directConv && !legacyConvList.some((c) => c.id === directConv.id)) {
      legacyConvList.push(directConv);
    }

    for (const lc of legacyConvList) {
      const convId = lc.conversation_id || lc.id;
      let candAdapter = lc.adapter_id || lc.adapter;
      let candModel = lc.canonical_model_id || lc.model;
      let candAccount = lc.provider_account_scope || lc.account;

      let sourceRun: Run | undefined;
      if (lc.run_id) {
        sourceRun = this.store.get<Run>("run", lc.run_id);
      }
      if (!candAdapter && sourceRun?.profile) {
        candAdapter = (sourceRun.profile as any).adapterId || (sourceRun.profile as any).adapter_id;
      }
      if (!candModel && sourceRun?.profile) {
        candModel = (sourceRun.profile as any).modelId || (sourceRun.profile as any).canonical_model_id;
      }
      candAdapter = candAdapter || "unknown";
      candModel = candModel || "unknown";

      // CW4-F04: 统一使用现有身份解析逻辑中的配置域与工作区归一化规则，不再用简称冒充
      const candClientScope = legacyClientScope(candAdapter, lc.client_scope_id) ?? "";
      const candWsRoot = lc.workspace_root || primaryWs?.root || "";
      const candNormRoot = resolveWorkspaceIdentity(candWsRoot, workspaces);

      if (!candAccount && sourceRun?.profile) {
        candAccount = (sourceRun.profile as any).accountScope || (sourceRun.profile as any).provider_account_scope;
      }
      if (!candAccount) {
        candAccount = process.env.DEVFLOW_ACCOUNT_SCOPE || process.env.DEVFLOW_PROVIDER_ACCOUNT;
      }
      if (!candAccount && candAdapter !== "unknown") {
        const clientHome = candClientScope || resolveClientScope(candAdapter);
        if (clientHome) {
          candAccount = readLocalAccountScope(candAdapter, clientHome);
        }
      }
      if (!candAccount) {
        candAccount = "unknown";
      }

      const isUnverifiable =
        !convId ||
        !candNormRoot ||
        !candClientScope ||
        !hostId ||
        candModel === "default" ||
        candModel === "unknown" ||
        candAdapter === "unknown" ||
        ["unknown", "default", "default-account"].includes(candAccount);

      let isConflict = false;
      let existingOwnerId: string | undefined;
      if (convId && !isUnverifiable) {
        const ownerKey = computeSessionOwnerKey({
          adapter_id: candAdapter,
          host_id: hostId,
          client_scope_id: candClientScope,
          provider_account_scope: candAccount,
          conversation_id: convId,
        });
        const existingOwner = this.store.get<{ workflow_id: string }>(
          "session_owner_index",
          ownerKey,
        );
        if (existingOwner && existingOwner.workflow_id !== workflowId) {
          isConflict = true;
          existingOwnerId = existingOwner.workflow_id;
        }
      }

      let status: SessionRepairCandidate["status"] = "verified";
      let reason: string | undefined;
      if (isConflict) {
        status = "conflict";
        reason = `已由任务 ${existingOwnerId} 认领`;
      } else if (isUnverifiable) {
        status = "unverifiable";
        reason = "缺少会话ID、工作区、真实模型或账号配置，无法确证";
      }

      candidates.push({
        candidate_id: `cand:legacy_conv:${convId || lc.id || "empty"}`,
        source_ref: "conversation",
        conversation_id: convId || "",
        adapter_id: candAdapter,
        host_id: hostId,
        client_scope_id: candClientScope,
        provider_account_scope: candAccount,
        canonical_model_id: candModel,
        workspace_identity: candNormRoot,
        workspace_root: candWsRoot,
        source_root: sourceRoot,
        repo_id: repoId,
        status,
        reason,
        expected_binding_revision: 0,
      });
    }

    // 3. 清点旧 native_conversation 记录
    const nativeConvs = this.store.list<any>("native_conversation", workflowId);
    for (const nc of nativeConvs) {
      const convId = nc.native_conversation_id || nc.conversation_id || nc.id;
      let candAdapter = nc.adapter_id || nc.adapter;
      let candModel = nc.canonical_model_id || nc.model;
      let candAccount = nc.provider_account_scope || nc.account;

      let sourceRun: Run | undefined;
      if (nc.run_id) {
        sourceRun = this.store.get<Run>("run", nc.run_id);
      }
      if (!candAdapter && sourceRun?.profile) {
        candAdapter = (sourceRun.profile as any).adapterId || (sourceRun.profile as any).adapter_id;
      }
      if (!candModel && sourceRun?.profile) {
        candModel = (sourceRun.profile as any).modelId || (sourceRun.profile as any).canonical_model_id;
      }
      candAdapter = candAdapter || "unknown";
      candModel = candModel || "unknown";

      // CW4-F04: 统一使用现有身份解析逻辑中的配置域与工作区归一化规则，不再用简称冒充
      const candClientScope = legacyClientScope(candAdapter, nc.client_scope_id) ?? "";
      const candWsRoot = nc.workspace_root || primaryWs?.root || "";
      const candNormRoot = resolveWorkspaceIdentity(candWsRoot, workspaces);

      if (!candAccount && sourceRun?.profile) {
        candAccount = (sourceRun.profile as any).accountScope || (sourceRun.profile as any).provider_account_scope;
      }
      if (!candAccount) {
        candAccount = process.env.DEVFLOW_ACCOUNT_SCOPE || process.env.DEVFLOW_PROVIDER_ACCOUNT;
      }
      if (!candAccount && candAdapter !== "unknown") {
        const clientHome = candClientScope || resolveClientScope(candAdapter);
        if (clientHome) {
          candAccount = readLocalAccountScope(candAdapter, clientHome);
        }
      }
      if (!candAccount) {
        candAccount = "unknown";
      }

      if (convId && candidates.some((c) => c.conversation_id === convId && c.adapter_id === candAdapter)) {
        continue;
      }

      const isUnverifiable =
        !convId ||
        !candNormRoot ||
        !candClientScope ||
        !hostId ||
        candModel === "default" ||
        candModel === "unknown" ||
        candAdapter === "unknown" ||
        ["unknown", "default", "default-account"].includes(candAccount);

      let isConflict = false;
      let existingOwnerId: string | undefined;
      if (convId && !isUnverifiable) {
        const ownerKey = computeSessionOwnerKey({
          adapter_id: candAdapter,
          host_id: hostId,
          client_scope_id: candClientScope,
          provider_account_scope: candAccount,
          conversation_id: convId,
        });
        const existingOwner = this.store.get<{ workflow_id: string }>(
          "session_owner_index",
          ownerKey,
        );
        if (existingOwner && existingOwner.workflow_id !== workflowId) {
          isConflict = true;
          existingOwnerId = existingOwner.workflow_id;
        }
      }

      let status: SessionRepairCandidate["status"] = "verified";
      let reason: string | undefined;
      if (isConflict) {
        status = "conflict";
        reason = `已由任务 ${existingOwnerId} 认领`;
      } else if (isUnverifiable) {
        status = "unverifiable";
        reason = "缺少会话ID、工作区、真实模型或账号配置，无法确证";
      }

      candidates.push({
        candidate_id: `cand:native_conv:${convId || nc.id || "empty"}`,
        source_ref: "native_conversation",
        conversation_id: convId || "",
        adapter_id: candAdapter,
        host_id: hostId,
        client_scope_id: candClientScope,
        provider_account_scope: candAccount,
        canonical_model_id: candModel,
        workspace_identity: candNormRoot,
        workspace_root: candWsRoot,
        source_root: sourceRoot,
        repo_id: repoId,
        status,
        reason,
        expected_binding_revision: 0,
      });
    }

    // 标记同目标键多个不同根为 ambiguous (保留核验事实，只在前端或选择时单选)
    const keyMap = new Map<string, SessionRepairCandidate[]>();
    for (const c of candidates) {
      const k = `${c.adapter_id}::${c.canonical_model_id}::${c.workspace_identity}`;
      const list = keyMap.get(k) || [];
      list.push(c);
      keyMap.set(k, list);
    }
    for (const [, list] of keyMap.entries()) {
      if (list.length > 1) {
        for (const it of list) {
          if (it.status === "verified") {
            it.status = "ambiguous";
            it.reason = "存在多个历史会话候选匹配相同目标键";
          }
        }
      }
    }

    // CW3-F17: sourceDigest 纳入模型、账号、实体版本与全部核验摘要
    const sourceDigest = createHash("sha256")
      .update(
        JSON.stringify([
          workflowId,
          workflow.version,
          controlRevision,
          candidates.map((c) => [
            c.candidate_id,
            c.conversation_id,
            c.status,
            c.workspace_root,
            c.adapter_id,
            c.canonical_model_id,
            c.provider_account_scope,
            c.client_scope_id,
            c.expected_binding_revision,
          ]),
        ]),
      )
      .digest("hex");

    return {
      workflow_id: workflowId,
      workflow_version: workflow.version,
      control_revision: controlRevision,
      source_digest: sourceDigest,
      candidates,
      writer_state: writerState,
      requires_dispatch_disabled: true,
    };
  }

  /**
   * 依据 CW2-D06 / §9.2 规范：原子应用会话修复
   */
  applyRepair(
    workflowId: string,
    input: SessionBindingRepairApplyInput,
  ): SessionBindingRepairApplyResult {
    // 幂等记录查询
    const idemKey = `repair:${workflowId}:${input.request_id}`;
    const past = this.store.get<{
      request_hash: string;
      result: SessionBindingRepairApplyResult;
    }>("idempotency_record", idemKey);
    const reqDigest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    if (past) {
      if (past.request_hash === reqDigest) {
        return { ...past.result, replayed: true };
      }
      throw new FlowError(
        "IDEMPOTENCY_CONFLICT",
        `相同 request_id (${input.request_id}) 但请求正文不一致`,
        409,
      );
    }

    const preview = this.previewRepair(workflowId, input.expected_workflow_version);

    if (input.expected_control_revision !== undefined) {
      requireCondition(
        preview.control_revision === input.expected_control_revision,
        "CONTROL_REVISION_CONFLICT",
        `调度控制版本冲突: 期望 r${input.expected_control_revision}, 当前 r${preview.control_revision}`,
        409,
      );
    }

    requireCondition(
      preview.source_digest === input.source_digest,
      "SOURCE_DIGEST_STALE",
      "修复候选列表已发生变化，请刷新后重试",
      409,
    );

    // 门禁检查：调度必须关闭且无 active/unknown writer
    const control = this.store.get<WorkflowDispatchControl>("workflow_dispatch_control", workflowId);
    requireCondition(
      control && !control.dispatch_enabled,
      "DISPATCH_NOT_DISABLED",
      "必须先停用工作流自动调度方可应用会话修复",
      409,
    );
    requireCondition(
      preview.writer_state === "idle",
      "WRITER_ACTIVE",
      `当前存在活跃或状态未知的写者 (状态: ${preview.writer_state})，禁止会话修复`,
      409,
    );

    // 防后项覆盖检查 (CW2-F15 / §9.2 第 4 项: 每目标键最多选一个根)
    const targetKeyChosen = new Set<string>();
    for (const sel of input.selections) {
      const cand = preview.candidates.find((c) => c.candidate_id === sel.candidate_id);
      requireCondition(cand, "CANDIDATE_NOT_FOUND", `未找到候选 ${sel.candidate_id}`, 400);
      const targetKey = `${cand.adapter_id}::${cand.canonical_model_id}::${cand.workspace_identity}`;
      if (targetKeyChosen.has(targetKey)) {
        throw new FlowError(
          "DUPLICATE_KEY_SELECTION",
          `同一目标键选择了多个候选根，禁止后项覆盖: ${targetKey}`,
          409,
        );
      }
      targetKeyChosen.add(targetKey);
    }

    const migrationId = `mig_repair_${Date.now()}_${createHash("md5").update(input.request_id).digest("hex").slice(0, 8)}`;
    const affectedBindingIds: string[] = [];
    const previousBindings: Array<{ keyStr: string; binding: SessionBinding | null }> = [];

    this.store.transaction(() => {
      // CW3-F18: 事务内重核 digest 与写者占用，防并发变更
      const currentPreview = this.previewRepair(workflowId, input.expected_workflow_version);
      requireCondition(
        currentPreview.source_digest === input.source_digest,
        "SOURCE_DIGEST_STALE",
        "修复候选列表已发生变化，请刷新后重试",
        409,
      );
      requireCondition(
        currentPreview.writer_state === "idle",
        "WRITER_ACTIVE",
        `当前存在活跃或状态未知的写者 (状态: ${currentPreview.writer_state})，禁止会话修复`,
        409,
      );

      for (const sel of input.selections) {
        const cand = preview.candidates.find((c) => c.candidate_id === sel.candidate_id)!;
        if (cand.status === "conflict" || cand.status === "unverifiable") {
          throw new FlowError(
            "CANDIDATE_UNAVAILABLE",
            `候选 ${cand.candidate_id} 状态为 ${cand.status}，不可应用`,
            409,
          );
        }

        const key: SessionBindingKey = {
          workflow_id: workflowId,
          adapter_id: cand.adapter_id,
          host_id: cand.host_id,
          client_scope_id: cand.client_scope_id,
          provider_account_scope: cand.provider_account_scope,
          canonical_model_id: cand.canonical_model_id,
          workspace_identity: cand.workspace_identity,
        };
        const keyStr = computeSessionBindingKey(key);
        const existing = this.store.get<SessionBinding>("session_binding", keyStr);

        // CAS 版本比较 (CW2-F13 / CW2-F15)
        if (existing) {
          if (sel.expected_binding_revision === 0) {
            throw new FlowError(
              "BINDING_ALREADY_EXISTS",
              `绑定已存在，预期 revision 为 0 冲突 (当前 r${existing.revision})`,
              409,
            );
          }
          if (sel.expected_binding_revision !== undefined && existing.revision !== sel.expected_binding_revision) {
            throw new FlowError(
              "REVISION_CONFLICT",
              `绑定版本冲突: 期望 r${sel.expected_binding_revision}, 当前 r${existing.revision}`,
              409,
            );
          }
        } else if (sel.expected_binding_revision !== 0 && sel.expected_binding_revision !== undefined) {
          throw new FlowError(
            "REVISION_CONFLICT",
            `绑定不存在，期望 r${sel.expected_binding_revision} 冲突`,
            409,
          );
        }

        previousBindings.push({ keyStr, binding: existing ? { ...existing } : null });

        const ownerKey = computeSessionOwnerKey({
          adapter_id: cand.adapter_id,
          host_id: cand.host_id,
          client_scope_id: cand.client_scope_id,
          provider_account_scope: cand.provider_account_scope,
          conversation_id: cand.conversation_id,
        });

        const existingOwner = this.store.get<{ workflow_id: string }>(
          "session_owner_index",
          ownerKey,
        );
        if (existingOwner && existingOwner.workflow_id !== workflowId) {
          throw new FlowError(
            "SESSION_ALREADY_OWNED",
            `原生会话已由任务 ${existingOwner.workflow_id} 认领`,
            409,
          );
        }

        const bindingId = existing?.id ?? id("sb");
        const binding: SessionBinding = {
          id: bindingId,
          workflow_id: workflowId,
          adapter_id: cand.adapter_id,
          host_id: cand.host_id,
          client_scope_id: cand.client_scope_id,
          provider_account_scope: cand.provider_account_scope,
          canonical_model_id: cand.canonical_model_id,
          workspace_identity: cand.workspace_identity,
          conversation_id: cand.conversation_id,
          owner_key: ownerKey,
          workspace_root: cand.workspace_root,
          source_root: cand.source_root,
          repo_id: cand.repo_id,
          revision: (existing?.revision ?? 0) + 1,
          generation: (existing?.generation ?? 0) + 1,
          state: "bound",
          created_at: existing?.created_at ?? now(),
          updated_at: now(),
          metadata: existing?.metadata ?? {},
        };

        this.store.put("session_binding", keyStr, workflowId, binding);
        this.store.put("session_binding_by_id", bindingId, workflowId, { keyStr });
        this.store.put("session_owner_index", ownerKey, workflowId, {
          owner_key: ownerKey,
          workflow_id: workflowId,
          binding_id: bindingId,
        });
        affectedBindingIds.push(bindingId);
      }

      // 保存迁移 patch 记录用于安全回滚
      const patchRecord: MigrationPatchRecord = {
        id: migrationId,
        workflow_id: workflowId,
        request_id: input.request_id,
        affected_binding_ids: affectedBindingIds,
        previous_bindings: previousBindings,
        created_at: now(),
        status: "applied",
      };
      this.store.put("session_binding_migration_patch", migrationId, workflowId, patchRecord);

      // 保存幂等记录
      const result: SessionBindingRepairApplyResult = {
        migration_id: migrationId,
        operation: "session_binding_repair",
        status: "completed",
        replayed: false,
        affected_binding_ids: affectedBindingIds,
        workflow_version: preview.workflow_version,
        control_revision: preview.control_revision,
      };
      this.store.put("idempotency_record", idemKey, workflowId, {
        request_hash: reqDigest,
        result,
      });
    });

    return {
      migration_id: migrationId,
      operation: "session_binding_repair",
      status: "completed",
      replayed: false,
      affected_binding_ids: affectedBindingIds,
      workflow_version: preview.workflow_version,
      control_revision: preview.control_revision,
    };
  }

  /**
   * 依据 CW2-D06 / §9.3 规范：安全回滚会话修复
   */
  rollbackRepair(
    workflowId: string,
    input: SessionBindingRepairRollbackInput,
  ): { status: "rolled_back"; migration_id: string; replayed?: boolean } {
    // 1. 幂等查询 (CW3-F19: 同 request 幂等回执)
    const idemKey = `rollback_repair:${workflowId}:${input.request_id}`;
    const reqDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const past = this.store.get<{ request_hash: string; result: any }>("idempotency_record", idemKey);
    if (past) {
      if (past.request_hash === reqDigest) {
        return { ...past.result, replayed: true };
      }
      throw new FlowError("IDEMPOTENCY_CONFLICT", `相同 request_id (${input.request_id}) 但请求正文不一致`, 409);
    }

    const workflow = this.store.must<Workflow>("workflow", workflowId);
    requireCondition(
      workflow.version === input.expected_workflow_version,
      "WORKFLOW_VERSION_CONFLICT",
      `工作流版本冲突: 期望 v${input.expected_workflow_version}, 当前 v${workflow.version}`,
      409,
    );

    const control = this.store.get<WorkflowDispatchControl>("workflow_dispatch_control", workflowId);
    requireCondition(
      control && !control.dispatch_enabled,
      "DISPATCH_NOT_DISABLED",
      "必须先停用工作流调度方可回滚",
      409,
    );

    // 写者状态核查
    const preview = this.previewRepair(workflowId, input.expected_workflow_version);
    requireCondition(
      preview.writer_state === "idle",
      "WRITER_ACTIVE",
      `当前存在活跃或状态未知的写者 (状态: ${preview.writer_state})，禁止会话修复回滚`,
      409,
    );

    const patch = this.store.get<MigrationPatchRecord>(
      "session_binding_migration_patch",
      input.migration_id,
    );
    requireCondition(
      patch && patch.workflow_id === workflowId,
      "MIGRATION_NOT_FOUND",
      `未找到迁移记录 ${input.migration_id}`,
      404,
    );
    requireCondition(
      patch.status !== "rolled_back",
      "ALREADY_ROLLED_BACK",
      "该迁移记录已经回滚",
      409,
    );

    // CW2-F15 / §9.3 第 1 项: expected_binding_revisions 必须精确覆盖整个 patch 的受影响集合
    requireCondition(
      Array.isArray(input.expected_binding_revisions) &&
        input.expected_binding_revisions.length === patch.affected_binding_ids.length &&
        patch.affected_binding_ids.every((id) =>
          input.expected_binding_revisions.some((r) => r.binding_id === id),
        ),
      "INVALID_REVISION_LIST",
      "回滚版本清单必须精确覆盖整个迁移 patch 的受影响绑定集合，不得为空或遗漏",
      400,
    );

    // 检查版本与是否有后续 Run
    const runs = this.store.list<Run>("run", workflowId);
    const subsequentRuns = runs.filter((r) => ((r as any).created_at || r.started_at) > patch.created_at);
    requireCondition(
      subsequentRuns.length === 0,
      "CANNOT_ROLLBACK_AFTER_NEW_RUNS",
      "迁移后已发生新的执行 Run，禁止回滚",
      409,
    );

    for (const exp of input.expected_binding_revisions) {
      const b = this.sessionStore.getBindingById(exp.binding_id);
      if (b && b.revision !== exp.revision) {
        throw new FlowError(
          "REVISION_CONFLICT",
          `绑定 ${exp.binding_id} 版本已漂移 (当前 r${b.revision}, 期望 r${exp.revision})，禁止回滚`,
          409,
        );
      }
    }

    const res = { status: "rolled_back" as const, migration_id: input.migration_id };

    this.store.transaction(() => {
      for (const prev of patch.previous_bindings) {
        const curr = this.store.get<SessionBinding>("session_binding", prev.keyStr);
        if (prev.binding) {
          // CW3-F19: 回退版本必须严格大于当前值与历史值，杜绝复用旧CAS版本
          const currentRev = curr ? curr.revision : prev.binding.revision;
          const nextRevision = Math.max(currentRev, prev.binding.revision) + 1;
          const restored: SessionBinding = {
            ...prev.binding,
            revision: nextRevision,
            generation: (curr?.generation ?? prev.binding.generation) + 1,
            updated_at: now(),
          };
          this.store.put("session_binding", prev.keyStr, workflowId, restored);
          this.store.put("session_binding_by_id", restored.id, workflowId, { keyStr: prev.keyStr });
          if (curr?.owner_key && curr.owner_key !== restored.owner_key) {
            this.store.remove("session_owner_index", curr.owner_key);
          }
          if (restored.owner_key) {
            this.store.put("session_owner_index", restored.owner_key, workflowId, {
              owner_key: restored.owner_key,
              workflow_id: workflowId,
              binding_id: restored.id,
            });
          }
        } else {
          // 原本不存在，清理创建的绑定和索引
          if (curr) {
            this.store.remove("session_binding", prev.keyStr);
            this.store.remove("session_binding_by_id", curr.id);
            if (curr.owner_key) {
              this.store.remove("session_owner_index", curr.owner_key);
            }
          }
        }
      }

      patch.status = "rolled_back";
      this.store.put("session_binding_migration_patch", input.migration_id, workflowId, patch);
      this.store.put("idempotency_record", idemKey, workflowId, {
        request_hash: reqDigest,
        result: res,
      });
    });

    return res;
  }
}
