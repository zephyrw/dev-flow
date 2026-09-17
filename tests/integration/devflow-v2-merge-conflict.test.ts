import { GitDeliveryCoordinator } from "../../packages/git/src/delivery-coordinator.js";
import { describe, it, expect } from "vitest";
import { setup, repository, project, proof } from "../helpers.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { git } from "../../packages/git/src/git.js";
import { resolve, join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
import type {
  MergeConflictRequest,
  MergeConflictReceipt,
} from "../../packages/contracts/src/index.js";

describe("DevFlow v2 Git 冲突模型修复与终态保护", () => {
  it(
    "同行冲突由责任模型修复并保留双方需求，补测终审后发布并清理",
    { timeout: 180000 },
    async () => {
      const s = setup(),
        r = await repository(s.root),
        p = project(r.repo);
      s.store.put("project", p.id, "global", p);
      s.store.put("tool_profile", "profile-codex", "global", {
        id: "profile-codex",
        revision: 1,
        adapterId: "codex",
        executableRef: process.execPath,
        modelSelection: "native-config",
        options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
      });

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
        const end = Date.now() + 120000;
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
        throw Error("Timeout waiting for " + state);
      };

      try {
        await wait("PLAN_PENDING");
        const a = proof(s.engine, w.id, "approve");
        s.engine.approve(w.id, a.proof, a.binding);

        await wait("HUMAN_PENDING");
        const accept = proof(s.engine, w.id, "accept");
        await s.engine.accept(w.id, accept.proof, accept.binding);

        // 持续调度直到冲突解决并重新进入 HUMAN_PENDING
        await wait("HUMAN_PENDING");
        expect(conflictResolved).toBe(true);

        // 冲突解决后生成新合并候选，作废旧证据并重新补测与终审
        const accept2 = proof(s.engine, w.id, "accept");
        await s.engine.accept(w.id, accept2.proof, accept2.binding);

        await wait("COMPLETED");

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
    s.store.put("tool_profile", "profile-codex", "global", {
      id: "profile-codex",
      revision: 1,
      adapterId: "codex",
      executableRef: process.execPath,
      modelSelection: "native-config",
      options: { prefixArgs: [resolve("tests/fixtures/native-cli.mjs")] },
    });

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
});
