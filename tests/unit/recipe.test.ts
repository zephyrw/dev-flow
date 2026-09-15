import { it, expect } from "vitest";
import {
  BrowserRecipeSchema,
  assertResult,
  template,
  pointer,
} from "../../packages/runtime/src/recipe.js";
import { writeAgyProject } from "../../packages/adapters/agy/src/project.js";
import { setup } from "../helpers.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserGateway } from "../../packages/runtime/src/browser.js";
import { project } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { workerNames } from "../../packages/mcp/src/tools.js";
it("UT-15 browser evidence records only observed assertions and fails missing values", () => {
  expect(
    assertResult(
      { content: "实际完成" },
      [{ pointer: "/content", contains: "完成", case_id: "real" }],
      {},
    ),
  ).toEqual(["real"]);
  expect(() =>
    assertResult(
      { content: "未运行" },
      [{ pointer: "/content", equals: "完成", case_id: "fake" }],
      {},
    ),
  ).toThrow();
  expect(() =>
    BrowserRecipeSchema.parse({
      project_id: "p",
      scene_id: "s",
      origins: [],
      actions: [],
    }),
  ).toThrow();
  expect(
    template(
      { tabId: "${TAB}", url: "${ORIGIN}/api" },
      { TAB: 42, ORIGIN: "http://localhost:1" },
    ),
  ).toEqual({ tabId: 42, url: "http://localhost:1/api" });
  expect(() => template("${MISSING}", {})).toThrow();
  expect(pointer({ "a/b": { "~key": 1 } }, "/a~1b/~0key")).toBe(1);
});
it("UT-05 agy grants are scoped to a unique project and never permit native commands", () => {
  const s = setup();
  try {
    const id = crypto.randomUUID();
    const result = writeAgyProject(s.root, id, join(s.root, "container"));
    const p = JSON.parse(readFileSync(result.path, "utf8"));
    expect(p.permissionGrants.permissionGrants.allow).toEqual(
      workerNames.map((name) => `mcp(devflow_worker/${name})`),
    );
    expect(
      p.permissionGrants.permissionGrants.allow.every((x: string) =>
        x.startsWith("mcp(devflow_worker/devflow_"),
      ),
    ).toBe(true);
    expect(() => writeAgyProject(s.root, id, join(s.root, "other"))).toThrow(
      /其他目录/,
    );
  } finally {
    s.store.close();
  }
});
it("UT-15 browser scenes cannot enter controller approval even if an origin is misconfigured", async () => {
  const s = setup(),
    p = project(".");
  p.browser_scenes = [
    {
      id: "s",
      steps: ["检查"],
      assertions: ["检查"],
      allowed_tools: ["browser_open_tab"],
    },
  ];
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "边界",
      request: "验证控制台来源隔离",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "origin-test",
  );
  s.engine.transition(w.id, ["RESEARCHING"], "EXECUTING", "browser", {
    run_id: "r",
  });
  s.store.put("environment", w.id, w.id, {
    services: [{ id: "frontend", origin: s.config.server.human_origin }],
  });
  s.store.put("browser_recipe", p.id + "-s", p.id, {
    project_id: p.id,
    scene_id: "s",
    project_hash: objectHash(p),
    origins: [s.config.server.human_origin],
    actions: [
      {
        tool: "browser_open_tab",
        arguments: { url: s.config.server.human_origin },
        assertions: [{ pointer: "/id", minimum: 1 }],
      },
    ],
  });
  try {
    await expect(
      new BrowserGateway(s.engine).run(w.id, "r", "s"),
    ).rejects.toThrow(/审批入口/);
    expect(s.store.list("lease")).toHaveLength(0);
  } finally {
    s.store.close();
  }
});
