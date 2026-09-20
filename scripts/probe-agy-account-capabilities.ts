import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import os from "node:os";
import { parseAgyUsageOutput } from "../packages/adapters/agy/src/quota-parser.js";

const execFileAsync = promisify(execFile);

const CLI_PATH = process.env.AGY_CLI_PATH || "";
const IS_WINDOWS = process.platform === "win32";

interface CapabilityReport {
  timestamp: string;
  cli_path: string;
  cli_exists: boolean;
  cli_version: string;
  cli_sha256: string;
  help_output_snippet: string;
  supports_conversation: boolean;
  supports_model: boolean;
  supports_effort: boolean;
  supports_output_format: boolean;
  supports_print_timeout: boolean;
  credential_source: {
    windows_credential_target: string;
    has_windows_credential?: boolean;
    gemini_dir_exists?: boolean;
  };
  usage_probe: {
    command: string;
    exit_code: number | null;
    raw_stdout: string;
    raw_stderr: string;
    duration_ms: number;
    parsed: {
      account_email?: string;
      plan_tier?: string;
      weekly_quota?: {
        remaining_fraction: number | null;
        reset_at: string | null;
        status: "observed" | "missing" | "unsupported";
      };
      five_hour_quota?: {
        remaining_fraction: number | null;
        reset_at: string | null;
        status: "observed" | "missing" | "unsupported";
      };
      pools: Array<{
        pool_id: string;
        models: string[];
      }>;
    };
  };
  evaluation: {
    has_identity: boolean;
    has_weekly: boolean;
    has_five_hour: boolean;
    has_resets: boolean;
    can_enable_auto_switch: boolean;
    notes: string[];
  };
}

function sanitizeEmail(email?: string): string {
  if (!email) return "";
  const parts = email.split("@");
  if (parts.length !== 2) return "masked@example.com";
  const name = parts[0];
  const maskedName = name.length > 2 ? `${name.slice(0, 2)}***` : `${name}***`;
  return `${maskedName}@${parts[1]}`;
}

function parseUsageText(text: string): CapabilityReport["usage_probe"]["parsed"] {
  // This strict fixture parser is useful for research observations only. It
  // does not establish an official, fingerprint-bound production contract.
  const parsed = parseAgyUsageOutput(text);
  const window = (kind: "weekly" | "five_hour") => {
    const value = parsed.windows.find(item => item.kind === kind)!;
    return {
      remaining_fraction: value.remaining_fraction,
      reset_at: value.reset_at,
      status: value.status === "observed" ? "observed" as const : "missing" as const,
    };
  };
  return { account_email: parsed.email, plan_tier: parsed.plan_tier,
    weekly_quota: window("weekly"), five_hour_quota: window("five_hour"), pools: [] };
}

async function main() {
  console.log("=== AC-D00 AGY CLI 能力调查与样本采集 ===");
  const cliExists = existsSync(CLI_PATH);
  console.log(`CLI Path: ${CLI_PATH}, Exists: ${cliExists}`);

  let cliVersion = "unknown";
  let cliSha256 = "unknown";
  let helpSnippet = "";
  let supportsConversation = false;
  let supportsModel = false;
  let supportsEffort = false;
  let supportsOutputFormat = false;
  let supportsPrintTimeout = false;

  if (cliExists) {
    try {
      const fileBytes = readFileSync(CLI_PATH);
      cliSha256 = createHash("sha256").update(fileBytes).digest("hex");
    } catch (err) {
      console.warn("读取 CLI 文件计算 SHA-256 失败:", err);
    }

    try {
      const { stdout } = await execFileAsync(CLI_PATH, ["--version"], { timeout: 10000 });
      cliVersion = stdout.trim();
      console.log(`CLI Version: ${cliVersion}`);
    } catch (err: any) {
      console.warn("获取 CLI 版本失败，状态为未验证。");
    }

    try {
      const { stdout } = await execFileAsync(CLI_PATH, ["--help"], { timeout: 10000 });
      helpSnippet = stdout.slice(0, 1000);
      supportsConversation = stdout.includes("--conversation");
      supportsModel = stdout.includes("--model");
      supportsEffort = stdout.includes("--effort");
      supportsOutputFormat = stdout.includes("--output-format");
      supportsPrintTimeout = stdout.includes("--print-timeout");
    } catch (err: any) {
      console.warn("获取 CLI 帮助失败，参数能力状态为未验证。");
    }
  }

  // 检查凭据与目录
  const geminiDir = join(os.homedir(), ".gemini");
  const geminiDirExists = existsSync(geminiDir);

  // 独立隔离环境执行 /usage
  const scratchDir = resolve(".cache/agy-probe-scratch");
  mkdirSync(scratchDir, { recursive: true });

  const usageCommand = `${CLI_PATH} -p "/usage" --output-format text --print-timeout 30s`;
  let usageExitCode: number | null = null;
  let usageStdout = "";
  let usageStderr = "";
  const startTime = Date.now();

  try {
    if (!process.argv.includes("--probe")) throw new Error("usage_probe_not_requested: pass --probe only during an authorized exclusive account window");
    console.log(`执行探测命令: ${usageCommand}`);
    const result = await execFileAsync(
      CLI_PATH,
      ["-p", "/usage", "--output-format", "text", "--print-timeout", "30s"],
      {
        cwd: scratchDir,
        timeout: 35000,
        env: {
          ...process.env,
          // 隔离 CWD，不注入会话
        },
      }
    );
    usageExitCode = 0;
    usageStdout = result.stdout;
    usageStderr = result.stderr;
  } catch (err: any) {
    usageExitCode = typeof err.code === "number" ? err.code : null;
    usageStdout = err.stdout ?? "";
    usageStderr = err.stderr ?? (err.message || String(err));
    console.warn(`执行 /usage 未成功，退出码: ${usageExitCode}`);
  }
  const durationMs = Date.now() - startTime;

  const parsed = parseUsageText(usageExitCode === 0 ? usageStdout : "");

  const notes: string[] = [];
  const hasIdentity = !!parsed.account_email;
  const hasWeekly = parsed.weekly_quota?.status === "observed";
  const hasFiveHour = parsed.five_hour_quota?.status === "observed";
  const hasResets = !!(parsed.weekly_quota?.reset_at && parsed.five_hour_quota?.reset_at);

  if (!cliExists) {
    notes.push("CLI 可执行文件不存在于指定路径。");
  }
  if (!hasIdentity) {
    notes.push("未从 /usage 输出中匹配到账户邮箱/身份。");
  }
  if (!hasWeekly) {
    notes.push("未从 /usage 输出中观察到周额度(Weekly quota)。");
  }
  if (!hasFiveHour) {
    notes.push("未从 /usage 输出中观察到五小时额度(5-Hour quota)。");
  }
  if (!hasResets) {
    notes.push("额度重置时间(reset_at)不完整或未提供。");
  }

  // Collecting text is not a fingerprint-bound production parser contract.
  const canEnableAutoSwitch = false;
  notes.push("本脚本仅采集观测，不签发生产切号能力；需确认官方输出的目标池映射、字段语义与CLI指纹。");
  notes.push("未建立已验证官方能力合同；自动和手动切号均不可据此启用，账号额度保持待补测。");

  const report: CapabilityReport = {
    timestamp: new Date().toISOString(),
    cli_path: CLI_PATH,
    cli_exists: cliExists,
    cli_version: cliVersion,
    cli_sha256: cliSha256,
    help_output_snippet: helpSnippet,
    supports_conversation: supportsConversation,
    supports_model: supportsModel,
    supports_effort: supportsEffort,
    supports_output_format: supportsOutputFormat,
    supports_print_timeout: supportsPrintTimeout,
    credential_source: {
      windows_credential_target: "gemini:antigravity",
      gemini_dir_exists: geminiDirExists,
    },
    usage_probe: {
      command: usageCommand,
      exit_code: usageExitCode,
      raw_stdout: usageStdout,
      raw_stderr: usageStderr,
      duration_ms: durationMs,
      parsed,
    },
    evaluation: {
      has_identity: hasIdentity,
      has_weekly: hasWeekly,
      has_five_hour: hasFiveHour,
      has_resets: hasResets,
      can_enable_auto_switch: canEnableAutoSwitch,
      notes,
    },
  };

  // 保存 fixtures
  const fixturesDir = resolve("tests/fixtures/agy-accounts");
  mkdirSync(fixturesDir, { recursive: true });

  // 原始脱敏
  const sanitizedStdout = usageStdout.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    (m) => sanitizeEmail(m)
  );
  writeFileSync(join(fixturesDir, "cli-usage-sample.txt"), sanitizedStdout, "utf8");

  const sanitizedParsed = {
    ...parsed,
    account_email: sanitizeEmail(parsed.account_email),
  };
  writeFileSync(join(fixturesDir, "cli-usage-parsed.json"), JSON.stringify(sanitizedParsed, null, 2), "utf8");

  // 生成 docs/test/AGY账号能力验证-20260920.md
  const docsDir = resolve("docs/test");
  mkdirSync(docsDir, { recursive: true });

  const mdReport = `# AGY 账号能力验证报告 (AC-D00)

- **验证时间**：${report.timestamp}
- **CLI 路径**：\`${report.cli_path}\`
- **CLI 存在**：${report.cli_exists ? "是" : "否"}
- **版本**：\`${report.cli_version}\`
- **文件 SHA-256**：\`${report.cli_sha256}\`

## 1. 命令行参数支持核验

| 参数 | 支持状态 |
| --- | --- |
| \`--conversation\` | ${report.supports_conversation ? "帮助中已观察到" : "未验证"} |
| \`--model\` | ${report.supports_model ? "帮助中已观察到" : "未验证"} |
| \`--effort\` | ${report.supports_effort ? "帮助中已观察到" : "未验证"} |
| \`--output-format\` | ${report.supports_output_format ? "帮助中已观察到" : "未验证"} |
| \`--print-timeout\` | ${report.supports_print_timeout ? "帮助中已观察到" : "未验证"} |

## 2. 凭据来源核查

- **目标平台**：Windows
- **凭据管理器目标**：\`${report.credential_source.windows_credential_target}\` (CRED_TYPE_GENERIC)
- **用户目录 \`.gemini\` 存在**：${report.credential_source.gemini_dir_exists ? "是" : "否"}

## 3. 官方 \`/usage\` 实测探测

- **执行命令**：\`${report.usage_probe.command}\`
- **退出码**：\`${report.usage_probe.exit_code}\`
- **耗时**：${report.usage_probe.duration_ms} ms
- **身份邮箱**：\`${sanitizedParsed.account_email || "未检出"}\`
- **周额度 (Weekly)**：${parsed.weekly_quota?.status === "observed" ? `${(parsed.weekly_quota.remaining_fraction ?? 0) * 100}% (重置: ${parsed.weekly_quota.reset_at || "未知"})` : "未检出"}
- **五小时额度 (5-Hour)**：${parsed.five_hour_quota?.status === "observed" ? `${(parsed.five_hour_quota.remaining_fraction ?? 0) * 100}% (重置: ${parsed.five_hour_quota.reset_at || "未知"})` : "未检出"}

## 4. 结论与评估

- **候选身份字段**：${report.evaluation.has_identity ? "已观察到，正式语义未验证" : "未观察到"}
- **候选双额度字段**：${report.evaluation.has_weekly && report.evaluation.has_five_hour ? "已观察到，正式语义未验证" : "需补测/受限"}
- **重置时间具备**：${report.evaluation.has_resets ? "具备" : "缺失/待定"}
- **允许启用切号**：未验证官方能力，自动和手动切号均不可启用

### 评估备忘：
${report.evaluation.notes.map((n) => `- ${n}`).join("\n")}
`;

  writeFileSync(join(docsDir, "AGY账号能力验证-20260920.md"), mdReport, "utf8");
  console.log("报告生成完成: docs/test/AGY账号能力验证-20260920.md");
}

main().catch((err) => {
  console.error("能力调查执行失败:", err);
  process.exit(1);
});
