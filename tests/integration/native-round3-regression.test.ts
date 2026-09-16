import { attestFixture } from "../native-fixture.js";
import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, repository, project, plan, proof } from "../helpers.js";
import { objectHash } from "../../packages/core/src/util.js";
import { NativeRunRecordReader as Reader } from "../../packages/evidence/src/native-run-records.js";
import {
  DeliveryManifestSchema,
  type DeliveryRevision,
} from "../../packages/contracts/src/index.js";
import { BufferedEventSink } from "../../packages/core/src/buffered-sink.js";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const report = {
  testResults: [
    {
      assertionResults: [{ title: "updates content", status: "passed" }],
    },
  ],
};

async function fixture(
  options: {
    multi?: boolean;
    hook?: boolean;
    extraChecks?: any[];
    config?: boolean;
  } = {},
) {
  const s = setup();
  const ri = await repository(s.root);
  const p = project(ri.repo);
  let other: any;
  if (options.multi) {
    other = await repository(s.root, "second");
    p.repositories.push({ id: "second", path: other.repo });
  }
  if (options.hook && p.commands[0])
    p.commands[0].required_before_commit = true;
  if (options.extraChecks) p.commands.push(...options.extraChecks);
  p.commands[0]!.executable = "pnpm";
  p.commands[0]!.args = ["test"];
  s.store.put("project", p.id, p.id, p);

  const pl = {
    ...plan(objectHash(p), ri.baseline),
    task_model: "native-v2",
    modules: [{ id: "M01", title: "Core" }],
  };
  if (options.config) {
    pl.scope.allowed_paths.push("config.json");
    writeFileSync(join(ri.repo, "config.json"), '{"version":1}');
  }
  if (options.multi) {
    pl.baselines.second = other.baseline;
    pl.scope.repository_paths = { main: ["app.txt"], second: ["app.txt"] };
    const firstTask = pl.tasks[0]!;
    firstTask.repo_id = "main";
    pl.tasks.push({
      ...firstTask,
      id: "T02",
      repo_id: "second",
      test_ids: ["UT02"],
    });
    const firstTest = pl.tests[0]!;
    pl.tests.push({ ...firstTest, id: "UT02", task_ids: ["T02"] });
  }

  const w = s.engine.create(
    {
      project_id: p.id,
      title: "Third round review fixture",
      request: "Isolated verification",
      complexity: "simple",
      workspace_mode: "existing_workspace",
    },
    "create",
  );
  s.engine.submitPlan(w.id, pl, w.version, "plan");
  const pr = proof(s.engine, w.id, "approve");
  s.engine.approve(w.id, pr.proof, pr.binding);

  const makeWs = (idStr: string, repo: string, baseline: string) => ({
    id: "ws-" + idStr,
    workflow_id: w.id,
    repo_id: idStr,
    root: repo,
    common_dir: join(repo, ".git"),
    baseline,
    branch: "task/fixture",
    owned: true,
  });
  const ws = makeWs("main", ri.repo, ri.baseline);
  s.store.put("workspace", ws.id, w.id, ws);
  if (other) {
    const ws2 = makeWs("second", other.repo, other.baseline);
    s.store.put("workspace", ws2.id, w.id, ws2);
  }

  const runId = "run-" + w.id;
  s.engine.transition(w.id, ["QUEUED"], "EXECUTING", "execute", {
    run_id: runId,
  });
  s.store.put("run", runId, w.id, {
    id: runId,
    workflow_id: w.id,
    plan_revision: 1,
    adapter: "agy",
    stage: "execute",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "review",
  });

  writeFileSync(join(ri.repo, "app.txt"), "after\n");
  mkdirSync(join(ri.repo, ".reports"), { recursive: true });
  writeFileSync(join(ri.repo, ".reports", "unit.json"), JSON.stringify(report));

  const fact = {
    tool_call_id: "call-1",
    command: "pnpm test",
    cwd: ri.repo,
    exit_code: 0,
    ended_at: new Date().toISOString(),
  };
  const manifest = DeliveryManifestSchema.parse({
    implementations: [{ task_id: "T01", repo_id: "main", path: "app.txt" }],
    test_executions: [
      {
        ...fact,
        repo_id: "main",
        format: "vitest_json",
        report_paths: [".reports/unit.json"],
      },
    ],
    acceptance_mappings: [
      {
        requirement_id: "UT01",
        scene_id: "updates content",
        test_execution_id: "call-1",
        report_path: ".reports/unit.json",
        case_id: "updates content",
      },
    ],
  });

  let reader = new Reader([fact]);
  if (other) {
    manifest.implementations.push({
      task_id: "T02",
      repo_id: "second",
      path: "app.txt",
    });
    const secondFact = {
      ...fact,
      tool_call_id: "call-2",
      cwd: other.repo,
      ended_at: new Date().toISOString(),
    };
    manifest.test_executions.push({
      ...secondFact,
      repo_id: "second",
      format: "vitest_json",
      report_paths: [".reports/unit.json"],
    });
    const firstMapping = manifest.acceptance_mappings[0]!;
    manifest.acceptance_mappings.push({
      ...firstMapping,
      requirement_id: "UT02",
      test_execution_id: "call-2",
    });
    reader = new Reader([fact, secondFact]);
  }

  reader = attestFixture(s.engine, w.id, manifest, reader);
  return { ...s, ...ri, p, pl, w, ws, runId, fact, manifest, reader, other };
}

describe("第三轮复核反例自动化回归套件 (R01 ~ R12)", () => {
  it("R01: 缓冲器等待所有真实异步写入完成，并发上限严格为 1", async () => {
    let active = 0,
      maxActive = 0,
      completed = 0;
    const sink = new BufferedEventSink({
      maxBytes: 1,
      maxMemoryBytes: 2,
      onFlush: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await delay(50);
        active--;
        completed++;
      },
    });
    await sink.writeAsync("a");
    await sink.writeAsync("b");
    await sink.writeAsync("c");
    await sink.close();

    expect(completed).toBe(3);
    expect(active).toBe(0);
    expect(maxActive).toBe(1);
  });

  it("R02: 缓冲器不干预调用方的外部队列或私自执行回调", async () => {
    let callbackCalls = 0;
    const externalQueue: Function[] = [];
    const sink = new BufferedEventSink({
      maxBytes: 1,
      onFlush: async () => {
        externalQueue.push(() => callbackCalls++);
        await delay(50);
      },
    });
    sink.write("a");
    await sink.close();

    expect(callbackCalls).toBe(0);
    expect(externalQueue.length).toBe(1);
  });

  it("R03: 测试报告不变，修改代码后重新复制旧报告，交付被拒绝 (旧测试不能证明新代码)", async () => {
    const s = await fixture();
    try {
      const path = join(s.repo, ".reports", "unit.json");
      const original = readFileSync(path);
      await delay(30);
      writeFileSync(join(s.repo, "app.txt"), "new code never tested\n");
      await delay(30);
      writeFileSync(path, original);

      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("rejected");
      expect(r.issues?.some((i) => i.code === "FINGERPRINT_STALE")).toBe(true);
    } finally {
      s.store.close();
    }
  });

  it("R04: 多仓同名报告第二仓缺失时，必须报 REPORT_MISSING 且第二仓验收项不通过", async () => {
    const s = await fixture({ multi: true });
    try {
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("rejected");
      expect(
        r.issues?.some(
          (i) => i.code === "REPORT_MISSING" && i.message.includes("second"),
        ),
      ).toBe(true);
      const acceptances = s.store
        .list<any>("acceptance_result", s.w.id)
        .filter((a) => a.requirement_id === "UT02" && a.status === "passed");
      expect(acceptances.length).toBe(0);
    } finally {
      s.store.close();
    }
  });

  it("R05: 多仓同名报告第二仓包含失败用例，交付必须拒绝阻断", async () => {
    const s = await fixture({ multi: true });
    try {
      mkdirSync(join(s.other.repo, ".reports"), { recursive: true });
      writeFileSync(
        join(s.other.repo, ".reports", "unit.json"),
        JSON.stringify({
          testResults: [
            {
              assertionResults: [
                { title: "updates content", status: "failed" },
              ],
            },
          ],
        }),
      );
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("rejected");
      expect(r.issues?.some((i) => i.code === "ACCEPTANCE_CASE_FAILED")).toBe(
        true,
      );
    } finally {
      s.store.close();
    }
  });

  it("R06: 必需 build 命令从未执行时，提交门禁抛出 HOOK_EVIDENCE_MISSING 阻断提交", async () => {
    const s = await fixture({
      extraChecks: [
        {
          id: "build",
          executable: process.execPath,
          args: ["-e", "process.exit(1)"],
          parser: "none",
          required_before_commit: true,
        },
      ],
    });
    try {
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status, JSON.stringify(r)).toBe("accepted");

      s.store.put("run", s.runId, s.w.id, {
        ...s.store.get<any>("run", s.runId),
        status: "completed",
      });
      for (const rev of s.store.list<DeliveryRevision>(
        "delivery_revision",
        s.w.id,
      )) {
        s.store.put("delivery_revision", rev.id, s.w.id, {
          ...rev,
          execution_finished: true,
        });
      }
      const p = proof(s.engine, s.w.id, "accept");
      await s.engine.accept(s.w.id, p.proof, p.binding);

      s.engine.transition(s.w.id, ["REVIEW_QUEUED"], "REVIEWING", "review", {
        review_request_id: "review-test",
      });
      const w = s.engine.get(s.w.id);

      let reviewError: any = null;
      try {
        await s.engine.receiveReview(s.w.id, {
          schema_version: 1,
          review_request_id: "review-test",
          workflow_id: s.w.id,
          plan_revision: 1,
          snapshot_id: w.snapshot_id,
          verdict: "pass",
          coverage: {
            all_changed_files_reviewed: true,
            all_requirements_checked: true,
            upstream_downstream_checked: true,
            security_checked: true,
            tests_validity_checked: true,
            files: ["main:app.txt"],
          },
          findings: [],
          unresolved_questions: [],
          repair_plan: null,
          commit_message: "test: isolated round3 review",
        });
      } catch (e: any) {
        reviewError = e;
      }

      expect(reviewError?.code).toBe("HOOK_EVIDENCE_MISSING");
      expect(s.engine.get(s.w.id).state).not.toBe("COMMITTED");
    } finally {
      s.store.close();
    }
  });

  it("R07: 额外必需检查从未执行时，提交门禁抛出 HOOK_EVIDENCE_MISSING 阻断提交", async () => {
    const s = await fixture({
      extraChecks: [
        {
          id: "integration-required",
          executable: process.execPath,
          args: ["-e", "process.exit(1)"],
          parser: "vitest_json",
          report_path: ".reports/extra.json",
          required_before_commit: true,
        },
      ],
    });
    try {
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status, JSON.stringify(r)).toBe("accepted");

      s.store.put("run", s.runId, s.w.id, {
        ...s.store.get<any>("run", s.runId),
        status: "completed",
      });
      for (const rev of s.store.list<DeliveryRevision>(
        "delivery_revision",
        s.w.id,
      )) {
        s.store.put("delivery_revision", rev.id, s.w.id, {
          ...rev,
          execution_finished: true,
        });
      }
      const p = proof(s.engine, s.w.id, "accept");
      await s.engine.accept(s.w.id, p.proof, p.binding);

      s.engine.transition(s.w.id, ["REVIEW_QUEUED"], "REVIEWING", "review", {
        review_request_id: "review-test",
      });
      const w = s.engine.get(s.w.id);

      let reviewError: any = null;
      try {
        await s.engine.receiveReview(s.w.id, {
          schema_version: 1,
          review_request_id: "review-test",
          workflow_id: s.w.id,
          plan_revision: 1,
          snapshot_id: w.snapshot_id,
          verdict: "pass",
          coverage: {
            all_changed_files_reviewed: true,
            all_requirements_checked: true,
            upstream_downstream_checked: true,
            security_checked: true,
            tests_validity_checked: true,
            files: ["main:app.txt"],
          },
          findings: [],
          unresolved_questions: [],
          repair_plan: null,
          commit_message: "test: isolated round3 review",
        });
      } catch (e: any) {
        reviewError = e;
      }

      expect(reviewError?.code).toBe("HOOK_EVIDENCE_MISSING");
      expect(s.engine.get(s.w.id).state).not.toBe("COMMITTED");
    } finally {
      s.store.close();
    }
  });

  it("R08: 实际分支与预期不一致导致快照失败时，拒绝交付且不标记任务 verified", async () => {
    const s = await fixture();
    try {
      s.store.put("workspace", s.ws.id, s.w.id, {
        ...s.ws,
        branch: "task/different-expected-branch",
      });
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("rejected");
      expect(r.issues?.some((i) => i.code === "BRANCH_CHANGED")).toBe(true);

      const w = s.engine.get(s.w.id);
      expect(w.snapshot_id).toBeFalsy();
      const proofs = s.store
        .list<any>("task_proof", s.w.id)
        .filter((tp) => tp.verified === true);
      expect(proofs.length).toBe(0);
    } finally {
      s.store.close();
    }
  });

  it("R09: 执行器状态为 failed 时，拒绝交付且拒绝人工验收", async () => {
    const s = await fixture();
    try {
      s.store.put("run", s.runId, s.w.id, {
        ...s.store.get<any>("run", s.runId),
        status: "failed",
      });
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("rejected");
      expect(r.issues?.some((i) => i.code === "EXECUTION_FAILED")).toBe(true);

      const p = proof(s.engine, s.w.id, "accept");
      let acceptError: any = null;
      try {
        await s.engine.accept(s.w.id, p.proof, p.binding);
      } catch (e: any) {
        acceptError = e;
      }
      expect(acceptError?.code).toBe("INVALID_STATE");
      expect(s.engine.get(s.w.id).state).toBe("EXECUTING");
    } finally {
      s.store.close();
    }
  });

  it("R10: 清单声明的 conversation_id 与宿主事实不一致时，严格拒绝交付", async () => {
    const s = await fixture();
    try {
      s.manifest.conversation_id = "different-conversation";
      s.reader = new Reader([
        { ...s.fact, conversation_id: "actual-conversation" },
      ]);
      const r = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(r.status).toBe("rejected");
      expect(r.issues?.some((i) => i.code === "IDENTITY_MISMATCH")).toBe(true);
    } finally {
      s.store.close();
    }
  });

  it("R11: 成功交付后，相同 submission_id 原样重试实现幂等返回原 accepted 结果", async () => {
    const s = await fixture();
    try {
      s.manifest.submission_id = "fixed-submission-r11";
      const first = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(first.status, JSON.stringify(first)).toBe("accepted");
      expect(s.engine.get(s.w.id).state).toBe("HUMAN_PENDING");

      const retry = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(retry.status).toBe("accepted");
      expect(retry.delivery_id).toBe(first.delivery_id);
    } finally {
      s.store.close();
    }
  });

  it("R12: 交付失效且代码改动后，重发旧清单不返回可用的旧 accepted", async () => {
    const s = await fixture();
    try {
      s.manifest.submission_id = "fixed-submission-r12";
      const first = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(first.status, JSON.stringify(first)).toBe("accepted");

      s.engine.invalidate(s.w.id, "changed code");
      s.engine.transition(
        s.w.id,
        ["HUMAN_PENDING"],
        "EXECUTING",
        "review-probe-resume",
      );
      writeFileSync(join(s.repo, "app.txt"), "untested after invalidation\n");

      const again = await s.engine.deliver(s.w.id, s.manifest, s.reader);
      expect(again.status).toBe("rejected");
      expect(again.issues?.some((i) => i.code === "EVIDENCE_INVALIDATED")).toBe(
        true,
      );
      expect(s.engine.get(s.w.id).state).toBe("EXECUTING");
    } finally {
      s.store.close();
    }
  });
});
it("R13: snapshot failure remains rejected on the same submission retry", async () => {
  const s = await fixture();
  try {
    s.engine.git.snapshot = async () => {
      throw new Error("snapshot unavailable");
    };
    const a = await s.engine.deliver(s.w.id, s.manifest, s.reader);
    const b = await s.engine.deliver(s.w.id, s.manifest, s.reader);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(b.issues?.some((i) => i.code === "SNAPSHOT_FAILED")).toBe(true);
    expect(s.store.list("delivery_revision", s.w.id)).toHaveLength(0);
  } finally {
    s.store.close();
  }
});
it("R14: a stopped run cannot submit or mark progress complete", async () => {
  const s = await fixture();
  try {
    s.store.put("run", s.runId, s.w.id, {
      ...s.store.get<any>("run", s.runId),
      status: "stopped",
    });
    expect((await s.engine.deliver(s.w.id, s.manifest, s.reader)).status).toBe(
      "rejected",
    );
    expect(s.engine.taskStatus(s.w.id).every((t) => !t.completed)).toBe(true);
  } finally {
    s.store.close();
  }
});
it("R15: malformed delivery input is rejected before import side effects", async () => {
  const s = await fixture();
  try {
    const result = await s.engine.deliver(
      s.w.id,
      { test_executions: null } as any,
      s.reader,
    );
    expect(result.status).toBe("rejected");
    expect(result.issues?.[0]?.code).toBe("INVALID_DELIVERY_MANIFEST");
    expect(s.store.list("delivery", s.w.id)).toHaveLength(0);
  } finally {
    s.store.close();
  }
});
it("R16: changes after delivery prevent finalization and task completion", async () => {
  const s = await fixture();
  try {
    s.store.put("run", s.runId, s.w.id, {
      ...s.store.get<any>("run", s.runId),
      status: "running",
    });
    expect((await s.engine.deliver(s.w.id, s.manifest, s.reader)).status).toBe(
      "accepted",
    );
    writeFileSync(join(s.repo, "app.txt"), "changed after submission\n");
    s.store.put("run", s.runId, s.w.id, {
      ...s.store.get<any>("run", s.runId),
      status: "completed",
    });
    await expect(
      s.engine.finalizeNativeDelivery(s.w.id, s.runId),
    ).rejects.toThrow();
    expect(s.engine.get(s.w.id).state).toBe("VERIFYING");
    expect(s.engine.taskStatus(s.w.id).every((t) => !t.completed)).toBe(true);
  } finally {
    s.store.close();
  }
});
it("R17: a host call alias resolves to the same execution receipt", async () => {
  const s = await fixture();
  try {
    const facts = s.reader.getAllFacts().map((f) => ({
      ...f,
      tool_call_id: "real-" + f.tool_call_id,
      aliases: [f.tool_call_id],
    }));
    expect(
      (await s.engine.deliver(s.w.id, s.manifest, new Reader(facts))).status,
    ).toBe("accepted");
  } finally {
    s.store.close();
  }
});
it("R18: evidence display includes all cases for a requirement and waits for executor completion", async () => {
  const s = await fixture();
  try {
    s.store.put("run", s.runId, s.w.id, {
      ...s.store.get<any>("run", s.runId),
      status: "running",
    });
    expect((await s.engine.deliver(s.w.id, s.manifest, s.reader)).status).toBe(
      "accepted",
    );
    expect(s.engine.getEvidence(s.w.id)).toEqual([]);
    s.store.put("run", s.runId, s.w.id, {
      ...s.store.get<any>("run", s.runId),
      status: "completed",
    });
    await s.engine.finalizeNativeDelivery(s.w.id, s.runId);
    const a = s.store.list<any>("acceptance_result", s.w.id)[0];
    s.store.put("acceptance_result", "additional-case", s.w.id, {
      ...a,
      id: "additional-case",
      case_id: "second scenario",
    });
    const evidence = s.engine.getEvidence(s.w.id);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.case_ids).toEqual(
      expect.arrayContaining(["updates content", "second scenario"]),
    );
    expect(evidence[0]!.passed).toBe(2);
  } finally {
    s.store.close();
  }
});
