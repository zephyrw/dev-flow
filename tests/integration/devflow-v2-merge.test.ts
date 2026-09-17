import { GitDeliveryCoordinator } from "../../packages/git/src/delivery-coordinator.js";
import { it, expect, vi } from "vitest";
import { setup, repository, project, proof } from "../helpers.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { git } from "../../packages/git/src/git.js";
import { resolve, join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
it(
  "主分支推进后必须完整重测新候选，终审通过才合回并清理",
  { timeout: 900000 },
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
      request_id: "merge",
      workspace_root: r.repo,
      request_text: "修改 app.txt",
      workspace_mode: "new_worktree",
      planner_profile_id: "profile-codex",
    }).workflow;
    const native = new LocalRuntime(s.engine);
    const original = GitDeliveryCoordinator.prototype.executeDelivery;
    let interrupted = false;
    const spy = vi
      .spyOn(GitDeliveryCoordinator.prototype, "executeDelivery")
      .mockImplementation(async function (
        this: GitDeliveryCoordinator,
        ...args: Parameters<GitDeliveryCoordinator["executeDelivery"]>
      ) {
        const outcome = await original.apply(this, args);
        if (outcome.needsVerification && !interrupted) {
          interrupted = true;
          throw Error("simulated interruption after merge");
        }
        return outcome;
      });
    let advanced = false,
      candidateRuns = 0,
      finalReviews = 0;
    s.engine.runtime = {
      plan: (w, r) => native.plan(w, r),
      aside: (w, r, q) => native.aside(w, r, q),
      check: (w, t, p) => native.check(w, t, p),
      stop: (r) => native.stop(r),
      close: () => native.close(),
      async execute(w, run, token) {
        if (s.store.get("integration_candidate", w.id + ":main")) {
          candidateRuns++;
          expect(await git(r.repo, ["show", "HEAD:app.txt"])).toBe("before");
        }
        return native.execute(w, run, token);
      },
      async review(w, run) {
        const result = await native.review(w, run);
        if (w.stage === "review") {
          finalReviews++;
          if (!advanced) {
            writeFileSync(join(r.repo, "upstream.txt"), "main advanced\n");
            await git(r.repo, ["add", "upstream.txt"]);
            await git(r.repo, ["commit", "-m", "independent upstream"]);
            advanced = true;
          }
        }
        return result;
      },
    };
    const wait = async (state: string) => {
      const end = Date.now() + 420000;
      while (Date.now() < end) {
        await s.engine.dispatch();
        const current = s.engine.get(w.id);
        if (
          ["BLOCKED", "COMMIT_PARTIAL"].includes(current.state) &&
          current.state !== state
        )
          throw Error(JSON.stringify(current.blocker));
        if (current.state === state) {
          await s.engine.waitForIdle(w.id);
          return;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw Error("Timeout " + state);
    };
    try {
      await wait("PLAN_PENDING");
      const a = proof(s.engine, w.id, "approve");
      s.engine.approve(w.id, a.proof, a.binding);
      await wait("HUMAN_PENDING");
      const accept = proof(s.engine, w.id, "accept");
      await s.engine.accept(w.id, accept.proof, accept.binding);
      await wait("COMMIT_PARTIAL");
      expect(interrupted).toBe(true);
      await s.engine.retryCommit(w.id);
      await wait("COMPLETED");
      expect(candidateRuns).toBe(2);
      expect(finalReviews).toBe(2);
      expect(await git(r.repo, ["show", "HEAD:app.txt"])).toBe("after");
      expect(await git(r.repo, ["show", "HEAD:upstream.txt"])).toBe(
        "main advanced",
      );
      const ws = s.store.list<any>("workspace", w.id)[0];
      expect(existsSync(ws.root)).toBe(false);
      expect(await git(r.repo, ["branch", "--list", ws.branch])).toBe("");
      expect(s.store.list("delivery_revision", w.id)).toHaveLength(4);
    } finally {
      spy.mockRestore();
      if (
        ![
          "COMPLETED",
          "COMMITTED",
          "COMMIT_PARTIAL",
          "CLEANUP_PENDING",
        ].includes(s.engine.get(w.id).state)
      )
        await s.engine.stop(w.id);
      await s.engine.waitForIdle(w.id);
      await native.close();
      s.store.close();
    }
  },
);
