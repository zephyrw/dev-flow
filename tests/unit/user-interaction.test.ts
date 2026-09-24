import { describe, it, expect } from "vitest";
import {
  UserInteractionInputSchema,
  UserInteractionResponseInputSchema,
  type UserInteractionInput,
} from "../../packages/contracts/src/user-interaction.js";
import {
  normalizeExecutionIntent,
} from "../../packages/core/src/round-intent.js";
import { UserInteractionService } from "../../packages/core/src/user-interaction-service.js";
import { Store } from "../../packages/store/src/store.js";

describe("U01 — 用户交互输入合同与安全降级", () => {
  it("验证 action_required 类型的正常解析与字段校验", () => {
    const input: UserInteractionInput = {
      kind: "action_required",
      title: "请完成扫码登录",
      message: "在弹出的浏览器页面中完成微信扫码登录，完成后点击确认。",
      action_label: "已完成登录",
      target: {
        url: "http://127.0.0.1:5173/login",
      },
    };

    const parsed = UserInteractionInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("action_required");
      expect(parsed.data.title).toBe("请完成扫码登录");
      expect(parsed.data.target?.url).toBe("http://127.0.0.1:5173/login");
      expect(parsed.data.action_label).toBe("已完成登录");
    }
  });

  it("验证 question 类型的选项与输入框参数解析", () => {
    const input: UserInteractionInput = {
      kind: "question",
      title: "选择目标环境",
      message: "请选择要连接的远程环境",
      question: "需要连接哪套环境？",
      choices: [
        { id: "opt-dev", label: "开发环境" },
        { id: "opt-staging", label: "预发环境" },
      ],
      allow_free_text: true,
    };

    const parsed = UserInteractionInputSchema.safeParse(input);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.kind).toBe("question");
      expect(parsed.data.choices).toHaveLength(2);
      const firstChoice = parsed.data.choices?.[0];
      expect(firstChoice?.id).toBe("opt-dev");
      expect(parsed.data.allow_free_text).toBe(true);
    }
  });

  it("拒绝非法 URL（javascript: 或 ftp: 等）与超长标题", () => {
    const badUrlInput = {
      kind: "action_required",
      title: "危险链接",
      message: "点击执行脚本",
      target: {
        url: "javascript:alert(1)",
      },
    };
    expect(UserInteractionInputSchema.safeParse(badUrlInput).success).toBe(false);

    const longTitleInput = {
      kind: "question",
      title: "a".repeat(121),
      message: "问题描述",
    };
    expect(UserInteractionInputSchema.safeParse(longTitleInput).success).toBe(false);
  });

  it("拒绝重复 choice id 或过多选项", () => {
    const duplicateChoicesInput = {
      kind: "question",
      title: "重复选项",
      message: "请选择：",
      choices: [
        { id: "opt-1", label: "选项 1" },
        { id: "opt-1", label: "选项 1 副本" },
      ],
    };
    expect(UserInteractionInputSchema.safeParse(duplicateChoicesInput).success).toBe(false);

    const tooManyChoices = {
      kind: "question",
      title: "选项过多",
      message: "请选择：",
      choices: Array.from({ length: 9 }, (_, i) => ({
        id: `opt-${i}`,
        label: `选项 ${i}`,
      })),
    };
    expect(UserInteractionInputSchema.safeParse(tooManyChoices).success).toBe(false);
  });

  it("可选对象损坏或不完整时安全降级，不抛出异常", () => {
    const corruptedPayload = {
      status: "need_user",
      summary: "需要用户确认",
      user_interaction: {
        kind: "invalid_kind_here",
        title: 12345,
      },
    };

    const normalized = normalizeExecutionIntent(corruptedPayload);
    expect(normalized.intent).toBe("need_user");
    // 损坏的 user_interaction 附件会被安全降级为合法的交互请求，不抛出异常且不丢失求助
    expect(normalized.user_interaction).toBeDefined();
    expect(normalized.user_interaction?.kind).toBe("action_required");
    expect(normalized.summary).toBe("需要用户确认");
  });

  it("在缺少 user_interaction 的纯文本或旧格式下，通过 UserInteractionService 降级生成合法交互", () => {
    const store = new Store(":memory:");
    const service = new UserInteractionService(store);

    const interaction = service.createInteraction({
      workflowId: "wf-test-01",
      sourceRunId: "run-01",
      sourcePlanRevision: 1,
      purpose: "execute",
      role: "executor",
      rawInput: undefined,
      fallbackSummary: "请确认是否继续发布",
      fallbackQuestions: ["确定要发布到生产环境吗？"],
    });

    expect(interaction).toBeDefined();
    expect(interaction.request.kind).toBe("question");
    expect(interaction.request.title).toBe("请回答执行提问");
    expect(interaction.request.question).toBe("确定要发布到生产环境吗？");
    expect(interaction.status).toBe("pending");
  });

  it("验证响应合同校验规则（action_required 与 question 响应）", () => {
    const validActionResp = {
      request_id: "req-1",
      source_run_id: "run-1",
      action: "confirm" as const,
      answer: "已在页面完成授权",
    };
    expect(UserInteractionResponseInputSchema.safeParse(validActionResp).success).toBe(true);

    const validQuestionResp = {
      request_id: "req-2",
      source_run_id: "run-1",
      action: "answer" as const,
      choice_id: "opt-dev",
      answer: "使用测试库",
    };
    expect(UserInteractionResponseInputSchema.safeParse(validQuestionResp).success).toBe(true);

    const invalidActionResp = {
      request_id: "req-1",
      // 缺少 source_run_id 与 action
    };
    expect(UserInteractionResponseInputSchema.safeParse(invalidActionResp).success).toBe(false);
  });
});
