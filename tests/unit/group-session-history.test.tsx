// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GroupChatPage } from "../../apps/web/src/group-chat.js";
import type { Group, Message, Session } from "../../packages/group-chat/src/contracts.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const member = { id: "member", nickname: "模型", tool: "codex" as const, model: "example" };
const group: Group = { id: "group", title: "历史分页", version: 1, human: "我", admin: member.id, members: [member] };
const session = (id: string): Session => ({
  ...group, id, group: group.id, title: `会话 ${id}`, scene: "open", archived: false, answers: [],
  created: "2026-11-12T00:00:00Z", updated: "2026-11-12T00:00:00Z",
});
const a = session("A");
const b = session("B");
const message = (id: string, seq: number): Message & { seq: number } => ({
  id, seq, text: id, author: "我", recipients: [], created: "2026-11-12T00:00:00Z",
});
const view = (row: Session, text: string, next?: number) => ({
  session: row, messages: [message(text, next === undefined ? 1 : next + 1)], artifacts: [], next,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let root: Root | undefined;
let container: HTMLDivElement;
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount(history: (url: URL) => Promise<Response>) {
  vi.useFakeTimers();
  const fetchMock = vi.fn<typeof fetch>(async input => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/groups") return Response.json([group]);
    if (url.pathname === "/api/groups/group/sessions") return Response.json({ items: [a, b] });
    if (url.searchParams.has("before") || url.pathname.includes("/artifacts/")) return history(url);
    if (url.pathname === "/api/group-sessions/A") return Response.json(view(a, "A 最新消息", 10));
    if (url.pathname === "/api/group-sessions/B") return Response.json(view(b, "B 最新消息", 20));
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<GroupChatPage />));
  await act(async () => vi.advanceTimersByTimeAsync(150));
  return fetchMock;
}
async function select(id: string) {
  const item = Array.from(container.querySelectorAll<HTMLElement>(".gc-session-item"))
    .find(row => row.querySelector(".gc-session-item-title")?.textContent === `会话 ${id}`);
  expect(item).toBeDefined();
  await act(async () => item!.click());
}
async function loadOlder() {
  const button = container.querySelector<HTMLButtonElement>(".gc-btn-load-more");
  expect(button).not.toBeNull();
  expect(button!.disabled).toBe(false);
  await act(async () => button!.click());
}
const threadText = () => container.querySelector(".gc-thread")?.textContent ?? "";

describe("R13: selected session owns history responses and pagination", () => {
  it("discards A's late history after switching to B and uses B's cursor", async () => {
    const late = deferred<Response>();
    const fetchMock = await mount(async url => url.pathname.endsWith("/A")
      ? late.promise : Response.json(view(b, "B 更早消息")));
    await select("A");
    await loadOlder();
    await select("B");
    await act(async () => late.resolve(Response.json(view(a, "A 迟到历史", 5))));
    expect(threadText()).toContain("B 最新消息");
    expect(threadText()).not.toContain("A 迟到历史");
    await loadOlder();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/group-sessions/B?before=20")).toBe(true);
    expect(threadText()).toContain("B 更早消息");
    expect(container.querySelector(".gc-btn-load-more")).toBeNull();
  });

  it("rejects the old selection's response even after switching A to B to A", async () => {
    const late = deferred<Response>();
    let requests = 0;
    await mount(async () => ++requests === 1 ? late.promise : Response.json(view(a, "A 新历史")));
    await select("A");
    await loadOlder();
    await select("B");
    await select("A");
    await act(async () => late.resolve(Response.json(view(a, "A 旧选择历史", 5))));
    expect(threadText()).toContain("A 最新消息");
    expect(threadText()).not.toContain("A 旧选择历史");
    await loadOlder();
    expect(threadText()).toContain("A 新历史");
    expect(container.querySelector(".gc-btn-load-more")).toBeNull();
  });

  it("keeps successive history pages from the current session", async () => {
    await mount(async url => Response.json(view(a,
      url.searchParams.get("before") === "10" ? "A 第一页历史" : "A 第二页历史",
      url.searchParams.get("before") === "10" ? 5 : undefined)));
    await select("A");
    await loadOlder();
    await loadOlder();
    expect(threadText()).toContain("A 第一页历史");
    expect(threadText()).toContain("A 第二页历史");
    expect(threadText()).toContain("A 最新消息");
    expect(container.querySelector(".gc-btn-load-more")).toBeNull();
  });

  it("does not report a late history failure in a different session", async () => {
    const late = deferred<Response>();
    await mount(async () => late.promise);
    await select("A");
    await loadOlder();
    await select("B");
    await act(async () => late.reject(new Error("A 历史读取失败")));
    expect(threadText()).toContain("B 最新消息");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
