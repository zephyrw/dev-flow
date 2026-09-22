import type { Store } from "../../store/src/store.js";
import { ExecutionSessionStore } from "../../core/src/execution-session-store.js";
import type { ProcessManager } from "../../process/src/manager.js";
import {
  FlowError,
  requireCondition,
  type CliDispatchRecord,
  type WorkflowDispatchControl,
  type DispatchControlReason,
  type DispatchControlReasonItem,
  type Run,
} from "../../contracts/src/index.js";
import { now } from "../../core/src/util.js";

export { CliDispatchRecord };

export interface DispatchControlState {
  workflow_id: string;
  revision: number;
  dispatch_enabled: boolean;
  writer_state: "idle" | "active" | "unknown";
  reasons: DispatchControlReasonItem[];
  paused_reason?: string;
  reason?: string;
  updated_at: string;
}

export interface InvocationOccupancy {
  state: "idle" | "active" | "unknown";
  active_dispatch_id?: string;
  has_active_runner: boolean;
  writer_count: number;
}

export class CliDispatchManager {
  private sessionStore: ExecutionSessionStore;

  constructor(
    private store: Store,
    private processManager?: ProcessManager,
  ) {
    this.sessionStore = new ExecutionSessionStore(store);
  }

  /**
   * 获取工作流持久化自动调度开关 (CAS 单调 revision)
   * dispatch_enabled 由明确原因集合导出 (CW2-D04 / §7 第 7 项)
   */
  getDispatchControl(workflowId: string): DispatchControlState {
    const record = this.store.get<WorkflowDispatchControl>(
      "workflow_dispatch_control",
      workflowId,
    );
    if (record) {
      let reasons = record.reasons ?? [];
      // 兼容旧记录：若 dispatch_enabled=false 但无原因集合，保守映射为 user_disabled
      if (!record.dispatch_enabled && reasons.length === 0) {
        reasons = [
          {
            reason: "user_disabled" as const,
            created_at: record.updated_at,
            message: record.paused_reason || record.reason || "用户停用自动调度",
          },
        ];
      }
      const effectiveEnabled = reasons.length === 0;
      return {
        workflow_id: record.workflow_id,
        revision: record.revision ?? 1,
        dispatch_enabled: effectiveEnabled,
        writer_state: record.writer_state ?? "idle",
        reasons,
        paused_reason: record.paused_reason,
        reason: record.reason,
        updated_at: record.updated_at,
      };
    }
    return {
      workflow_id: workflowId,
      revision: 1,
      dispatch_enabled: true,
      writer_state: "idle",
      reasons: [],
      updated_at: now(),
    };
  }

  /**
   * 添加禁止派发原因 (CAS 版本控制事务)
   */
  addControlReason(
    workflowId: string,
    reasonItem: Omit<DispatchControlReasonItem, "created_at"> & { created_at?: string },
    expectedRevision?: number,
  ): DispatchControlState {
    return this.store.transaction(() => {
      const current = this.getDispatchControl(workflowId);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new FlowError(
          "REVISION_CONFLICT",
          `调度控制版本冲突: 期望 r${expectedRevision}, 当前 r${current.revision}`,
          409,
        );
      }
      const fullItem: DispatchControlReasonItem = {
        ...reasonItem,
        created_at: reasonItem.created_at ?? now(),
      };
      const filteredReasons = current.reasons.filter((r) => {
        if (fullItem.reason === "migration" && r.reason === "migration") {
          return r.migration_id !== fullItem.migration_id;
        }
        return r.reason !== fullItem.reason;
      });
      const updatedReasons = [...filteredReasons, fullItem];
      const nextRevision = current.revision + 1;

      const updated: WorkflowDispatchControl = {
        workflow_id: workflowId,
        revision: nextRevision,
        dispatch_enabled: false,
        writer_state: current.writer_state,
        reasons: updatedReasons,
        paused_reason: reasonItem.message ?? current.paused_reason,
        reason: reasonItem.message ?? current.reason,
        updated_at: now(),
      };
      this.store.put(
        "workflow_dispatch_control",
        workflowId,
        workflowId,
        updated,
      );
      return {
        ...updated,
        reasons: updatedReasons,
      };
    });
  }

  /**
   * 移除特定禁止派发原因 (CAS 版本控制事务)
   */
  removeControlReason(
    workflowId: string,
    reason: DispatchControlReason,
    filter?: { migration_id?: string },
    expectedRevision?: number,
  ): DispatchControlState {
    return this.store.transaction(() => {
      const current = this.getDispatchControl(workflowId);
      if (expectedRevision !== undefined && current.revision !== expectedRevision) {
        throw new FlowError(
          "REVISION_CONFLICT",
          `调度控制版本冲突: 期望 r${expectedRevision}, 当前 r${current.revision}`,
          409,
        );
      }
      const updatedReasons = current.reasons.filter((r) => {
        if (r.reason !== reason) return true;
        if (reason === "migration" && filter?.migration_id) {
          return r.migration_id !== filter.migration_id;
        }
        return false;
      });

      const nextRevision = current.revision + 1;
      const effectiveEnabled = updatedReasons.length === 0;

      const updated: WorkflowDispatchControl = {
        workflow_id: workflowId,
        revision: nextRevision,
        dispatch_enabled: effectiveEnabled,
        writer_state: current.writer_state,
        reasons: updatedReasons,
        paused_reason: effectiveEnabled ? undefined : current.paused_reason,
        reason: effectiveEnabled ? undefined : current.reason,
        updated_at: now(),
      };
      this.store.put(
        "workflow_dispatch_control",
        workflowId,
        workflowId,
        updated,
      );
      return {
        ...updated,
        reasons: updatedReasons,
      };
    });
  }

  /**
   * 修改调度控制开关 (通过原因集合统一维护，带 CAS 版本检查与幂等回执)
   */
  setDispatchControl(
    input:
      | {
          workflowId: string;
          dispatch_enabled: boolean;
          reason?: string;
          request_id?: string;
          expected_control_revision?: number;
        }
      | string,
    legacyEnabled?: boolean,
    legacyReason?: string,
    legacyExpectedRevision?: number,
  ): DispatchControlState & { replayed?: boolean } {
    const options =
      typeof input === "string"
        ? {
            workflowId: input,
            dispatch_enabled: !!legacyEnabled,
            reason: legacyReason,
            expected_control_revision: legacyExpectedRevision,
          }
        : input;

    const { workflowId, dispatch_enabled, reason, request_id, expected_control_revision } =
      options;

    // CW2-F12 / CW3-F06: 同请求重放幂等查询先于首次版本检查
    if (request_id) {
      const receipt = this.store.get<{
        request_id: string;
        result: DispatchControlState;
      }>("control_receipt", request_id);
      if (receipt) {
        return {
          ...receipt.result,
          replayed: true,
        };
      }
    }

    return this.store.transaction(() => {
      let res: DispatchControlState;
      if (!dispatch_enabled) {
        res = this.addControlReason(
          workflowId,
          {
            reason: "user_disabled",
            created_at: now(),
            message: reason ?? "用户手动停用自动调度",
          },
          expected_control_revision,
        );
      } else {
        // 用户开启调度仅解除 user_disabled 原因，保留其他原因
        res = this.removeControlReason(
          workflowId,
          "user_disabled",
          undefined,
          expected_control_revision,
        );
      }

      if (request_id) {
        this.store.put("control_receipt", request_id, workflowId, {
          request_id,
          result: res,
          created_at: now(),
        });
      }

      return {
        ...res,
        replayed: false,
      };
    });
  }

  /**
   * 依据 CW2-D04 规范：检查是否满足派发资格
   */
  checkDispatchEligibility(
    workflowId: string,
    options?: { excludeDispatchId?: string; excludeRunId?: string } | string,
  ): { allowed: boolean; reason?: string } {
    const control = this.getDispatchControl(workflowId);
    if (!control.dispatch_enabled) {
      const reasonMessages = control.reasons.map((r) => r.message || r.reason).join("; ");
      return {
        allowed: false,
        reason: reasonMessages || control.paused_reason || "当前禁止自动派发",
      };
    }
    const occupancy = this.readInvocationOccupancy(workflowId, options);
    if (occupancy.state !== "idle") {
      return {
        allowed: false,
        reason: `当前存在未结束的受管调用或状态未知 (状态: ${occupancy.state})`,
      };
    }
    return { allowed: true };
  }

  canDispatch(workflowId: string): { allowed: boolean; reason?: string } {
    return this.checkDispatchEligibility(workflowId);
  }

  /**
   * 依据 CW2-D04 / CW3-F01 规范：登记一次准备启动的受管 CLI 调用 (prepared 阶段)
   */
  prepareDispatch(options: {
    dispatchId: string;
    workflowId: string;
    runId: string;
    bindingId?: string;
    expectedConversationId?: string;
    hostId?: string;
    strategy?: "unified" | "legacy";
    controlRevision?: number;
    legacySourceRef?: string;
    sourceEntityVersion?: number;
    resolvedIdentity?: Record<string, unknown>;
  }): CliDispatchRecord {
    const existing = this.store.get<CliDispatchRecord>(
      "cli_dispatch_record",
      options.dispatchId,
    );
    if (existing) {
      return existing;
    }

    const check = this.checkDispatchEligibility(options.workflowId, {
      excludeDispatchId: options.dispatchId,
      excludeRunId: options.runId,
    });
    if (!check.allowed) {
      throw new FlowError(
        "DISPATCH_DISABLED",
        `工作流 ${options.workflowId} 当前禁止自动派发: ${check.reason}`,
        409,
      );
    }

    const control = this.getDispatchControl(options.workflowId);
    const record: CliDispatchRecord = {
      id: options.dispatchId,
      dispatch_id: options.dispatchId,
      workflow_id: options.workflowId,
      run_id: options.runId,
      control_revision: options.controlRevision ?? control.revision,
      expected_conversation_id: options.expectedConversationId,
      host_id: options.hostId ?? "local",
      process_identity: {},
      state: "prepared",
      event_cursor: 0,
      strategy: options.strategy ?? "unified",
      binding_id: options.bindingId,
      legacy_source_ref: options.legacySourceRef,
      source_entity_version: options.sourceEntityVersion,
      resolved_identity: options.resolvedIdentity,
      created_at: now(),
      updated_at: now(),
    };

    this.store.put(
      "cli_dispatch_record",
      options.dispatchId,
      options.workflowId,
      record,
    );
    return record;
  }

  /**
   * 依据 CW2-D04 / CW3-F02 规范：认领启动 (starting 阶段，带版本 CAS 事务)
   */
  claimStarting(
    dispatchId: string,
    options?: {
      processIdentity?: { pid?: number; started_at?: string; host?: string };
      expectedRunId?: string;
      expectedControlRevision?: number;
      expectedBindingRevision?: number;
    } | { pid?: number; started_at?: string; host?: string },
  ): CliDispatchRecord {
    const processIdentity =
      options && "pid" in options ? options : (options as any)?.processIdentity;
    const expectedRunId =
      options && "expectedRunId" in options ? (options as any).expectedRunId : undefined;
    const expectedControlRevision =
      options && "expectedControlRevision" in options
        ? (options as any).expectedControlRevision
        : undefined;
    const expectedBindingRevision =
      options && "expectedBindingRevision" in options
        ? (options as any).expectedBindingRevision
        : undefined;

    return this.store.transaction(() => {
      const record = this.store.must<CliDispatchRecord>(
        "cli_dispatch_record",
        dispatchId,
      );

      requireCondition(
        record.state === "prepared",
        "INVALID_DISPATCH_STATE",
        `只有 prepared 状态的派发可以 claim 启动，当前状态: ${record.state}`,
        409,
      );

      if (expectedRunId && record.run_id !== expectedRunId) {
        throw new FlowError(
          "RUN_ID_MISMATCH",
          `派发所属 Run ID 不匹配: 期望 ${expectedRunId}, 实际 ${record.run_id}`,
          409,
        );
      }

      // 重新确认开关未在此期间被关闭 (CW2-D04 / §7 第 3 项: 准备参数期间开关变化在最后 claim 被拦)
      const control = this.getDispatchControl(record.workflow_id);
      if (expectedControlRevision !== undefined && control.revision !== expectedControlRevision) {
        throw new FlowError(
          "CONTROL_REVISION_MISMATCH",
          `调度控制版本冲突: 期望 r${expectedControlRevision}, 当前 r${control.revision}`,
          409,
        );
      }

      if (!control.dispatch_enabled) {
        const reasonMessages = control.reasons.map((r) => r.message || r.reason).join("; ");
        throw new FlowError(
          "DISPATCH_DISABLED",
          `派发已被拦截: ${reasonMessages || control.paused_reason || "自动调度已停用"}`,
          409,
        );
      }

      if (expectedBindingRevision !== undefined && record.binding_id) {
        const binding = this.sessionStore.getBindingById(record.binding_id);
        if (binding && binding.revision !== expectedBindingRevision) {
          throw new FlowError(
            "BINDING_REVISION_MISMATCH",
            `会话绑定版本冲突: 期望 r${expectedBindingRevision}, 当前 r${binding.revision}`,
            409,
          );
        }
      }

      const otherOccupancy = this.readInvocationOccupancy(record.workflow_id, {
        excludeDispatchId: dispatchId,
        excludeRunId: record.run_id,
      });
      if (otherOccupancy.state !== "idle") {
        throw new FlowError(
          "WRITER_BUSY",
          `派发已被拦截: 当前存在其他未结束的受管调用 (状态: ${otherOccupancy.state})`,
          409,
        );
      }

      const updated: CliDispatchRecord = {
        ...record,
        state: "starting",
        process_identity: {
          ...record.process_identity,
          ...processIdentity,
          started_at: processIdentity?.started_at ?? now(),
        },
        updated_at: now(),
      };
      this.store.put(
        "cli_dispatch_record",
        dispatchId,
        record.workflow_id,
        updated,
      );
      return updated;
    });
  }

  markStarting(dispatchId: string, pid?: number): CliDispatchRecord {
    return this.claimStarting(dispatchId, { pid });
  }

  /**
   * 依据 CW2-D04 规范：收到进程启动事实转为 running
   */
  observeProcess(
    dispatchId: string,
    processIdentity: { pid?: number; host?: string },
  ): CliDispatchRecord {
    const record = this.store.must<CliDispatchRecord>(
      "cli_dispatch_record",
      dispatchId,
    );
    const updated: CliDispatchRecord = {
      ...record,
      state: "running",
      process_identity: {
        ...record.process_identity,
        ...processIdentity,
      },
      updated_at: now(),
    };
    this.store.put(
      "cli_dispatch_record",
      dispatchId,
      record.workflow_id,
      updated,
    );
    return updated;
  }

  /**
   * 持久化根会话初始化事实
   */
  observeRootInit(
    dispatchId: string,
    observedConversationId: string,
  ): void {
    if (!observedConversationId || !observedConversationId.trim()) return;

    const dispatch = this.store.get<CliDispatchRecord>(
      "cli_dispatch_record",
      dispatchId,
    );
    if (!dispatch || !dispatch.binding_id) return;

    const binding = this.sessionStore.getBindingById(dispatch.binding_id);
    if (!binding) return;

    if (!binding.conversation_id) {
      this.sessionStore.bindConversationId(
        binding.id,
        observedConversationId,
        dispatch.run_id,
      );
      return;
    }

    if (this.sessionStore.isSubagentSession(binding, observedConversationId)) {
      return;
    }
  }

  onObservedConversationId(dispatchId: string, observedConversationId: string): void {
    this.observeRootInit(dispatchId, observedConversationId);
  }

  /**
   * 依据 CW2-D04 / CW3-F02 规范：完成并持久化调用结果与退出码
   */
  finishDispatch(
    dispatchId: string,
    result: { exitCode: number | null; error?: string; resultId?: string },
  ): CliDispatchRecord {
    return this.store.transaction(() => {
      const record = this.store.must<CliDispatchRecord>(
        "cli_dispatch_record",
        dispatchId,
      );
      const isCompleted = typeof result.exitCode === "number" && result.exitCode === 0 && !result.error;
      const finalState = isCompleted
        ? "completed"
        : (result.exitCode === null ? "needs_reconcile" : "interrupted");
      const updated: CliDispatchRecord = {
        ...record,
        state: finalState,
        exit_code: typeof result.exitCode === "number" ? result.exitCode : undefined,
        error: result.error ?? (isCompleted ? undefined : "进程异常退出或未提供退出码"),
        result_id: result.resultId ?? record.result_id,
        updated_at: now(),
      };
      this.store.put(
        "cli_dispatch_record",
        dispatchId,
        record.workflow_id,
        updated,
      );
      return updated;
    });
  }

  markCompleted(dispatchId: string, exitCode: number, error?: string): CliDispatchRecord {
    return this.finishDispatch(dispatchId, { exitCode, error });
  }

  /**
   * 依据 CW2-D04 / CW3-F01 规范：读取占用状态
   * 对外使用 idle | active | unknown，unknown 不能派生为空闲
   * prepared / starting / running / stopping / needs_reconcile 均视为非 idle
   * 内部准备与 claim 支持传入 excludeRunId，避免将本轮正准备启动的业务 Run 误算为外部写者
   */
  readInvocationOccupancy(
    workflowId: string,
    options?: { excludeDispatchId?: string; excludeRunId?: string } | string,
  ): InvocationOccupancy {
    const excludeDispatchId = typeof options === "string" ? options : options?.excludeDispatchId;
    const excludeRunId = typeof options === "object" ? options?.excludeRunId : undefined;

    const dispatches = this.store.list<CliDispatchRecord>(
      "cli_dispatch_record",
      workflowId,
    );

    const activeList = dispatches.filter(
      (d) =>
        d.dispatch_id !== excludeDispatchId &&
        (d.state === "prepared" ||
          d.state === "starting" ||
          d.state === "running" ||
          d.state === "stopping" ||
          d.state === "needs_reconcile"),
    );

    if (activeList.length > 0) {
      const active = activeList[0]!;
      const state = active.state === "needs_reconcile" ? "unknown" : "active";
      return {
        state,
        active_dispatch_id: active.dispatch_id,
        has_active_runner: true,
        writer_count: activeList.length,
      };
    }

    // 检查是否有正在运行的 Run 实体（排除当前准备意图所属的 Run）
    const activeRuns = this.store
      .list<Run>("run", workflowId)
      .filter((r) => {
        if (r.status !== "running") return false;
        if (excludeRunId && r.id === excludeRunId) return false;
        return true;
      });
    if (activeRuns.length > 0) {
      return {
        state: "active",
        has_active_runner: true,
        writer_count: activeRuns.length,
      };
    }

    // 检查控制事实中的 writer_state
    const control = this.store.get<WorkflowDispatchControl>("workflow_dispatch_control", workflowId);
    if (control?.writer_state && control.writer_state !== "idle") {
      return {
        state: control.writer_state,
        has_active_runner: control.writer_state === "active",
        writer_count: 1,
      };
    }

    return {
      state: "idle",
      has_active_runner: false,
      writer_count: 0,
    };
  }

  hasActiveRunner(workflowId: string): boolean {
    return this.readInvocationOccupancy(workflowId).has_active_runner;
  }

  /**
   * 依据 CW2-D04 / CW3-F02 规范：核对未决或崩溃派发
   */
  reconcileDispatch(workflowId: string): void {
    const dispatches = this.store.list<CliDispatchRecord>(
      "cli_dispatch_record",
      workflowId,
    );
    const processRecords = this.store.list<{
      id: string;
      status: string;
      confirmed?: boolean;
    }>("process_record", workflowId);
    const runs = this.store.list<Run>("run", workflowId);

    this.store.transaction(() => {
      for (const d of dispatches) {
        if (d.state === "starting" && !d.process_identity?.pid) {
          // 未获得回执且未能确认启动
          const updated: CliDispatchRecord = {
            ...d,
            state: "needs_reconcile",
            updated_at: now(),
          };
          this.store.put("cli_dispatch_record", d.id, workflowId, updated);
        } else if (d.state === "running" || d.state === "starting") {
          const procRecord = processRecords.find((p) => p.id === d.run_id);
          const run = runs.find((r) => r.id === d.run_id);
          const isProcExited = procRecord && procRecord.status === "exited" && procRecord.confirmed;
          const isRunFinished = run && run.status !== "running";

          if (isProcExited || isRunFinished) {
            const updated: CliDispatchRecord = {
              ...d,
              state: "interrupted",
              error: isProcExited ? "关联进程在宿主上已确认为退出" : "关联 Run 已不再处于运行状态",
              updated_at: now(),
            };
            this.store.put("cli_dispatch_record", d.id, workflowId, updated);

            // 同时收尾可能残留的 running Run，避免长期占用
            if (run && run.status === "running") {
              this.store.put("run", run.id, workflowId, {
                ...run,
                status: "failed",
                error: "关联进程已在宿主退出，派发已对账收尾",
                finished_at: now(),
              });
            }
          }
        }
      }
    });
  }
}
