import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildServer } from "../../apps/api/src/server.js";
import { GroupChat } from "../../packages/group-chat/src/service.js";
import { openCodeGroupFailure, parseGroupReply } from "../../packages/group-chat/src/model-runner.js";
import { scoreTotal, type Action } from "../../packages/group-chat/src/contracts.js";
import { groupChatFixtureModel } from "../fixtures/group-chat-model.js";
import { setup, testConsoleHeaders } from "../helpers.js";

const models = [
  { tool: "codex", model: "gpt-6.1-sol", nickname: "墨舟" },
  { tool: "agy", model: "gemini-flash", nickname: "远山" },
] as const;
const resources: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of resources.splice(0).reverse()) await close(); });
function fixture() {
  const test = setup();
  const skill = join(test.root, "skill");
  mkdirSync(join(skill, "references"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "# plan-fiction");
  for (const file of ["character-and-premise.md", "causality-and-pressure.md", "reader-and-structure.md", "delivery-and-review.md"])
    writeFileSync(join(skill, "references", file), "小说结构参考");
  const run = vi.fn(groupChatFixtureModel);
  const chat = new GroupChat(test.store, test.config.storage_root, run, () => true, skill);
  resources.push(async () => { await chat.close(); test.store.close(); rmSync(test.root, { recursive: true, force: true }); });
  const group = chat.createGroup("模型群", "我", [...models], 0);
  return {
    ...test, chat, run, group,
    act: (id: string, input: Action, request = randomUUID()) => chat.act(id, chat.session(id).version, request, input),
    wait: (id: string, stage: string, status = "waiting") => vi.waitFor(() => {
      expect(chat.view(id).round).toMatchObject({ stage, status });
    }, { timeout: 7000, interval: 40 }),
  };
}

describe("模型群聊", () => {
  it("分别改名、按成员投递与执行，并隔离、删除工作目录", async () => {
    const { chat, group, run, act, wait, root } = fixture();
    const first = chat.createSession(group.id, "会话一", "open");
    const second = chat.createSession(group.id, "会话二", "open");
    const renamed = chat.rename(first.id, true, first.version, group.members[0]!.id, "墨舟新名");
    expect(() => chat.rename(first.id, true, renamed.version, group.members[1]!.id, "墨舟新名")).toThrow("昵称须唯一");
    chat.rename(first.id, true, renamed.version, "human", "创作者");
    const request = randomUUID();
    const input = { action: "send", text: "创建一个文件", targets: [group.members[0]!.id], mode: "execute" } as const;
    const message: Action = { ...input, targets: [...input.targets] };
    await act(first.id, message, request);
    await act(first.id, message, request);
    await wait(first.id, "reply", "done");
    expect(run).toHaveBeenCalledTimes(1);
    const data = chat.view(first.id);
    expect(data.messages[0]).toMatchObject({ author: "创作者", recipients: ["human", ...group.members.map(member => member.id)] });
    expect(data.messages[1]?.author).toBe("墨舟新名");
    expect(chat.session(second.id).members[0]?.nickname).toBe("墨舟");
    expect(() => chat.document(second.id, data.artifacts[0]!.id)).toThrow("文档不属于此会话");
    await act(second.id, { action: "send", text: "生成 AGY 的笔记", mode: "execute", targets: [group.members[1]!.id] });
    await wait(second.id, "reply", "done");
    expect(existsSync(join(chat.workspace(second.id), "work", group.members[1]!.id, "drafts", "notes.md"))).toBe(true);
    expect(run.mock.calls.at(-1)?.[0].execute).toBe(false);
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.md"), "保留");
    symlinkSync(outside, join(chat.workspace(first.id), "external"), process.platform === "win32" ? "junction" : "dir");
    const directory = chat.workspace(first.id);
    await chat.remove(first.id, chat.session(first.id).version, true);
    expect(existsSync(directory)).toBe(false);
    expect(existsSync(join(outside, "keep.md"))).toBe(true);
    expect(existsSync(chat.workspace(second.id))).toBe(true);
  });

  it("其他工具通过受控文本文件任务执行，路径越界时回滚已经创建的文件", async () => {
    const { chat, group, run, act, root } = fixture();
    const row = chat.createSession(group.id, "文件范围", "open");
    const member = group.members[1]!;
    run.mockResolvedValueOnce(JSON.stringify({
      summary: "准备文件", files: [{ path: "drafts/valid.md", content: "valid" }, { path: "../unsafe.md", content: "unsafe" }],
    }));
    await act(row.id, { action: "send", text: "生成 Markdown", mode: "execute", targets: [member.id] });
    await vi.waitFor(() => expect(chat.view(row.id).round?.jobs[0]).toMatchObject({ state: "failed", error: "文件任务包含不可用的相对路径" }));
    expect(existsSync(join(chat.workspace(row.id), "work", member.id, "drafts", "valid.md"))).toBe(false);
    expect(existsSync(join(root, "unsafe.md"))).toBe(false);
  });

  it("删除运行中的会话先停止成员，并禁止迟到回复重建文件", async () => {
    const { chat, group, run, act, wait } = fixture();
    const row = chat.createSession(group.id, "运行中", "open");
    const directory = chat.workspace(row.id);
    let cancelled = false;
    run.mockImplementationOnce(({ signal }) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        cancelled = true;
        reject(new Error("stopped"));
      }, { once: true });
    }));
    await act(row.id, { action: "send", text: "运行中请求", mode: "reply" });
    await wait(row.id, "reply", "running");
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await chat.remove(row.id, chat.session(row.id).version, true);
    expect(cancelled).toBe(true);
    expect(existsSync(directory)).toBe(false);
    expect(() => chat.view(row.id)).toThrow("会话不存在");
  });

  it("小说选题重想、含自投的投票、选择问题及大纲成稿", async () => {
    const { chat, group, run, act, wait } = fixture();
    const { id } = chat.createSession(group.id, "小说", "fiction");
    await act(id, { action: "send", text: "构思一篇中短篇小说", mode: "scene" });
    await wait(id, "idea_vote");
    const first = chat.view(id);
    expect(first.round?.candidates).toHaveLength(2);
    const votes = first.artifacts.flatMap(item => item.ballot ? [item.ballot] : []);
    expect(votes).toHaveLength(2);
    expect(votes.every(vote => vote.reasons.length === 2)).toBe(true);
    await act(id, { action: "restart", text: "避免以梦收尾" });
    await wait(id, "idea_vote");
    const second = chat.view(id);
    expect(second.round?.id).not.toBe(first.round?.id);
    expect(run.mock.calls.some(([call]) => call.prompt.includes("避免以梦收尾"))).toBe(true);
    await act(id, { action: "premise", artifact: second.round!.candidates[1] });
    await wait(id, "question_vote");
    const question = chat.view(id).round!.candidates[1]!;
    await act(id, { action: "question", artifact: question });
    expect(chat.view(id).artifacts.find(item => item.id === question)?.options).toHaveLength(3);
    await act(id, { action: "answer", text: "由我决定让主角坦白" });
    await wait(id, "question_vote");
    expect(chat.session(id).answers[0]?.answer).toBe("由我决定让主角坦白");
    await act(id, { action: "outline", text: "", member: group.members[1]!.id });
    await wait(id, "outline");
    const outline = chat.view(id).round!.jobs[0]!.artifact!;
    expect(chat.document(id, outline).body).toContain("# 小说大纲");
    await act(id, { action: "adopt", artifact: outline });
    expect(chat.session(id).adopted).toBe(outline);
  }, 20_000);

  it("独立出方案、给全体方案评分并由指定成员修订", async () => {
    const { chat, group, run, act, wait } = fixture();
    const { id } = chat.createSession(group.id, "方案", "design");
    await act(id, { action: "send", text: "设计群聊文件隔离", mode: "scene" });
    await wait(id, "reviews");
    const view = chat.view(id);
    const reviews = view.round!.jobs.map(job => chat.document(id, job.artifact!));
    expect(reviews).toHaveLength(2);
    expect(reviews.every(doc => doc.scores?.length === 2 && doc.body.includes("自评"))).toBe(true);
    expect(scoreTotal(reviews[0]!.scores![0]!)).toBe(82);
    expect(run.mock.calls.filter(([call]) => call.prompt.includes("返回 JSON 数组"))
      .every(([call]) => call.prompt.match(/## 验收/g)?.length === 2)).toBe(true);
    run.mockClear();
    await act(id, { action: "final", member: group.members[1]!.id, artifact: view.round!.candidates[0], text: "吸收失败恢复建议" });
    await wait(id, "final");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0].member.nickname).toBe("远山");
    expect(run.mock.calls[0]?.[0].prompt).toContain("比较简报");
    expect(chat.session(id).adopted).toBeUndefined();
    expect(chat.document(id, chat.view(id).round!.jobs[0]!.artifact!).body).toContain("# 最终稿");
  });

  it("经正式 API 校验来源、输入以及会话归属", async () => {
    const test = setup();
    const app = await buildServer(test.engine, { groupRunModel: groupChatFixtureModel });
    resources.push(async () => { await app.close(); test.store.close(); rmSync(test.root, { recursive: true, force: true }); });
    const headers = testConsoleHeaders(test.config);
    const payload = { title: "测试群", human: "我", members: [...models], admin: 0 };
    expect((await app.inject({ method: "POST", url: "/api/groups", headers: { ...headers, origin: "https://elsewhere.example" }, payload })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/api/groups", headers, payload: { ...payload, members: [] } })).statusCode).toBe(422);
    const created = await app.inject({ method: "POST", url: "/api/groups", headers, payload });
    expect(created.statusCode).toBe(200);
    const group = created.json();
    const renamed = await app.inject({ method: "PATCH", url: `/api/groups/${group.id}/nickname`, headers, payload: {
      member: group.members[1].id, version: group.version, nickname: "独立改名",
    } });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json().members[1].nickname).toBe("独立改名");
  });

  it("OpenCode 区分已耗尽额度与可以重试的限流", () => {
    expect(openCodeGroupFailure('message="stream error" error="AI_APICallError: Free usage limit reached."')).toContain("免费额度限制");
    expect(openCodeGroupFailure('error="insufficient_quota"')).toContain("当前提供方的额度不足");
    expect(openCodeGroupFailure("HTTP 429: rate limited, retry after 2 seconds")).toBeUndefined();
  });

  it("AGY 的群聊结构化文件任务保留完整 JSON，而普通回复仍可提取摘要", () => {
    const response = JSON.stringify({ summary: "已准备文件", files: [{ path: "check.md", content: "OK" }] });
    const stdout = JSON.stringify({ event: "result", result: { status: "SUCCESS", response } });
    expect(parseGroupReply("agy", stdout, true)).toBe(response);
    expect(parseGroupReply("agy", stdout)).toBe("已准备文件");
  });

  it("解码不同 CLI 的公开正文，拒绝失败结果", () => {
    expect(parseGroupReply("codex", '{"type":"item.completed","item":{"type":"agent_message","text":"Codex 回复"}}')).toBe("Codex 回复");
    expect(parseGroupReply("agy", '{"event":"result","result":{"status":"SUCCESS","response":"AGY 回复"}}')).toBe("AGY 回复");
    expect(parseGroupReply("opencode", '{"type":"text","part":{"text":"OpenCode 回复"}}')).toBe("OpenCode 回复");
    expect(() => parseGroupReply("agy", '{"event":"result","result":{"status":"FAILED"}}')).toThrow();
  });
});
