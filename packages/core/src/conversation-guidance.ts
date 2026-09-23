import {
  ATTACHMENT_HANDOFF_NOTICE,
  unknownSubagentCapabilities,
  type RecoveryManifest,
  type SubagentCapabilities,
} from "../../contracts/src/index.js";
import { recoveryGuidanceText } from "../../runtime/src/conversation-recovery.js";
import { readOnlyPurpose } from "../../adapters/sdk/src/invocation.js";
import { roleBoundaryInstructionsFor } from "./role-boundaries.js";
import {
  CURSOR_NO_CHILD_REASON,
  cursorSubagentCapabilities,
} from "../../adapters/cursor/src/conversation-source.js";
import {
  CODEX_UNPAID_REASON,
  codexSubagentCapabilities,
} from "../../adapters/codex/src/conversation-source.js";
import {
  AGY_PAUSE_ATTRIBUTION,
  agySubagentCapabilities,
} from "../../adapters/agy/src/conversation-source.js";
import { claudeSubagentCapabilities } from "../../adapters/claude/src/conversation-source.js";
import {
  kimiPromptAllowsPlanFlag,
  kimiSubagentCapabilities,
} from "../../adapters/kimi/src/conversation-source.js";
import {
  grokSubagentCapabilities,
  grokSubagentsDefaultDisabled,
} from "../../adapters/grok/src/conversation-source.js";
import { qoderSubagentCapabilities } from "../../adapters/qoder/src/conversation-source.js";
import { openCodeSubagentCapabilities } from "../../adapters/opencode/src/conversation-source.js";

export type RecoveryGuidanceRole =
  | "planning"
  | "execute"
  | "review"
  | "repair"
  | "planner_takeover"
  | "executor_test"
  | "planner_commit"
  | "functional_fix"
  | "aside";

export interface RecoveryGuidanceAttachment {
  display_name: string;
  read_mode: "text" | "image" | "binary";
}

export interface RecoveryGuidanceOptions {
  adapterId?: string;
  attachments?: RecoveryGuidanceAttachment[];
}

export const AGY_ENCRYPTED_METADATA_GAP =
  "agy 加密元数据不可读：只读取公开工具元数据与子会话关联，不解密 provider payload。";

export function planningRecoveryGuidance(
  manifest: RecoveryManifest,
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  return composeRoleGuidance("planning", manifest, capabilities, extra);
}

export function executeRecoveryGuidance(
  manifest: RecoveryManifest,
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  return composeRoleGuidance("execute", manifest, capabilities, extra);
}

export function reviewRecoveryGuidance(
  manifest: RecoveryManifest,
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  return composeRoleGuidance("review", manifest, capabilities, extra);
}

export function repairRecoveryGuidance(
  manifest: RecoveryManifest,
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  return composeRoleGuidance("repair", manifest, capabilities, extra);
}

export function asideRecoveryGuidance(
  manifest: RecoveryManifest,
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  return composeRoleGuidance("aside", manifest, capabilities, extra);
}

export function planningBridgeInstructions(
  capabilities: SubagentCapabilities = unknownSubagentCapabilities(),
  extra?: RecoveryGuidanceOptions,
): string {
  return roleCapabilityGuidance("planning", capabilities, extra);
}

export function reviewBridgeInstructions(
  capabilities: SubagentCapabilities = unknownSubagentCapabilities(),
  extra?: RecoveryGuidanceOptions,
): string {
  return roleCapabilityGuidance("review", capabilities, extra);
}

export function composeRoleGuidance(
  role: RecoveryGuidanceRole,
  manifest: RecoveryManifest,
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  return joinSections([
    recoveryGuidanceText(manifest),
    parentHierarchyHint(manifest),
    skipTerminalHint(manifest),
    deliveredNotFollowedHint(),
    roleCapabilityGuidance(role, capabilities, extra),
  ]);
}

function roleCapabilityGuidance(
  role: RecoveryGuidanceRole,
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  return joinSections([
    roleWorkHint(role),
    readonlyBoundaryText(role, capabilities),
    invocationReadonlyFacts(extra?.adapterId),
    attachmentGuidanceText(capabilities, extra),
    capabilityGapText(capabilities, extra?.adapterId),
  ]);
}

function joinSections(parts: Array<string | undefined>): string {
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n");
}

function purposeForRole(role: RecoveryGuidanceRole): string {
  if (role === "planning") return "planning";
  if (role === "review") return "quality_review";
  if (role === "aside") return "aside";
  return "implement";
}

function roleWorkHint(role: RecoveryGuidanceRole): string {
  if (["planner_takeover", "executor_test", "planner_commit", "functional_fix"].includes(role))
    return roleBoundaryInstructionsFor(role);
  if (role === "planning")
    return "继续原规划用途：只调查和规划，不修改产品代码，不自行批准或启动执行。";
  if (role === "execute")
    return "继续原开发用途：按已批准计划实施，不另建替代计划。";
  if (role === "review")
    return "继续原复核职责与阶段，不降为 implement；审查子 Agent 均只读。";
  if (role === "repair")
    return "继续原整改范围，按确定修复意见执行，不得自行换方案。";
  return "独立只读临时提问，不打断主工作树，不自动重提已取消问题。";
}

function readonlyBoundaryText(
  role: RecoveryGuidanceRole,
  capabilities: SubagentCapabilities,
): string {
  const readonly = readOnlyPurpose(purposeForRole(role));
  const boundary = readonly
    ? "本角色只读，子 Agent 继承同样的读写边界、允许目录和授权边界，不能利用嵌套 Agent 绕过父限制。原生委派可放行，文件写、任意终端写入和外部发送权限不因委派放大。"
    : "本角色可写。若委派只读子任务，子 Agent 仍须保持只读边界，不能把 unknown 只读委派当成已关闭。";
  return `${boundary}${readonlyDelegationStatus(capabilities.readonly_delegation)}`;
}

function readonlyDelegationStatus(
  status: SubagentCapabilities["readonly_delegation"],
): string {
  if (status === "unknown")
    return "只读委派能力为 unknown，unknown 不等于 false，也未证实已支持；不得把未知当成已关闭或已验证。";
  if (status === "unsupported")
    return "当前工具不支持安全的只读子 Agent，只读角色保持原限制，不可宣称各角色均已支持。";
  return "当前工具已证实只读委派。";
}

function parentHierarchyHint(manifest: RecoveryManifest): string | undefined {
  if (!manifest.pending_children.length) return undefined;
  return "待恢复项按清单中的 parent_id 交给直接父 Agent，不要把孙节点全部重新挂到根。";
}

function skipTerminalHint(manifest: RecoveryManifest): string {
  const lines = [
    "已经完成或用户取消的子任务不要重跑，不自动重启完成/取消项。",
  ];
  if (manifest.completed_children.length) {
    lines.push(
      "已完成、不要重跑：" +
        manifest.completed_children
          .map((item) => item.conversation_id)
          .join("、"),
    );
  }
  if (manifest.cancelled_children.length) {
    lines.push(
      "用户已取消、不要重跑：" + manifest.cancelled_children.join("、"),
    );
  }
  return lines.join("\n");
}

function deliveredNotFollowedHint(): string {
  return "清单或附件的 delivered 只表示作为输入传入，不表示模型已遵从或子 Agent 已启动。";
}

function attachmentGuidanceText(
  capabilities: SubagentCapabilities,
  extra?: RecoveryGuidanceOptions,
): string {
  const input = capabilities.file_input;
  const lines = [
    ATTACHMENT_HANDOFF_NOTICE,
    "模型对某类型没有可用读取能力时必须在失败点明确写出类型与文件，不能悄悄只传文件名。上传成功或清单 delivered 不代表模型已读或已遵从。",
  ];
  const unsupportedKinds: string[] = [];
  if (!input.text) unsupportedKinds.push("文本");
  if (!input.image) unsupportedKinds.push("图片");
  if (!input.binary) unsupportedKinds.push("二进制");
  if (unsupportedKinds.length)
    lines.push("当前工具未支持的附件类型：" + unsupportedKinds.join("、") + "。");
  for (const file of extra?.attachments ?? []) {
    if (input[file.read_mode]) continue;
    lines.push(
      `附件 ${file.display_name} 类型 ${file.read_mode} 当前工具无法读取，必须失败点明确，不能只传文件名。`,
    );
  }
  return lines.join("");
}

function invocationReadonlyFacts(adapterId?: string): string {
  const facts: string[] = [];
  const include = (id: string, text: string) => {
    if (!adapterId || adapterId === id) facts.push(text);
  };
  include(
    "claude-code",
    "claude-code 只读用途允许 Agent/Task，同时拒绝 Bash/Edit/Write。",
  );
  include(
    "qoder",
    "qoder 只读仅允许受约束 Agent，不能放行 Task 或无约束 Agent。",
  );
  if (!kimiPromptAllowsPlanFlag())
    include(
      "kimi-code",
      "kimi-code 的 --plan 不能与 -p/--prompt 同时使用。",
    );
  include("opencode", "opencode 的 task 只放行只读子 agent。");
  if (!grokSubagentsDefaultDisabled())
    include(
      "grok-build",
      "grok-build 已去掉全局禁用子 Agent，只读仍须设置子权限边界。",
    );
  return facts.length ? "只读启动须与当前工具事实一致：" + facts.join("") : "";
}

function capabilityGapText(
  capabilities: SubagentCapabilities,
  adapterId?: string,
): string {
  const reasons: string[] = [];
  pushUnique(reasons, capabilities.reason);
  pushUnique(reasons, adapterDefaultReason(adapterId, capabilities));
  if (adapterId === "cursor-agent" || reasonsInclude(reasons, CURSOR_NO_CHILD_REASON))
    pushUnique(reasons, CURSOR_NO_CHILD_REASON);
  if (adapterId === "codex" || reasonsInclude(reasons, CODEX_UNPAID_REASON))
    pushUnique(reasons, CODEX_UNPAID_REASON);
  if (adapterId === "agy" || reasonsInclude(reasons, AGY_PAUSE_ATTRIBUTION))
    pushUnique(reasons, AGY_ENCRYPTED_METADATA_GAP);
  if (adapterId === "opencode" && !hasBoundOpenCode(capabilities))
    pushUnique(reasons, unboundOpenCodeReason());
  if (!reasons.length) return "";
  return "能力限制：" + reasons.join("；");
}

function adapterDefaultReason(
  adapterId: string | undefined,
  capabilities: SubagentCapabilities,
): string | undefined {
  if (!adapterId) return undefined;
  if (adapterId === "opencode" && hasBoundOpenCode(capabilities)) return undefined;
  return adapterDefaultCapabilities(adapterId)?.reason;
}

function adapterDefaultCapabilities(
  adapterId: string,
): SubagentCapabilities | undefined {
  if (adapterId === "cursor-agent") return cursorSubagentCapabilities();
  if (adapterId === "codex") return codexSubagentCapabilities();
  if (adapterId === "agy") return agySubagentCapabilities();
  if (adapterId === "claude-code") return claudeSubagentCapabilities({});
  if (adapterId === "kimi-code") return kimiSubagentCapabilities();
  if (adapterId === "grok-build") return grokSubagentCapabilities();
  if (adapterId === "qoder") return qoderSubagentCapabilities();
  if (adapterId === "opencode")
    return openCodeSubagentCapabilities({
      workflowId: "guidance",
      runId: "guidance",
      lineageId: "guidance",
    });
  return undefined;
}

function hasBoundOpenCode(capabilities: SubagentCapabilities): boolean {
  return capabilities.discovery === "native" || capabilities.stop === "native";
}

function unboundOpenCodeReason(): string {
  return (
    openCodeSubagentCapabilities({
      workflowId: "guidance",
      runId: "guidance",
      lineageId: "guidance",
    }).reason ?? "没有可绑定的 OpenCode 实例或 session，未另启常驻服务"
  );
}

function reasonsInclude(reasons: string[], value: string): boolean {
  return reasons.some((item) => item.includes(value));
}

function pushUnique(list: string[], value?: string) {
  if (!value) return;
  if (list.some((item) => item.includes(value) || value.includes(item))) return;
  list.push(value);
}
