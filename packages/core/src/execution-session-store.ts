import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";
import type { Store } from "../../store/src/store.js";
import {
  type SessionBinding,
  type SessionBindingKey,
  type SessionBindingState,
  type SessionBindingAdoptInput,
  computeSessionBindingKey,
  computeSessionOwnerKey,
  SessionBindingSchema,
} from "../../contracts/src/session-binding.js";
import { FlowError, requireCondition, type Workspace, type Workflow } from "../../contracts/src/index.js";
import { id, now } from "./util.js";
import { confirmedBindingComparator, recordNativeConfirmation } from "./session-binding-recency.js";

export class ExecutionSessionStore {
  constructor(private store: Store) {}

  /**
   * 按复用键查询或创建初始保留绑定 (reserved)
   */
  getOrCreateBinding(
    key: SessionBindingKey,
    context: {
      workspace_root: string;
      source_root: string;
      repo_id: string;
      native_project_id?: string;
    },
  ): SessionBinding {
    const keyStr = computeSessionBindingKey(key);
    const existing = this.store.get<SessionBinding>("session_binding", keyStr);
    if (existing?.state !== "bound") this.assertNoPendingClientScopeRepair(key);
    if (existing) {
      return existing;
    }

    const newBinding: SessionBinding = {
      id: id("sb"),
      workflow_id: key.workflow_id,
      adapter_id: key.adapter_id,
      host_id: key.host_id,
      client_scope_id: key.client_scope_id,
      provider_account_scope: key.provider_account_scope,
      canonical_model_id: key.canonical_model_id,
      workspace_identity: key.workspace_identity,
      conversation_id: "", // 初始待绑定
      native_project_id: context.native_project_id,
      workspace_root: context.workspace_root,
      source_root: context.source_root,
      repo_id: context.repo_id,
      revision: 1,
      generation: 1,
      state: "reserved",
      created_at: now(),
      updated_at: now(),
      metadata: {},
    };

    this.store.put("session_binding", keyStr, key.workflow_id, newBinding);
    // 同时以 binding.id 为索引写入快速反查
    this.store.put("session_binding_by_id", newBinding.id, key.workflow_id, {
      keyStr,
    });

    return newBinding;
  }

  /**
   * 按复用键查询已有绑定
   */
  getBinding(key: SessionBindingKey): SessionBinding | undefined {
    const keyStr = computeSessionBindingKey(key);
    return this.store.get<SessionBinding>("session_binding", keyStr);
  }

  /**
   * 按 binding_id 查询绑定
   */
  getBindingById(bindingId: string): SessionBinding | undefined {
    const index = this.store.get<{ keyStr: string }>(
      "session_binding_by_id",
      bindingId,
    );
    if (!index) return undefined;
    return this.store.get<SessionBinding>("session_binding", index.keyStr);
  }

  /**
   * 列出指定任务下的所有绑定
   */
  listBindings(workflowId: string): SessionBinding[] {
    return this.store.list<SessionBinding>("session_binding", workflowId);
  }

  /** Keep the persisted model keys; select confirmed roots independently of model. */
  findReusableBinding(key: SessionBindingKey, preferredNativeId?: string): SessionBinding | undefined {
    const candidates = this.listBindings(key.workflow_id).filter(binding =>
      binding.state === "bound" && !!binding.conversation_id &&
      binding.adapter_id === key.adapter_id && binding.host_id === key.host_id &&
      binding.client_scope_id === key.client_scope_id &&
      binding.provider_account_scope === key.provider_account_scope &&
      binding.workspace_identity === key.workspace_identity &&
      (!binding.latest_run_id || this.store.get<{ purpose?: string }>("run", binding.latest_run_id)?.purpose !== "aside"));
    const preferred = preferredNativeId && candidates.find(binding => binding.conversation_id === preferredNativeId);
    const selected = preferred || candidates.sort(confirmedBindingComparator(this.store, key.workflow_id))[0];
    if (!selected) this.assertNoPendingClientScopeRepair(key);
    if (selected?.conversation_id) {
      this.assertNativeOwner(selected, selected.conversation_id);
    }
    return selected;
  }

  private assertNoPendingClientScopeRepair(key: SessionBindingKey): void {
    if (process.platform === "win32" || !isAbsolute(key.client_scope_id)) return;
    const pending = this.listBindings(key.workflow_id).some(binding =>
      binding.state === "bound" && !!binding.conversation_id &&
      binding.adapter_id === key.adapter_id && binding.host_id === key.host_id &&
      binding.workspace_identity === key.workspace_identity &&
      isAbsolute(binding.client_scope_id) &&
      binding.client_scope_id !== key.client_scope_id &&
      binding.client_scope_id === key.client_scope_id.toLowerCase());
    requireCondition(!pending, "SESSION_BINDING_REPAIR_REQUIRED",
      "原会话的配置路径大小写尚未确认，请通过会话修复预览并确认；保留原会话，禁止自动新建替代根", 409);
  }

  /** A legacy lower-case owner cannot silently become an unowned native root. */
  assertNativeOwner(key: SessionBindingKey, conversationId: string): void {
    const owner = this.store.get<{ workflow_id: string }>("session_owner_index",
      computeSessionOwnerKey({ ...key, conversation_id: conversationId }));
    requireCondition(!owner || owner.workflow_id === key.workflow_id,
      "SESSION_ALREADY_OWNED", "原生会话已由其他任务认领", 409);
    const legacyScope = key.client_scope_id.toLowerCase();
    if (process.platform === "win32" || !isAbsolute(key.client_scope_id) || legacyScope === key.client_scope_id) return;
    const legacyOwner = this.store.get<{ workflow_id: string }>("session_owner_index",
      computeSessionOwnerKey({ ...key, client_scope_id: legacyScope, conversation_id: conversationId }));
    if (!legacyOwner) return;
    let sameDirectory: boolean | undefined;
    try {
      const current = statSync(key.client_scope_id, { bigint: true });
      const legacy = statSync(legacyScope, { bigint: true });
      if (current.isDirectory() && legacy.isDirectory() && current.ino > 0n && legacy.ino > 0n)
        sameDirectory = current.dev === legacy.dev && current.ino === legacy.ino;
    } catch { /* Unreadable identity remains unknown; never expose filesystem errors. */ }
    if (sameDirectory === false) return; // Real distinct POSIX homes stay distinct.
    requireCondition(sameDirectory !== undefined, "SESSION_BINDING_REPAIR_REQUIRED",
      "原会话配置目录归属尚未确认，请核对原目录并通过会话修复；禁止自动认领替代根", 409);
    requireCondition(legacyOwner.workflow_id === key.workflow_id,
      "SESSION_ALREADY_OWNED", "原生会话已由其他任务认领", 409);
    requireCondition(!!owner, "SESSION_BINDING_REPAIR_REQUIRED",
      "原会话的配置路径大小写尚未确认，请通过会话修复预览并确认；保留原会话，禁止自动新建替代根", 409);
  }

  /** A confirmed missing native root is archived; its history is never overwritten. */
  reserveAfterMissingRoot(key: SessionBindingKey, nativeId: string): SessionBinding {
    return this.store.transaction(() => {
      const context = this.getBinding(key) ?? this.listBindings(key.workflow_id).find(b =>
        b.adapter_id === key.adapter_id && b.conversation_id === nativeId);
      for (const binding of this.listBindings(key.workflow_id).filter(b =>
        b.adapter_id === key.adapter_id && b.client_scope_id === key.client_scope_id &&
        b.host_id === key.host_id && b.provider_account_scope === key.provider_account_scope &&
        b.workspace_identity === key.workspace_identity && b.conversation_id === nativeId && b.state === "bound"))
        this.updateBindingState(binding.id, binding.revision, "unavailable");
      const keyStr = computeSessionBindingKey(key);
      const previous = this.getBinding(key);
      if (previous?.conversation_id) {
        const archiveKey = "retired:" + previous.id;
        this.store.put("session_binding", archiveKey, key.workflow_id, { ...previous, state: "retired", revision: previous.revision + 1, updated_at: now() });
        this.store.put("session_binding_by_id", previous.id, key.workflow_id, { keyStr: archiveKey });
        this.store.remove("session_binding", keyStr);
      }
      return this.getOrCreateBinding(key, {
        workspace_root: context?.workspace_root ?? "", source_root: context?.source_root ?? "",
        repo_id: context?.repo_id ?? "primary",
      });
    });
  }

  /**
   * 首次 CLI 结构化 init 确认 conversationId 时立即持久化保存（不等整轮成功）
   * 根 ID 一旦确认不可直接被其他不同 ID 覆写
   */
  bindConversationId(
    bindingId: string,
    conversationId: string,
    runId: string,
    nativeProjectId?: string,
  ): SessionBinding {
    requireCondition(
      typeof conversationId === "string" && !!conversationId.trim(),
      "INVALID_CONVERSATION_ID",
      "会话 ID 不能为空",
      400,
    );

    return this.store.transaction(() => {
      const index = this.store.get<{ keyStr: string }>(
        "session_binding_by_id",
        bindingId,
      );
      if (!index) {
        throw new FlowError("BINDING_NOT_FOUND", `会话绑定 ${bindingId} 不存在`, 404);
      }

      const current = this.store.must<SessionBinding>(
        "session_binding",
        index.keyStr,
      );

      // 防覆写检查：如果已有根 ID，且与传入的新 ID 不一致，禁止静默覆盖
      if (current.conversation_id && current.conversation_id !== conversationId) {
        throw new FlowError(
          "CONVERSATION_ROOT_IMMUTABLE",
          `已有会话根 ID (${current.conversation_id}) 不可被新 ID (${conversationId}) 覆盖`,
          409,
        );
      }

      this.assertNativeOwner(current, conversationId);

      // 相同会话 ID 确认幂等，不重复递增 revision (CW2-D05 / CW3-F03)
      if (current.conversation_id === conversationId) {
        if (current.latest_run_id === runId) return current;
        const observed: SessionBinding = {
          ...current,
          latest_run_id: runId,
          updated_at: now(),
        };
        this.store.put("session_binding", index.keyStr, current.workflow_id, observed);
        recordNativeConfirmation(this.store, observed);
        return observed;
      }

      // 跨任务原生根所有权互斥检查 (CW-D00 / CW-D07)
      const ownerKey = computeSessionOwnerKey({
        adapter_id: current.adapter_id,
        host_id: current.host_id,
        client_scope_id: current.client_scope_id,
        provider_account_scope: current.provider_account_scope,
        conversation_id: conversationId,
      });
      const updated: SessionBinding = {
        ...current,
        conversation_id: conversationId,
        owner_key: ownerKey,
        native_project_id: nativeProjectId ?? current.native_project_id,
        state: "bound",
        first_run_id: current.first_run_id ?? runId,
        latest_run_id: runId,
        revision: current.revision + 1,
        updated_at: now(),
      };

      this.store.put("session_binding", index.keyStr, current.workflow_id, updated);
      recordNativeConfirmation(this.store, updated);
      this.store.put("session_owner_index", ownerKey, current.workflow_id, {
        owner_key: ownerKey,
        workflow_id: current.workflow_id,
        binding_id: updated.id,
      });
      return updated;
    });
  }

  /**
   * 接管外部已有合法 CLI 会话 (adopt)
   * 依据 CW2-D06 / CW3-F16 规范：外部 DTO 严格受限，workflowId 来自路由，服务端权威解析工作区与身份
   */
  adoptExistingSession(
    workflowId: string,
    input: SessionBindingAdoptInput,
    options?: {
      workspace_root?: string;
      source_root?: string;
      repo_id?: string;
      adapter_id?: string;
      host_id?: string;
      client_scope_id?: string;
      provider_account_scope?: string;
      canonical_model_id?: string;
      workspace_identity?: string;
      expected_workflow_version?: number;
      expected_control_revision?: number;
    },
  ): SessionBinding {
    const idemKey = `adopt_${workflowId}_${input.request_id}`;
    const reqDigest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");

    const existingIdem = this.store.get<{
      request_hash: string;
      result: SessionBinding;
    }>("idempotency_record", idemKey);

    if (existingIdem) {
      if (existingIdem.request_hash === reqDigest) {
        return existingIdem.result;
      }
      throw new FlowError(
        "IDEMPOTENCY_CONFLICT",
        `相同 request_id (${input.request_id}) 但请求正文不一致`,
        409,
      );
    }

    // CW3-F16: 严格核验 workspace_id 必须属于当前 workflow，禁止跨任务越权
    const ws = this.store
      .list<Workspace>("workspace", workflowId)
      .find((w) => w.id === input.workspace_id);
    requireCondition(ws, "WORKSPACE_NOT_FOUND", `未找到属于当前任务的工作区: ${input.workspace_id}`, 404);

    const workspaceRoot = options?.workspace_root || ws.root;
    const sourceRoot = options?.source_root || ws.source_root || ws.root;
    const repoId = options?.repo_id || ws.repo_id || "main";

    // CW3-F16 / CW4-F05: 严格核验真实会话身份，禁止使用假 default 或硬编码兜底
    const adapterId = options?.adapter_id;
    const canonicalModelId = options?.canonical_model_id;
    const hostId = options?.host_id;
    const clientScopeId = options?.client_scope_id;
    const providerAccountScope = options?.provider_account_scope;
    const workspaceIdentity = options?.workspace_identity;

    requireCondition(
      adapterId && canonicalModelId && canonicalModelId !== "default" &&
        hostId && clientScopeId && workspaceIdentity && providerAccountScope &&
        providerAccountScope !== "default" && providerAccountScope !== "default-account",
      "IDENTITY_UNVERIFIED",
      "会话身份缺少真实工具、模型、主机、配置域、账号或工作区，禁止接管",
      400,
    );

    const key: SessionBindingKey = {
      workflow_id: workflowId,
      adapter_id: adapterId,
      host_id: hostId,
      client_scope_id: clientScopeId,
      provider_account_scope: providerAccountScope,
      canonical_model_id: canonicalModelId,
      workspace_identity: workspaceIdentity,
    };

    const keyStr = computeSessionBindingKey(key);

    const ownerKey = computeSessionOwnerKey({
      adapter_id: key.adapter_id,
      host_id: key.host_id,
      client_scope_id: key.client_scope_id,
      provider_account_scope: key.provider_account_scope,
      conversation_id: input.conversation_id,
    });

    let binding!: SessionBinding;

    // CW2-D06 / CW3-F16: 整个版本校验、所有权互斥及写入必须在同一原子事务内执行
    this.store.transaction(() => {
      // 1. 校验 workflow 版本
      if (options?.expected_workflow_version !== undefined) {
        const wf = this.store.get<Workflow>("workflow", workflowId);
        if (wf && wf.version !== options.expected_workflow_version) {
          throw new FlowError(
            "VERSION_CONFLICT",
            `工作流版本冲突: 期望 v${options.expected_workflow_version}, 当前 v${wf.version}`,
            409,
          );
        }
      }

      // 2. 校验调度控制版本
      if (options?.expected_control_revision !== undefined) {
        const ctrl = this.store.get<any>("workflow_dispatch_control", workflowId);
        if (ctrl && ctrl.revision !== options.expected_control_revision) {
          throw new FlowError(
            "REVISION_CONFLICT",
            `控制版本冲突: 期望 r${options.expected_control_revision}, 当前 r${ctrl.revision}`,
            409,
          );
        }
      }

      // 3. 事务内重读 existing session_binding 并进行 CAS 版本检查
      const existing = this.store.get<SessionBinding>("session_binding", keyStr);

      if (existing) {
        if (input.expected_binding_revision === 0) {
          throw new FlowError(
            "BINDING_ALREADY_EXISTS",
            `会话绑定已存在，期望 revision 为 0 冲突 (当前 r${existing.revision})`,
            409,
          );
        }
        if (
          input.expected_binding_revision !== undefined &&
          existing.revision !== input.expected_binding_revision
        ) {
          throw new FlowError(
            "REVISION_CONFLICT",
            `绑定版本冲突: 期望 r${input.expected_binding_revision}, 当前 r${existing.revision}`,
            409,
          );
        }
      } else {
        if (
          input.expected_binding_revision !== undefined &&
          input.expected_binding_revision > 0
        ) {
          throw new FlowError(
            "REVISION_CONFLICT",
            `绑定版本冲突: 期望 r${input.expected_binding_revision}, 但绑定尚不存在`,
            409,
          );
        }
      }

      if (existing && existing.conversation_id && existing.conversation_id !== input.conversation_id) {
        throw new FlowError(
          "SESSION_ADOPT_CONFLICT",
          `当前工作流与模型已绑定其他会话 (${existing.conversation_id})，不能直接偷换为 ${input.conversation_id}`,
          409,
        );
      }

      // 4. 事务内重读 session_owner_index 进行跨任务根所有权互斥检查
      this.assertNativeOwner(key, input.conversation_id);

      const bindingId = existing?.id ?? id("sb");
      binding = {
        id: bindingId,
        workflow_id: key.workflow_id,
        adapter_id: key.adapter_id,
        host_id: key.host_id,
        client_scope_id: key.client_scope_id,
        provider_account_scope: key.provider_account_scope,
        canonical_model_id: key.canonical_model_id,
        workspace_identity: key.workspace_identity,
        conversation_id: input.conversation_id,
        owner_key: ownerKey,
        workspace_root: existing?.workspace_root || workspaceRoot,
        source_root: existing?.source_root || sourceRoot,
        repo_id: existing?.repo_id || repoId,
        revision: (existing?.revision ?? 0) + 1,
        generation: (existing?.generation ?? 0) + 1,
        state: "bound",
        created_at: existing?.created_at ?? now(),
        updated_at: now(),
        metadata: existing?.metadata ?? {},
      };

      this.store.put("session_binding", keyStr, key.workflow_id, binding);
      recordNativeConfirmation(this.store, binding);
      this.store.put("session_binding_by_id", binding.id, key.workflow_id, {
        keyStr,
      });
      this.store.put("session_owner_index", ownerKey, key.workflow_id, {
        owner_key: ownerKey,
        workflow_id: key.workflow_id,
        binding_id: binding.id,
      });
      this.store.put("idempotency_record", idemKey, key.workflow_id, {
        request_hash: reqDigest,
        result: binding,
      });
    });

    return binding;
  }

  /**
   * CAS 更新绑定状态 (reserved / bound / needs_reconcile / unavailable / retired)
   */
  updateBindingState(
    bindingId: string,
    expectedRevision: number,
    nextState: SessionBindingState,
  ): SessionBinding {
    const index = this.store.get<{ keyStr: string }>(
      "session_binding_by_id",
      bindingId,
    );
    if (!index) {
      throw new FlowError("BINDING_NOT_FOUND", `会话绑定 ${bindingId} 不存在`, 404);
    }

    const current = this.store.must<SessionBinding>(
      "session_binding",
      index.keyStr,
    );

    if (current.revision !== expectedRevision) {
      throw new FlowError(
        "BINDING_CAS_CONFLICT",
        `绑定版本冲突：期望版本 ${expectedRevision}，当前版本 ${current.revision}`,
        409,
      );
    }

    const updated: SessionBinding = {
      ...current,
      state: nextState,
      revision: current.revision + 1,
      updated_at: now(),
    };

    this.store.put("session_binding", index.keyStr, current.workflow_id, updated);
    return updated;
  }

  /**
   * 子 Agent 会话隔离保护：判断传入的 conversation_id 是否为该主会话的子会话
   * 确保子 Agent 事件不覆盖主会话根 ID
   */
  isSubagentSession(binding: SessionBinding, incomingConversationId: string): boolean {
    if (!binding.conversation_id) return false;
    return (
      !!incomingConversationId &&
      incomingConversationId.trim() !== "" &&
      incomingConversationId !== binding.conversation_id
    );
  }
}
