import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { setup, repository, project } from "../helpers.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { ConversationFileService, conversationFileContentPath } from "../../packages/core/src/conversation-files.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import { CONVERSATION_ENTITY, type ConversationFile, type Workflow } from "../../packages/contracts/src/index.js";

const PNG_1X1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082",
  "hex",
);

describe("A-draft-integration & A-create-images-e2e: 草稿附件存储与工作流绑定集成测试", () => {
  it("支持草稿上传、创建工作流时合法绑定并迁移文件、规划入队与草稿清理保护", async () => {
    const s = setup();
    const repo = await repository(s.root);
    const p = project(repo.repo);
    s.store.put("project", p.id, "global", p);

    // 设置 profile-codex 与 verified access
    const codexProfile = {
      id: "profile-codex",
      revision: 1,
      adapterId: "codex" as const,
      executableRef: process.execPath,
      modelSelection: "explicit" as const,
      modelId: "gpt-4o",
      options: {},
    };
    s.store.put("tool_profile", "profile-codex", "global", codexProfile);
    seedVerifiedAccess(s.store, codexProfile);

    const fileService = new ConversationFileService(s.store, s.config.storage_root);
    const createService = new CreateWorkflowService(s.store, s.config, undefined, fileService);

    const draftId = "draft-req-12345";
    // 1. 上传草稿文件
    const meta = fileService.createMetadata(draftId, {
      request_id: "file-req-1",
      display_name: "architecture.png",
      size: PNG_1X1.length,
      declared_mime: "image/png",
    });
    expect(meta.file_id).toBeDefined();

    // 写入真实内容
    const uploaded = await fileService.writeContent(draftId, meta.file_id, PNG_1X1, PNG_1X1.length);
    expect(uploaded.status).toBe("ready");
    expect(uploaded.detected_mime).toBe("image/png");

    const draftFilePath = conversationFileContentPath(s.config.storage_root, draftId, meta.file_id);
    expect(existsSync(draftFilePath)).toBe(true);

    // 2. 创建任务并携带 attachment_ids
    const result = createService.execute({
      request_id: "req-12345",
      workspace_root: repo.repo,
      request_text: "请分析此架构图并制定方案",
      title: "任务图片测试",
      workspace_mode: "existing_workspace",
      planner_profile: codexProfile,
      executor_profile: codexProfile,
      attachment_ids: [meta.file_id],
      draft_id: draftId,
    });

    const workflow = result.workflow;
    expect(workflow).toBeDefined();
    expect(result.is_existing).toBe(false);

    // 3. 验证 requirement_message 保存了附件
    const reqMessages = s.store.list<{ text: string; attachment_ids?: string[] }>(
      "requirement_message",
      workflow.id,
    );
    expect(reqMessages.length).toBe(1);
    expect(reqMessages[0]!.attachment_ids).toEqual([meta.file_id]);

    // 4. 验证草稿目录已物理迁移到 workflow.id 下
    const newFilePath = conversationFileContentPath(s.config.storage_root, workflow.id, meta.file_id);
    expect(existsSync(newFilePath)).toBe(true);

    // 5. 验证文件记录的 workflow_id 和 referenced_message_ids 更新
    const boundFile = s.store.get<ConversationFile>(CONVERSATION_ENTITY.file, meta.file_id)!;
    expect(boundFile.workflow_id).toBe(workflow.id);
    expect(boundFile.referenced_message_ids.length).toBe(1);

    // 6. 重复提交（幂等）：返回同一任务且不报错
    const retryResult = createService.execute({
      request_id: "req-12345",
      workspace_root: repo.repo,
      request_text: "请分析此架构图并制定方案",
      title: "任务图片测试",
      workspace_mode: "existing_workspace",
      planner_profile: codexProfile,
      executor_profile: codexProfile,
      attachment_ids: [meta.file_id],
      draft_id: draftId,
    });
    expect(retryResult.is_existing).toBe(true);
    expect(retryResult.workflow.id).toBe(workflow.id);

    // 7. 测试草稿过期清理保护已引用的材料
    const expired = fileService.cleanupExpiredDrafts(Date.now() + 100 * 86400 * 1000);
    // 已经绑定的文件不能被清理
    expect(expired).not.toContain(meta.file_id);
    expect(existsSync(newFilePath)).toBe(true);
  });

  it("当草稿附件尚未上传完成或模型不支持时阻止创建工作流", async () => {
    const s = setup();
    const repo = await repository(s.root);
    const p = project(repo.repo);
    s.store.put("project", p.id, "global", p);

    const agyProfile = {
      id: "profile-agy",
      revision: 1,
      adapterId: "agy" as const,
      executableRef: process.execPath,
      modelSelection: "explicit" as const,
      modelId: "gemini-flash",
      options: {},
    };
    s.store.put("tool_profile", "profile-agy", "global", agyProfile);
    seedVerifiedAccess(s.store, agyProfile);

    const fileService = new ConversationFileService(s.store, s.config.storage_root);
    const createService = new CreateWorkflowService(s.store, s.config, undefined, fileService);

    const draftId = "draft-req-incomplete";
    // 1. 创建但未上传内容的草稿文件（status: pending）
    const pendingMeta = fileService.createMetadata(draftId, {
      request_id: "file-req-pending",
      display_name: "unready.png",
      size: 1024,
      declared_mime: "image/png",
    });

    expect(() =>
      createService.execute({
        request_id: "req-incomplete",
        workspace_root: repo.repo,
        request_text: "测试未就绪附件",
        title: "未就绪附件测试",
        workspace_mode: "existing_workspace",
        planner_profile: agyProfile,
        executor_profile: agyProfile,
        attachment_ids: [pendingMeta.file_id],
        draft_id: draftId,
      }),
    ).toThrow(/附件尚未上传完成/);

    // 2. 上传一个 AGY 不支持的图片格式 (例如 webp)
    const unsupportedDraftId = "draft-req-unsupported-format";
    const webpMeta = fileService.createMetadata(unsupportedDraftId, {
      request_id: "file-req-webp",
      display_name: "sample.webp",
      size: 10,
      declared_mime: "image/webp",
    });
    // 伪造上传为 ready
    const draftFile = s.store.get<ConversationFile>(CONVERSATION_ENTITY.file, webpMeta.file_id)!;
    s.store.put(CONVERSATION_ENTITY.file, webpMeta.file_id, unsupportedDraftId, {
      ...draftFile,
      status: "ready",
      detected_mime: "image/webp",
    });

    expect(() =>
      createService.execute({
        request_id: "req-unsupported-format",
        workspace_root: repo.repo,
        request_text: "测试不支持格式",
        title: "不支持格式测试",
        workspace_mode: "existing_workspace",
        planner_profile: agyProfile,
        executor_profile: agyProfile,
        attachment_ids: [webpMeta.file_id],
        draft_id: unsupportedDraftId,
      }),
    ).toThrow(/不支持此附件格式/);
  });

  it("首次规划 materials 能够读取首条需求中的附件并在 handoff 中完整传递", async () => {
    const s = setup();
    const repo = await repository(s.root);
    const p = project(repo.repo);
    s.store.put("project", p.id, "global", p);

    const codexProfile = {
      id: "profile-codex",
      revision: 1,
      adapterId: "codex" as const,
      executableRef: process.execPath,
      modelSelection: "explicit" as const,
      modelId: "gpt-4o",
      options: {},
    };
    s.store.put("tool_profile", "profile-codex", "global", codexProfile);
    seedVerifiedAccess(s.store, codexProfile);

    const fileService = new ConversationFileService(s.store, s.config.storage_root);
    const createService = new CreateWorkflowService(s.store, s.config, undefined, fileService);

    const draftId = "draft-req-plan-1";
    const meta = fileService.createMetadata(draftId, {
      request_id: "planning-file-1",
      display_name: "plan-mock.png",
      size: PNG_1X1.length,
      declared_mime: "image/png",
    });
    await fileService.writeContent(draftId, meta.file_id, PNG_1X1, PNG_1X1.length);

    const created = createService.execute({
      request_id: "req-plan-1",
      workspace_root: repo.repo,
      request_text: "带图规划需求",
      title: "带图规划",
      workspace_mode: "existing_workspace",
      planner_profile: codexProfile,
      executor_profile: codexProfile,
      attachment_ids: [meta.file_id],
      draft_id: draftId,
    });

    // 检查 requirement_message
    const reqMsgs = s.store.list<{ attachment_ids?: string[] }>("requirement_message", created.workflow.id);
    expect(reqMsgs.length).toBe(1);
    expect(reqMsgs[0]!.attachment_ids).toEqual([meta.file_id]);

    // 检查已就绪附件
    const files = s.store.list<ConversationFile>(CONVERSATION_ENTITY.file, created.workflow.id);
    expect(files.some(f => f.id === meta.file_id && f.status === "ready")).toBe(true);
  });
});

const draftFixtures: Array<ReturnType<typeof setup>> = [];
afterEach(() => {
  for (const s of draftFixtures.splice(0)) {
    s.store.close();
    rmSync(s.root, { recursive: true, force: true });
  }
});

function draftFixture(requestId = "draft-files") {
  const s = setup();
  draftFixtures.push(s);
  const files = new ConversationFileService(s.store, s.config.storage_root);
  const draftId = `draft-${requestId}`;
  const target: Workflow = {
    id: "wf-target", project_id: "p-target", title: "附件绑定", request: "读取附件",
    complexity: "simple", workspace_mode: "existing_workspace", state: "PLANNING", stage: "planning",
    version: 1, plan_revision: 0, environment_revision: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), feedback: [],
  };
  async function upload(clientRequestId = "image-upload", content = PNG_1X1, mime = "image/png") {
    const meta = files.createMetadata(draftId, {
      request_id: clientRequestId, display_name: "image", size: content.length, declared_mime: mime,
    });
    return files.writeContent(draftId, meta.file_id, content);
  }
  return { s, files, draftId, requestId, target, upload };
}

describe("R05-R08 草稿归属、完整性和取消恢复", () => {
  it("拒绝其他创建请求认领草稿，保留原附件内容", async () => {
    const { s, files, draftId, upload } = draftFixture("request-a");
    const file = await upload();
    const service = new CreateWorkflowService(s.store, s.config, undefined, files);
    expect(() => service.execute({
      request_id: "request-b", draft_id: draftId, attachment_ids: [file.id],
      title: "错误归属", workspace_root: s.root, request_text: "读取图片",
    })).toThrow(/不属于本次创建请求/);
    expect(files.getMetadata(draftId, file.id).status).toBe("ready");
    expect(existsSync(conversationFileContentPath(s.config.storage_root, draftId, file.id))).toBe(true);
  });

  it.each(["missing", "changed"])("内容%s时拒绝迁移，事务不产生附件新归属", async (mode) => {
    const { s, files, draftId, requestId, target, upload } = draftFixture();
    const file = await upload();
    const content = conversationFileContentPath(s.config.storage_root, draftId, file.id);
    if (mode === "missing") unlinkSync(content);
    else writeFileSync(content, Buffer.alloc(file.size, 1));
    expect(() => s.store.transaction(() => files.bindDraftFiles(
      draftId, target, [file.id], "msg-initial", requestId,
    ))).toThrow(/内容/);
    expect(files.getMetadata(draftId, file.id).referenced_message_ids).toEqual([]);
    expect(existsSync(conversationFileContentPath(s.config.storage_root, target.id, file.id))).toBe(false);
  });

  it("数据库失败时恢复原件；恢复冲突登记后可重试恢复", async () => {
    const { s, files, draftId, requestId, target, upload } = draftFixture();
    const file = await upload();
    const original = conversationFileContentPath(s.config.storage_root, draftId, file.id);
    const moved = conversationFileContentPath(s.config.storage_root, target.id, file.id);
    expect(() => s.store.transaction(() => {
      files.bindDraftFiles(draftId, target, [file.id], "msg-initial", requestId);
      throw new Error("database write failed");
    })).toThrow("database write failed");
    expect(existsSync(original)).toBe(true);
    expect(existsSync(moved)).toBe(false);
    expect(() => s.store.transaction(() => {
      files.bindDraftFiles(draftId, target, [file.id], "msg-initial", requestId);
      s.store.onRollback(() => mkdirSync(dirname(original), { recursive: true }));
      throw new Error("database write failed again");
    })).toThrow(/恢复/);
    expect(s.store.list("conversation_file_move_recovery", draftId)).toHaveLength(1);
    expect(existsSync(moved)).toBe(true);
    rmSync(dirname(original), { recursive: true, force: true });
    files.assertDraftForRequest(draftId, requestId);
    expect(existsSync(original)).toBe(true);
    expect(existsSync(moved)).toBe(false);
    expect(s.store.list("conversation_file_move_recovery", draftId)).toHaveLength(0);
  });

  it.each(["image/avif", "image/bmp"])("%s 与运行时使用同一分类，在创建前明确拒绝", async (mime) => {
    const { s, files, draftId, requestId, upload } = draftFixture();
    const file = await upload("unknown-image", Buffer.from("unrecognized-image-content"), mime);
    const profile = { id: "codex", revision: 1, adapterId: "codex" as const,
      modelSelection: "native-config" as const, options: {} };
    const service = new CreateWorkflowService(s.store, s.config, undefined, files);
    expect(() => service.execute({ request_id: requestId, draft_id: draftId,
      attachment_ids: [file.id], workspace_root: s.root, title: "图片格式", request_text: "读取图片",
      planner_profile: profile, executor_profile: profile,
    })).toThrow(/格式尚未接入/);
    expect(s.store.list("workflow")).toHaveLength(0);
  });

  it("按请求取消早于元数据、晚于元数据及重复取消都不会复活附件", async () => {
    const { s, files, draftId, upload } = draftFixture();
    files.cancelDraftRequest(draftId, "early");
    const input = { request_id: "early", display_name: "image.png", size: PNG_1X1.length, declared_mime: "image/png" };
    expect(() => files.createMetadata(draftId, input)).toThrow(/已取消/);
    const file = await upload("late");
    files.cancelDraftRequest(draftId, "late");
    files.cancelDraftRequest(draftId, "late");
    expect(files.getMetadata(draftId, file.id).status).toBe("deleted");
    expect(existsSync(conversationFileContentPath(s.config.storage_root, draftId, file.id))).toBe(false);
    expect(s.store.get("idempotency_record", `conversation-file:${draftId}:late`)).toBeUndefined();
    await expect(files.writeContent(draftId, file.id, PNG_1X1)).rejects.toThrow(/已取消/);
  });

  it("上传中取消后，迟到内容不会重新变为ready", async () => {
    const { s, files, draftId } = draftFixture();
    const meta = files.createMetadata(draftId, {
      request_id: "uploading", display_name: "image.png", size: PNG_1X1.length, declared_mime: "image/png",
    });
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const firstChunk = new Promise<void>(resolve => { started = resolve; });
    async function* source() {
      yield PNG_1X1.subarray(0, 8);
      started();
      await gate;
      yield PNG_1X1.subarray(8);
    }
    const result = files.writeContent(draftId, meta.file_id, source()).catch(error => error);
    await firstChunk;
    files.cancelDraftRequest(draftId, "uploading");
    release();
    expect(await result).toMatchObject({ code: "DRAFT_CANCELLED" });
    expect(files.getMetadata(draftId, meta.file_id).status).toBe("deleted");
    expect(existsSync(conversationFileContentPath(s.config.storage_root, draftId, meta.file_id))).toBe(false);
  });

  it("过期回收删除未绑定内容，整草稿取消保护已绑定材料", async () => {
    const { s, files, draftId, requestId, target, upload } = draftFixture();
    const bound = await upload("bound");
    const abandoned = await upload("abandoned");
    s.store.transaction(() => files.bindDraftFiles(draftId, target, [bound.id], "msg-initial", requestId));
    files.cleanupExpiredDrafts(Date.now() + 25 * 60 * 60 * 1000);
    expect(files.getMetadata(draftId, abandoned.id).status).toBe("deleted");
    files.cancelDraftScope(draftId);
    files.cancelDraftScope(draftId);
    expect(files.getMetadata(target.id, bound.id).status).toBe("ready");
    expect(existsSync(conversationFileContentPath(s.config.storage_root, target.id, bound.id))).toBe(true);
    expect(() => files.createMetadata(draftId, { request_id: "late", display_name: "late.png",
      size: PNG_1X1.length, declared_mime: "image/png" })).toThrow(/已取消/);
  });
});
