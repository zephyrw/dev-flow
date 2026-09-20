import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setup, repository, project } from "../helpers.js";
import { git } from "../../packages/git/src/git.js";
import { GitDeliveryCoordinator } from "../../packages/git/src/delivery-coordinator.js";
import type { MergeConflictReceipt, Workspace } from "../../packages/contracts/src/index.js";

async function conflictFixture(cleanCompanionFirst = false) {
  const s = setup();
  try {
    const a = await repository(s.root, "repo-a");
    const b = await repository(s.root, "repo-b");
    const repositories = [
      { id: "a", path: a.repo }, { id: "b", path: b.repo },
    ];
    const p = { ...project(a.repo), repositories: cleanCompanionFirst ? repositories.reverse() : repositories };
    const workflowId = "multi-conflict";
    s.store.put("project", p.id, "global", p);
    s.store.put("workflow", workflowId, p.id, {
      id: workflowId, project_id: p.id, title: "multi repo", version: 1,
      plan_revision: 1, plan_hash: "plan", state: "COMMITTING", stage: "review",
      workspace_mode: "new_worktree",
    });
    s.store.put("quality_gate", workflowId + ":gate:after_human", workflowId, {
      status: "passed", passed_input_fingerprint: { plan_hash: "plan" },
    });
    s.store.put("acceptance", workflowId, workflowId, { confirmed_by: "fixture" });
    const workspaces = await s.engine.git.prepare(p, workflowId, "new_worktree", {
      a: a.baseline, b: b.baseline,
    });
    for (const ws of workspaces)
      writeFileSync(join(ws.root, "app.txt"), "task " + ws.repo_id + "\n");
    writeFileSync(join(a.repo, "app.txt"), "upstream a\n");
    await git(a.repo, ["add", "app.txt"]);
    await git(a.repo, ["commit", "-m", "upstream a"]);
    if (cleanCompanionFirst) {
      writeFileSync(join(b.repo, "upstream.txt"), "upstream b\n");
      await git(b.repo, ["add", "upstream.txt"]);
      await git(b.repo, ["commit", "-m", "upstream b"]);
    }
    const coordinator = new GitDeliveryCoordinator(s.store, s.config.workspace_root, s.engine.git);
    const result = await coordinator.executeDelivery(workflowId);
    expect(result.hasConflict).toBe(true);
    const request = result.conflictRequest!;
    s.store.put("workflow", workflowId, p.id, {
      ...s.engine.get(workflowId), run_id: request.run_id,
    });
    writeFileSync(join(request.worktree_root, "app.txt"), "task a\nupstream a\n");
    const receipt: MergeConflictReceipt = {
      request_id: request.id, workflow_id: workflowId, run_id: request.run_id,
      candidate_commit: request.candidate_commit, source_commit: request.source_commit,
      status: "resolved", resolved_paths: ["app.txt"], function_impact: "none",
    };
    return { ...s, a, b, p, workflowId, workspaces, coordinator, request, receipt };
  } catch (error) {
    s.store.close();
    throw error;
  }
}

describe("multi-repository conflict continuation", () => {
  it("retains every committed candidate and delivers both repositories after conflict review", async () => {
    const s = await conflictFixture();
    try {
      const other = s.workspaces.find((ws) => ws.repo_id === "b")!;
      const committedB = await git(other.root, ["rev-parse", "HEAD"]);
      expect(committedB).not.toBe(s.b.baseline);
      await s.coordinator.handleConflictResolution(s.workflowId, s.request.id, s.receipt);
      expect(s.store.must<Workspace>("workspace", other.id).execution_base).toBe(committedB);
      expect(s.store.get("commit_intent", s.workflowId)).toBeUndefined();
      expect(s.store.list("commit_index", s.workflowId)).toEqual([]);
      const snapshot = await s.engine.git.snapshot(s.workflowId, 0);
      expect(snapshot.repositories.find((repo) => repo.repo_id === "b")?.baseline).toBe(committedB);
      // A subsequent passed review restores the retained human confirmation.
      s.store.put("acceptance", s.workflowId, s.workflowId, { confirmed_by: "fixture" });
      const result = await s.coordinator.executeDelivery(s.workflowId);
      expect(result.integrations).toHaveLength(2);
      expect(s.engine.get(s.workflowId).state).toBe("COMPLETED");
      expect(readFileSync(join(s.a.repo, "app.txt"), "utf8")).toBe("task a\nupstream a\n");
      expect(readFileSync(join(s.b.repo, "app.txt"), "utf8")).toBe("task b\n");
      expect(s.workspaces.every((ws) => !existsSync(ws.root))).toBe(true);
    } finally { s.store.close(); }
  });

  it.each(["head", "index"] as const)("preserves external %s changes in the companion repository", async (kind) => {
    const s = await conflictFixture();
    try {
      const other = s.workspaces.find((ws) => ws.repo_id === "b")!;
      writeFileSync(join(other.root, "user.txt"), "keep user work\n");
      await git(other.root, ["add", "user.txt"]);
      if (kind === "head") await git(other.root, ["commit", "-m", "external user change"]);
      const head = await git(other.root, ["rev-parse", "HEAD"]);
      const index = await git(other.root, ["write-tree"]);
      await expect(s.coordinator.handleConflictResolution(s.workflowId, s.request.id, s.receipt))
        .rejects.toMatchObject({ code: kind === "head" ? "BASELINE_CHANGED" : "INDEX_CHANGED" });
      expect(await git(other.root, ["rev-parse", "HEAD"])).toBe(head);
      expect(await git(other.root, ["write-tree"])).toBe(index);
      expect(readFileSync(join(other.root, "user.txt"), "utf8")).toBe("keep user work\n");
      expect(await git(s.request.worktree_root, ["rev-parse", "MERGE_HEAD"])).toBe(s.request.source_commit);
      expect(s.store.get("commit_intent", s.workflowId)).toBeDefined();
    } finally { s.store.close(); }
  });

  it("retains a companion candidate already merged earlier in the same delivery", async () => {
    const s = await conflictFixture(true);
    try {
      const other = s.workspaces.find((ws) => ws.repo_id === "b")!;
      const mergedB = await git(other.root, ["rev-parse", "HEAD"]);
      const intent = s.store.must<{ repos: Record<string, string> }>("commit_intent", s.workflowId);
      expect(mergedB).not.toBe(intent.repos.b);
      await s.coordinator.handleConflictResolution(s.workflowId, s.request.id, s.receipt);
      const snapshot = await s.engine.git.snapshot(s.workflowId, 0);
      expect(snapshot.repositories.find((repo) => repo.repo_id === "b")?.baseline).toBe(mergedB);
      expect(readFileSync(join(other.root, "upstream.txt"), "utf8")).toBe("upstream b\n");
      await s.engine.git.commit(snapshot, s.p, "fix: reviewed conflict");
    } finally { s.store.close(); }
  });

  it("does not reuse a companion integration candidate from an earlier delivery", async () => {
    const s = await conflictFixture();
    try {
      const other = s.workspaces.find((ws) => ws.repo_id === "b")!;
      s.store.put("workspace", other.id, s.workflowId, { ...other, execution_base: s.b.baseline });
      s.store.put("integration_candidate", s.workflowId + ":b", s.workflowId, {
        candidate_commit: s.b.baseline,
      });
      const committedB = await git(other.root, ["rev-parse", "HEAD"]);
      await s.coordinator.handleConflictResolution(s.workflowId, s.request.id, s.receipt);
      expect(s.store.must<Workspace>("workspace", other.id).execution_base).toBe(committedB);
      await s.engine.git.snapshot(s.workflowId, 0);
    } finally { s.store.close(); }
  });

  it("revocation before a Git write preserves the unresolved merge", async () => {
    const s = await conflictFixture();
    try {
      let checks = 0;
      await expect(s.coordinator.handleConflictResolution(s.workflowId, s.request.id, s.receipt, () => {
        if (++checks > 1) throw Object.assign(new Error("stopped"), { code: "RUN_REVOKED" });
      })).rejects.toMatchObject({ code: "RUN_REVOKED" });
      expect(await git(s.request.worktree_root, ["rev-parse", "HEAD"])).toBe(s.request.candidate_commit);
      expect(await git(s.request.worktree_root, ["diff", "--name-only", "--diff-filter=U"])).toContain("app.txt");
      expect(s.store.get("acceptance", s.workflowId)).toBeDefined();
    } finally { s.store.close(); }
  });
  it("retains a completed Git commit when stopped during commit without advancing the workflow", async () => {
    const s = await conflictFixture();
    try {
      let checks = 0;
      await expect(s.coordinator.handleConflictResolution(s.workflowId, s.request.id, s.receipt, () => {
        if (++checks === 3) {
          s.store.put("workflow", s.workflowId, s.p.id, {
            ...s.engine.get(s.workflowId), state: "STOPPED", stage: "stopped",
          });
        } else if (checks > 3) {
          throw Object.assign(new Error("stopped"), { code: "RUN_REVOKED" });
        }
      })).rejects.toMatchObject({ code: "RUN_REVOKED" });
      expect(s.engine.get(s.workflowId).state).toBe("STOPPED");
      const committed = await git(s.request.worktree_root, ["rev-parse", "HEAD"]);
      expect(committed).not.toBe(s.request.candidate_commit);
      expect(s.store.get("merge_conflict_commit", s.request.id)).toMatchObject({ new_head: committed });
      expect(s.store.get("commit_intent", s.workflowId)).toBeUndefined();
      const snapshot = await s.engine.git.snapshot(s.workflowId, 0);
      expect(snapshot.repositories.find((repo) => repo.repo_id === "a")?.baseline).toBe(committed);
    } finally { s.store.close(); }
  });

  it("records a completed Git commit without overwriting a replacement run's candidate state", async () => {
    const s = await conflictFixture();
    try {
      let checks = 0;
      await expect(s.coordinator.handleConflictResolution(s.workflowId, s.request.id, s.receipt, () => {
        if (++checks === 3) {
          s.store.put("workflow", s.workflowId, s.p.id, {
            ...s.engine.get(s.workflowId), run_id: "replacement", state: "QUEUED",
          });
          s.store.put("integration_candidate", s.workflowId + ":a", s.workflowId, {
            candidate_commit: "replacement-candidate",
          });
        }
      })).rejects.toMatchObject({ code: "RUN_REVOKED" });
      expect(s.engine.get(s.workflowId).run_id).toBe("replacement");
      expect(s.store.get("integration_candidate", s.workflowId + ":a")).toEqual({ candidate_commit: "replacement-candidate" });
      expect(s.store.get("commit_intent", s.workflowId)).toBeDefined();
      expect(s.store.get("merge_conflict_commit", s.request.id)).toMatchObject({
        run_id: s.request.run_id,
        new_head: await git(s.request.worktree_root, ["rev-parse", "HEAD"]),
      });
    } finally { s.store.close(); }
  });

});
