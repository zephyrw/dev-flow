import { readableLogs } from "./activity.js";
import { matchesScopePath } from "../../contracts/src/path-scope.js";

export interface NativeTestRun {
  key: string;
  command: string;
  cwd?: string;
  run_id?: string;
  sequence: number;
  created_at: string;
  status: "running" | "passed" | "failed" | "returned" | "interrupted";
  passed?: number;
  failed?: number;
  skipped?: number;
  output: string;
}

export function isTestCommand(command: string) {
  // Match actual runner invocations, never a script which merely writes tests.
  const first = command.trim().split(/\r?\n/)[0]!;
  if (/(?:^|\s)(?:--help|-h|--version|--listTests|--list)(?:\s|$)/.test(first))
    return false;
  if (/-D(?:skipTests|maven\.test\.skip)(?:=true)?(?:\s|$|["'])/i.test(first))
    return false;
  return (
    /^(?:pnpm|npm|npx|yarn|bun)(?:\.cmd)?\s+(?:(?:exec|run)\s+)?(?:vitest\s+(?:run|--run)|jest\b|playwright\s+test\b|test(?::[\w:-]+)?\b)/i.test(
      first,
    ) ||
    /^(?:\.\.?[/\\])?mvn(?:w)?(?:\.cmd)?\s+.*\b(?:test|verify|integration-test)\b/i.test(
      first,
    ) ||
    /^(?:python(?:3)?\s+-m\s+pytest|pytest|go\s+test|cargo\s+test|dotnet\s+test)\b/i.test(
      first,
    )
  );
}

export function testOutputCounts(output: string) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, "");
  const maven = [
    ...text.matchAll(
      /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/g,
    ),
  ].at(-1);
  if (maven) {
    const failed = Number(maven[2]) + Number(maven[3]),
      skipped = Number(maven[4]);
    return {
      passed: Math.max(0, Number(maven[1]) - failed - skipped),
      failed,
      skipped,
    };
  }
  const vitest = [...text.matchAll(/^\s*Tests\s+(.+)$/gm)].at(-1)?.[1];
  // Playwright/pytest summaries also have independent lines with "N passed".
  const summary =
    vitest ??
    text
      .split(/\r?\n/)
      .filter((line) =>
        /^\s*(?:=+\s*)?\d+ (?:passed|failed|skipped)\b/.test(line),
      )
      .join(" ");
  if (!/\d+\s+(?:passed|failed|skipped)/.test(summary)) return undefined;
  const count = (status: string) =>
    Number(summary.match(new RegExp(`(\\d+)\\s+${status}\\b`))?.[1] ?? 0);
  return {
    passed: count("passed"),
    failed: count("failed"),
    skipped: count("skipped"),
  };
}

/** Display-only projection. It never writes claims, evidence, workflow states,
 * instructions or execution gates. A tool return is not delivery acceptance. */
export function nativeProgress(detail: any, changes?: any[]) {
  if (detail?.plan?.plan?.task_model !== "native-v2" || detail.loading)
    return detail;
  const plan = detail.plan.plan,
    w = detail.workflow;
  const runs = new Map<string, any>(
    (detail.runs ?? []).map((r: any) => [r.id, r]),
  );
  const scopedEvents = (detail.events ?? []).filter((e: any) => {
    const run = runs.get(e.run_id);
    return (
      e.workflow_id === w.id &&
      !!run &&
      run.plan_revision === w.plan_revision &&
      (!run.plan_hash || !w.plan_hash || run.plan_hash === w.plan_hash) &&
      (!run.started_at || !e.created_at || e.created_at >= run.started_at)
    );
  });
  const logs = readableLogs(scopedEvents, w.id).filter(
    (r) => r.kind === "tool",
  );
  const tests: NativeTestRun[] = [];
  const background = new Map<string, NativeTestRun>();
  for (const row of logs) {
    const event: any = row.raw.at(-1),
      step = event?.payload?.step_update;
    const info = step?.tool_info ?? {},
      parameters = info.parameters ?? {};
    const name = step?.tool_name ?? info.name;
    const run = runs.get(event?.run_id);
    let test: NativeTestRun | undefined;
    if (row.command && isTestCommand(row.command)) {
      test = {
        key: row.key,
        command: row.command,
        cwd: row.cwd,
        run_id: event.run_id,
        sequence: row.sequence,
        created_at: row.created_at,
        status: "running",
        output: "",
      };
      tests.push(test);
    } else if (["manage_task", "command_status"].includes(name)) {
      const id = String(
        parameters.TaskId ?? parameters.task_id ?? parameters.CommandId ?? "",
      )
        .split("/")
        .at(-1);
      test = background.get(`${event.run_id}:${id}`);
    }
    if (!test) continue;
    const output = row.output ?? "";
    if (output) test.output = output;
    test.sequence = row.sequence;
    test.created_at = row.created_at;
    for (const match of output.matchAll(
      /\btask-\d+\b|(?:Command ID:\s*)([\w-]+)/g,
    ))
      background.set(`${event.run_id}:${match[1] ?? match[0]}`, test);
    const counts = testOutputCounts(output);
    const code =
      typeof info.output === "object"
        ? (info.output?.exit_code ?? info.output?.exitCode)
        : undefined;
    const backgroundRunning =
      /(?:^Status:\s*(?:RUNNING|PENDING)|\bbackground\b|\btask-\d+\b|Last progress:)/im.test(
        output,
      ) &&
      !/(?:BUILD (?:SUCCESS|FAILURE)|\bexit(?:ed)?(?: with)? code[:\s]+\d+|\btask (?:completed|failed)\b)/i.test(
        output,
      ) &&
      !/^Status:\s*(?:COMPLETED|FAILED|CANCELLED)/im.test(output);
    const returned = row.status === "done" && !backgroundRunning;
    const failed =
      row.status === "error" ||
      (typeof code === "number" && code !== 0) ||
      (returned &&
        /(?:BUILD FAILURE|^Status:\s*FAILED|^\s*Test Files\s+.*\d+ failed|^\s*Errors\s+\d+ error|Unhandled Errors)/m.test(
          output,
        )) ||
      (returned &&
        (counts
          ? counts.failed > 0
          : /(?:BUILD FAILURE|^Status:\s*FAILED|\b\w*Error:|\[ERROR\]|Unknown option|No test files found|^\s*FAIL\s|^\s*Test Files\s+.*\d+ failed)/m.test(
              output,
            )));
    test.status = failed
      ? "failed"
      : returned
        ? counts && counts.passed > 0
          ? "passed"
          : "returned"
        : "running";
    if (returned && counts) Object.assign(test, counts);
    // A process from an earlier run cannot stay "running" after pause/restart.
    if (
      test.status === "running" &&
      (run?.status !== "running" ||
        event.run_id !== w.run_id ||
        w.state !== "EXECUTING")
    )
      test.status = "interrupted";
  }

  const tasks = (detail.tasks ?? []).map((task: any) => {
    if (task.status === "verified") return task;
    const spec = plan.tasks.find((t: any) => t.id === task.id);
    if (!spec) return task;
    const workspaces = (detail.workspaces ?? []).filter(
      (ws: any) => !spec.repo_id || spec.repo_id === ws.repo_id,
    );
    const files = (changes ?? [])
      .filter((c: any) => !spec.repo_id || c.repo_id === spec.repo_id)
      .flatMap((c: any) =>
        (c.files ?? [])
          .filter((f: any) => {
            const ws = workspaces.find((ws: any) => ws.repo_id === c.repo_id);
            return spec.paths.some((p: string) =>
              matchesScopePath(f.path, p, /^[A-Za-z]:/.test(ws?.root ?? "")),
            );
          })
          .map((f: any) => f.path),
      );
    const writes = logs.filter((row) => {
      if (row.status === "error") return false;
      const last: any = row.raw.at(-1),
        step = last?.payload?.step_update;
      if (
        ![
          "write_to_file",
          "replace_file_content",
          "multi_replace_file_content",
        ].includes(step?.tool_name)
      )
        return false;
      return workspaces.some((ws: any) =>
        spec.paths.some((p: string) =>
          matchesScopePath(
            row.text,
            `${ws.root}/${p}`,
            /^[A-Za-z]:/.test(ws.root),
          ),
        ),
      );
    });
    const observed = files.length > 0 || writes.length > 0;
    if (!observed)
      return {
        ...task,
        development_status: changes ? task.development_status : "unobserved",
      };
    return {
      ...task,
      development_status: "active",
      implementation_status: "active",
      summary: files.length
        ? `已观察到 ${new Set(files).size} 个相关文件变更；完成情况待核验。`
        : "已观察到文件写入操作；完成情况待核验。",
      observed_paths: [...new Set(files)],
      started_at: writes[0]?.created_at ?? task.started_at,
    };
  });
  // Keep only the latest attempt for each exact invocation in the summary.
  // Attempts remain available below; reruns must not double-count passing tests.
  const latest = new Map<string, NativeTestRun>();
  for (const test of tests)
    latest.set(`${test.cwd ?? ""}\0${test.command}`, test);
  const currentTests = [...latest.values()];
  const latestResult = [...tests]
    .reverse()
    .find((t) => t.status !== "running" && t.status !== "interrupted");
  return {
    ...detail,
    tasks,
    task_counts: {
      total: tasks.length,
      developed: tasks.filter((t: any) => t.development_status === "completed")
        .length,
      verified: tasks.filter((t: any) => t.status === "verified").length,
      started: tasks.filter((t: any) =>
        ["active", "completed", "pending_check"].includes(t.development_status),
      ).length,
    },
    native_progress: {
      tests: tests.reverse(),
      running: currentTests.filter((t) => t.status === "running").length,
      latest_result: latestResult,
      observed: changes !== undefined,
      latest: currentTests,
    },
  };
}
