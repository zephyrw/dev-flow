import { it, expect } from "vitest";
import { writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { prepared } from "../helpers.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";

it("a rejected output schema retries once without wire constraints and validates the actual returned diagnosis", async () => {
  const s = await prepared(),
    runtime = new LocalRuntime(s.engine);
  const cli = join(s.root, "synthetic-planner.cjs"),
    calls = join(s.root, "calls.txt");
  const diagnosis = {
    diagnosis: "受管进程缺少 Windows 命令执行环境",
    instructions: "恢复必需环境变量并执行真实命令验证",
    requires_plan_change: false,
    repair_plan: null,
  };
  writeFileSync(
    cli,
    `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(calls)},'x');if(process.argv.includes('--output-schema')){console.error('invalid_json_schema: propertyNames is not permitted');process.exitCode=1;}else{fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],${JSON.stringify(JSON.stringify(diagnosis))});}`,
  );
  s.config.models.codex_executable = process.execPath;
  s.config.models.codex_prefix_args = [cli];
  s.store.put("evidence", "delivery-fixture", s.workflow.id, {
    id: "delivery-fixture",
  });
  s.store.put("development_evidence", "development-fixture", s.workflow.id, {
    id: "development-fixture",
  });
  try {
    expect(
      await runtime.diagnose(s.workflow, "启动服务没有真正执行且提前退出"),
    ).toMatchObject({ diagnosis: diagnosis.diagnosis });
    expect(readFileSync(calls, "utf8")).toBe("xx");
    expect(
      s.store
        .recentEvents(s.workflow.id, 50)
        .filter((e) => e.type === "DiagnosisRetrying"),
    ).toHaveLength(1);
    expect(s.store.list("check_process", s.principal.run_id)).toHaveLength(0);
    const diagnostics = join(s.config.storage_root, "diagnostics");
    const manifest = JSON.parse(
      readFileSync(
        join(diagnostics, readdirSync(diagnostics)[0]!, "materials.json"),
        "utf8",
      ),
    );
    expect(manifest.evidence.map((e: any) => e.id)).toEqual([
      "delivery-fixture",
      "development-fixture",
    ]);
  } finally {
    await runtime.close();
    s.store.close();
  }
});
