import { expect, it } from "vitest";
import { uniqueAttachments } from "../../packages/evidence/src/archive-consumer.js";

it("ignores malformed attachment paths and repository identifiers while retaining valid files", () => {
  const manifest = {
    test_executions: [
      null,
      { report_paths: [" reports/unit.json ", {}, 42, null] },
      { report_paths: { path: "invalid" } },
    ],
    artifacts: [
      { path: { value: "reports/bad.json" } },
      { path: 42 },
      { path: "reports/wrong-repo.json", repo_id: {} },
      { file: "reports/fallback.json" },
      "reports/unit.json",
      null,
      { path: " " },
      { repo_id: "secondary", path: "reports/unit.json" },
    ],
  } as any;
  expect(uniqueAttachments(manifest, [])).toEqual([
    { repo_id: "main", path: "reports/unit.json" },
    { repo_id: "main", path: "reports/fallback.json" },
    { repo_id: "secondary", path: "reports/unit.json" },
  ]);
  expect(uniqueAttachments({ artifacts: {}, test_executions: {} } as any, [])).toEqual([]);
});
