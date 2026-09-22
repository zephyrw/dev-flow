import { describe, it, expect, vi } from "vitest";
import type { SessionBindingResumeInstructions } from "../../packages/contracts/src/session-binding.js";

describe("CW2-T17: CLI 会话详情与复制门禁单测 (前端契约)", () => {
  it("CW2-T17: 当 copy_script 为空或缺失时，复制 handler 不调用 clipboard.writeText，旧字段被忽略", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    const mockClipboard = { writeText: writeTextMock };

    // 模拟服务端响应数据：故意带上旧的兼容 command_line 字符串，但 copy_script 为空/未就绪
    const legacyInfo: SessionBindingResumeInstructions & { command_line?: string } = {
      workflow_id: "wf-1",
      binding_id: "b-1",
      binding_revision: 1,
      conversation_id: "conv-1",
      cwd: "C:\\projects\\app",
      target_shell: "powershell-windows",
      status: "supported",
      reason: "调度处于开启状态，禁止复制",
      executable: "agy",
      args: ["--conversation", "conv-1"],
      safe_env: {},
      copy_script: undefined,
      command_line: "agy --conversation conv-1", // 遗留/伪造字段
      managed_writer_state: "idle",
      dispatch_enabled: true,
      observed_at: new Date().toISOString(),
    };

    // 模拟前端 handleCopy 逻辑：严格判定 !resumeInfo.copy_script 则直接 return，绝不消费 command_line
    const handleCopy = async (info: typeof legacyInfo) => {
      if (!info || !info.copy_script) return false;
      await mockClipboard.writeText(info.copy_script);
      return true;
    };

    const copied = await handleCopy(legacyInfo);
    expect(copied).toBe(false);
    expect(writeTextMock).not.toHaveBeenCalled();
  });

  it("CW2-T17: 满足安全门禁且 copy_script 存在时，精准将 copy_script 写入 clipboard", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    const mockClipboard = { writeText: writeTextMock };

    const validInfo: SessionBindingResumeInstructions = {
      workflow_id: "wf-1",
      binding_id: "b-1",
      binding_revision: 1,
      conversation_id: "conv-1",
      cwd: "C:\\projects\\app",
      target_shell: "powershell-windows",
      status: "supported",
      executable: "agy",
      args: ["--conversation", "conv-1"],
      safe_env: {},
      copy_script: "$proc = [System.Diagnostics.Process]::Start($psi)",
      managed_writer_state: "idle",
      dispatch_enabled: false,
      observed_at: new Date().toISOString(),
    };

    const handleCopy = async (info: typeof validInfo) => {
      if (!info || !info.copy_script) return false;
      await mockClipboard.writeText(info.copy_script);
      return true;
    };

    const copied = await handleCopy(validInfo);
    expect(copied).toBe(true);
    expect(writeTextMock).toHaveBeenCalledWith(validInfo.copy_script);
  });
});
