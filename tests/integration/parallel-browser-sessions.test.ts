import { expect, it, vi } from "vitest";
import { setup, project } from "../helpers.js";
import { BrowserGateway } from "../../packages/runtime/src/browser.js";
import { objectHash } from "../../packages/core/src/util.js";

it("parallel browser calls in one run own separate tabs and stop together", async () => {
  const s = setup();
  const p = project(s.root);
  p.browser_scenes = [{ id: "scene", steps: ["fixture"], assertions: ["fixture"], allowed_tools: ["browser_open_tab", "browser_get_tab_content"] }];
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create({ project_id: p.id, title: "browser", request: "fixture", complexity: "simple", workspace_mode: "existing_workspace" }, crypto.randomUUID());
  s.store.put("workflow", w.id, p.id, { ...w, state: "VERIFYING", run_id: "shared-run" });
  const origin = "http://127.0.0.1:14816";
  s.store.put("environment", w.id, w.id, { services: [{ id: "frontend", origin }] });
  s.store.put("browser_recipe", p.id + "-scene", p.id, { project_id: p.id, scene_id: "scene", project_hash: objectHash(p), origins: [origin], actions: [
    { tool: "browser_open_tab", arguments: { url: origin }, capture: { TAB: "/id" }, assertions: [{ pointer: "/id", minimum: 1 }] },
    { tool: "browser_get_tab_content", arguments: { tabId: "${TAB}" }, capture: {}, assertions: [{ pointer: "/content", equals: "ok", case_id: "C01" }] },
  ] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => release = resolve);
  const closed: number[] = [];
  let reading = 0, nextTab = 1;
  const gateway = new BrowserGateway(s.engine);
  vi.spyOn(gateway, "connect").mockImplementation(async () => {
    const tab = nextTab++;
    return {
      listTools: async () => ({ tools: p.browser_scenes[0]!.allowed_tools.map(name => ({ name })) }),
      callTool: async ({ name, arguments: args }: any) => {
        if (name === "browser_get_tab_content") { reading++; await gate; }
        if (name === "browser_close_tab") closed.push(args.tabId);
        return { content: [], structuredContent: name === "browser_open_tab" ? { id: tab } : name === "browser_get_tab_info" ? { url: origin } : { content: "ok" } };
      }, close: async () => {},
    } as any;
  });
  try {
    const calls = [gateway.run(w.id, "shared-run", "scene", "check-A"), gateway.run(w.id, "shared-run", "scene", "check-B")];
    await vi.waitFor(() => expect(reading).toBe(2));
    expect(s.store.list<any>("lease", w.id).map(l => l.id)).toEqual(["browser:session:check-A", "browser:session:check-B"]);
    const stopped = gateway.stop("shared-run");
    release();
    await Promise.all(calls); await stopped;
    expect(closed.sort()).toEqual([1, 2]);
    expect(s.store.list("lease", w.id)).toHaveLength(0);
    expect(s.store.list<any>("browser_session", w.id).every(session => session.status === "closed" && session.tabs.length === 0)).toBe(true);
  } finally { release(); s.store.close(); }
});
