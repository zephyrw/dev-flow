// @vitest-environment jsdom
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { UserInteractionDialog } from "../../apps/web/src/components/UserInteractionDialog.js";
import type { UserInteractionRecord } from "../../packages/contracts/src/user-interaction.js";
import * as api from "../../apps/web/src/components/user-interaction-api.js";
import { AppDialog } from "../../apps/web/src/components/AppDialog.js";

describe("U03 — 人机交互 UI 组件 (UserInteractionDialog)", () => {
  let container: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
    container = null;
    root = null;
    vi.restoreAllMocks();
  });

  const mockActionInteraction: UserInteractionRecord = {
    id: "int-act-1",
    workflow_id: "wf-1",
    source_run_id: "run-1",
    source_plan_revision: 1,
    purpose: "execute",
    role: "executor",
    request: {
      kind: "action_required",
      title: "请人工登录测试系统",
      message: "在浏览器中登录后点击确认",
      action_label: "已完成登录",
      target: {
        url: "http://127.0.0.1:5173/login",
      },
    },
    status: "pending",
    created_at: new Date().toISOString(),
  };

  const mockQuestionInteraction: UserInteractionRecord = {
    id: "int-quest-1",
    workflow_id: "wf-1",
    source_run_id: "run-1",
    source_plan_revision: 1,
    purpose: "execute",
    role: "executor",
    request: {
      kind: "question",
      title: "请选择运行模式",
      message: "选择一个本地开发运行模式：",
      question: "请选择本地开发运行模式：",
      choices: [
        { id: "choice-mock", label: "Mock 模式" },
        { id: "choice-real", label: "真实后端模式" },
      ],
      allow_free_text: true,
    },
    status: "pending",
    created_at: new Date().toISOString(),
  };

  it("旧问题延迟响应不能关闭后来打开的问题或触发其刷新", async () => {
    let resolveResponse!: (value: {
      success: boolean;
      interaction: UserInteractionRecord;
    }) => void;
    vi.spyOn(api, "respondUserInteraction").mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve;
        }),
    );
    const onClose = vi.fn();
    const onResponded = vi.fn(async () => {});
    await act(async () => {
      root?.render(
        <UserInteractionDialog
          workflowId="wf-1"
          interaction={mockActionInteraction}
          isOpen
          onClose={onClose}
          onResponded={onResponded}
        />,
      );
    });
    await act(async () => {
      (
        document.querySelector(".btn-interaction-confirm") as HTMLButtonElement
      ).click();
    });
    await act(async () => {
      root?.render(
        <UserInteractionDialog
          workflowId="wf-1"
          interaction={mockQuestionInteraction}
          isOpen
          onClose={onClose}
          onResponded={onResponded}
        />,
      );
    });
    await act(async () => {
      resolveResponse({
        success: true,
        interaction: { ...mockActionInteraction, status: "answered" },
      });
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(onResponded).not.toHaveBeenCalled();
    expect(document.querySelector(".app-dialog-title")?.textContent).toBe(
      mockQuestionInteraction.request.title,
    );
    expect(
      (document.querySelector(".btn-interaction-submit") as HTMLButtonElement)
        .textContent,
    ).toBe("提交回答");
  });

  it("多弹窗只关闭顶层，隐藏弹窗不提前释放滚动锁", async () => {
    const closeFirst = vi.fn();
    const closeTop = vi.fn();
    await act(async () => {
      root?.render(
        <>
          <AppDialog isOpen onClose={closeFirst} title="first">
            first
          </AppDialog>
          <AppDialog isOpen={false} onClose={() => {}} title="hidden">
            hidden
          </AppDialog>
          <AppDialog isOpen onClose={closeTop} title="top">
            top
          </AppDialog>
        </>,
      );
    });
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
      );
    });
    expect(closeTop).toHaveBeenCalledOnce();
    expect(closeFirst).not.toHaveBeenCalled();
  });

  it("渲染 action_required 弹窗，验证标题、说明与独立标题 ID 无障碍关联", async () => {
    await act(async () => {
      root?.render(
        <UserInteractionDialog
          workflowId="wf-1"
          interaction={mockActionInteraction}
          isOpen={true}
          onClose={() => {}}
          onResponded={async () => {}}
        />,
      );
    });

    const dialog = document.querySelector(".app-dialog-container");
    expect(dialog).not.toBeNull();
    const title = document.querySelector(".app-dialog-title");
    expect(title?.textContent).toBe("请人工登录测试系统");

    // 检查 aria-labelledby 关联
    const titleId = title?.getAttribute("id");
    expect(titleId).toBeTruthy();
    expect(dialog?.getAttribute("aria-labelledby")).toBe(titleId);

    // 检查按钮文本
    const confirmBtn = document.querySelector(".btn-interaction-confirm");
    expect(confirmBtn?.textContent).toBe("已完成登录");
  });

  it("点击关闭或稍后处理不触发 API 回答，仅调用 onClose", async () => {
    const respondSpy = vi
      .spyOn(api, "respondUserInteraction")
      .mockResolvedValue({
        success: true,
        interaction: mockActionInteraction,
      });
    const onClose = vi.fn();

    await act(async () => {
      root?.render(
        <UserInteractionDialog
          workflowId="wf-1"
          interaction={mockActionInteraction}
          isOpen={true}
          onClose={onClose}
          onResponded={async () => {}}
        />,
      );
    });

    const closeBtn = document.querySelector(
      ".app-dialog-close-btn",
    ) as HTMLButtonElement;
    expect(closeBtn).not.toBeNull();

    await act(async () => {
      closeBtn.click();
    });

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(respondSpy).not.toHaveBeenCalled();
  });

  it("question 类型进行空提交校验：未选选项且未填文字时阻止提交并显示错误", async () => {
    const respondSpy = vi.spyOn(api, "respondUserInteraction");
    const onResponded = vi.fn();

    await act(async () => {
      root?.render(
        <UserInteractionDialog
          workflowId="wf-1"
          interaction={mockQuestionInteraction}
          isOpen={true}
          onClose={() => {}}
          onResponded={onResponded}
        />,
      );
    });

    const submitBtn = document.querySelector(
      ".btn-interaction-submit",
    ) as HTMLButtonElement;
    expect(submitBtn).not.toBeNull();
    // 验证未选择选项且未输入文本时，提交按钮被禁用
    expect(submitBtn.disabled).toBe(true);

    const firstRadio = document.querySelector(
      'input[type="radio"]',
    ) as HTMLInputElement;
    expect(firstRadio).not.toBeNull();

    await act(async () => {
      firstRadio.click();
    });

    // 选中选项后提交按钮启用
    expect(submitBtn.disabled).toBe(false);
    expect(respondSpy).not.toHaveBeenCalled();
    expect(onResponded).not.toHaveBeenCalled();
  });

  it("网络失败时显示错误信息，支持重新提交且保持幂等 request_id 相同", async () => {
    let callCount = 0;
    let firstRequestId = "";
    let secondRequestId = "";

    const respondSpy = vi
      .spyOn(api, "respondUserInteraction")
      .mockImplementation(async (_wfId, _intId, payload) => {
        callCount++;
        if (callCount === 1) {
          firstRequestId = payload.request_id;
          throw new Error("网络连接失败，请稍后重试");
        }
        secondRequestId = payload.request_id;
        return {
          success: true,
          interaction: { ...mockActionInteraction, status: "answered" },
        };
      });

    const onClose = vi.fn();
    const onResponded = vi.fn();

    await act(async () => {
      root?.render(
        <UserInteractionDialog
          workflowId="wf-1"
          interaction={mockActionInteraction}
          isOpen={true}
          onClose={onClose}
          onResponded={onResponded}
        />,
      );
    });

    const confirmBtn = document.querySelector(
      ".btn-interaction-confirm",
    ) as HTMLButtonElement;

    // 第一次点击：网络失败
    await act(async () => {
      confirmBtn.click();
    });

    expect(callCount).toBe(1);
    expect(
      document.querySelector(".user-interaction-error")?.textContent,
    ).toContain("网络连接失败，请稍后重试");
    expect(onClose).not.toHaveBeenCalled();

    // 第二次点击：重试成功
    await act(async () => {
      confirmBtn.click();
    });

    expect(callCount).toBe(2);
    // 验证同一次打开流程内重试保持相同幂等 request_id
    expect(firstRequestId).toBeTruthy();
    expect(secondRequestId).toBe(firstRequestId);
    expect(onResponded).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
