import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { setup, repository } from "../helpers.js";
import {
  ProjectSchema,
  requireCondition,
} from "../../packages/contracts/src/index.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
import { Environments } from "../../packages/runtime/src/environment.js";
import { BrowserGateway } from "../../packages/runtime/src/browser.js";
import { objectHash } from "../../packages/core/src/util.js";
const s = setup(),
  r = await repository(s.root),
  other = await repository(s.root, "second");
const p = ProjectSchema.parse(
  JSON.parse(readFileSync("examples/project.json", "utf8")),
);
p.repositories[0]!.path = r.repo;
p.browser_scenes[0]!.allowed_tools.push("browser_navigate_tab");
for (const c of p.commands) c.executable = process.execPath;
await s.engine.registerProject(p);
const q = {
  ...p,
  id: "second",
  repositories: [{ id: "main", path: other.repo }],
};
await s.engine.registerProject(q);
s.config.opentabs.secret_file = join(
  homedir(),
  ".opentabs/extension/auth.json",
);
const processes = new ProcessManager(
    resolve(
      "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
    ),
    true,
  ),
  environments = new Environments(s.engine, processes),
  browser = new BrowserGateway(s.engine),
  flows: any[] = [],
  results: any[] = [];
const output = resolve(".cache/live-opentabs/parallel-" + Date.now());
mkdirSync(output, { recursive: true });
try {
  for (let i = 0; i < 3; i++) {
    const project = i === 2 ? q : p,
      w = s.engine.create(
        {
          project_id: project.id,
          title: "真实浏览器并行环境 " + i,
          request: "核对动态端口和各自持久化数据",
          complexity: "simple",
          workspace_mode: "new_worktree",
        },
        "parallel-live-" + i,
      );
    await s.engine.git.prepare(project, w.id, "new_worktree", {
      main: i === 2 ? other.baseline : r.baseline,
    });
    s.engine.transition(w.id, ["RESEARCHING"], "EXECUTING", "browser_probe", {
      run_id: "browser-run-" + i,
    });
    flows.push(s.engine.get(w.id));
  }
  const envs = await Promise.all(flows.map((w) => environments.ensure(w)));
  requireCondition(
    new Set(envs.flatMap((e) => e.services.map((s) => s.port))).size === 6,
    "PORT_COLLISION",
    "三套环境端口冲突",
  );
  for (let i = 0; i < 3; i++) {
    const w = flows[i]!,
      project = s.engine.project(w.project_id),
      marker = "ONLY-" + w.id;
    const recipe = JSON.parse(
      readFileSync("examples/browser-recipe.json", "utf8").replaceAll(
        "DEVFLOW-NOTES-ACCEPTED",
        marker,
      ),
    );
    recipe.project_id = project.id;
    recipe.actions.push(
      {
        tool: "browser_navigate_tab",
        arguments: { tabId: "${TAB}", url: "${DEVFLOW_FRONTEND_ORIGIN}" },
        assertions: [
          { pointer: "/url", contains: "${DEVFLOW_FRONTEND_ORIGIN}" },
        ],
      },
      {
        tool: "browser_wait_for_element",
        arguments: {
          tabId: "${TAB}",
          selector: "#result[data-ready='true']",
          visible: true,
        },
        assertions: [{ pointer: "/found", equals: true }],
      },
      {
        tool: "browser_get_tab_content",
        arguments: { tabId: "${TAB}", selector: "#result" },
        assertions: [
          { pointer: "/content", equals: marker, case_id: "notes-reloaded" },
        ],
      },
    );
    s.store.put("browser_recipe", project.id + "-notes", project.id, {
      ...recipe,
      project_hash: objectHash(project),
    });
    const result = await browser.run(w.id, w.run_id, "notes");
    writeFileSync(join(output, w.id + ".json"), readFileSync(result.path));
    results.push({ workflow_id: w.id, ...result });
  }
  for (let i = 0; i < 3; i++) {
    const origin = envs[i]!.services.find((s) => s.id === "frontend")!.origin;
    const result: any = await (await fetch(origin + "/api/notes")).json();
    requireCondition(
      result.text === "ONLY-" + flows[i]!.id,
      "DATA_CROSSED",
      "数据串到其他工作流",
    );
  }
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(
      {
        passed: true,
        environments: envs,
        results,
        shared_lease_released: !s.store.get("lease", "browser:shared"),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      environments: 3,
      unique_ports: 6,
      browser_scenes: 3,
      output,
    }),
  );
} finally {
  for (const w of flows) await environments.stop(w.id);
  await processes.close();
  s.store.close();
}
