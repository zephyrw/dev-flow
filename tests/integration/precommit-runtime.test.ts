import { afterEach, expect, it, vi } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setup, project, plan, proof } from "../helpers.js";
import { hash, objectHash } from "../../packages/core/src/util.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import * as gitModule from "../../packages/git/src/git.js";
import {
  FlowError,
  type Run,
  type Snapshot,
} from "../../packages/contracts/src/index.js";

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}

// These tests target runtime interleavings. Git hashing is a stable fixture;
// command-error tests below still launch actual Node processes through WinHost.
async function fixture(args: string[] = []) {
  const s = setup();
  const repo = join(s.root, "repo");
  mkdirSync(repo);
  writeFileSync(join(repo, "app.txt"), "after\n");
  const p = project(repo);
  p.commands[0]!.args = args;
  s.store.put("project", p.id, p.id, p);
  const w = s.engine.create(
    {
      project_id: p.id,
      title: "提交前运行时回归",
      request: "验证取消、证据与配置绑定",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "precommit-runtime",
  );
  const contract = plan(objectHash(p), "a".repeat(40));
  contract.tests.push({ ...contract.tests[0]!, id: "UT02" });
  contract.tasks[0]!.test_ids.push("UT02");
  s.engine.submitPlan(w.id, contract, w.version, "p1");
  const approval = proof(s.engine, w.id, "approve");
  s.engine.approve(w.id, approval.proof, approval.binding);
  s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
    run_id: "run-fixture",
  });
  s.store.put("workspace", "ws-fixture", w.id, {
    id: "ws-fixture",
    workflow_id: w.id,
    repo_id: "main",
    root: repo,
    common_dir: repo,
    baseline: "a".repeat(40),
    branch: "task/fixture",
    owned: false,
  });
  const snapshot: Snapshot = {
    id: "snapshot-fixture",
    workflow_id: w.id,
    environment_revision: 0,
    created_at: new Date().toISOString(),
    repositories: [
      {
        workspace_id: "ws-fixture",
        repo_id: "main",
        baseline: "a".repeat(40),
        branch: "task/fixture",
        tree: "b".repeat(40),
        changed_paths: ["app.txt"],
        files: [{ path: "app.txt", hash: hash("after\n"), mode: "100644" }],
      },
    ],
  };
  s.store.put("snapshot", snapshot.id, w.id, snapshot);
  vi.spyOn(s.engine.git, "snapshot").mockResolvedValue(snapshot);
  vi.spyOn(s.engine.git, "matches").mockResolvedValue(true);
  const principal = {
    role: "worker" as const,
    workflow_id: w.id,
    run_id: "run-fixture",
    expires: Date.now() + 120000,
  };
  s.engine.claimTask(
    principal,
    w.id,
    "T01",
    "独立回归夹具提供确定的变更和验证对象",
  );
  await s.engine.freeze(w.id, principal);
  s.config.host = {
    required: true,

    executable: resolve(
      "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
    ),
  };
  const runtime = new LocalRuntime(s.engine);
  s.engine.runtime = runtime;
  const run: Run = {
    id: principal.run_id,
    workflow_id: w.id,
    plan_revision: 1,
    adapter: "agy",
    stage: "execute",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "fixture",
  };
  return {
    ...s,
    repo,
    project: p,
    contract,
    key: w.id,
    principal,
    runtime,
    run,
  };
}

it.each([
  {
    name: "missing report",
    script: "console.error('actual missing-report fixture'); process.exit(7)",
    code: "REPORT_MISSING",
    exit: 7,
  },
  {
    name: "malformed report",
    script:
      "console.error('actual malformed-report fixture'); require('node:fs').writeFileSync(process.env.DEVFLOW_REPORT_PATH,'{invalid-json')",
    code: "CHECK_FAILED",
    exit: 0,
  },
])(
  "R1 $name records the actual error and reopens repair without invented passing cases",
  async ({ script, code, exit }) => {
    const s = await fixture(["-e", script]);
    try {
      const result = await s.runtime.check(
        s.engine.get(s.key),
        "UT01",
        s.principal,
      );
      expect(result).toMatchObject({
        status: "failed",
        passed: 0,
        discovered: 0,
        case_ids: [],
        exit_code: exit,
        error: { code },
      });
      expect(s.engine.get(s.key)).toMatchObject({ state: "EXECUTING" });
      expect(s.engine.get(s.key).snapshot_id).toBeUndefined();
      expect(s.store.list("check_process", s.principal.run_id)).toHaveLength(0);
      const error = result.files.find((f) => f.path.endsWith("error.json"))!;
      const log = result.files.find((f) => f.path.endsWith("output.log"))!;
      expect(JSON.parse(readFileSync(error.path, "utf8"))).toMatchObject({
        observed_exit_code: exit,
        error: { code },
      });
      expect(readFileSync(log.path, "utf8")).toContain("actual");
      for (const file of result.files)
        expect(hash(readFileSync(file.path))).toBe(file.hash);
      const f = s.engine.files(s.principal, s.key, "main", true);
      f.broker.apply(f.root, s.contract.scope, [
        {
          path: "app.txt",
          expected_hash: hash("after\n"),
          content: "after repair\n",
        },
      ]);
      await s.engine.freeze(s.key, s.principal);
      expect(s.engine.get(s.key).state).toBe("VERIFYING");
    } finally {
      await s.runtime.close();
      s.store.close();
    }
  },
  60000,
);

it("R1 browser assertion exceptions record failure instead of trapping the worker in VERIFYING", async () => {
  const s = await fixture();
  try {
    const record = s.engine.plan(s.key);
    record.plan.tests[0]!.layer = "opentabs";
    record.plan.tests[0]!.scene_id = "scene-fixture";
    s.store.put("plan", record.id, s.key, record);
    vi.spyOn(s.runtime.browser, "run").mockRejectedValue(
      new FlowError("ASSERTION_FAILED", "fixture browser assertion failed"),
    );
    const result = await s.runtime.check(
      s.engine.get(s.key),
      "UT01",
      s.principal,
    );
    expect(result).toMatchObject({
      status: "failed",
      discovered: 0,
      passed: 0,
      error: { code: "ASSERTION_FAILED" },
    });
    expect(s.engine.get(s.key).state).toBe("EXECUTING");
  } finally {
    await s.runtime.close();
    s.store.close();
  }
});

it("R1 waiting for a browser lease is a retryable precondition and creates no failed evidence", async () => {
  const s = await fixture();
  try {
    const record = s.engine.plan(s.key);
    record.plan.tests[0]!.layer = "opentabs";
    record.plan.tests[0]!.scene_id = "scene-fixture";
    s.store.put("plan", record.id, s.key, record);
    vi.spyOn(s.runtime.browser, "run").mockRejectedValue(
      new FlowError("BROWSER_BUSY", "fixture browser lease is occupied"),
    );
    await expect(
      s.runtime.check(s.engine.get(s.key), "UT01", s.principal),
    ).rejects.toMatchObject({ code: "BROWSER_BUSY" });
    expect(s.engine.get(s.key).state).toBe("VERIFYING");
    expect(s.store.list("evidence", s.key)).toHaveLength(0);
  } finally {
    await s.runtime.close();
    s.store.close();
  }
});

it.each(["verification", "review"] as const)(
  "R2 stopping during %s preparation cannot launch a late agent",
  async (stage) => {
    const s = await fixture();
    const gate = deferred<any>();
    const entered = deferred<void>();
    const start = vi.spyOn(s.runtime.processes, "start");
    try {
      let pending: Promise<unknown>;
      if (stage === "verification") {
        s.engine.transition(s.key, ["VERIFYING"], "EXECUTING", "execute");
        vi.spyOn(s.runtime.environments, "ensure").mockImplementation(
          async () => {
            entered.resolve();
            return gate.promise;
          },
        );
        pending = s.runtime.prepareVerification(
          s.engine.get(s.key),
          s.principal,
        );
      } else {
        s.engine.transition(s.key, ["VERIFYING"], "REVIEWING", "review", {
          review_request_id: "review-fixture",
        });
        vi.spyOn(s.engine.git, "diff")
          .mockResolvedValue([])
          .mockImplementationOnce(async () => {
            entered.resolve();
            return gate.promise;
          });
        pending = s.runtime.review(s.engine.get(s.key), {
          ...s.run,
          adapter: "codex",
        });
      }
      const rejected = expect(pending).rejects.toMatchObject({
        code: "RUN_REVOKED",
      });
      await entered.promise;
      const stopping = s.engine.stop(s.key);
      expect(s.engine.get(s.key).state).toBe("STOPPING");
      gate.resolve([]);
      await stopping;
      await rejected;
      expect(start).not.toHaveBeenCalled();
      expect(s.engine.get(s.key).state).toBe("STOPPED");
    } finally {
      gate.resolve([]);
      await s.runtime.close();
      s.store.close();
    }
  },
);

it("R2 stopping while checking the snapshot cannot launch a late test or reopen a stopped workflow", async () => {
  const s = await fixture();
  const gate = deferred<boolean>();
  const start = vi.spyOn(s.runtime.processes, "start");
  vi.mocked(s.engine.git.matches).mockReturnValueOnce(gate.promise);
  try {
    const pending = expect(
      s.runtime.check(s.engine.get(s.key), "UT01", s.principal),
    ).rejects.toMatchObject({ code: "RUN_REVOKED" });
    await s.engine.stop(s.key);
    gate.resolve(true);
    await pending;
    expect(start).not.toHaveBeenCalled();
    expect(s.store.list("evidence", s.key)).toHaveLength(0);
    expect(s.engine.get(s.key).state).toBe("STOPPED");
  } finally {
    gate.resolve(true);
    await s.runtime.close();
    s.store.close();
  }
});

it.each(["success", "failure"] as const)(
  "R2 an old queued preparation %s cannot activate or block a recovered queue entry",
  async (outcome) => {
    const s = await fixture();
    const gate = deferred<any>();
    const entered = deferred<void>();
    const settled = deferred<void>();
    // This fixture deliberately does not create a Git repository. Provide the
    // same validated identity that production now checks before preparation.
    vi.spyOn(gitModule, "repositoryInfo").mockResolvedValue({
      path: s.repo,
      common_dir: s.repo,
      head: "a".repeat(40),
      branch: "task/fixture",
    });
    const nativeDispatch = s.engine.dispatch.bind(s.engine);
    const nativeRelease = s.engine.scheduler.release.bind(s.engine.scheduler);
    vi.spyOn(s.engine, "dispatch").mockResolvedValue();
    vi.spyOn(s.engine.scheduler, "release").mockImplementation((...args) => {
      nativeRelease(...args);
      if (args[2].includes("executor:0")) settled.resolve();
    });
    vi.spyOn(s.engine.git, "prepare").mockImplementation(async () => {
      entered.resolve();
      return gate.promise;
    });
    const execute = vi.spyOn(s.runtime, "execute");
    try {
      await s.engine.stop(s.key);
      s.engine.feedback(s.key, "在原计划范围内继续", "within_plan");
      await nativeDispatch();
      await entered.promise;
      await s.engine.stop(s.key);
      s.engine.feedback(s.key, "停止后再次恢复这一计划", "within_plan");
      const recovered = s.engine.get(s.key);
      if (outcome === "success") gate.resolve([]);
      else gate.reject(new Error("fixture late preparation failure"));
      await settled.promise;
      expect(s.engine.get(s.key)).toEqual(recovered);
      expect(s.engine.get(s.key).state).toBe("QUEUED");
      expect(s.store.get("queue", s.key)).toBeTruthy();
      expect(s.store.list("run", s.key)).toHaveLength(0);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      gate.resolve([]);
      await s.runtime.close();
      s.store.close();
    }
  },
);

it("R3 changed project configuration remains recoverable without blocking resume", async () => {
  const s = await fixture();
  try {
    await s.engine.stop(s.key);
    s.store.put("project", s.project.id, s.project.id, {
      ...s.project,
      name: "updated configuration",
    });
    expect(() =>
      s.engine.feedback(s.key, "按原批准继续执行", "within_plan"),
    ).not.toThrow();
  } finally {
    await s.runtime.close();
    s.store.close();
  }
});

it("R3 project registration rechecks active workflows after repository inspection", async () => {
  const s = await fixture();
  const gate = deferred<Awaited<ReturnType<typeof gitModule.repositoryInfo>>>();
  vi.spyOn(gitModule, "repositoryInfo").mockReturnValue(gate.promise);
  try {
    await s.engine.stop(s.key);
    const pending = expect(
      s.engine.registerProject({
        ...s.project,
        name: "configuration changed during inspection",
      }),
    ).rejects.toMatchObject({ code: "PROJECT_IN_USE" });
    s.engine.feedback(s.key, "继续执行原先已批准的计划", "within_plan");
    gate.resolve({
      path: s.repo,
      common_dir: s.repo,
      head: "a".repeat(40),
      branch: "task/fixture",
    });
    await pending;
    expect(s.engine.project(s.project.id)).toEqual(s.project);
    expect(s.engine.get(s.key).state).toBe("QUEUED");
  } finally {
    gate.resolve({
      path: s.repo,
      common_dir: s.repo,
      head: "a".repeat(40),
      branch: "task/fixture",
    });
    await s.runtime.close();
    s.store.close();
  }
});

it("R4 different tests of one workflow cannot concurrently consume a shared report path", async () => {
  const s = await fixture();
  const gate = deferred<boolean>();
  vi.mocked(s.engine.git.matches).mockReturnValueOnce(gate.promise);
  const start = vi.spyOn(s.runtime.processes, "start");
  try {
    const pending = expect(
      s.runtime.check(s.engine.get(s.key), "UT01", s.principal),
    ).rejects.toMatchObject({ code: "RUN_REVOKED" });
    await expect(
      s.runtime.check(s.engine.get(s.key), "UT02", s.principal),
    ).rejects.toMatchObject({ code: "CHECK_RUNNING" });
    await s.engine.stop(s.key);
    gate.resolve(true);
    await pending;
    expect(start).not.toHaveBeenCalled();
    expect(
      s.store.list("lease", s.key).filter((l: any) => l.id.startsWith("test:")),
    ).toHaveLength(0);
  } finally {
    gate.resolve(true);
    await s.runtime.close();
    s.store.close();
  }
});

it("R4 a late result cannot be attached after invalidation and refreezing identical source", async () => {
  const report = JSON.stringify({
    testResults: [
      { assertionResults: [{ fullName: "updates content", status: "passed" }] },
    ],
  });
  const s = await fixture([
    "-e",
    `require('node:fs').writeFileSync(process.env.DEVFLOW_REPORT_PATH,${JSON.stringify(report)})`,
  ]);
  const gate = deferred<boolean>();
  const entered = deferred<void>();
  vi.mocked(s.engine.git.matches)
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(async () => {
      entered.resolve();
      return gate.promise;
    });
  try {
    const pending = expect(
      s.runtime.check(s.engine.get(s.key), "UT01", s.principal),
    ).rejects.toMatchObject({ code: "CHECK_SUPERSEDED" });
    await entered.promise;
    const snapshotId = s.engine.get(s.key).snapshot_id;
    s.engine.invalidate(
      s.key,
      "fixture invalidates verification while result is in flight",
    );
    s.engine.transition(s.key, ["VERIFYING"], "EXECUTING", "repair_tests");
    await expect(s.engine.freeze(s.key, s.principal)).rejects.toMatchObject({
      code: "CHECK_RUNNING",
    });
    gate.resolve(true);
    await pending;
    await s.engine.freeze(s.key, s.principal);
    expect(s.engine.get(s.key).snapshot_id).toBe(snapshotId);
    expect(s.store.list("evidence", s.key)).toHaveLength(0);
    expect(s.engine.get(s.key).state).toBe("VERIFYING");
  } finally {
    gate.resolve(true);
    await s.runtime.close();
    s.store.close();
  }
}, 60000);
