import { it, expect } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { prepared } from "../helpers.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import {
  cleanArchivedReports,
  takeReportSlot,
} from "../../packages/runtime/src/report-output.js";
import { hash } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";

it("renamed legacy reports are cleaned only from the dedicated directory with exact archive proof", async () => {
  const s = await prepared();
  try {
    const project = s.engine.project(s.project.id);
    project.commands[0]!.report_path = ".reports/portable-unit.json";
    s.store.put("project", project.id, project.id, project);
    mkdirSync(join(s.repo, ".reports"), { recursive: true });
    const archive = join(s.root, "report.json");
    writeFileSync(archive, "archived result");
    s.store.put("evidence", "legacy", s.workflow.id, {
      files: [{ path: archive, hash: hash("archived result") }],
    });
    for (const name of ["unit.json", "tracked.json", "changed.json"])
      writeFileSync(join(s.repo, ".reports", name), "archived result");
    writeFileSync(join(s.repo, ".reports", "changed.json"), "user modified");
    writeFileSync(join(s.repo, "outside.json"), "archived result");
    await git(s.repo, ["add", "-f", ".reports/tracked.json"]);
    await cleanArchivedReports(s.engine, s.workflow.id);
    expect(existsSync(join(s.repo, ".reports/unit.json"))).toBe(false);
    for (const path of [
      ".reports/tracked.json",
      ".reports/changed.json",
      "outside.json",
    ])
      expect(existsSync(join(s.repo, path))).toBe(true);
    expect(existsSync(archive)).toBe(true);
  } finally {
    s.store.close();
  }
});

it("a real development test archives an unignored report without changing the code snapshot", async () => {
  const s = await prepared(),
    runtime = new LocalRuntime(s.engine);
  try {
    const p = s.engine.project(s.project.id);
    Object.assign(p.commands[0]!, {
      report_path: "report-output/fresh-report.xml",
      parser: "junit",
      args: [
        "-e",
        "const {spawnSync}=require('node:child_process');const r=spawnSync(process.execPath,['--test-reporter=junit','--test-reporter-destination='+process.env.DEVFLOW_REPORT_PATH,'-e',\"require('node:test')('updates content',()=>require('node:assert/strict').equal(1,1))\"],{stdio:'inherit'});require('node:fs').copyFileSync(process.env.DEVFLOW_REPORT_PATH,'report-output/legacy.xml');process.exit(r.status??1)",
      ],
    });
    s.store.put("project", p.id, p.id, p);
    const plan = s.engine.plan(s.workflow.id);
    plan.plan.tests[0]!.expected_case_ids = ["test updates content"];
    s.store.put("plan", plan.id, s.workflow.id, plan);
    const result = await runtime.check(s.workflow, "UT01", s.principal);
    expect(result.status).toBe("passed");
    expect(existsSync(join(s.repo, "report-output/fresh-report.xml"))).toBe(
      false,
    );
    expect(existsSync(join(s.repo, "report-output/legacy.xml"))).toBe(false);
    expect(
      result.files.some(
        (f) => f.path.endsWith("report.xml") && existsSync(f.path),
      ),
    ).toBe(true);
    expect(
      await s.engine.git.matches(s.store.must("snapshot", result.snapshot_id)),
    ).toBe(true);
  } finally {
    await runtime.close();
    s.store.close();
  }
});
it("pre-existing report files are restored and legacy cleanup requires a matching archive", async () => {
  const s = await prepared();
  try {
    const report = join(s.repo, ".reports/unit.json");
    mkdirSync(join(s.repo, ".reports"), { recursive: true });
    writeFileSync(report, "user content");
    const restore = takeReportSlot(report);
    writeFileSync(report, "generated report");
    restore();
    expect(readFileSync(report, "utf8")).toBe("user content");
    const archive = join(s.root, "report.json");
    writeFileSync(archive, "generated report");
    s.store.put("evidence", "archived", s.workflow.id, {
      files: [{ path: archive, hash: hash("generated report") }],
    });
    await cleanArchivedReports(s.engine, s.workflow.id);
    expect(readFileSync(report, "utf8")).toBe("user content");
    writeFileSync(report, "generated report");
    await cleanArchivedReports(s.engine, s.workflow.id);
    expect(existsSync(report)).toBe(false);
    expect(existsSync(archive)).toBe(true);
  } finally {
    s.store.close();
  }
});
