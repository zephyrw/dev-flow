import { it, expect } from "vitest";
import { setup, repository, project } from "../helpers.js";
import { resolve, join } from "node:path";
import { readFileSync } from "node:fs";
import { Environments } from "../../packages/runtime/src/environment.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
it("IT-06/07 three parallel environments use distinct ports, real frontend proxies and isolated persisted data", async () => {
  const s = setup(),
    r = await repository(s.root),
    other = await repository(s.root, "other"),
    p = project(r.repo);
  p.commands = [
    {
      ...p.commands[0]!,
      id: "api",
      executable: process.execPath,
      args: [resolve("examples/demo/api.mjs")],
      lifecycle: "service",
      parser: "none",
      report_path: undefined,
    },
    {
      ...p.commands[0]!,
      id: "web",
      executable: process.execPath,
      args: [resolve("examples/demo/frontend.mjs")],
      lifecycle: "service",
      parser: "none",
      report_path: undefined,
    },
  ];
  p.services = [
    {
      id: "backend",
      repo_id: "main",
      command_id: "api",
      port_pool: "backend",
      health_path: "/health",
      identity_header: "x-devflow-identity",
    },
    {
      id: "frontend",
      repo_id: "main",
      command_id: "web",
      port_pool: "frontend",
      health_path: "/health",
      backend_probe_path: "/api/health",
      identity_header: "x-devflow-identity",
    },
  ];
  await s.engine.registerProject(p);
  const q = {
    ...p,
    id: "p2",
    repositories: [{ id: "main", path: other.repo }],
  };
  await s.engine.registerProject(q);
  const manager = new ProcessManager(
      resolve(
        "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
      ),
      true,
    ),
    environments = new Environments(
      s.engine,
      manager,
    );
  const flows = [];
  try {
    for (let i = 0; i < 3; i++) {
      const source = i === 2 ? q : p,
        baseline = i === 2 ? other.baseline : r.baseline;
      const w = s.engine.create(
        {
          project_id: source.id,
          title: "并行环境" + i,
          request: "测试环境隔离",
          complexity: "simple",
          workspace_mode: "new_worktree",
        },
        "parallel-" + i,
      );
      await s.engine.git.prepare(source, w.id, "new_worktree", {
        main: baseline,
      });
      flows.push(w);
    }
    const envs = await Promise.all(flows.map((w) => environments.ensure(w)));
    expect(
      new Set(envs.flatMap((e) => e.services.map((s) => s.port))).size,
    ).toBe(6);
    for (let i = 0; i < 3; i++) {
      const base = envs[i]!.services.find((s) => s.id === "frontend")!.origin;
      const value = "only-workflow-" + i;
      expect(
        (
          await fetch(base + "/api/notes", {
            method: "POST",
            body: JSON.stringify({ text: value }),
          })
        ).ok,
      ).toBe(true);
      expect(await (await fetch(base + "/api/notes")).json()).toEqual({
        text: value,
      });
    }
    for (let i = 0; i < 3; i++) {
      const base = envs[i]!.services.find((s) => s.id === "frontend")!.origin;
      expect(await (await fetch(base + "/api/notes")).json()).toEqual({
        text: "only-workflow-" + i,
      });
    }
    for (const env of envs) await environments.health(env);
  } finally {
    for (const flow of flows) await environments.stop(flow.id);
    await manager.close();
    expect(s.store.list("lease")).toHaveLength(0);
    s.store.close();
  }
}, 60000);
it("IT-07 registered fixture receives only its workflow data namespace before environment readiness", async () => {
  const s = setup(),
    r = await repository(s.root),
    p = project(r.repo);
  p.commands = [
    {
      ...p.commands[0]!,
      id: "fixture",
      lifecycle: "fixture",
      parser: "none",
      report_path: undefined,
      args: [
        "-e",
        "require('node:fs').writeFileSync(require('node:path').join(process.env.DEVFLOW_DATA_DIR,'fixture.json'),JSON.stringify({workflow:process.env.DEVFLOW_WORKFLOW_ID}))",
      ],
    },
  ];
  p.data = { mode: "directory", fixture_command_id: "fixture" };
  await s.engine.registerProject(p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "数据初始化",
      request: "验证 fixture 变量",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "fixture",
  );
  await s.engine.git.prepare(p, w.id, "existing_workspace", {
    main: r.baseline,
  });
  const manager = new ProcessManager(
      resolve(
        "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
      ),
      true,
    ),
    environments = new Environments(
      s.engine,
      manager,
    );
  try {
    const env = await environments.ensure(w);
    expect(
      JSON.parse(readFileSync(join(env.data_dir, "fixture.json"), "utf8")),
    ).toEqual({ workflow: w.id });
    expect(env.status).toBe("ready");
  } finally {
    await environments.stop(w.id);
    await manager.close();
    s.store.close();
  }
}, 60000);
