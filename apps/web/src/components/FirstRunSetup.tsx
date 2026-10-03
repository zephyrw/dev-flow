import React, { useState, useEffect } from "react";
import { AppDialog } from "./AppDialog.js";
import {
  getModelDefaults,
  putModelDefaults,
  verifyModelAccess,
  newRequestId,
} from "./model-api.js";
import type { ToolProfile, SupportedAdapterId, ToolSummary } from "../../../../packages/contracts/src/index.js";

export interface FirstRunSetupProps {
  isOpen: boolean;
  onClose: () => void;
  onCompleted?: () => void;
}

type Step = 1 | 2 | 3 | 4;

const SUPPORTED_ASSISTANTS: Array<{
  id: SupportedAdapterId;
  name: string;
  desc: string;
  icon: string;
  installHint: string;
}> = [
  {
    id: "codex",
    name: "Codex",
    desc: "OpenAI 编程助手，提供基于官方 CLI 的工作流调度与交互支持",
    icon: "🤖",
    installHint: "确保 codex 命令在系统 PATH 中，并通过 codex login 完成登录",
  },
  {
    id: "agy",
    name: "Antigravity CLI",
    desc: "Google DeepMind 智能开发工作流与多账号调度",
    icon: "⚡",
    installHint: "确保 agy 命令在系统 PATH 中，并可在「AGY 账号」中查看额度",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    desc: "Anthropic Claude 编程终端与子 Agent 协同",
    icon: "🧠",
    installHint: "通过 npm install -g @anthropic-ai/claude-code 安装并授权",
  },
  {
    id: "cursor-agent",
    name: "Cursor Agent",
    desc: "Cursor 智能代理，专注本地文件编辑与终端执行",
    icon: "💻",
    installHint: "安装 Cursor 桌面端及其终端命令行工具",
  },
  {
    id: "kimi-code",
    name: "Kimi Code",
    desc: "Moonshot Kimi 长上下文深度代码推理",
    icon: "🌙",
    installHint: "安装 kimi-code CLI 并完成官方 API 凭据配置",
  },
  {
    id: "mimo-code",
    name: "MiMo Code",
    desc: "小米 MiMo 模型与代码工程能力接入",
    icon: "📱",
    installHint: "安装 @mimo-ai/cli 并配置 API 密钥",
  },
  {
    id: "grok-build",
    name: "Grok Build",
    desc: "xAI Grok 深度推理与构建辅助工具",
    icon: "🚀",
    installHint: "安装 grok-build CLI 并配置相关凭据",
  },
  {
    id: "qoder",
    name: "Qoder",
    desc: "阿里通义灵码及本地编程助理调度接入",
    icon: "✨",
    installHint: "安装 qoder CLI 并完成账号激活",
  },
  {
    id: "opencode",
    name: "OpenCode",
    desc: "开源终端代码助手通用调度接口",
    icon: "🌐",
    installHint: "配置 opencode 运行环境及系统路径",
  },
];

function setupProfile(base: ToolProfile, adapterId: SupportedAdapterId, modelId: string): ToolProfile {
  const sameAdapter = base.adapterId === adapterId;
  return {
    ...(sameAdapter ? base : { id: base.id, revision: base.revision, options: {} }),
    adapterId, modelId: modelId.trim(), modelSelection: "explicit", selectionKind: "fixed",
  };
}

export function FirstRunSetup({ isOpen, onClose, onCompleted }: FirstRunSetupProps) {
  const [step, setStep] = useState<Step>(1);
  const [selectedTool, setSelectedTool] = useState<SupportedAdapterId>("codex");
  const [plannerTool, setPlannerTool] = useState<SupportedAdapterId>("codex");
  const [executorTool, setExecutorTool] = useState<SupportedAdapterId>("agy");
  const [plannerModel, setPlannerModel] = useState<string>("gpt-6-astra");
  const [executorModel, setExecutorModel] = useState<string>("gemini-3.8-flash-high");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [plannerVerifyStatus, setPlannerVerifyStatus] = useState<string | null>(null);
  const [executorVerifyStatus, setExecutorVerifyStatus] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (isOpen) {
      getModelDefaults()
        .then((def) => {
          if (def.plannerProfile?.adapterId) setPlannerTool(def.plannerProfile.adapterId);
          if (def.plannerProfile?.modelId) setPlannerModel(def.plannerProfile.modelId);
          if (def.executorProfile?.adapterId) setExecutorTool(def.executorProfile.adapterId);
          if (def.executorProfile?.modelId) setExecutorModel(def.executorProfile.modelId);
        })
        .catch(() => {});
    }
  }, [isOpen]);

  useEffect(() => {
    setPlannerVerifyStatus(null);
    setExecutorVerifyStatus(null);
  }, [plannerTool, executorTool, plannerModel, executorModel]);

  const handleSkipOrDismiss = () => {
    // R13: 跳过或关闭时仅记录已忽略，严禁写入已完成
    localStorage.setItem("devflow.wizard_dismissed", "true");
    onClose();
  };

  const handleFinish = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const def = await getModelDefaults();
      const newPlanner = setupProfile(def.plannerProfile, plannerTool, plannerModel);
      const newExecutor = setupProfile(def.executorProfile, executorTool, executorModel);
      await putModelDefaults({
        request_id: newRequestId(),
        expected_defaults_revision: def.revision,
        planner_profile: newPlanner,
        executor_profile: newExecutor,
      });

      // 读回确认写入成功
      const verified = await getModelDefaults();
      if (
        verified.plannerProfile?.adapterId !== plannerTool ||
        verified.executorProfile?.adapterId !== executorTool ||
        verified.plannerProfile?.modelId !== plannerModel.trim() ||
        verified.executorProfile?.modelId !== executorModel.trim()
      ) {
        throw new Error("模型配置未能成功读回确认，请重试");
      }

      // 仅在真实保存并读回成功后标记已完成
      localStorage.setItem("devflow.first_run_completed", "true");
      onCompleted?.();
      onClose();
    } catch (e: any) {
      // 保留表单，展示具体错误与重试入口；严禁标记已完成
      setSaveError(e?.message || "保存模型默认配置失败，请检查网络或后端状态后重试");
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async () => {
    setVerifying(true);
    setPlannerVerifyStatus("正在验证...");
    setExecutorVerifyStatus("正在验证...");
    try {
      const def = await getModelDefaults();
      const pProfile = setupProfile(def.plannerProfile, plannerTool, plannerModel);
      const pRes = await verifyModelAccess(pProfile, undefined, true);
      setPlannerVerifyStatus(
        pRes.status === "verified"
          ? "✓ 验证成功"
          : `状态：${pRes.message || pRes.status}`,
      );
    } catch (e: any) {
      setPlannerVerifyStatus(`验证失败：${e?.message || "未知错误"}`);
    }

    try {
      const def = await getModelDefaults();
      const eProfile = setupProfile(def.executorProfile, executorTool, executorModel);
      const eRes = await verifyModelAccess(eProfile, undefined, true);
      setExecutorVerifyStatus(
        eRes.status === "verified"
          ? "✓ 验证成功"
          : `状态：${eRes.message || eRes.status}`,
      );
    } catch (e: any) {
      setExecutorVerifyStatus(`验证失败：${e?.message || "未知错误"}`);
    } finally {
      setVerifying(false);
    }
  };

  const copyTaskExample = () => {
    const text = `用 DevFlow 帮我修复客户列表筛选的问题：选择负责人后，列表没有变化。请先给我计划，等我确认后再开始修改。`;
    navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <AppDialog
      isOpen={isOpen}
      onClose={handleSkipOrDismiss}
      title="欢迎使用 DevFlow · 首次使用向导"
      width={720}
    >
      <div className="first-run-container" style={{ padding: "8px 4px" }}>
        {/* 步骤条 */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: "20px",
            borderBottom: "1px solid var(--color-border, #e1e4e8)",
            paddingBottom: "12px",
          }}
        >
          {[
            { s: 1, title: "1. 连接工具" },
            { s: 2, title: "2. 选择分工" },
            { s: 3, title: "3. 验证授权" },
            { s: 4, title: "4. 第一个任务" },
          ].map((item) => (
            <div
              key={item.s}
              style={{
                fontWeight: step === item.s ? 600 : 400,
                color:
                  step === item.s
                    ? "var(--color-primary, #0969da)"
                    : step > item.s
                    ? "#2da44e"
                    : "#6e7781",
                fontSize: "14px",
              }}
            >
              {item.title}
            </div>
          ))}
        </div>

        {/* 步骤一：连接工具 */}
        {step === 1 && (
          <div>
            <h3 style={{ margin: "0 0 8px 0" }}>选择你要使用的编程助手</h3>
            <p style={{ color: "#57606a", fontSize: "13px", margin: "0 0 16px 0" }}>
              DevFlow 将为你选择的编程助手接入调度配置与 Skill。没有选中的工具不会被改动。
            </p>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
                gap: "12px",
                marginBottom: "20px",
              }}
            >
              {SUPPORTED_ASSISTANTS.map((asst) => {
                const isSelected = selectedTool === asst.id;
                return (
                  <div
                    key={asst.id}
                    onClick={() => {
                      setSelectedTool(asst.id);
                      setPlannerTool(asst.id);
                    }}
                    style={{
                      border: isSelected
                        ? "2px solid var(--color-primary, #0969da)"
                        : "1px solid #d0d7de",
                      borderRadius: "6px",
                      padding: "12px",
                      cursor: "pointer",
                      background: isSelected ? "var(--color-canvas-subtle, #f6f8fa)" : "#fff",
                    }}
                  >
                    <div style={{ fontSize: "20px", marginBottom: "4px" }}>
                      {asst.icon} <strong>{asst.name}</strong>
                    </div>
                    <div style={{ fontSize: "12px", color: "#57606a", lineHeight: 1.4 }}>
                      {asst.desc}
                    </div>
                  </div>
                );
              })}
            </div>
            <div
              style={{
                background: "#f6f8fa",
                padding: "10px 12px",
                borderRadius: "6px",
                fontSize: "12px",
                color: "#57606a",
                marginBottom: "20px",
              }}
            >
              💡 接入提示：
              {SUPPORTED_ASSISTANTS.find((a) => a.id === selectedTool)?.installHint}
            </div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <button
                type="button"
                className="btn"
                onClick={handleSkipOrDismiss}
              >
                跳过，稍后设置
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep(2)}
              >
                下一步：选择分工 →
              </button>
            </div>
          </div>
        )}

        {/* 步骤二：选择分工 */}
        {step === 2 && (
          <div>
            <h3 style={{ margin: "0 0 8px 0" }}>模型各司其职，专注所长</h3>
            <p style={{ color: "#57606a", fontSize: "13px", margin: "0 0 16px 0" }}>
              让擅长思考的模型负责规划与代码复核，让擅长执行的模型负责编码与测试。同一工具也可承担两项职责。
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "16px", marginBottom: "20px" }}>
              {/* 规划与复核 */}
              <div style={{ border: "1px solid #d0d7de", borderRadius: "6px", padding: "14px" }}>
                <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "6px" }}>
                  🧠 规划与复核（Planner & Reviewer）
                </div>
                <div style={{ fontSize: "12px", color: "#57606a", marginBottom: "12px" }}>
                  负责需求调研、制定计划、审查代码质量并给出修改意见。
                </div>
                <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>负责工具：</label>
                <select
                  value={plannerTool}
                  onChange={(e) => setPlannerTool(e.target.value as SupportedAdapterId)}
                  style={{ width: "100%", padding: "6px", marginBottom: "10px", borderRadius: "4px" }}
                >
                  {SUPPORTED_ASSISTANTS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>模型选择：</label>
                <input
                  type="text"
                  value={plannerModel}
                  onChange={(e) => setPlannerModel(e.target.value)}
                  style={{ width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #d0d7de" }}
                  placeholder="例如: gpt-6-astra 或 claude-3-7-sonnet"
                />
              </div>

              {/* 开发与测试 */}
              <div style={{ border: "1px solid #d0d7de", borderRadius: "6px", padding: "14px" }}>
                <div style={{ fontWeight: 600, fontSize: "14px", marginBottom: "6px" }}>
                  ⚡ 开发与测试（Executor & Tester）
                </div>
                <div style={{ fontSize: "12px", color: "#57606a", marginBottom: "12px" }}>
                  负责按计划编写修改代码、运行自测并在独立工作区验证。
                </div>
                <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>负责工具：</label>
                <select
                  value={executorTool}
                  onChange={(e) => setExecutorTool(e.target.value as SupportedAdapterId)}
                  style={{ width: "100%", padding: "6px", marginBottom: "10px", borderRadius: "4px" }}
                >
                  {SUPPORTED_ASSISTANTS.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <label style={{ fontSize: "12px", display: "block", marginBottom: "4px" }}>模型选择：</label>
                <input
                  type="text"
                  value={executorModel}
                  onChange={(e) => setExecutorModel(e.target.value)}
                  style={{ width: "100%", padding: "6px", borderRadius: "4px", border: "1px solid #d0d7de" }}
                  placeholder="例如: gemini-3.8-flash-high"
                />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <button type="button" className="btn" onClick={() => setStep(1)}>
                ← 上一步
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep(3)}
              >
                下一步：验证授权 →
              </button>
            </div>
          </div>
        )}

        {/* 步骤三：验证授权 */}
        {step === 3 && (
          <div>
            <h3 style={{ margin: "0 0 8px 0" }}>验证模型访问与授权</h3>
            <p style={{ color: "#57606a", fontSize: "13px", margin: "0 0 16px 0" }}>
              确保所选助手已在官方完成登录，且能够正常访问指定模型。
            </p>

            <div
              style={{
                border: "1px solid #d0d7de",
                borderRadius: "6px",
                padding: "16px",
                marginBottom: "20px",
                background: "#fafbfc",
              }}
            >
              <div style={{ marginBottom: "12px", fontSize: "13px" }}>
                <strong>规划模型（Planner）：</strong> {plannerTool} / <code>{plannerModel}</code>
                {plannerVerifyStatus && (
                  <span style={{ marginLeft: "10px", fontSize: "12px", color: plannerVerifyStatus.startsWith("✓") ? "#2da44e" : "#cf222e" }}>
                    {plannerVerifyStatus}
                  </span>
                )}
              </div>
              <div style={{ marginBottom: "16px", fontSize: "13px" }}>
                <strong>执行模型（Executor）：</strong> {executorTool} / <code>{executorModel}</code>
                {executorVerifyStatus && (
                  <span style={{ marginLeft: "10px", fontSize: "12px", color: executorVerifyStatus.startsWith("✓") ? "#2da44e" : "#cf222e" }}>
                    {executorVerifyStatus}
                  </span>
                )}
              </div>

              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                <button
                  type="button"
                  className="btn"
                  onClick={handleVerify}
                  disabled={verifying}
                >
                  {verifying ? "正在检测模型访问..." : "🔍 验证所选模型访问"}
                </button>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <button type="button" className="btn" onClick={() => setStep(2)}>
                ← 上一步
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => setStep(4)}
              >
                下一步：查看第一条任务示例 →
              </button>
            </div>
          </div>
        )}

        {/* 步骤四：完成与第一条任务 */}
        {step === 4 && (
          <div>
            <div style={{ textAlign: "center", marginBottom: "16px" }}>
              <div style={{ fontSize: "36px", marginBottom: "6px" }}>🎉</div>
              <h3 style={{ margin: "0 0 4px 0" }}>设置就绪！试试你的第一个任务</h3>
              <p style={{ color: "#57606a", fontSize: "13px", margin: 0 }}>
                不需要在网页反复复制需求，直接在你的编程助手中提出需求即可。
              </p>
            </div>

            {saveError && (
              <div
                style={{
                  background: "#ffebe9",
                  border: "1px solid rgba(255, 129, 130, 0.4)",
                  color: "#cf222e",
                  padding: "10px 12px",
                  borderRadius: "6px",
                  fontSize: "13px",
                  marginBottom: "16px",
                }}
              >
                <strong>保存失败：</strong> {saveError}
              </div>
            )}

            <div
              style={{
                background: "#f6f8fa",
                border: "1px solid #d0d7de",
                borderRadius: "6px",
                padding: "14px",
                marginBottom: "20px",
              }}
            >
              <div style={{ fontSize: "12px", fontWeight: 600, color: "#24292f", marginBottom: "8px" }}>
                在 {SUPPORTED_ASSISTANTS.find((a) => a.id === plannerTool)?.name ?? "编程助手"} 中打开你要修改的项目，输入：
              </div>
              <div
                style={{
                  background: "#ffffff",
                  border: "1px solid #d0d7de",
                  borderRadius: "4px",
                  padding: "10px 12px",
                  fontSize: "13px",
                  lineHeight: 1.5,
                  fontFamily: "monospace",
                  color: "#0969da",
                  marginBottom: "8px",
                }}
              >
                用 DevFlow 帮我修复客户列表筛选的问题：选择负责人后，列表没有变化。请先给我计划，等我确认后再开始修改。
              </div>
              <button
                type="button"
                className="btn btn-sm"
                onClick={copyTaskExample}
                style={{ fontSize: "12px" }}
              >
                {copied ? "✓ 已复制提示词" : "📋 复制需求示例"}
              </button>
            </div>

            <div
              style={{
                fontSize: "12px",
                color: "#57606a",
                lineHeight: 1.5,
                marginBottom: "20px",
              }}
            >
              <strong>后续流程：</strong>
              <ol style={{ margin: "6px 0 0 18px", padding: 0 }}>
                <li>在助手提出需求后，规划模型将自动调研并在工作台生成计划；</li>
                <li>在工作台阅读并批准计划后，执行模型开始编码与自动化测试；</li>
                <li>通过两阶段代码复核后，由你进行实际功能验收并确认提交。</li>
              </ol>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button type="button" className="btn" onClick={() => setStep(3)}>
                ← 上一步
              </button>
              <div style={{ display: "flex", gap: "8px" }}>
                <button type="button" className="btn" onClick={handleSkipOrDismiss}>
                  稍后设置
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={handleFinish}
                  disabled={saving}
                >
                  {saving ? "正在保存..." : "完成，进入工作台 →"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </AppDialog>
  );
}
