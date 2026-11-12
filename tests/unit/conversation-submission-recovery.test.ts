import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginConversationSubmission,
  commitConversationSubmission,
  isDefiniteSubmissionRejection,
  listConversationSubmissions,
  peekConversationDraft,
  resetConversationDrafts,
  resolveConversationSubmissionFailure,
  resolveConversationSubmissionSuccess,
  restoreFailedConversationSubmission,
  setConversationSubmissionTransport,
} from "../../apps/web/src/use-conversation-draft.js";
import {
  applyAttachmentCapability,
  draftConversationAttachments,
  resetConversationAttachments,
  removeConversationAttachment,
  restoreConversationAttachments,
  restoreConversationAttachmentQueue,
  snapshotConversationAttachments,
  type AttachmentRecord,
} from "../../apps/web/src/components/ConversationAttachments.js";

const workflowId = "wf-submission-recovery";
function attachment(id: string): AttachmentRecord {
  return {
    clientId: `client-${id}`, workflowId, requestId: `upload-${id}`, fileId: id,
    displayName: `${id}.txt`, size: 4, mime: "text/plain", kind: "text",
    status: "ready", supported: true, interrupted: false,
  };
}
function edit(text: string, files: AttachmentRecord[] = []) {
  const draft = peekConversationDraft(workflowId);
  draft.text = text;
  draft.attachments = draftConversationAttachments(files);
  restoreConversationAttachments(workflowId, files);
  return draft;
}
function commit() {
  const draft = peekConversationDraft(workflowId);
  return commitConversationSubmission(workflowId, {
    requestId: draft.requestId, draftText: draft.text, sendText: draft.text,
    refs: draft.refs, attachments: draft.attachments, mode: "formal",
  });
}
function reject(submission: ReturnType<typeof commit>) {
  resolveConversationSubmissionFailure(workflowId, submission, { status: 422 });
}
function setTransport(submission: ReturnType<typeof commit>) {
  setConversationSubmissionTransport(workflowId, submission, {
    path: `/workflows/${workflowId}/conversation-messages`,
    body: { request_id: submission.requestId, text: submission.draftText, expected_generation: 2 },
  });
}

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  resetConversationDrafts();
  resetConversationAttachments();
});
afterEach(() => {
  resetConversationDrafts();
  resetConversationAttachments();
  vi.unstubAllGlobals();
});

describe("independent conversation submissions", () => {
  it("does not delete another rejected request when a newer request succeeds or fails", () => {
    edit("A");
    const a = commit();
    edit("B");
    reject(a);
    const b = commit();
    resolveConversationSubmissionSuccess(workflowId, b);
    expect(listConversationSubmissions(workflowId).map(item => item.requestId)).toEqual([a.requestId]);
    edit("C");
    const c = commit();
    reject(c);
    expect(listConversationSubmissions(workflowId).map(item => item.requestId)).toEqual([a.requestId, c.requestId]);
  });

  it("restores old content and its real attachment queue while separately saving the newer draft", () => {
    edit("A", [attachment("a")]);
    const a = commit();
    expect(snapshotConversationAttachments(workflowId)).toEqual([]);
    edit("B", [attachment("b")]);
    reject(a);
    expect(restoreFailedConversationSubmission(workflowId, a.requestId)).toBe(true);
    expect(peekConversationDraft(workflowId).text).toBe("A");
    expect(snapshotConversationAttachments(workflowId).map(item => item.displayName)).toEqual(["a.txt"]);
    const b = listConversationSubmissions(workflowId).find(item => item.status === "saved")!;
    expect(b.draftText).toBe("B");
    expect(b.attachmentRecords[0]?.displayName).toBe("b.txt");
    expect(restoreFailedConversationSubmission(workflowId, b.requestId)).toBe(true);
    expect(peekConversationDraft(workflowId).text).toBe("B");
    expect(snapshotConversationAttachments(workflowId).map(item => item.displayName)).toEqual(["b.txt"]);
  });

  it.each([
    { withOriginalFile: true, draftText: "B" },
    { withOriginalFile: false, draftText: "B" },
    { withOriginalFile: true, draftText: "" },
    { withOriginalFile: false, draftText: "" },
  ])("preserves refreshed draft attachments during delayed metadata: %j", async ({ withOriginalFile, draftText }) => {
    const originalFiles = withOriginalFile ? [attachment("a")] : [];
    edit("A", originalFiles);
    const a = commit();
    const b = edit(draftText, [attachment("b")]);
    reject(a);
    // The hook persists text separately from the attachment queue.
    localStorage.setItem(`devflow.conversation-draft.${workflowId}`, JSON.stringify(b));
    resetConversationDrafts();
    resetConversationAttachments();
    let release!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(() => pending));
    const hydration = restoreConversationAttachmentQueue(workflowId);
    expect(peekConversationDraft(workflowId).attachments.map(item => item.id)).toEqual(["b"]);
    expect(restoreFailedConversationSubmission(workflowId, a.requestId)).toBe(true);
    const saved = listConversationSubmissions(workflowId).find(item => item.status === "saved")!;
    expect(saved.draftText).toBe(draftText);
    expect(saved.attachments.map(item => item.id)).toEqual(["b"]);
    expect(saved.attachmentRecords.map(item => item.fileId)).toEqual(["b"]);
    release(new Response(JSON.stringify({
      id: "b", status: "ready", display_name: "late-b.txt", size: 4, declared_mime: "text/plain",
    }), { status: 200 }));
    await hydration;
    expect(snapshotConversationAttachments(workflowId).map(item => item.fileId))
      .toEqual(originalFiles.map(item => item.fileId));
    // Another reload must retain both the selected draft and the saved attachment.
    resetConversationDrafts();
    resetConversationAttachments();
    expect(peekConversationDraft(workflowId).text).toBe("A");
    expect(snapshotConversationAttachments(workflowId).map(item => item.fileId))
      .toEqual(originalFiles.map(item => item.fileId));
    expect(restoreFailedConversationSubmission(workflowId, saved.requestId)).toBe(true);
    expect(peekConversationDraft(workflowId).text).toBe(draftText);
    expect(snapshotConversationAttachments(workflowId).map(item => item.fileId)).toEqual(["b"]);
  });

  it("preserves persisted attachments when recovery precedes queue initialization", () => {
    edit("A");
    const a = commit();
    const b = edit("B", [attachment("b")]);
    reject(a);
    localStorage.setItem(`devflow.conversation-draft.${workflowId}`, JSON.stringify(b));
    resetConversationDrafts();
    resetConversationAttachments();
    expect(restoreFailedConversationSubmission(workflowId, a.requestId)).toBe(true);
    expect(listConversationSubmissions(workflowId).find(item => item.status === "saved")
      ?.attachmentRecords.map(item => item.fileId)).toEqual(["b"]);
  });

  it("applies delayed metadata while retaining capability updates on the same draft", async () => {
    edit("B", [attachment("b")]);
    resetConversationAttachments();
    let release!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(resolve => { release = resolve; })));
    const hydration = restoreConversationAttachmentQueue(workflowId);
    applyAttachmentCapability(workflowId);
    const capabilityReason = snapshotConversationAttachments(workflowId)[0]!.unsupportedReason;
    expect(capabilityReason).toBeDefined();
    release(new Response(JSON.stringify({
      id: "b", status: "failed", display_name: "server-b.txt", size: 4, declared_mime: "text/plain",
    }), { status: 200 }));
    await hydration;
    expect(snapshotConversationAttachments(workflowId)[0]).toMatchObject({
      fileId: "b", displayName: "server-b.txt", status: "failed",
      supported: true, unsupportedReason: capabilityReason,
    });
  });

  it("rehydrates in-flight requests as uncertain and retains the exact promote route and body", () => {
    const draft = edit("promote A", [attachment("a")]);
    draft.promoteTarget = { workflowId: "original-workflow", asideId: "aside-a" };
    const a = commit();
    const transport = {
      path: "/workflows/original-workflow/asides/aside-a/promote",
      body: { request_id: a.requestId, text: "promote A", attachment_ids: ["a"] },
    };
    setConversationSubmissionTransport(workflowId, a, transport);
    resetConversationDrafts();
    resetConversationAttachments();
    const restored = listConversationSubmissions(workflowId)[0]!;
    expect(restored.status).toBe("uncertain");
    expect(restored.transport).toEqual(transport);
    expect(restored.promoteTarget).toEqual({ workflowId: "original-workflow", asideId: "aside-a" });
    expect(restored.attachmentRecords[0]?.displayName).toBe("a.txt");
    expect(restoreFailedConversationSubmission(workflowId, restored.requestId)).toBe(false);
    edit("new B");
    beginConversationSubmission(workflowId, restored);
    expect(restored.transport).toEqual(transport);
    resolveConversationSubmissionSuccess(workflowId, restored);
    expect(peekConversationDraft(workflowId).text).toBe("new B");
    expect(listConversationSubmissions(workflowId)).toEqual([]);
  });

  it("keeps transport loss and server failures uncertain without restoring already accepted text", () => {
    edit("A");
    const a = commit();
    setTransport(a);
    resolveConversationSubmissionFailure(workflowId, a, new TypeError("connection lost"));
    expect(a.status).toBe("uncertain");
    expect(peekConversationDraft(workflowId).text).toBe("");
    expect(isDefiniteSubmissionRejection({ status: 500 })).toBe(false);
    expect(isDefiniteSubmissionRejection({ status: 408 })).toBe(false);
    expect(isDefiniteSubmissionRejection({ status: 422 })).toBe(true);
    expect(restoreFailedConversationSubmission(workflowId, a.requestId)).toBe(false);
  });

  it("does not guess the route of legacy records without a saved transport", () => {
    localStorage.setItem(`devflow.conversation-failed.${workflowId}`, JSON.stringify({
      workflowId, requestId: "legacy-promote", draftText: "old guidance", sendText: "old guidance",
      refs: [], attachments: [], mode: "formal", committedAt: 1,
    }));
    resetConversationDrafts();
    const legacy = listConversationSubmissions(workflowId)[0]!;
    expect(legacy.status).toBe("uncertain");
    expect(legacy.recoveryBlockedReason).toContain("未保存发送路由");
    expect(restoreFailedConversationSubmission(workflowId, legacy.requestId)).toBe(false);
    expect(() => beginConversationSubmission(workflowId, legacy)).toThrow("未保存发送路由");
    expect(legacy.draftText).toBe("old guidance");
  });

  it("keeps an uncertain request uncertain when its retry returns an idempotency conflict", () => {
    edit("A");
    const a = commit();
    setTransport(a);
    resolveConversationSubmissionFailure(workflowId, a, new TypeError("response lost"));
    beginConversationSubmission(workflowId, a);
    resolveConversationSubmissionFailure(workflowId, a, { status: 409, code: "IDEMPOTENCY_CONFLICT" });
    expect(a.status).toBe("uncertain");
    expect(peekConversationDraft(workflowId).text).toBe("");
    expect(restoreFailedConversationSubmission(workflowId, a.requestId)).toBe(false);
  });

  it("reuses the original frozen request on unchanged retry and rotates the ID after editing a rejection", () => {
    edit("A").promoteTarget = { workflowId, asideId: "aside-a" };
    const a = commit();
    setTransport(a);
    reject(a);
    const retried = commit();
    expect(retried).toBe(a);
    expect(retried.transport?.body.text).toBe("A");
    reject(a);
    edit("edited A");
    const changed = commit();
    expect(changed.requestId).not.toBe(a.requestId);
    expect(changed.transport).toBeUndefined();
    expect(changed.promoteTarget).toEqual({ workflowId, asideId: "aside-a" });
    expect(listConversationSubmissions(workflowId)).toHaveLength(2);
  });

  it("keeps edits on a separate request when retrying the original submission", () => {
    edit("A");
    const a = commit();
    setTransport(a);
    reject(a);
    edit("new B");
    beginConversationSubmission(workflowId, a);
    resolveConversationSubmissionSuccess(workflowId, a);
    const b = commit();
    expect(b.draftText).toBe("new B");
    expect(b.requestId).not.toBe(a.requestId);
  });

  it("restores attachments after rejection and includes them when another attachment is added", () => {
    edit("A", [attachment("a")]);
    const a = commit();
    reject(a);
    const restored = snapshotConversationAttachments(workflowId);
    expect(restored.map(item => item.fileId)).toEqual(["a"]);
    const files = [...restored, attachment("b")];
    restoreConversationAttachments(workflowId, files);
    peekConversationDraft(workflowId).attachments = draftConversationAttachments(files);
    const next = commit();
    expect(next.attachments.map(item => item.id)).toEqual(["a", "b"]);
    expect(next.attachmentRecords.map(item => item.displayName)).toEqual(["a.txt", "b.txt"]);
  });

  it("does not delete a file retained by the failed submission when editing its restored draft", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    edit("A", [attachment("a")]);
    const a = commit();
    reject(a);
    await removeConversationAttachment(workflowId, "client-a");
    peekConversationDraft(workflowId).attachments = [];
    expect(fetchMock).not.toHaveBeenCalled();
    expect(snapshotConversationAttachments(workflowId)).toEqual([]);
    expect(restoreFailedConversationSubmission(workflowId, a.requestId)).toBe(true);
    expect(snapshotConversationAttachments(workflowId)[0]?.fileId).toBe("a");
  });

  it("does not swap a newer draft while its attachment upload is in progress", () => {
    edit("A");
    const a = commit();
    edit("B", [{ ...attachment("b"), status: "uploading" }]);
    reject(a);
    expect(restoreFailedConversationSubmission(workflowId, a.requestId)).toBe(false);
    expect(peekConversationDraft(workflowId).text).toBe("B");
  });
});
