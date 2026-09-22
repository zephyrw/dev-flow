import { describe, it, expect } from "vitest";
import {
  generateResumeInstructions,
  buildPowerShellScript,
  encodeWindowsArgv,
  INJECTED_DEVFLOW_ENV_VARS,
} from "../../packages/adapters/sdk/src/resume-instructions.js";

describe("CW2-T17 & CW2-T18: CLI 续接 PowerShell 脚本生成与安全门禁测试", () => {
  it("CW2-T17: 门禁拦截——dispatch 开启、写者非空闲、retired/unavailable 均不生成 copy_script", () => {
    // 1. dispatchEnabled === true 时无 copy_script
    const resDispatchOpen = generateResumeInstructions({
      bindingId: "b1",
      workflowId: "wf1",
      adapterId: "agy",
      conversationId: "conv-1",
      cwd: "C:\\projects\\app",
      dispatchEnabled: true,
      managedWriterState: "idle",
    });
    expect(resDispatchOpen.copy_script).toBeUndefined();
    expect(resDispatchOpen.reason).toContain("自动调度当前处于开启状态");

    // 2. managedWriterState 为 active 时无 copy_script
    const resWriterActive = generateResumeInstructions({
      bindingId: "b1",
      workflowId: "wf1",
      adapterId: "agy",
      conversationId: "conv-1",
      cwd: "C:\\projects\\app",
      dispatchEnabled: false,
      managedWriterState: "active",
    });
    expect(resWriterActive.copy_script).toBeUndefined();
    expect(resWriterActive.reason).toContain("存在受管调用写者");

    // 3. bindingState 为 retired 时无 copy_script
    const resRetired = generateResumeInstructions({
      bindingId: "b1",
      workflowId: "wf1",
      adapterId: "codex",
      conversationId: "conv-1",
      cwd: "C:\\projects\\app",
      bindingState: "retired",
      dispatchEnabled: false,
      managedWriterState: "idle",
    });
    expect(resRetired.copy_script).toBeUndefined();
    expect(resRetired.status).toBe("unsupported");
    expect(resRetired.reason).toContain("retired");

    // 4. 未核验工具无 copy_script
    const resUnsupported = generateResumeInstructions({
      bindingId: "b1",
      workflowId: "wf1",
      adapterId: "claude-code",
      conversationId: "conv-1",
      cwd: "C:\\projects\\app",
      dispatchEnabled: false,
      managedWriterState: "idle",
    });
    expect(resUnsupported.copy_script).toBeUndefined();
    expect(resUnsupported.status).toBe("unsupported");
  });

  it("CW2-T17: 特殊字符、引号、反斜杠与表达式必须安全字面编码，控制字符被拒绝", () => {
    // 特殊字符参数测试
    const argSpecial = 'foo "bar" baz\\ \\" $(Get-Process) `test% &';
    const encoded = encodeWindowsArgv(argSpecial);
    expect(encoded.startsWith('"')).toBe(true);
    expect(encoded.endsWith('"')).toBe(true);

    // 换行符等控制字符必须抛错
    expect(() => encodeWindowsArgv("bad\narg")).toThrow(/包含非法控制字符/);
    expect(() => encodeWindowsArgv("bad\rarg")).toThrow(/包含非法控制字符/);
    expect(() => encodeWindowsArgv("bad\0arg")).toThrow(/包含非法控制字符/);
  });

  it("CW2-T18: 生成脚本清理 DEVFLOW 内部注入环境变量且设置 $global:LASTEXITCODE，不使用 exit 退出 shell", () => {
    const script = buildPowerShellScript(
      "C:\\Tools\\fake-agy.exe",
      "C:\\projects\\my-worktree",
      ["--conversation", "conv-999"],
      { CUSTOM_ENV: "val123" },
    );

    // 验证不包含 exit 语句（避免关闭用户交互终端）
    expect(script).not.toMatch(/\bexit\b/i);
    // 验证设置 $global:LASTEXITCODE
    expect(script).toContain("$global:LASTEXITCODE = $proc.ExitCode");
    // 验证清理真实 DEVFLOW 注入变量
    for (const v of INJECTED_DEVFLOW_ENV_VARS) {
      expect(script).toContain(v);
    }
    // 验证包含 safeEnv
    expect(script).toContain("CUSTOM_ENV");
    expect(script).toContain("val123");
  });

  it("CW2-T18: 满足全部安全门禁时成功生成受支持工具的 copy_script", () => {
    const resAgy = generateResumeInstructions({
      bindingId: "b-ok",
      workflowId: "wf-ok",
      adapterId: "agy",
      conversationId: "conv-ok-123",
      cwd: "C:\\workspaces\\demo",
      dispatchEnabled: false,
      managedWriterState: "idle",
      modelId: "gemini-2.5-pro",
      executablePath: "C:\\Tools\\agy.exe",
    });

    expect(resAgy.status).toBe("supported");
    expect(resAgy.copy_script).toBeDefined();
    expect(resAgy.copy_script).toContain("conv-ok-123");
    expect(resAgy.copy_script).toContain("gemini-2.5-pro");
  });
});
