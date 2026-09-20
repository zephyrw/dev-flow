import { it, expect } from "vitest";
import { setup, repository, project, proof } from "../helpers.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { git } from "../../packages/git/src/git.js";
import { resolve, join } from "node:path";
import { writeFileSync, existsSync } from "node:fs";
it(
  "主分支推进后合并进候选并完成交付，不强制程序重测",
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
    let advanced = false;
    s.engine.runtime = {
      plan: (w, r) => native.plan(w, r),
      aside: (w, r, q) => native.aside(w, r, q),
      check: (w, t, p) => native.check(w, t, p),
      stop: (r) => native.stop(r),
      close: () => native.close(),
      execute: (w, run, token) => native.execute(w, run, token),
      async review(w, run) {
        const result = await native.review(w, run);
        if (w.stage === "review" && !advanced) {
          writeFileSync(join(r.repo, "upstream.txt"), "main advanced\n");
          await git(r.repo, ["add", "upstream.txt"]);
          await git(r.repo, ["commit", "-m", "independent upstream"]);
          advanced = true;
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
      await wait("COMPLETED");
      expect(await git(r.repo, ["show", "HEAD:app.txt"])).toBe("after");
      expect(await git(r.repo, ["show", "HEAD:upstream.txt"])).toBe(
        "main advanced",
      );
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
      )
        await s.engine.stop(w.id);
      await s.engine.waitForIdle(w.id);
      await native.close();
      s.store.close();
    }
  },
);
