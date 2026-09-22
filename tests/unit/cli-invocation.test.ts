import { describe, it, expect } from "vitest";
import { clientInvocation } from "../../packages/adapters/sdk/src/invocation.js";
import { agyArguments } from "../../packages/adapters/agy/src/session.js";
import { generateResumeInstructions } from "../../packages/adapters/sdk/src/resume-instructions.js";
import type { RunContext } from "../../packages/adapters/sdk/src/interface.js";

describe("NV-U07 & NV-U02: CLI调用参数与手动续接指令", () => {
  const baseRunContext: RunContext = {
    workflowId: "wf-test-123",
    runId: "run-test-456",
    epoch: 1,
    stage: "planning",
    purpose: "planning",
    workspaceRoots: { main: "C:/Code/crm/crm" },
    allowedPaths: ["app.txt"],
    toolProfile: {
      adapter: "agy",
      modelSelection: "explicit",
      modelId: "gemini-2.5-pro",
    } as any,
    prompt: "请制定计划",
  };

  describe("clientInvocation: agy 适配器参数", () => {
    it("初次启动且无 conversationId 时，不包含 --new-project 或伪项目注册", () => {
      const inv = clientInvocation("agy", baseRunContext, "agy.cmd");
      expect(inv.args).not.toContain("--new-project");
      expect(inv.args).not.toContain("--project");
      expect(inv.args).toContain("--output-format");
      expect(inv.args).toContain("stream-json");
      expect(inv.args).toContain("--model");
      expect(inv.args).toContain("gemini-2.5-pro");
      expect(inv.args).toContain("--mode");
      expect(inv.args).toContain("plan"); // planning is readonly
      expect(inv.args).toContain("-p");
      expect(inv.args).toContain("请制定计划");
      expect(inv.cwd).toBe("C:/Code/crm/crm");
    });

    it("续接启动且有 conversationId 时，生成 --conversation 参数", () => {
      const resumeContext: RunContext = {
        ...baseRunContext,
        stage: "execute",
        purpose: "implement",
        conversationId: "conv-agy-987",
      };
      const inv = clientInvocation("agy", resumeContext, "agy.cmd");
      expect(inv.args).toContain("--conversation");
      expect(inv.args).toContain("conv-agy-987");
      expect(inv.args).not.toContain("--new-project");
      expect(inv.args).not.toContain("--project");
      expect(inv.args).toContain("--mode");
      expect(inv.args).toContain("accept-edits"); // execution is read-write
    });

    it("显式传入 projectId 时生成 --project 参数", () => {
      const projectContext: RunContext = {
        ...baseRunContext,
        projectId: "proj-native-111",
      } as any;
      const inv = clientInvocation("agy", projectContext, "agy.cmd");
      expect(inv.args).toContain("--project");
      expect(inv.args).toContain("proj-native-111");
      expect(inv.args).not.toContain("--new-project");
    });
  });

  describe("agyArguments: 底层参数构造函数", () => {
    it("无会话与无项目时不带 --new-project", () => {
      const args = agyArguments("gemini-2.5-flash", "测试prompt", 5);
      expect(args).not.toContain("--new-project");
      expect(args).toContain("--model");
      expect(args).toContain("gemini-2.5-flash");
      expect(args).toContain("-p");
      expect(args).toContain("测试prompt");
    });

    it("带会话ID时传入 --conversation", () => {
      const args = agyArguments("gemini-2.5-flash", "测试prompt", 5, "conv-001");
      expect(args).toContain("--conversation");
      expect(args).toContain("conv-001");
      expect(args).not.toContain("--project");
    });
  });

  describe("clientInvocation: codex 适配器参数", () => {
    it("只读阶段生成 sandbox_mode=read-only 与 approval_policy=never", () => {
      const codexContext: RunContext = {
        ...baseRunContext,
        toolProfile: {
          adapter: "codex",
          modelSelection: "explicit",
          modelId: "gpt-5-codex",
        } as any,
      };
      const inv = clientInvocation("codex", codexContext, "codex.cmd");
      expect(inv.args).toContain("exec");
      expect(inv.args).toContain("-c");
      expect(inv.args).toContain('sandbox_mode="read-only"');
      expect(inv.args).toContain('approval_policy="never"');
      expect(inv.stdin).toBe("请制定计划");
    });

    it("执行阶段生成 sandbox_mode=workspace-write 且支持 resume", () => {
      const codexContext: RunContext = {
        ...baseRunContext,
        stage: "execute",
        purpose: "implement",
        conversationId: "thread-codex-abc",
        toolProfile: {
          adapter: "codex",
          modelSelection: "explicit",
          modelId: "gpt-5-codex",
        } as any,
      };
      const inv = clientInvocation("codex", codexContext, "codex.cmd");
      expect(inv.args).toContain("exec");
      expect(inv.args).toContain('sandbox_mode="workspace-write"');
      expect(inv.args).toContain("resume");
      expect(inv.args).toContain("thread-codex-abc");
    });
  });

  describe("generateResumeInstructions: 手动续接指令与安全占用提示", () => {
    it("生成 agy CLI 续接命令与占用提示", () => {
      const res = generateResumeInstructions({
        bindingId: "bind-1",
        workflowId: "wf-1",
        adapterId: "agy",
        conversationId: "conv-12345",
        cwd: "C:/Code/crm/crm",
        managedWriterState: "active",
        dispatchEnabled: false,
        modelId: "gemini-2.5-pro",
        executablePath: "agy",
      });

      // CW2-F17 / CW2-F18: 占用存在时阻止提供 copy_script
      expect(res.copy_script).toBeUndefined();
      expect(res.reason).toBeDefined();
    });

    it("生成 codex CLI 续接命令，无占用且调度停用时生成可执行安全脚本", () => {
      const res = generateResumeInstructions({
        bindingId: "bind-2",
        workflowId: "wf-2",
        adapterId: "codex",
        conversationId: "thread-789",
        cwd: "C:/Code/crm/crm",
        managedWriterState: "idle",
        dispatchEnabled: false,
        executablePath: "codex",
      });

      // CW-D13 / CW2-D07: Codex 交互 resume <exact-id>
      expect(res.copy_script).toBeDefined();
      expect(res.copy_script).toContain("codex");
      expect(res.copy_script).toContain("resume");
      expect(res.copy_script).toContain('"thread-789"');
      expect(res.reason).toBeUndefined();
    });
  });
});
