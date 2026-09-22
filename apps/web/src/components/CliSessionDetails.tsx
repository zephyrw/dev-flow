import React, { useState, useEffect, useRef } from "react";
import type {
  SessionBinding,
  SessionBindingResumeInstructions,
} from "../../../../packages/contracts/src/session-binding.js";

interface CliSessionDetailsProps {
  workflowId: string;
}

interface RepairCandidate {
  candidate_id: string;
  source_ref: string;
  conversation_id: string;
  adapter_id: string;
  canonical_model_id: string;
  status: string;
  reason?: string;
  expected_binding_revision: number;
}

interface RepairPreviewResult {
  workflow_id: string;
  workflow_version: number;
  source_digest: string;
  candidates: RepairCandidate[];
  writer_state: string;
  requires_dispatch_disabled: boolean;
}

export function CliSessionDetails({ workflowId }: CliSessionDetailsProps) {
  const [bindings, setBindings] = useState<SessionBinding[]>([]);
  const [selectedBindingId, setSelectedBindingId] = useState<string | null>(null);
  const [resumeInfo, setResumeInfo] = useState<SessionBindingResumeInstructions | null>(null);
  const [dispatchEnabled, setDispatchEnabled] = useState<boolean>(true);
  const [dispatchRevision, setDispatchRevision] = useState<number>(1);
  const [workflowVersion, setWorkflowVersion] = useState<number>(1);
  const [loading, setLoading] = useState<boolean>(false);
  const [mutationBusy, setMutationBusy] = useState<boolean>(false);
  const [copySuccess, setCopySuccess] = useState<boolean>(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 刷新触发器：dispatch mutation 等操作通过增加 tick 触发当前选择重新请求说明
  const [refreshTick, setRefreshTick] = useState<number>(0);

  // 修复与回退状态 (CW3-F24: 保留真实迁移受影响绑定集合，用于精确单调回滚)
  const [repairPreview, setRepairPreview] = useState<RepairPreviewResult | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<string[]>([]);
  const [lastMigration, setLastMigration] = useState<{
    migration_id: string;
    affected_binding_ids: string[];
  } | null>(null);
  const [repairLoading, setRepairLoading] = useState<boolean>(false);

  // CW2-F19 / CW2-D07: workflow generation 与 binding/request generation 分开
  const workflowGenerationRef = useRef<number>(0);
  const bindingGenerationRef = useRef<number>(0);
  const selectedBindingIdRef = useRef<string | null>(null);
  const selectedBindingRevisionRef = useRef<number>(0);
  const copyTimerRef = useRef<NodeJS.Timeout | null>(null);

  selectedBindingIdRef.current = selectedBindingId;
  const currentBindingObj = bindings.find((b) => b.id === selectedBindingId);
  selectedBindingRevisionRef.current = currentBindingObj?.revision ?? 0;

  // CW3-F23: 统一复制门禁 eligibility (调度已停用、写者 idle、处于当前会话与任务、无在途 mutation、有合格 copy_script)
  const canCopy = Boolean(
    !mutationBusy &&
    !dispatchEnabled &&
    resumeInfo &&
    resumeInfo.copy_script &&
    resumeInfo.status === "supported" &&
    resumeInfo.binding_id === selectedBindingId &&
    resumeInfo.workflow_id === workflowId
  );

  // CW3-F23: 接入现有占用与绑定事件，外部状态变动时立即失效旧可执行快照并重新请求
  useEffect(() => {
    const onActivity = () => {
      setResumeInfo(null);
      setRefreshTick((t) => t + 1);
    };
    window.addEventListener("devflow-activity", onActivity);
    return () => window.removeEventListener("devflow-activity", onActivity);
  }, []);

  // 清理复制提示定时器
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
        copyTimerRef.current = null;
      }
    };
  }, []);

  // CW2-D07: 切任务时立即清空所有状态，递增 workflow generation
  useEffect(() => {
    workflowGenerationRef.current += 1;
    const currentWorkflowGen = workflowGenerationRef.current;
    const controller = new AbortController();

    setBindings([]);
    setSelectedBindingId(null);
    setResumeInfo(null);
    setError(null);
    setCopySuccess(false);
    setCopyError(null);
    setRepairPreview(null);
    setSelectedCandidateIds([]);
    setLastMigration(null);

    const fetchInitialData = async () => {
      setLoading(true);
      try {
        const [bindingRes, controlRes] = await Promise.all([
          fetch(`/api/workflows/${workflowId}/session-bindings`, { signal: controller.signal }),
          fetch(`/api/workflows/${workflowId}/dispatch-control`, { signal: controller.signal }),
        ]);

        if (controller.signal.aborted || workflowGenerationRef.current !== currentWorkflowGen) return;

        if (bindingRes.ok) {
          const envelope = await bindingRes.json();
          if (controller.signal.aborted || workflowGenerationRef.current !== currentWorkflowGen) return;

          const list: SessionBinding[] = Array.isArray(envelope)
            ? envelope
            : (envelope.bindings ?? []);
          setBindings(list);

          const wfVer = !Array.isArray(envelope) ? (envelope.workflow_version ?? 1) : 1;
          setWorkflowVersion(wfVer);

          // CW2-D07 第7条: 有实际 Run binding 则选择它；无当前根且唯一合法 binding 才自动选，否则保持未选。删除 list[0] 回退
          const currentId = !Array.isArray(envelope) ? envelope.current_binding_id : undefined;
          if (currentId && list.some((b) => b.id === currentId)) {
            setSelectedBindingId(currentId);
          } else if (
            list.length === 1 &&
            list[0] &&
            (list[0].state === "bound" || list[0].state === "reserved")
          ) {
            setSelectedBindingId(list[0].id);
          } else {
            setSelectedBindingId(null);
          }
        }

        if (controlRes.ok) {
          const ctrl = await controlRes.json();
          if (controller.signal.aborted || workflowGenerationRef.current !== currentWorkflowGen) return;
          setDispatchEnabled(!!ctrl.dispatch_enabled);
          setDispatchRevision(ctrl.revision ?? 1);
        }
      } catch (err: any) {
        if (!controller.signal.aborted && workflowGenerationRef.current === currentWorkflowGen) {
          setError(err.message || "加载会话信息失败");
        }
      } finally {
        if (workflowGenerationRef.current === currentWorkflowGen) {
          setLoading(false);
        }
      }
    };

    fetchInitialData();

    return () => {
      controller.abort();
    };
  }, [workflowId]);

  // CW2-F19 / CW2-D07: 当选择 binding 或 refreshTick 变化时获取续接说明
  useEffect(() => {
    bindingGenerationRef.current += 1;
    const currentWorkflowGen = workflowGenerationRef.current;
    const currentBindingGen = bindingGenerationRef.current;
    const targetBindingId = selectedBindingId;
    const targetBindingRev = selectedBindingRevisionRef.current;

    // 选择变更或清空时立即清空说明
    setResumeInfo(null);
    setCopyError(null);
    setCopySuccess(false);

    if (!targetBindingId) {
      return;
    }

    const controller = new AbortController();

    const fetchInstructions = async () => {
      try {
        const res = await fetch(
          `/api/workflows/${workflowId}/session-bindings/${targetBindingId}/resume-instructions`,
          { signal: controller.signal },
        );

        // await 后核对当前 workflow generation、binding generation、selectedBindingId
        if (
          controller.signal.aborted ||
          workflowGenerationRef.current !== currentWorkflowGen ||
          bindingGenerationRef.current !== currentBindingGen ||
          selectedBindingIdRef.current !== targetBindingId
        ) {
          return;
        }

        if (res.ok) {
          const data: SessionBindingResumeInstructions = await res.json();
          // 再次核对 await res.json 之后的归属
          if (
            controller.signal.aborted ||
            workflowGenerationRef.current !== currentWorkflowGen ||
            bindingGenerationRef.current !== currentBindingGen ||
            selectedBindingIdRef.current !== targetBindingId
          ) {
            return;
          }

          // 核对返回说明的 bindingRevision 归属（如果数据携带）
          if (
            (data as any).binding_revision !== undefined &&
            targetBindingRev > 0 &&
            (data as any).binding_revision !== targetBindingRev
          ) {
            return;
          }

          setResumeInfo(data);
        } else {
          const err = await res.json().catch(() => ({}));
          if (
            controller.signal.aborted ||
            workflowGenerationRef.current !== currentWorkflowGen ||
            bindingGenerationRef.current !== currentBindingGen ||
            selectedBindingIdRef.current !== targetBindingId
          ) {
            return;
          }
          setError(err.message || "获取续接说明失败");
          setResumeInfo(null);
        }
      } catch (err: any) {
        if (
          !controller.signal.aborted &&
          workflowGenerationRef.current === currentWorkflowGen &&
          bindingGenerationRef.current === currentBindingGen &&
          selectedBindingIdRef.current === targetBindingId
        ) {
          setError(err.message || "网络请求异常");
          setResumeInfo(null);
        }
      }
    };

    fetchInstructions();

    return () => {
      controller.abort();
    };
  }, [workflowId, selectedBindingId, refreshTick]);

  // 切换自动调度控制开关 (带 CAS 版本防护与忙时禁用)
  const handleToggleDispatch = async () => {
    if (mutationBusy) return;
    setMutationBusy(true);
    // CW3-F23: mutation 开始立即清空脚本快照，防止请求在途期间复制旧的可执行内容
    setResumeInfo(null);
    setError(null);
    const nextState = !dispatchEnabled;
    const currentWorkflowGen = workflowGenerationRef.current;

    try {
      const res = await fetch(`/api/workflows/${workflowId}/dispatch-control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: `toggle:${workflowId}:${Date.now()}`,
          expected_control_revision: dispatchRevision,
          dispatch_enabled: nextState,
          reason: nextState ? undefined : "用户在工作台手动暂停调度",
        }),
      });

      if (workflowGenerationRef.current !== currentWorkflowGen) return;

      if (res.ok) {
        const data = await res.json();
        if (workflowGenerationRef.current !== currentWorkflowGen) return;
        setDispatchEnabled(nextState);
        setDispatchRevision(data.revision ?? dispatchRevision + 1);

        // CW2-D07 第7条: dispatch mutation 只刷新当前控制事实并使当前选择的 effect 重新请求说明，
        // 不继续用点击时捕获的 A 直接 setResumeInfo
        setRefreshTick((t) => t + 1);
      } else {
        const err = await res.json().catch(() => ({}));
        if (workflowGenerationRef.current !== currentWorkflowGen) return;
        setError(err.message || "修改调度状态失败");
      }
    } catch (err: any) {
      if (workflowGenerationRef.current === currentWorkflowGen) {
        setError(err.message || "修改调度状态网络异常");
      }
    } finally {
      if (workflowGenerationRef.current === currentWorkflowGen) {
        setMutationBusy(false);
      }
    }
  };

  // 复制续接脚本 (CW3-F23: 统一切入 canCopy 资格判定，彻底杜绝状态过期复制)
  const handleCopy = async () => {
    if (!canCopy || !resumeInfo || !resumeInfo.copy_script) return;
    setCopyError(null);
    const textToCopy = resumeInfo.copy_script;

    const currentWorkflowGen = workflowGenerationRef.current;
    const currentBindingGen = bindingGenerationRef.current;
    const currentSelectedId = selectedBindingId;

    try {
      await navigator.clipboard.writeText(textToCopy);
      if (
        workflowGenerationRef.current !== currentWorkflowGen ||
        bindingGenerationRef.current !== currentBindingGen ||
        selectedBindingIdRef.current !== currentSelectedId
      ) {
        return;
      }
      setCopySuccess(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => {
        setCopySuccess(false);
      }, 2500);
    } catch (err: any) {
      if (
        workflowGenerationRef.current === currentWorkflowGen &&
        bindingGenerationRef.current === currentBindingGen &&
        selectedBindingIdRef.current === currentSelectedId
      ) {
        setCopyError("复制到剪贴板失败，请手动选择复制");
      }
    }
  };

  // 触发历史绑定修复预览
  const handlePreviewRepair = async () => {
    setRepairLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/workflows/${workflowId}/session-bindings/repair-preview`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      if (res.ok) {
        const data: RepairPreviewResult = await res.json();
        setRepairPreview(data);
        const verifiedIds = data.candidates
          .filter((c) => c.status === "verified")
          .map((c) => c.candidate_id);
        setSelectedCandidateIds(verifiedIds);
      } else {
        const err = await res.json().catch(() => ({}));
        setError(err.message || "获取会话修复预览失败");
      }
    } catch (err: any) {
      setError(err.message || "获取会话修复预览网络错误");
    } finally {
      setRepairLoading(false);
    }
  };

  // 应用修复 (CW2-D07 第7条: repair 后立即失效当前说明，删除 list[0] 默认回退)
  const handleApplyRepair = async () => {
    if (!repairPreview || selectedCandidateIds.length === 0) return;
    setRepairLoading(true);
    setError(null);
    setResumeInfo(null);

    const selections = selectedCandidateIds.map((cid) => {
      const cand = repairPreview.candidates.find((c) => c.candidate_id === cid);
      return {
        candidate_id: cid,
        expected_binding_revision: cand?.expected_binding_revision ?? 0,
      };
    });

    try {
      const res = await fetch(`/api/workflows/${workflowId}/session-bindings/repair`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          request_id: `repair:${workflowId}:${Date.now()}`,
          expected_workflow_version: repairPreview.workflow_version,
          expected_control_revision: dispatchRevision,
          source_digest: repairPreview.source_digest,
          selections,
        }),
      });

      if (res.ok) {
        const data = await res.json();
        setLastMigration({
          migration_id: data.migration_id,
          affected_binding_ids: data.affected_binding_ids || [],
        });
        setRepairPreview(null);
        // 重新获取 bindings 信封
        const bindingRes = await fetch(`/api/workflows/${workflowId}/session-bindings`);
        if (bindingRes.ok) {
          const envelope = await bindingRes.json();
          const list: SessionBinding[] = Array.isArray(envelope)
            ? envelope
            : (envelope.bindings ?? []);
          setBindings(list);
          const wfVer = !Array.isArray(envelope) ? (envelope.workflow_version ?? 1) : 1;
          setWorkflowVersion(wfVer);
          const currentId = !Array.isArray(envelope) ? envelope.current_binding_id : undefined;
          if (currentId && list.some((b) => b.id === currentId)) {
            setSelectedBindingId(currentId);
          } else if (
            list.length === 1 &&
            list[0] &&
            (list[0].state === "bound" || list[0].state === "reserved")
          ) {
            setSelectedBindingId(list[0].id);
          } else {
            setSelectedBindingId(null);
          }
        }
      } else {
        const err = await res.json().catch(() => ({}));
        setError(err.message || "应用修复失败");
      }
    } catch (err: any) {
      setError(err.message || "应用修复网络异常");
    } finally {
      setRepairLoading(false);
    }
  };

  // 回滚修复 (CW3-F24: 读取并保留真实版本信封和 migration 受影响集合，只提交该 patch 精确集合与真实版本)
  const handleRollbackRepair = async () => {
    if (!lastMigration) return;
    setRepairLoading(true);
    setError(null);
    setResumeInfo(null);

    // 精确获取该 patch 受影响绑定集合的当前 revision
    const targetBindings = bindings.filter((b) =>
      lastMigration.affected_binding_ids.includes(b.id),
    );
    if (targetBindings.length !== lastMigration.affected_binding_ids.length) {
      setError("无法回滚：受影响的部分会话绑定已被删除或不可用");
      setRepairLoading(false);
      return;
    }

    const revisions = targetBindings.map((b) => ({
      binding_id: b.id,
      revision: b.revision,
    }));

    try {
      const res = await fetch(
        `/api/workflows/${workflowId}/session-bindings/repair-rollback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            request_id: `rollback:${workflowId}:${Date.now()}`,
            migration_id: lastMigration.migration_id,
            expected_workflow_version: workflowVersion,
            expected_control_revision: dispatchRevision,
            expected_binding_revisions: revisions,
          }),
        },
      );

      if (res.ok) {
        setLastMigration(null);
        const bindingRes = await fetch(`/api/workflows/${workflowId}/session-bindings`);
        if (bindingRes.ok) {
          const envelope = await bindingRes.json();
          const list: SessionBinding[] = Array.isArray(envelope)
            ? envelope
            : (envelope.bindings ?? []);
          setBindings(list);
          const wfVer = !Array.isArray(envelope) ? (envelope.workflow_version ?? 1) : 1;
          setWorkflowVersion(wfVer);
          const currentId = !Array.isArray(envelope) ? envelope.current_binding_id : undefined;
          if (currentId && list.some((b) => b.id === currentId)) {
            setSelectedBindingId(currentId);
          } else if (
            list.length === 1 &&
            list[0] &&
            (list[0].state === "bound" || list[0].state === "reserved")
          ) {
            setSelectedBindingId(list[0].id);
          } else {
            setSelectedBindingId(null);
          }
        }
      } else {
        const err = await res.json().catch(() => ({}));
        setError(err.message || "回滚修复失败");
      }
    } catch (err: any) {
      setError(err.message || "回滚修复网络异常");
    } finally {
      setRepairLoading(false);
    }
  };

  if (loading && bindings.length === 0) {
    return (
      <div style={{ padding: "14px", fontSize: "12px", color: "#57606a" }}>
        正在读取任务 CLI 会话绑定...
      </div>
    );
  }

  const currentBinding = bindings.find((b) => b.id === selectedBindingId);

  return (
    <div
      style={{
        border: "1px solid var(--color-border, #d0d7de)",
        borderRadius: "8px",
        padding: "14px",
        background: "var(--color-canvas, #ffffff)",
        display: "flex",
        flexDirection: "column",
        gap: "12px",
        fontSize: "13px",
      }}
    >
      {/* 头部状态与调度控制 */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          borderBottom: "1px solid #eaeef2",
          paddingBottom: "8px",
        }}
      >
        <div style={{ fontWeight: 600, display: "flex", alignItems: "center", gap: "8px" }}>
          <span>CLI 原生持久会话</span>
          {currentBinding && (
            <span
              style={{
                fontSize: "11px",
                padding: "2px 6px",
                borderRadius: "10px",
                background: currentBinding.state === "bound" ? "#dafbe1" : "#fff8c5",
                color: currentBinding.state === "bound" ? "#1a7f37" : "#9a6700",
              }}
            >
              {currentBinding.state === "bound" ? "已绑定" : currentBinding.state} (r{currentBinding.revision})
            </span>
          )}
        </div>

        <button
          type="button"
          disabled={mutationBusy}
          onClick={handleToggleDispatch}
          style={{
            padding: "4px 10px",
            fontSize: "12px",
            borderRadius: "6px",
            border: "1px solid #d0d7de",
            background: dispatchEnabled ? "#ffebe9" : "#2da44e",
            color: dispatchEnabled ? "#cf222e" : "#ffffff",
            cursor: mutationBusy ? "not-allowed" : "pointer",
            fontWeight: 500,
            opacity: mutationBusy ? 0.6 : 1,
          }}
        >
          {dispatchEnabled ? "停用自动调度 (接管准备)" : "恢复自动调度"}
        </button>
      </div>

      {/* 历史绑定选择器 (当有多个绑定时必须明确选择) */}
      {bindings.length > 1 && (
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: "12px" }}>
          <span style={{ color: "#57606a" }}>选择会话绑定：</span>
          <select
            value={selectedBindingId || ""}
            onChange={(e) => setSelectedBindingId(e.target.value || null)}
            style={{
              padding: "3px 8px",
              borderRadius: "4px",
              border: "1px solid #d0d7de",
              fontSize: "12px",
            }}
          >
            <option value="">-- 请选择会话 --</option>
            {bindings.map((b) => (
              <option key={b.id} value={b.id}>
                [{b.adapter_id}] {b.canonical_model_id} ({b.conversation_id || "未绑定"})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 当前选中的绑定详情 */}
      {currentBinding ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "8px",
            fontSize: "12px",
            background: "#fbfcfd",
            padding: "8px",
            borderRadius: "6px",
          }}
        >
          <div>
            <span style={{ color: "#57606a" }}>适配工具：</span>
            <strong style={{ marginLeft: "4px" }}>{currentBinding.adapter_id}</strong>
          </div>
          <div>
            <span style={{ color: "#57606a" }}>实际模型：</span>
            <strong style={{ marginLeft: "4px" }}>{currentBinding.canonical_model_id}</strong>
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <span style={{ color: "#57606a" }}>工作区路径：</span>
            <code style={{ marginLeft: "4px", fontSize: "11px", wordBreak: "break-all" }}>
              {currentBinding.workspace_root}
            </code>
          </div>
          <div style={{ gridColumn: "span 2" }}>
            <span style={{ color: "#57606a" }}>精确会话 ID：</span>
            <code style={{ marginLeft: "4px", fontSize: "11px", color: "#0969da" }}>
              {currentBinding.conversation_id || "尚未确认（首次运行结构化回执时写入）"}
            </code>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: "12px", color: "#57606a" }}>
          {bindings.length > 0 ? "请在上方选择一个会话以查看其命令" : "尚未登记持久 CLI 会话"}
        </div>
      )}

      {/* 续接说明与脚本复制区 */}
      {resumeInfo && (
        <div
          style={{
            background: "#f6f8fa",
            padding: "10px",
            borderRadius: "6px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: "12px", fontWeight: 600, color: "#24292f" }}>
              原 CLI 交互续接命令 ({resumeInfo.target_shell})
            </span>
            <button
              type="button"
              disabled={!canCopy}
              onClick={handleCopy}
              style={{
                border: "1px solid #d0d7de",
                background: canCopy ? "#ffffff" : "#eaeef2",
                padding: "2px 8px",
                borderRadius: "4px",
                fontSize: "11px",
                cursor: canCopy ? "pointer" : "not-allowed",
                fontWeight: 500,
              }}
            >
              {copySuccess ? "已复制！" : "复制 PowerShell 脚本"}
            </button>
          </div>

          <pre
            style={{
              margin: 0,
              padding: "6px 8px",
              background: "#ffffff",
              border: "1px solid #e1e4e8",
              borderRadius: "4px",
              fontSize: "11px",
              overflowX: "auto",
              color: "#24292f",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
            }}
          >
            {resumeInfo.copy_script || (resumeInfo.reason ? `当前不可执行: ${resumeInfo.reason}` : "当前状态无可执行脚本")}
          </pre>

          {resumeInfo.reason && (
            <div style={{ fontSize: "11px", color: "#cf222e" }}>
              ⚠️ {resumeInfo.reason}
            </div>
          )}
          {copyError && (
            <div style={{ fontSize: "11px", color: "#cf222e" }}>
              ❌ {copyError}
            </div>
          )}
        </div>
      )}

      {/* 会话修复与回退功能区 */}
      <div style={{ borderTop: "1px solid #eaeef2", paddingTop: "8px" }}>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          {!repairPreview ? (
            <button
              type="button"
              disabled={repairLoading}
              onClick={handlePreviewRepair}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                background: "#f6f8fa",
                border: "1px solid #d0d7de",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              {repairLoading ? "正在扫描..." : "修复历史未绑定会话"}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setRepairPreview(null)}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                background: "#ffffff",
                border: "1px solid #d0d7de",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              取消修复
            </button>
          )}

          {lastMigration && (
            <button
              type="button"
              disabled={repairLoading}
              onClick={handleRollbackRepair}
              style={{
                fontSize: "11px",
                padding: "3px 8px",
                background: "#fff0ee",
                color: "#cf222e",
                border: "1px solid #ffc8c5",
                borderRadius: "4px",
                cursor: "pointer",
              }}
            >
              回滚上次修复 ({lastMigration.migration_id.slice(0, 8)})
            </button>
          )}
        </div>

        {repairPreview && (
          <div
            style={{
              marginTop: "8px",
              padding: "8px",
              background: "#fbfcfd",
              border: "1px solid #e1e4e8",
              borderRadius: "6px",
              fontSize: "12px",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: "6px" }}>发现的历史候选会话：</div>
            {repairPreview.candidates.length === 0 ? (
              <div style={{ color: "#57606a" }}>未发现需要修复的历史会话。</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                {repairPreview.candidates.map((cand) => {
                  // CW3-F25: 区分身份是否核验与同键歧义。verified 与 ambiguous 为已核验可供用户选择；未知与冲突保持禁用
                  const isSelectable = cand.status === "verified" || cand.status === "ambiguous";
                  const isSelected = selectedCandidateIds.includes(cand.candidate_id);
                  const groupKey = `${cand.adapter_id}::${cand.canonical_model_id}::${(cand as any).workspace_identity || (cand as any).workspace_root || "default"}`;

                  const handleCandidateChange = (checked: boolean) => {
                    if (checked) {
                      // 按核验后的目标键分组单选：若该组已有其他选中项，自动替换为当前项，防止提交多个同键根
                      const otherGroups = selectedCandidateIds.filter((cid) => {
                        const other = repairPreview.candidates.find((c) => c.candidate_id === cid);
                        if (!other) return true;
                        const otherGroup = `${other.adapter_id}::${other.canonical_model_id}::${(other as any).workspace_identity || (other as any).workspace_root || "default"}`;
                        return otherGroup !== groupKey;
                      });
                      setSelectedCandidateIds([...otherGroups, cand.candidate_id]);
                    } else {
                      setSelectedCandidateIds(selectedCandidateIds.filter((id) => id !== cand.candidate_id));
                    }
                  };

                  return (
                    <label
                      key={cand.candidate_id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "6px",
                        opacity: isSelectable ? 1 : 0.6,
                        cursor: isSelectable ? "pointer" : "not-allowed",
                      }}
                    >
                      <input
                        type="checkbox"
                        disabled={!isSelectable}
                        checked={isSelected}
                        onChange={(e) => handleCandidateChange(e.target.checked)}
                      />
                      <span>
                        [{cand.source_ref}] <code>{cand.conversation_id}</code> - {cand.status === "ambiguous" ? "歧义待决（可单选）" : cand.status}
                        {cand.reason ? ` (${cand.reason})` : ""}
                      </span>
                    </label>
                  );
                })}
                <button
                  type="button"
                  disabled={repairLoading || selectedCandidateIds.length === 0}
                  onClick={handleApplyRepair}
                  style={{
                    alignSelf: "flex-start",
                    marginTop: "6px",
                    padding: "3px 10px",
                    background: "#2da44e",
                    color: "#ffffff",
                    border: "none",
                    borderRadius: "4px",
                    cursor: "pointer",
                  }}
                >
                  应用选中项
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <div style={{ fontSize: "12px", color: "#cf222e", marginTop: "4px" }}>
          {error}
        </div>
      )}
    </div>
  );
}
