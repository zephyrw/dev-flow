import { describe, it, expect, beforeEach } from "vitest";
import {
  createApprovedExecutionInstructions,
  formatExecutionInstructionsForPrompt,
  verifyAndResolveExecutionInstructions,
} from "../../packages/core/src/execution-instructions.js";
import { normalizeInstructionsText } from "../../packages/contracts/src/plan-approval.js";
import { hash } from "../../packages/core/src/util.js";

describe("W04: 计划审批附加执行指令端到端单元测试", () => {
  describe("1. 附加指令规范化与 Hash 计算", () => {
    it("正确处理 CRLF 统一为 \\n，首尾空白 trim，保留内部缩进和代码块", () => {
      const raw = "\r\n  ```ts\r\nconst a = 1;\r\n  ```\r\n  ";
      const normalized = normalizeInstructionsText(raw);
      expect(normalized).toBe("```ts\nconst a = 1;\n  ```");
      const instructions = createApprovedExecutionInstructions(raw);
      expect(instructions.text).toBe(normalized);
      expect(instructions.text_hash).toBe(hash(normalized));
      expect(instructions.scope).toBe("approved-plan");
      expect(instructions.schema_version).toBe(1);
    });

    it("空指令或未提供指令时返回空文本和对应 hash", () => {
      const emptyInstructions = createApprovedExecutionInstructions("");
      expect(emptyInstructions.text).toBe("");
      expect(emptyInstructions.text_hash).toBe(hash(""));

      const nullInstructions = createApprovedExecutionInstructions(null);
      expect(nullInstructions.text).toBe("");
      expect(nullInstructions.text_hash).toBe(hash(""));
    });

    it("超过 20000 字符限制时抛出明确异常", () => {
      const longText = "a".repeat(20001);
      expect(() => normalizeInstructionsText(longText)).toThrow(/过长/);
    });
  });

  describe("2. 自然语言分节与 Prompt 组合", () => {
    it("空指令时不追加任何分节", () => {
      const prompt = formatExecutionInstructionsForPrompt(null);
      expect(prompt).toBe("");
      const emptyPrompt = formatExecutionInstructionsForPrompt(
        createApprovedExecutionInstructions("   "),
      );
      expect(emptyPrompt).toBe("");
    });

    it("非空指令时生成包含清晰 Markdown 分节和持续约束说明的提示词", () => {
      const instructions = createApprovedExecutionInstructions("不要删除失败断言；复用现有组件。");
      const prompt = formatExecutionInstructionsForPrompt(instructions);
      expect(prompt).toContain("## 审批附加执行指令（必须遵循的约束）");
      expect(prompt).toContain("不要删除失败断言；复用现有组件。");
      expect(prompt).toContain("已生效的持续约束");
    });
  });

  describe("3. 执行轮次指令材料解析与校验 (verifyAndResolveExecutionInstructions)", () => {
    const fakeStore = new Map<string, any>();
    const mockStore = {
      get: (table: string, key: string) => fakeStore.get(`${table}:${key}`),
    };

    beforeEach(() => {
      fakeStore.clear();
    });

    it("正常情况：带 RunApprovalRef 的运行成功解析并组装 payload", () => {
      const workflowId = "wf-1";
      const planRevision = 2;
      const planHash = "plan-hash-123";
      const instructions = createApprovedExecutionInstructions("先测后改");

      const approvalRecord = {
        schema_version: 2,
        workflow_id: workflowId,
        plan_revision: planRevision,
        revision: planRevision,
        plan_hash: planHash,
        request_id: "req-1",
        approved_at: new Date().toISOString(),
        execution_instructions: instructions,
      };
      fakeStore.set(`approval:${workflowId}-${planRevision}`, approvalRecord);

      const run = {
        approval_ref: {
          approval_id: `${workflowId}-${planRevision}`,
          plan_revision: planRevision,
          plan_hash: planHash,
          instructions_hash: instructions.text_hash,
        },
      };

      const result = verifyAndResolveExecutionInstructions(
        mockStore,
        workflowId,
        run,
        planRevision,
        planHash,
      );

      expect(result.instructions?.text).toBe("先测后改");
      expect(result.payload).toEqual({
        approval_id: `${workflowId}-${planRevision}`,
        plan_revision: planRevision,
        plan_hash: planHash,
        text: "先测后改",
        text_hash: instructions.text_hash,
        scope: "approved-plan",
      });
    });

    it("异常阻断：approval 不存在时阻止派发并报错", () => {
      const run = {
        approval_ref: {
          approval_id: "wf-1-2",
          plan_revision: 2,
          plan_hash: "hash",
          instructions_hash: "inst-hash",
        },
      };
      expect(() =>
        verifyAndResolveExecutionInstructions(mockStore, "wf-1", run, 2, "hash"),
      ).toThrow(/审批记录缺失/);
    });

    it("跨任务隔离：审批记录所属 workflow 不匹配时阻止派发", () => {
      const approvalRecord = {
        schema_version: 2,
        workflow_id: "wf-other",
        plan_revision: 1,
        revision: 1,
        plan_hash: "hash",
        execution_instructions: createApprovedExecutionInstructions("test"),
      };
      fakeStore.set("approval:wf-1-1", approvalRecord);

      const run = {
        approval_ref: {
          approval_id: "wf-1-1",
          plan_revision: 1,
          plan_hash: "hash",
          instructions_hash: approvalRecord.execution_instructions.text_hash,
        },
      };
      expect(() =>
        verifyAndResolveExecutionInstructions(mockStore, "wf-1", run, 1, "hash"),
      ).toThrow(/审批归属不符/);
    });

    it("哈希篡改防护：计划哈希或指令哈希不一致时阻止派发", () => {
      const instructions = createApprovedExecutionInstructions("原指令");
      const approvalRecord = {
        schema_version: 2,
        workflow_id: "wf-1",
        plan_revision: 1,
        revision: 1,
        plan_hash: "hash-real",
        execution_instructions: instructions,
      };
      fakeStore.set("approval:wf-1-1", approvalRecord);

      // 1. 计划哈希篡改
      const runBadPlan = {
        approval_ref: {
          approval_id: "wf-1-1",
          plan_revision: 1,
          plan_hash: "hash-tampered",
          instructions_hash: instructions.text_hash,
        },
      };
      expect(() =>
        verifyAndResolveExecutionInstructions(
          mockStore,
          "wf-1",
          runBadPlan,
          1,
          "hash-real",
        ),
      ).toThrow(/计划哈希不一致/);

      // 2. 指令哈希篡改
      const runBadInst = {
        approval_ref: {
          approval_id: "wf-1-1",
          plan_revision: 1,
          plan_hash: "hash-real",
          instructions_hash: "tampered-inst-hash",
        },
      };
      expect(() =>
        verifyAndResolveExecutionInstructions(
          mockStore,
          "wf-1",
          runBadInst,
          1,
          "hash-real",
        ),
      ).toThrow(/指令哈希不一致/);
    });

    it("兼容读取：旧版本无指令记录安全回退为空指令，不报错", () => {
      const legacyRecord = {
        revision: 1,
        plan_hash: "hash-legacy",
        approved_at: new Date().toISOString(),
      };
      fakeStore.set("approval:wf-1-1", legacyRecord);

      // 旧运行未带 approval_ref
      const run = {};
      const result = verifyAndResolveExecutionInstructions(
        mockStore,
        "wf-1",
        run,
        1,
        "hash-legacy",
      );
      expect(result.instructions).toBeNull();
      expect(result.payload).toBeNull();
    });
  });
});
