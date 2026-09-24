import { describe, expect, it } from "vitest";
import { resolveAgyExecutable } from "../../packages/adapters/agy/src/executable-resolver.js";
import {
  evaluateCapabilitySnapshot,
} from "../../packages/adapters/agy/src/account-capability-registry.js";
import {
  parseModelAccessOutput,
} from "../../packages/adapters/agy/src/account-probe.js";
import { parseAgyUsageOutput } from "../../packages/adapters/agy/src/quota-parser.js";

describe("W02 AGY 发现、能力与真实输出适配测试", () => {
  it("D01: resolveAgyExecutable 默认命令名通过 PATH 解析，明确无效路径报错", () => {
    // 默认命令名
    const resolved = resolveAgyExecutable("agy");
    expect(resolved.source).not.toBe("explicit_file");
    if (resolved.resolvedPath) {
      expect(resolved.resolvedPath.toLowerCase()).toMatch(/agy(\.exe|\.cmd)?$/);
    }

    // 显式指定不存在的路径直接报错且 source 为 explicit_file，绝不替换为其他文件
    const badExplicit = resolveAgyExecutable("./non_existent_path/fake_agy.exe");
    expect(badExplicit.source).toBe("explicit_file");
    expect(badExplicit.error).toContain("不存在");
    expect(badExplicit.resolvedPath).toBeUndefined();
  });

  it("D02: evaluateCapabilitySnapshot 区分 detected/supported/verified，不伪造 verified", () => {
    const hostCaps = {
      platform: "win32",
      version: "3.0.0-node",
      dpapi_available: true,
      cred_manager_available: true,
      named_mutex_available: true,
    };

    // 仅发现 CLI 版本，无真实核验证据
    const snapDetected = evaluateCapabilitySnapshot(
      { version: "1.2.8", sha256: "hash123", path: "C:/bin/agy.exe" },
      hostCaps,
    );
    expect(snapDetected.supported).toBe(true);
    // 身份和额度状态应为 unverified，而不是 verified
    expect(snapDetected.capabilities.identity.status).toBe("unverified");
    expect(snapDetected.capabilities.dual_quota.status).toBe("unverified");

    // 传入真实核验证据时为 verified
    const snapVerified = evaluateCapabilitySnapshot(
      { version: "1.2.8", sha256: "hash123", path: "C:/bin/agy.exe" },
      hostCaps,
      {
        identityVerified: true,
        dualQuotaVerified: true,
        loginVerified: true,
        modelAccessVerified: true,
      },
    );
    expect(snapVerified.capabilities.identity.status).toBe("verified");
    expect(snapVerified.capabilities.dual_quota.status).toBe("verified");
    expect(snapVerified.capabilities.interactive_login.status).toBe("verified");
    expect(snapVerified.capabilities.model_access.status).toBe("verified");
  });

  it("D05: parseModelAccessOutput 缺少 model 证据拒绝，严格匹配", () => {
    // 只有 init 和 result，缺少 model 证据
    const noModelOutput = [
      JSON.stringify({ event: "init", session_id: "s1" }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");

    const resNoModel = parseModelAccessOutput(noModelOutput, {
      modelId: "gemini-3.8-flash-high",
    });
    expect(resNoModel.success).toBe(false);
    expect(resNoModel.reason).toBe("missing_model_evidence");

    // 模型不匹配
    const mismatchOutput = [
      JSON.stringify({ event: "init", model: "claude-3-opus" }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");
    const resMismatch = parseModelAccessOutput(mismatchOutput, {
      modelId: "gemini-3.8-flash-high",
    });
    expect(resMismatch.success).toBe(false);
    expect(resMismatch.reason).toBe("model_mismatch");

    // 匹配且成功
    const matchedOutput = [
      JSON.stringify({ event: "init", model: "gemini-3.8-flash-high" }),
      JSON.stringify({ event: "result", result: { status: "SUCCESS" } }),
    ].join("\n");
    const resMatched = parseModelAccessOutput(matchedOutput, {
      modelId: "gemini-3.8-flash-high",
    });
    expect(resMatched.success).toBe(true);
  });

  it("解析真实 CLI 制表符格式的双额度", () => {
    const realCliOutput = [
      "Gemini Models\tWeekly Limit Remaining\t85%\t2026-09-30T09:58:52Z",
      "Gemini Models\tFive Hour Limit Remaining\t21%\t2026-09-24T05:33:38Z",
      "Claude and GPT models\tWeekly Limit Remaining\t100%\t2026-10-01T02:24:16Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t100%\t2026-09-24T07:24:16Z",
    ].join("\n");

    const parsed = parseAgyUsageOutput(realCliOutput);
    expect(parsed.windows).toHaveLength(2);
    const weekly = parsed.windows.find((w) => w.kind === "weekly");
    const fiveHour = parsed.windows.find((w) => w.kind === "five_hour");
    expect(weekly?.remaining_fraction).toBe(0.85);
    expect(weekly?.reset_at).toBe("2026-09-30T09:58:52.000Z");
    expect(fiveHour?.remaining_fraction).toBe(0.21);
    expect(fiveHour?.reset_at).toBe("2026-09-24T05:33:38.000Z");
    expect(parsed.pools).toHaveLength(2);
  });
});
