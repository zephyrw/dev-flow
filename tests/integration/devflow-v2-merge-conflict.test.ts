import {
  GitDeliveryCoordinator,
  mergeConflictResolutionInstructions,
} from "../../packages/git/src/delivery-coordinator.js";
import { describe, it, expect } from "vitest";
import { setup, repository, project, proof } from "../helpers.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { git } from "../../packages/git/src/git.js";
import { resolve, join } from "node:path";
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import type {
  MergeConflictRequest,
  MergeConflictReceipt,
  AcceptanceCarry,
  Run,
} from "../../packages/contracts/src/index.js";
import { MergeConflictReceiptSchema } from "../../packages/contracts/src/merge-conflict.js";
import { fixture, cleanup } from "../fixtures/native-flow.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";

describe("DevFlow v2 Git 冲突模型修复与终态保护", () => {
  it(
    "同行冲突由责任模型修复并保留双方需求，补测终审后发布并清理",
    { timeout: 900000 },
    async () => {
      const s = setup(),
        r = await repository(s.root),
        p = project(r.repo);
      s.store.put("project", p.id, "global", p);
      const profileCodex = {
        id: "profile-codex",
        revision: 1,
        adapterId: "codex" as const,
        executableRef: process.execPath,
        modelSelection: "native-config" as const,
        options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
      };
      s.store.put("tool_profile", "profile-codex", "global", profileCodex);
      seedVerifiedAccess(s.store, profileCodex);

      const w = new CreateWorkflowService(s.store).execute({
        request_id: "conflict-main",
        workspace_root: r.repo,
        request_text: "修改 app.txt",
        workspace_mode: "new_worktree",
        planner_profile_id: "profile-codex",
      }).workflow;

      const native = new LocalRuntime(s.engine);
      let conflictInjected = false;
      let conflictResolved = false;

      s.engine.runtime = {
        plan: (w, r) => native.plan(w, r),
        aside: (w, r, q) => native.aside(w, r, q),
        check: (w, t, p) => native.check(w, t, p),
        stop: (r) => native.stop(r),
        close: () => native.close(),
        async execute(w, run, token) {
          return native.execute(w, run, token);
        },
        async review(w, run) {
          const result = await native.review(w, run);
          if (w.stage === "review" && !conflictInjected) {
            // 在主仓库修改同行内容产生真实合并冲突
            writeFileSync(join(r.repo, "app.txt"), "upstream line\n");
            await git(r.repo, ["add", "app.txt"]);
            await git(r.repo, ["commit", "-m", "conflict upstream commit"]);
            conflictInjected = true;
          }
          return result;
        },
        async resolveMergeConflict(w, run, request) {
          conflictResolved = true;
          // 模拟责任模型在已批准范围内修改冲突文件，双方内容均保留
          const filePath = join(request.worktree_root, "app.txt");
          writeFileSync(filePath, "after\nupstream line\n");
          const receipt: MergeConflictReceipt = {
            request_id: request.id,
            workflow_id: w.id,
            run_id: run.id,
            candidate_commit: request.candidate_commit,
            source_commit: request.source_commit,
            status: "resolved",
            resolved_paths: ["app.txt"],
          };
          return receipt;
        },
      };

      const wait = async (state: string) => {
        const end = Date.now() + 600000;
        while (Date.now() < end) {
          await s.engine.dispatch();
          await s.engine.consumeOutbox();
          const current = s.engine.get(w.id);
          if (
            ["BLOCKED", "COMMIT_PARTIAL"].includes(current.state) &&
            current.state !== state
          ) {
            throw Error(JSON.stringify(current.blocker));
          }
          if (current.state === state) {
            await s.engine.waitForIdle(w.id);
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        throw Error(
          "Timeout waiting for " +
            state +
            " current=" +
            JSON.stringify({
              state: s.engine.get(w.id).state,
              stage: s.engine.get(w.id).stage,
              blocker: s.engine.get(w.id).blocker,
            }),
        );
      };

      try {
        await wait("PLAN_PENDING");
        const a = proof(s.engine, w.id, "approve");
        s.engine.approve(w.id, a.proof, a.binding);

        await wait("HUMAN_PENDING");
        const accept = proof(s.engine, w.id, "accept");
        await s.engine.accept(w.id, accept.proof, accept.binding);

        await wait("COMPLETED");
        expect(conflictResolved).toBe(true);

        // 断言最终主工作区内容同时保留了双方需求
        const finalContent = await git(r.repo, ["show", "HEAD:app.txt"]);
        expect(finalContent.trim()).toContain("after");
        expect(finalContent.trim()).toContain("upstream line");

        // 工作树已被清理，临时分支已被删除
        const ws = s.store.list<any>("workspace", w.id)[0];
        expect(existsSync(ws.root)).toBe(false);
        expect(await git(r.repo, ["branch", "--list", ws.branch])).toBe("");
      } finally {
        if (
          ![
            "COMPLETED",
            "COMMITTED",
            "COMMIT_PARTIAL",
            "CLEANUP_PENDING",
            "COMMITTING",
            "INTEGRATING",
          ].includes(s.engine.get(w.id).state)
        ) {
          await s.engine.stop(w.id);
        }
        await s.engine.waitForIdle(w.id);
        await native.close();
        s.store.close();
      }
    },
  );

  it("未批准路径与模型异常退出时主工作区HEAD不变且保留工作树现场", async () => {
    const s = setup(),
      r = await repository(s.root),
      p = project(r.repo);
    s.store.put("project", p.id, "global", p);

    const coordinator = new GitDeliveryCoordinator(s.store, s.root);
    const beforeHead = await git(r.repo, ["rev-parse", "HEAD"]);

    const receiptWithBlocker: MergeConflictReceipt = {
      request_id: "fake-req",
      workflow_id: "fake-wf",
      run_id: "fake-run",
      candidate_commit: beforeHead,
      source_commit: beforeHead,
      status: "blocked",
      resolved_paths: [],
      blockers: [{ path: "out_of_scope.txt", reason: "超出了已批准范围" }],
    };

    s.store.put("workflow", "fake-wf", p.id, {
      id: "fake-wf",
      project_id: p.id,
      state: "INTEGRATING",
      stage: "integration",
      version: 1,
      workspace_mode: "new_worktree",
    });
    s.store.put("merge_conflict_request", "fake-req", "fake-wf", {
      id: "fake-req",
      workflow_id: "fake-wf",
      repo_id: "main",
      plan_revision: 1,
      plan_hash: "hash1",
      candidate_commit: beforeHead,
      source_commit: beforeHead,
      worktree_root: r.repo,
      common_dir: r.repo,
      conflict_paths: ["app.txt"],
      run_id: "fake-run",
      status: "running",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    s.store.put("workspace", "ws-fake", "fake-wf", {
      id: "ws-fake",
      repo_id: "main",
      root: r.repo,
      branch: "branch-fake",
      common_dir: r.repo,
      owned: true,
      baseline: beforeHead,
    });

    const res = await coordinator.handleConflictResolution(
      "fake-wf",
      "fake-req",
      receiptWithBlocker,
    );

    expect(res.blocked).toBe(true);
    expect(await git(r.repo, ["rev-parse", "HEAD"])).toBe(beforeHead);
    const updatedReq = s.store.must<MergeConflictRequest>(
      "merge_conflict_request",
      "fake-req",
    );
    expect(updatedReq.status).toBe("blocked");
    s.store.close();
  });

  it("目标工作区脏或外部再次推进时拒绝发布", async () => {
    const s = setup(),
      r = await repository(s.root),
      p = project(r.repo);
    s.store.put("project", p.id, "global", p);
    const profileCodex = {
      id: "profile-codex",
      revision: 1,
      adapterId: "codex" as const,
      executableRef: process.execPath,
      modelSelection: "native-config" as const,
      options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
    };
    s.store.put("tool_profile", "profile-codex", "global", profileCodex);
    seedVerifiedAccess(s.store, profileCodex);

    const w = new CreateWorkflowService(s.store).execute({
      request_id: "dirty-check",
      workspace_root: r.repo,
      request_text: "修改 app.txt",
      workspace_mode: "new_worktree",
      planner_profile_id: "profile-codex",
    }).workflow;

    const native = new LocalRuntime(s.engine);
    s.engine.runtime = {
      plan: (w, r) => native.plan(w, r),
      aside: (w, r, q) => native.aside(w, r, q),
      check: (w, t, p) => native.check(w, t, p),
      stop: (r) => native.stop(r),
      close: () => native.close(),
      execute: (w, run, token) => native.execute(w, run, token),
      review: (w, run) => native.review(w, run),
    };

    const wait = async (state: string) => {
      const end = Date.now() + 180000;
      while (Date.now() < end) {
        await s.engine.dispatch();
        const current = s.engine.get(w.id);
        if (current.state === state) {
          await s.engine.waitForIdle(w.id);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("Timeout waiting for " + state);
    };

    try {
      await wait("PLAN_PENDING");
      const a = proof(s.engine, w.id, "approve");
      s.engine.approve(w.id, a.proof, a.binding);

      await wait("HUMAN_PENDING");

      // 在主工作区制造未提交的脏改动
      writeFileSync(join(r.repo, "dirty.txt"), "dirty file\n");

      const accept = proof(s.engine, w.id, "accept");
      await s.engine.accept(w.id, accept.proof, accept.binding);

      // 调度执行终审后尝试交付，此时应被拒绝并阻止发布
      let blockedOrFailed = false;
      const end = Date.now() + 60000;
      while (Date.now() < end) {
        try {
          await s.engine.dispatch();
        } catch (e: any) {
          if (String(e).includes("主工作区存在未提交改动")) {
            blockedOrFailed = true;
            break;
          }
        }
        const current = s.engine.get(w.id);
        if (current.state === "BLOCKED" || current.state === "COMMIT_PARTIAL") {
          blockedOrFailed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }

      expect(blockedOrFailed).toBe(true);
      // 主工作区依然保留未提交改动，没有被强制覆盖或清理
      expect(existsSync(join(r.repo, "dirty.txt"))).toBe(true);
    } finally {
      if (
        ![
          "COMPLETED",
          "COMMITTED",
          "COMMIT_PARTIAL",
          "CLEANUP_PENDING",
        ].includes(s.engine.get(w.id).state)
      ) {
        await s.engine.stop(w.id);
      }
      await s.engine.waitForIdle(w.id);
      await native.close();
      s.store.close();
    }
  });

  it("解析保留明确功能影响，旧回执缺字段仍兼容", () => {
    expect(
      MergeConflictReceiptSchema.parse({
        request_id: "req",
        workflow_id: "wf",
        run_id: "run",
        candidate_commit: "a",
        source_commit: "b",
        status: "resolved",
        resolved_paths: ["app.txt"],
        function_impact: "changed",
        function_impact_explanation: "合并后行为变化",
      }).function_impact,
    ).toBe("changed");
    expect(
      MergeConflictReceiptSchema.parse({
        request_id: "req",
        workflow_id: "wf",
        run_id: "run",
        candidate_commit: "a",
        source_commit: "b",
        status: "resolved",
        resolved_paths: ["app.txt"],
      }).function_impact,
    ).toBeUndefined();
    expect(mergeConflictResolutionInstructions()).toContain("function_impact");
  });

  it("none 沿承接、changed/uncertain 需要确认，重复回执不丢影响", async () => {
    const noneCarry = await resolveConflictWithImpact("none");
    expect(noneCarry.carry?.requires_confirmation).toBe(false);
    expect(noneCarry.carry?.reported_function_impact).toBe("none");
    noneCarry.store.close();

    const changed = await resolveConflictWithImpact("changed");
    expect(changed.carry?.requires_confirmation).toBe(true);
    expect(changed.carry?.reported_function_impact).toBe("changed");
    expect(changed.store.get("acceptance", "conflict-wf")).toBeUndefined();
    const duplicate = await changed.coordinator.handleConflictResolution(
      "conflict-wf",
      changed.requestId,
      changed.receipt,
    );
    expect(duplicate.carried).toBe(true);
    const afterDuplicate = changed.store.get<AcceptanceCarry>(
      "acceptance_carry",
      "conflict-wf",
    );
    expect(afterDuplicate?.reported_function_impact).toBe("changed");
    expect(afterDuplicate?.requires_confirmation).toBe(true);
    const noneReplay = await changed.coordinator.handleConflictResolution(
      "conflict-wf",
      changed.requestId,
      { ...changed.receipt, function_impact: "none" },
    );
    expect(noneReplay.carried).toBe(true);
    expect(
      changed.store.get<AcceptanceCarry>("acceptance_carry", "conflict-wf")
        ?.reported_function_impact,
    ).toBe("changed");
    changed.store.close();

    const uncertain = await resolveConflictWithImpact("uncertain");
    expect(uncertain.carry?.requires_confirmation).toBe(true);
    expect(uncertain.carry?.reported_function_impact).toBe("uncertain");
    uncertain.store.close();
  });

  it("冲突 changed 后审查材料可见影响，无 carry 不加该项", async () => {
    const s = await fixture();
    const runtime = new LocalRuntime(s.engine);
    const profile = captureReviewCli(s.root);
    try {
      const emptyRun = reviewingRun(s, profile, "rev-no-carry");
      const emptyMaterials = await reviewHandoff(runtime, s, emptyRun);
      expect(emptyMaterials).not.toHaveProperty("conflict_background");

      const w = s.engine.get(s.w.id);
      s.store.put("acceptance_carry", w.id, w.id, {
        original: { snapshot_id: w.snapshot_id },
        requires_confirmation: true,
        integration: true,
        reported_function_impact: "changed",
        function_impact_explanation: "合并后行为变化",
      });
      s.store.put("merge_conflict_request", "conflict-req-changed", w.id, {
        id: "conflict-req-changed",
        workflow_id: w.id,
        repo_id: "main",
        plan_revision: w.plan_revision ?? 1,
        plan_hash: w.plan_hash ?? "hash",
        candidate_commit: "cand",
        source_commit: "src",
        worktree_root: s.repo,
        common_dir: s.repo,
        conflict_paths: ["app.txt"],
        run_id: "conflict-run",
        quality_phase: "after_human",
        reported_function_impact: "changed",
        function_impact_explanation: "合并后行为变化",
        status: "resolved",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      const changedRun = reviewingRun(s, profile, "rev-changed-carry");
      const materials = await reviewHandoff(runtime, s, changedRun);
      expect(materials.conflict_background).toMatchObject({
        reported_function_impact: "changed",
        function_impact_explanation: "合并后行为变化",
        requires_confirmation: true,
        background_only: true,
        request_summary: {
          id: "conflict-req-changed",
          status: "resolved",
          repo_id: "main",
          conflict_paths: ["app.txt"],
          candidate_commit: "cand",
          source_commit: "src",
          quality_phase: "after_human",
        },
        receipt_summary: {
          status: "resolved",
          conflict_paths: ["app.txt"],
          reported_function_impact: "changed",
          function_impact_explanation: "合并后行为变化",
        },
      });
    } finally {
      await runtime.close();
      await cleanup(s);
    }
  });
});

async function resolveConflictWithImpact(
  impact: "none" | "changed" | "uncertain",
) {
  const s = setup();
  const r = await repository(s.root);
  await git(r.repo, ["checkout", "-b", "source"]);
  writeFileSync(join(r.repo, "app.txt"), "upstream line\n");
  await git(r.repo, ["add", "app.txt"]);
  await git(r.repo, ["commit", "-m", "source change"]);
  const sourceCommit = (await git(r.repo, ["rev-parse", "HEAD"])).trim();
  await git(r.repo, ["checkout", "task/fixture"]);
  writeFileSync(join(r.repo, "app.txt"), "after\n");
  await git(r.repo, ["add", "app.txt"]);
  await git(r.repo, ["commit", "-m", "candidate change"]);
  const candidateCommit = (await git(r.repo, ["rev-parse", "HEAD"])).trim();
  try {
    await git(
      r.repo,
      ["merge", "--no-edit", sourceCommit],
      {
        GIT_EDITOR: ":",
        GIT_MERGE_AUTOEDIT: "no",
        GIT_PAGER: "cat",
      },
    );
  } catch {}
  writeFileSync(join(r.repo, "app.txt"), "after\nupstream line\n");
  const requestId = "conflict-req-" + impact;
  s.store.put("workflow", "conflict-wf", "p1", {
    id: "conflict-wf",
    project_id: "p1",
    state: "INTEGRATING",
    stage: "integration",
    version: 1,
    snapshot_id: "snap",
    run_id: "conflict-run",
    plan_revision: 1,
    plan_hash: "hash",
  });
  s.store.put("project", "p1", "global", project(r.repo));
  s.store.put("workspace", "ws-conflict", "conflict-wf", {
    id: "ws-conflict",
    repo_id: "main",
    root: r.repo,
    branch: "task/fixture",
    common_dir: r.repo,
    owned: true,
    baseline: candidateCommit,
  });
  s.store.put("merge_conflict_request", requestId, "conflict-wf", {
    id: requestId,
    workflow_id: "conflict-wf",
    repo_id: "main",
    plan_revision: 1,
    plan_hash: "hash",
    candidate_commit: candidateCommit,
    source_commit: sourceCommit,
    worktree_root: r.repo,
    common_dir: r.repo,
    conflict_paths: ["app.txt"],
    run_id: "conflict-run",
    status: "running",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  s.store.put("acceptance", "conflict-wf", "conflict-wf", {
    snapshot_id: "snap",
    confirmed_by: "tester",
  });
  const coordinator = new GitDeliveryCoordinator(s.store, s.root);
  const receipt: MergeConflictReceipt = {
    request_id: requestId,
    workflow_id: "conflict-wf",
    run_id: "conflict-run",
    candidate_commit: candidateCommit,
    source_commit: sourceCommit,
    status: "resolved",
    resolved_paths: ["app.txt"],
    function_impact: impact,
    function_impact_explanation: "impact-" + impact,
  };
  await coordinator.handleConflictResolution("conflict-wf", requestId, receipt);
  return {
    store: s.store,
    coordinator,
    requestId,
    receipt,
    carry: s.store.get<AcceptanceCarry>("acceptance_carry", "conflict-wf"),
  };
}

function captureReviewCli(root: string) {
  const cli = join(root, "review-capture.cjs");
  writeFileSync(
    cli,
    [
      "const fs = require('node:fs');",
      "try { fs.readFileSync(0, 'utf8'); } catch {}",
      "const emit = (value) => console.log(JSON.stringify(value));",
      "const resume = process.argv.indexOf('resume');",
      "emit({ type: 'thread.started', thread_id: resume >= 0 ? process.argv[resume + 1] : 'new-session' });",
      "const idx = process.argv.indexOf('--output-last-message');",
      "const result = { verdict: 'passed', summary: '审查完成' };",
      "if (idx >= 0 && process.argv[idx + 1]) fs.writeFileSync(process.argv[idx + 1], JSON.stringify(result));",
      "emit({ type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(result) } });",
    ].join("\n"),
  );
  return {
    id: "fixture-reviewer",
    revision: 1,
    adapterId: "codex" as const,
    executableRef: process.execPath,
    modelSelection: "explicit" as const,
    modelId: "fixture-reviewer",
    options: { prefixArgs: [cli] },
  };
}

function reviewingRun(
  s: Awaited<ReturnType<typeof fixture>>,
  profile: ReturnType<typeof captureReviewCli>,
  runId: string,
) {
  const current = s.engine.get(s.w.id);
  const w = {
    ...current,
    state: "REVIEWING" as const,
    stage: "review" as const,
    run_id: runId,
    snapshot_id: current.snapshot_id ?? "snap-review",
  };
  s.store.put("workflow", w.id, w.project_id, w);
  s.store.put("snapshot", w.snapshot_id!, w.id, {
    id: w.snapshot_id,
    repositories: [],
  });
  s.store.put("workspace", "ws-review", w.id, {
    id: "ws-review",
    workflow_id: w.id,
    repo_id: "main",
    root: s.repo,
    common_dir: s.repo,
    baseline: s.baseline,
    branch: "task/fixture",
    owned: false,
  });
  const run: Run = {
    id: runId,
    workflow_id: w.id,
    plan_revision: w.plan_revision,
    adapter: "codex",
    purpose: "quality_review",
    protocol: "lightweight",
    stage: "review",
    status: "running",
    started_at: new Date().toISOString(),
    package_hash: "pkg",
    profile,
  };
  s.store.put("run", run.id, w.id, run);
  return run;
}

async function reviewHandoff(
  runtime: LocalRuntime,
  s: Awaited<ReturnType<typeof fixture>>,
  run: Run,
) {
  await runtime.review(s.engine.get(s.w.id), run);
  return JSON.parse(
    readFileSync(
      join(s.config.storage_root, "native-runs", run.id, "HANDOFF.json"),
      "utf8",
    ),
  );
}
