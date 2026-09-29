import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DeliveryStrip } from "../../apps/web/src/workbench.js";
import { TaskTree } from "../../apps/web/src/panels.js";

it("renders completed work, independent tests and repository delivery without obsolete per-package certification", () => {
  const detail = { workflow: { state: "COMPLETED" }, plan: { plan: { task_model: "native-v2", modules: [{ id: "M", title: "module" }], tasks: [] } },
    tasks: [{ id: "T", module_id: "M", title: "implemented", completed: true, status: "completed", development_status: "completed", validation_status: "not_certified" }],
    task_counts: { total: 1, started: 1, developed: 1, verified: 0 }, test_progress: { total: 2, passed: 2 } };
  const html = renderToStaticMarkup(<><DeliveryStrip detail={detail} /><TaskTree detail={detail} /></>);
  expect(html).not.toContain("已交付"); expect(html).not.toContain("交付记录");
  expect(html).toContain("开发完成"); expect(html).toContain("已提交至仓库"); expect(html).toContain("计划用例报告通过");
  expect(html).toContain('checkbox checked');
});
