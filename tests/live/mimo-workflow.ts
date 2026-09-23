/**
 * D12 真实外部能力验收（非自动化关卡，需在已安装 MiMo CLI 并登录的机器上人工执行）。
 *
 * 记录 CLI 实际版本、模型完整 ID、会话 ID 的脱敏关联、结果及限制，不记录 API Key/token。
 * 必须实际观察：
 * 1. Pro 与 Flash 分别完成一次受控任务（至少真实读写一个示例文件）。
 * 2. 每个模型至少一次按明确 session ID 续接。
 * 3. 一次 MiMo 作执行模型 + 既有规划模型的完整主流程；一次 MiMo 作规划模型的质量修复及提交。
 * 4. 一次“执行整改后仍被指出问题 → 规划修 → 执行测 → 直接人工”路径。
 * 5. 一次人工反馈 → 执行修及测 → 人工确认 → 最终复核发现问题 → 规划修 → 执行测试 → 直接规划提交。
 *
 * 运行方式（示例，按本机实际安装调整）：
 *   mimo --version
 *   mimo models --verbose
 *   mimo run --format json --model <目录中的完整provider/model>
 *
 * 账号、网络、额度或 CLI 不具备条件时记录具体阻塞；不得以 fixture 替代真实接入验收。
 */

import { spawnSync } from "node:child_process";

export type LiveCheckResult = {
  name: string;
  status: "passed" | "failed" | "blocked" | "skipped";
  detail: string;
};

function runMimo(args: string[]): { ok: boolean; output: string } {
  const result = spawnSync("mimo", args, {
    encoding: "utf8",
    timeout: 30_000,
    shell: false,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  return { ok: result.status === 0, output };
}

export function preflightMimoAvailable(): LiveCheckResult {
  const probe = runMimo(["--version"]);
  if (!probe.ok) {
    return {
      name: "M01 MiMo CLI 可用性",
      status: "blocked",
      detail: probe.output || "mimo 命令不可用（本机未安装或不在 PATH）",
    };
  }
  return {
    name: "M01 MiMo CLI 可用性",
    status: "passed",
    detail: probe.output.split("\n")[0] ?? "",
  };
}

export function listMimoModels(): LiveCheckResult {
  const probe = runMimo(["models", "--verbose"]);
  if (!probe.ok) {
    return {
      name: "M02/M08 模型目录可列出",
      status: "blocked",
      detail: probe.output || "models --verbose 失败",
    };
  }
  const hasPro = /mimo-v2\.6-pro|provider\/model/i.test(probe.output);
  const hasFlash = /mimo-v2\.6-flash/i.test(probe.output);
  return {
    name: "M02/M08 模型目录可列出",
    status: hasPro || hasFlash ? "passed" : "failed",
    detail: hasPro && hasFlash
      ? "目录含 Pro 与 Flash"
      : "目录缺少目标模型，记录实际输出供人工判断",
  };
}

/** 真机验收清单（需人工执行并记录，不可用 fixture 替代）。 */
export const LIVE_ACCEPTANCE_CHECKLIST = [
  "M01 未安装/路径错误/输出不兼容时清楚报运行能力问题，不换其他 CLI",
  "M02 Pro 与 Flash 各自保存配置并派发，完整 provider/model 准确传递",
  "M03 verbose 模型目录含 JSON/中文/variant 时正确关联",
  "M04 MiMo 与 OpenCode 的 profile/登录/session/授权缓存互不串用",
  "M05 Windows 中文目录、空格、长提示词、npm 包装器可启动",
  "M06 JSON 事件分块/error/无文本/非目标 session 结束不误报完成",
  "M07 不支持的 variant 或目标模型明确不支持，不静默降级",
  "M08 目录可列出但真实调用报授权/额度错误时只展示真实失败",
  "D12-1 Pro 与 Flash 各完成一次真实读写文件的受控任务",
  "D12-2 每个模型至少一次按明确 session ID 续接",
  "D12-3 MiMo 执行 + 既有规划的完整主流程；MiMo 规划的质量修复及提交",
  "D12-4 执行整改后规划修 → 执行测 → 直接人工（无追加复核）",
  "D12-5 人工反馈 → 执行修测 → 最终复核问题 → 规划修 → 执行测试 → 直接规划提交",
] as const;
