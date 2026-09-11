import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { BrowserGateway } from "../../packages/runtime/src/browser.js";
import { objectHash } from "../../packages/core/src/util.js";
const s = setup(),
  r = await repository(s.root),
  p = project(r.repo);
s.config.opentabs.endpoint = "http://127.0.0.1:9515/mcp";
s.config.opentabs.secret_file = join(
  homedir(),
  ".opentabs/extension/auth.json",
);
const tools = [
  "browser_open_tab",
  "browser_get_tab_info",
  "browser_wait_for_element",
  "browser_type_text",
  "browser_click_element",
  "browser_get_tab_content",
];
p.browser_scenes = [
  {
    id: "roundtrip",
    steps: ["输入并提交测试标记"],
    assertions: ["页面结果包含指定文本"],
    allowed_tools: tools,
  },
];
await s.engine.registerProject(p);
const w = s.engine.create(
  {
    project_id: p.id,
    title: "真实 Browser Gateway 验收",
    request: "专用本机测试页面",
    complexity: "simple",
    workspace_mode: "existing_workspace",
  },
  "gateway",
);
s.engine.submitPlan(w.id, plan(objectHash(p), r.baseline), w.version, "plan");
const a = proof(s.engine, w.id, "approve");
s.engine.approve(w.id, a.proof, a.binding);
s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
  run_id: "gateway-live",
});
s.store.put("environment", w.id, w.id, {
  services: [{ id: "frontend", origin: "http://127.0.0.1:14816" }],
});
s.store.put("browser_recipe", `${p.id}-roundtrip`, p.id, {
  project_id: p.id,
  scene_id: "roundtrip",
  project_hash: objectHash(p),
  origins: ["${DEVFLOW_FRONTEND_ORIGIN}"],
  actions: [
    {
      tool: "browser_open_tab",
      arguments: { url: "${DEVFLOW_FRONTEND_ORIGIN}" },
      capture: { TAB: "/id" },
      assertions: [{ pointer: "/id", minimum: 1 }],
    },
    {
      tool: "browser_wait_for_element",
      arguments: { tabId: "${TAB}", selector: "#submit", visible: true },
      assertions: [{ pointer: "/found", equals: true }],
    },
    {
      tool: "browser_type_text",
      arguments: {
        tabId: "${TAB}",
        selector: "#name",
        text: "GATEWAY-LIVE-947620",
      },
      assertions: [{ pointer: "/value", equals: "GATEWAY-LIVE-947620" }],
    },
    {
      tool: "browser_click_element",
      arguments: { tabId: "${TAB}", selector: "#submit" },
      assertions: [{ pointer: "/clicked", equals: true }],
    },
    {
      tool: "browser_get_tab_content",
      arguments: { tabId: "${TAB}", selector: "#result" },
      assertions: [
        {
          pointer: "/content",
          equals: "GATEWAY-LIVE-947620",
          case_id: "browser-roundtrip",
        },
      ],
    },
  ],
});
const server = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html;charset=utf-8");
  res.end(
    '<html><title>DevFlow Gateway 验收</title><input id="name"><button id="submit" onclick="document.getElementById(\'result\').textContent=document.getElementById(\'name\').value">确认</button><p id="result">等待</p></html>',
  );
});
await new Promise<void>((r) => server.listen(14816, "127.0.0.1", r));
try {
  const result = await new BrowserGateway(s.engine).run(
    w.id,
    "gateway-live",
    "roundtrip",
  );
  mkdirSync(".cache/live-opentabs", { recursive: true });
  writeFileSync(".cache/live-opentabs/gateway.json", readFileSync(result.path));
  console.log(
    JSON.stringify({
      passed: true,
      ...result,
      shared_lease_released: !s.store.get("lease", "browser:shared"),
    }),
  );
} finally {
  await new Promise<void>((r) => server.close(() => r()));
  s.store.close();
}
