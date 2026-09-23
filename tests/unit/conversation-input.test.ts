import { beforeEach, describe, expect, it } from "vitest";
import {
  ConversationNodeSchema,
  conversationParentIssue,
  countConversationWork,
  FeedbackMessageSchema,
  fileWithinConversationLimits,
  CONVERSATION_FILE_LIMITS,
  DEFAULT_ATTACHMENT_PROMPT,
} from "../../packages/contracts/src/index.js";
import {
  conversationCommandSuggestions,
  evaluateConversationSend,
  parseConversationInput,
  resolveConversationRuntimeDisplay,
  validateClientConversationMode,
} from "../../packages/core/src/conversation-input.js";
import {
  applyConversationCommandSuggestion,
  composerTextareaHeight,
  conversationHandoverHint,
  draftAfterSuccessfulSend,
  isConversationComposerReadonly,
  peekConversationDraft,
  removeConversationAsideCommand,
  resetConversationDrafts,
  resolveComposerSendPayload,
  shouldRenderConversationComposer,
  shouldSubmitComposerKey,
  showsRoundFeedbackEntry,
} from "../../apps/web/src/use-conversation-draft.js";
import {
  insertWorkspaceReference,
  nextReferencePopupState,
  startWorkspaceReferenceDraft,
} from "../../apps/web/src/components/RequirementComposer.js";

function sampleNode(
  id: string,
  extra: Partial<{ parent_id: string; root_id: string }> = {},
) {
  return ConversationNodeSchema.parse({
    id,
    project_id: "proj1",
    workflow_id: "wf1",
    root_id: extra.root_id ?? "root1",
    parent_id: extra.parent_id,
    kind: extra.parent_id ? "subagent" : "main",
    adapter_id: "codex",
    title: id,
    purpose: "implement",
    lineage_id: "lineage-1",
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
  });
}

describe("SA-U05 conversation input commands", () => {
  it("parses /btw and /side as the same aside mode", () => {
    expect(parseConversationInput("/btw 为什么这样实现？")).toMatchObject({
      mode: "aside",
      command: "btw",
      text: "为什么这样实现？",
      empty_question: false,
    });
    expect(parseConversationInput("/side 为什么这样实现？")).toMatchObject({
      mode: "aside",
      command: "side",
      text: "为什么这样实现？",
    });
  });

  it("allows leading whitespace and keeps body formatting", () => {
    const parsed = parseConversationInput("  /btw 第一行\n  第二行");
    expect(parsed.mode).toBe("aside");
    expect(parsed.text).toBe("第一行\n  第二行");
  });

  it("rejects empty aside questions but keeps the draft text", () => {
    const parsed = parseConversationInput("/btw");
    expect(parsed.mode).toBe("aside");
    expect(parsed.empty_question).toBe(true);
    expect(evaluateConversationSend({ text: "/btw" }).reason).toBe(
      "请输入临时问题",
    );
    expect(parseConversationInput(" /side   ").empty_question).toBe(true);
  });

  it("does not prefix-match similar tokens", () => {
    expect(parseConversationInput("/btwfoo").mode).toBe("formal");
    expect(parseConversationInput("/sidebar 说明").mode).toBe("formal");
  });

  it("ignores commands that are not at the start", () => {
    expect(parseConversationInput("这里的 /btw 是什么？").mode).toBe("formal");
  });

  it("treats escaped commands as ordinary text", () => {
    const parsed = parseConversationInput("\\/btw 仍是正文");
    expect(parsed.mode).toBe("formal");
    expect(parsed.escaped).toBe(true);
    expect(parsed.text).toBe("/btw 仍是正文");
  });

  it("does not parse commands inside code fences", () => {
    expect(parseConversationInput("```\n/btw hidden\n```").mode).toBe("formal");
  });

  it("only strips the first command token", () => {
    expect(parseConversationInput("/btw /side 的含义？")).toMatchObject({
      mode: "aside",
      command: "btw",
      text: "/side 的含义？",
    });
  });

  it("treats ASCII case as equivalent", () => {
    expect(parseConversationInput("/BTW 大写").command).toBe("btw");
    expect(parseConversationInput("/Side 问题").command).toBe("side");
  });

  it("lets the server win when client mode is forged", () => {
    const parsed = validateClientConversationMode("/btw 真实提问", "formal");
    expect(parsed.mode).toBe("aside");
    expect(conversationCommandSuggestions("/")).toEqual(["btw", "side"]);
    expect(conversationCommandSuggestions("/s")).toEqual(["side"]);
  });
});

describe("SA-U04 runtime display and sendability", () => {
  it("prefers actual model and effort over requested values", () => {
    const display = resolveConversationRuntimeDisplay({
      actual_model: "gpt-5",
      requested_model: "gpt-4",
      actual_effort: "high",
      requested_effort: "medium",
    });
    expect(display.model_label).toBe("gpt-5");
    expect(display.effort_label).toBe("high");
    expect(display.model_source).toBe("actual");
  });

  it("marks requested configuration when actual values are missing", () => {
    const display = resolveConversationRuntimeDisplay({
      requested_model: "gpt-5",
      requested_effort: "xhigh",
    });
    expect(display.model_label).toBe("gpt-5（请求）");
    expect(display.effort_label).toBe("xhigh（请求）");
    expect(display.model_source).toBe("requested");
  });

  it("does not invent effort for old objects and reports unknowns", () => {
    const display = resolveConversationRuntimeDisplay({
      actual_model: undefined,
      requested_model: undefined,
    });
    expect(display.model_label).toBe("工具默认，实际未报告");
    expect(display.effort_label).toBe("思考强度未报告");
    expect(display.effort_source).toBe("unreported");
  });

  it("shows not-applicable when the tool has no effort capability", () => {
    const display = resolveConversationRuntimeDisplay({
      actual_model: "local",
      supports_effort: false,
    });
    expect(display.effort_label).toBe("不适用");
    expect(display.effort_source).toBe("not_applicable");
  });

  it("allows a file-only formal message and blocks aside file-only questions", () => {
    const formal = evaluateConversationSend({
      text: "",
      attachments: [{ status: "ready", supported: true }],
    });
    expect(formal.can_send).toBe(true);
    expect(formal.default_text).toContain("请查看本次附件");
    const aside = evaluateConversationSend({
      text: "/btw",
      attachments: [{ status: "ready", supported: true }],
    });
    expect(aside.can_send).toBe(false);
    expect(aside.reason).toBe("请输入临时问题");
  });

  it("disables send while attachments are uploading, failed, or unsupported", () => {
    expect(
      evaluateConversationSend({
        text: "继续",
        attachments: [{ status: "uploading", supported: true }],
      }).can_send,
    ).toBe(false);
    expect(
      evaluateConversationSend({
        text: "继续",
        attachments: [{ status: "failed", supported: true }],
      }).reason,
    ).toContain("失败");
    expect(
      evaluateConversationSend({
        text: "继续",
        attachments: [{ status: "ready", supported: false }],
      }).reason,
    ).toContain("无法读取");
  });
});

describe("SA-U01/U10 contract boundaries used by later modules", () => {
  it("accepts old feedback objects without attachment_ids", () => {
    const parsed = FeedbackMessageSchema.parse({
      message_id: "msg1",
      client_request_id: "req1",
      seq: 1,
      workflow_id: "wf1",
      kind: "execution",
      text: "旧反馈",
      created_at: "2026-09-20T00:00:00.000Z",
    });
    expect(parsed.attachment_ids).toEqual([]);
  });

  it("rejects self-reference, cross-root, and cyclic parents", () => {
    const root = sampleNode("root1");
    const self = sampleNode("child1", { parent_id: "child1" });
    expect(conversationParentIssue(self, [root, self])).toBe("self_reference");
    const otherRoot = sampleNode("child2", {
      parent_id: "root2",
      root_id: "root1",
    });
    expect(
      conversationParentIssue(otherRoot, [
        root,
        sampleNode("root2", { root_id: "root2" }),
        otherRoot,
      ]),
    ).toBe("cross_root");
    const a = sampleNode("a1", { parent_id: "b1" });
    const b = sampleNode("b1", { parent_id: "a1" });
    expect(conversationParentIssue(a, [root, a, b])).toBe("cycle");
    expect(conversationParentIssue(sampleNode("orphan", { parent_id: "missing" }), [root])).toBe(
      "missing_parent",
    );
  });

  it("counts only starting and running as working", () => {
    const counts = countConversationWork([
      { conversation_id: "a", status: "starting", freshness: "fresh" },
      { conversation_id: "b", status: "running", freshness: "fresh" },
      { conversation_id: "c", status: "waiting", freshness: "fresh" },
      { conversation_id: "d", status: "failed", freshness: "stale" },
    ]);
    expect(counts.working).toBe(2);
    expect(counts.waiting).toBe(1);
    expect(counts.failed).toBe(1);
    expect(counts.stale).toBe(1);
  });

  it("enforces file count and size limits", () => {
    expect(
      fileWithinConversationLimits({
        fileCount: 11,
        fileBytes: 1,
        totalBytes: 1,
      }),
    ).toBe("too_many");
    expect(
      fileWithinConversationLimits({
        fileCount: 1,
        fileBytes: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
        totalBytes: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
      }),
    ).toBe("file_too_large");
    expect(
      fileWithinConversationLimits({
        fileCount: 2,
        fileBytes: 1,
        totalBytes: CONVERSATION_FILE_LIMITS.maxTotalBytes + 1,
      }),
    ).toBe("total_too_large");
  });
});

describe("SA-D18 composer helpers", () => {
  beforeEach(() => {
    resetConversationDrafts();
  });

  it("hides the composer when the selected conversation is not the root", () => {
    expect(
      shouldRenderConversationComposer({
        selectedConversationId: "child-1",
        rootConversationId: "root-1",
      }),
    ).toBe(false);
    expect(
      shouldRenderConversationComposer({
        selectedConversationId: "root-1",
        rootConversationId: "root-1",
      }),
    ).toBe(true);
    expect(shouldRenderConversationComposer({})).toBe(true);
  });

  it("keeps ended tasks read-only and exposes the round-feedback entry", () => {
    expect(isConversationComposerReadonly("COMMITTED")).toBe(true);
    expect(showsRoundFeedbackEntry("COMMITTED")).toBe(true);
    expect(isConversationComposerReadonly("COMMITTING")).toBe(true);
    expect(showsRoundFeedbackEntry("COMMITTING")).toBe(false);
    expect(isConversationComposerReadonly("EXECUTING")).toBe(false);
  });

  it("applies slash suggestions and can remove the aside marker", () => {
    expect(applyConversationCommandSuggestion("/", "btw")).toBe("/btw ");
    expect(applyConversationCommandSuggestion("/s", "side")).toBe("/side ");
    expect(removeConversationAsideCommand("/btw 为什么")).toBe("为什么");
  });

  it("uses the default attachment prompt for a file-only formal send", () => {
    const payload = resolveComposerSendPayload({
      text: "",
      attachments: [{ id: "file-1", status: "ready", supported: true }],
    });
    expect(payload.canSend).toBe(true);
    expect(payload.sendText).toBe(DEFAULT_ATTACHMENT_PROMPT);
    expect(
      resolveComposerSendPayload({
        text: "/btw",
        attachments: [{ id: "file-1", status: "ready", supported: true }],
      }).reason,
    ).toBe("请输入临时问题");
  });

  it("does not send during IME composition and grows the textarea up to 240px", () => {
    expect(
      shouldSubmitComposerKey({ key: "Enter", shiftKey: false, composing: true }),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey({ key: "Enter", shiftKey: true, composing: false }),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey({ key: "Enter", shiftKey: false, composing: false }),
    ).toBe(true);
    expect(
      shouldSubmitComposerKey({
        key: "Enter",
        shiftKey: false,
        composing: false,
        keyCode: 229,
      }),
    ).toBe(false);
    expect(
      shouldSubmitComposerKey({
        key: "Enter",
        shiftKey: false,
        composing: false,
        skipEnterAfterComposition: true,
      }),
    ).toBe(false);
    expect(composerTextareaHeight(80, 72)).toBe(80);
    expect(composerTextareaHeight(400, 72)).toBe(240);
  });

  it("clears a successful send only when the draft was not edited afterward", () => {
    expect(
      draftAfterSuccessfulSend({
        currentText: "指导",
        sentText: "指导",
        currentRequestId: "req-1",
        sentRequestId: "req-1",
      }),
    ).toEqual({ clear: true, rotateRequestId: true });
    expect(
      draftAfterSuccessfulSend({
        currentText: "指导 已改",
        sentText: "指导",
        currentRequestId: "req-1",
        sentRequestId: "req-1",
      }),
    ).toEqual({ clear: false, rotateRequestId: true });
    expect(
      draftAfterSuccessfulSend({
        currentText: "新草稿",
        sentText: "指导",
        currentRequestId: "req-2",
        sentRequestId: "req-1",
      }),
    ).toEqual({ clear: false, rotateRequestId: false });
  });

  it("isolates drafts by workflow and shows the formal handover hint", () => {
    const first = peekConversationDraft("wf-a");
    first.text = "主会话草稿";
    first.requestId = "same-request";
    expect(peekConversationDraft("wf-b").text).toBe("");
    expect(peekConversationDraft("wf-a").text).toBe("主会话草稿");
    expect(peekConversationDraft("wf-a").requestId).toBe("same-request");
    expect(
      conversationHandoverHint({
        mode: "formal",
        readonly: false,
        receivedFormal: false,
      }),
    ).toBeUndefined();
    expect(
      conversationHandoverHint({
        mode: "formal",
        readonly: false,
        receivedFormal: true,
      }),
    ).toBe("指导已接收，正在交接");
  });

  it("reuses RequirementComposer @ search helpers for the plus-menu cite action", () => {
    const started = startWorkspaceReferenceDraft("说明", 0);
    expect(started.text).toBe("@说明");
    const inserted = insertWorkspaceReference("请看 @", 4, {
      ref_id: "r1",
      repo_id: "repo",
      relative_path: "src/a.ts",
      kind: "file",
    });
    expect(inserted.text).toBe("请看 @src/a.ts ");
    expect(nextReferencePopupState("请看 @", 4, false)).toEqual({
      open: true,
      query: "",
    });
  });
});

describe("SA-D19 attachment UX and status bar facts", () => {
  it("classifies images, text/code, and office/binary attachments", async () => {
    const {
      classifyConversationAttachmentKind,
      conversationAttachmentLimitReason,
      ATTACHMENT_LIMIT_TOO_MANY,
      ATTACHMENT_LIMIT_FILE_TOO_LARGE,
      ATTACHMENT_LIMIT_TOTAL_TOO_LARGE,
      attachmentTypeSupported,
      toDraftAttachment,
      INTERRUPTED_ATTACHMENT_UPLOAD,
      isConversationFileDrag,
      conversationPasteImageFiles,
    } = await import("../../apps/web/src/components/ConversationAttachments.js");
    expect(classifyConversationAttachmentKind("image/png", "a.png")).toBe(
      "image",
    );
    expect(classifyConversationAttachmentKind("text/plain", "note.md")).toBe(
      "text",
    );
    expect(classifyConversationAttachmentKind("application/pdf", "a.pdf")).toBe(
      "binary",
    );
    expect(
      classifyConversationAttachmentKind(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "spec.docx",
      ),
    ).toBe("binary");
    expect(
      conversationAttachmentLimitReason({
        fileCount: 11,
        fileBytes: 1,
        totalBytes: 1,
      }),
    ).toBe(ATTACHMENT_LIMIT_TOO_MANY);
    expect(
      conversationAttachmentLimitReason({
        fileCount: 1,
        fileBytes: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
        totalBytes: CONVERSATION_FILE_LIMITS.maxFileBytes + 1,
      }),
    ).toBe(ATTACHMENT_LIMIT_FILE_TOO_LARGE);
    expect(
      conversationAttachmentLimitReason({
        fileCount: 2,
        fileBytes: 1,
        totalBytes: CONVERSATION_FILE_LIMITS.maxTotalBytes + 1,
      }),
    ).toBe(ATTACHMENT_LIMIT_TOTAL_TOO_LARGE);
    expect(
      attachmentTypeSupported("image", {
        text: true,
        image: false,
        binary: false,
      }),
    ).toBe(false);
    expect(
      toDraftAttachment({
        clientId: "local-1",
        workflowId: "wf1",
        requestId: "req",
        displayName: "cut.png",
        size: 12,
        mime: "image/png",
        kind: "image",
        status: "pending",
        supported: true,
        interrupted: true,
        error: INTERRUPTED_ATTACHMENT_UPLOAD,
      }).status,
    ).toBe("failed");
    expect(
      isConversationFileDrag({ types: ["Files"] } as unknown as DataTransfer),
    ).toBe(true);
    expect(
      isConversationFileDrag({ types: ["text/plain"] } as unknown as DataTransfer),
    ).toBe(false);
    expect(
      conversationPasteImageFiles({
        items: [
          {
            kind: "file",
            type: "image/png",
            getAsFile: () => new File([new Uint8Array([1])], "p.png"),
          },
        ],
        getData: () => "保留文本",
      } as unknown as DataTransfer),
    ).toHaveLength(1);
  });

  it("does not inherit parent model facts for a child conversation", async () => {
    const {
      observationBelongsToViewed,
      selectViewedRuntimeFacts,
      conversationIdleCaption,
      buildComposerRuntime,
      resolveFileInputCapability,
      DEFAULT_ADAPTER_FILE_INPUT,
    } = await import("../../apps/web/src/components/ConversationStatusBar.js");
    expect(
      observationBelongsToViewed({
        observation: { conversation_id: "root-1" },
        viewedConversationId: "child-1",
        rootConversationId: "root-1",
      }),
    ).toBe(false);
    const child = selectViewedRuntimeFacts({
      viewedConversationId: "child-1",
      rootConversationId: "root-1",
      viewedAttempt: { conversation_id: "child-1" },
      observation: {
        conversation_id: "root-1",
        actual_model: "gpt-parent",
        actual_effort: "high",
      },
      requestedModel: "gpt-parent",
    });
    expect(child.actual_model).toBeUndefined();
    expect(child.actual_effort).toBeUndefined();
    expect(child.requested_model).toBeUndefined();
    const paused = conversationIdleCaption({
      active: false,
      workflowState: "STOPPED",
      lastModelLabel: "gpt-5",
    });
    expect(paused).toBe("已暂停 · 上次模型 gpt-5");
    const waiting = conversationIdleCaption({
      active: false,
      workflowState: "PLAN_PENDING",
      nextConfigLabel: "gpt-5",
    });
    expect(waiting).toBe("等待规划 · 下一轮配置 gpt-5");
    const childBar = buildComposerRuntime(
      {
        workflow: { id: "wf1", state: "EXECUTING", run_id: "run-1" },
        conversation_tree: {
          active_root_id: "root-1",
          nodes: [
            { id: "root-1", kind: "main", adapter_id: "codex", purpose: "implement" },
            {
              id: "child-1",
              kind: "subagent",
              parent_id: "root-1",
              adapter_id: "codex",
              purpose: "implement",
            },
          ],
          attempts: [
            {
              conversation_id: "root-1",
              actual_model: "gpt-parent",
              actual_effort: "high",
              status: "running",
              generation: 1,
            },
          ],
        },
        runtime: {
          run_id: "run-1",
          adapter: "codex",
          actual_model: "gpt-parent",
          conversation_id: "root-1",
          status: "working",
          started_at: "2026-09-20T00:00:00.000Z",
          updated_at: "2026-09-20T00:00:00.000Z",
          active_tools: 1,
        },
      },
      "child-1",
    );
    expect(childBar.runtime.model_label).toBe("工具默认，实际未报告");
    expect(childBar.runtime.effort_label).toBe("思考强度未报告");
    expect(
      resolveFileInputCapability(
        "codex",
        { text: false, image: false, binary: false },
        "unknown",
      ),
    ).toEqual(DEFAULT_ADAPTER_FILE_INPUT.codex);
  });

  it("blocks send when an interrupted attachment is still in the draft", () => {
    const blocked = evaluateConversationSend({
      text: "继续",
      attachments: [{ status: "failed", supported: true }],
    });
    expect(blocked.can_send).toBe(false);
    expect(blocked.reason).toContain("失败");
  });
});

