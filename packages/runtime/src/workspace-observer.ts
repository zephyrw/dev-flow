import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import type { Engine } from "../../core/src/engine.js";
import type {
  Evidence,
  Snapshot,
  Workspace,
} from "../../contracts/src/index.js";
import { hash } from "../../core/src/util.js";
import { safePath } from "../../workspace/src/files.js";
import { invalidateTaskProofs } from "../../core/src/progress.js";

/** Watch approved source paths only. File checks happen after changes, never
 * while rendering a page. Delivery still performs a full snapshot check. */
export class WorkspaceObserver {
  private watches = new Map<string, FSWatcher>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  constructor(private engine: Engine) {
    engine.store.on("event", this.onEvent);
    this.refresh();
  }
  private onEvent = (event: { type: string }) => {
    if (["StateChanged", "PlanSubmitted"].includes(event.type)) this.refresh();
  };
  private refresh() {
    if (this.closed) return;
    for (const w of this.engine.list()) {
      if (w.state === "COMMITTED") continue;
      for (const ws of this.engine.store.list<Workspace>("workspace", w.id)) {
        if (this.watches.has(ws.id)) continue;
        try {
          const watcher = watch(
            ws.root,
            { recursive: true },
            (_event, file) => {
              if (!file || this.closed) return;
              const current = this.engine.get(ws.workflow_id);
              if (!current.plan_revision || current.state === "COMMITTED")
                return;
              const plan = this.engine.plan(current.id).plan;
              const normalized = file.toString().replaceAll("\\", "/");
              const path = (
                plan.scope.repository_paths[ws.repo_id] ??
                plan.scope.allowed_paths
              ).find((p) => p.toLowerCase() === normalized.toLowerCase());
              if (!path) return;
              const key = ws.id + ":" + path;
              clearTimeout(this.timers.get(key));
              this.timers.set(
                key,
                setTimeout(() => {
                  this.timers.delete(key);
                  void this.changed(ws, path).catch(() => {});
                }, 150),
              );
            },
          );
          watcher.on("error", () => {
            watcher.close();
            this.watches.delete(ws.id);
          });
          this.watches.set(ws.id, watcher);
        } catch {
          /* A missing workspace is handled by preparation/recovery. */
        }
      }
    }
  }
  async changed(ws: Workspace, path: string) {
    let actual: string | null;
    try {
      actual = hash(await readFile(safePath(ws.root, path)));
    } catch (e: any) {
      if (e.code !== "ENOENT") throw e;
      actual = null;
    }
    if (this.closed) return;
    const w = this.engine.get(ws.workflow_id);
    const tasks = this.engine
      .plan(w.id)
      .plan.tasks.filter(
        (t) =>
          (!t.repo_id || t.repo_id === ws.repo_id) && t.paths.includes(path),
      );
    let differs = tasks.some((t) => {
      const proof = this.engine.store.get<any>(
        "task_proof",
        `${w.id}-${w.plan_revision}-${t.id}`,
      );
      return proof && !proof.stale && proof.hashes[path] !== actual;
    });
    for (const e of [
      ...this.engine.store.list<Evidence>("development_evidence", w.id),
      ...this.engine.store.list<Evidence>("evidence", w.id),
    ]) {
      if (e.status !== "passed" || e.plan_revision !== w.plan_revision)
        continue;
      const snapshot = this.engine.store.get<Snapshot>(
        "snapshot",
        e.snapshot_id,
      );
      const repo = snapshot?.repositories.find((r) => r.repo_id === ws.repo_id);
      if (
        repo &&
        (repo.files.find((f) => f.path === path)?.hash ?? null) !== actual
      )
        differs = true;
    }
    if (!differs) return;
    invalidateTaskProofs(this.engine, w.id, [path], ws.repo_id);
    this.engine.invalidate(w.id, "代码修改", {
      paths: [path],
      repo: ws.repo_id,
    });
    this.engine.store.event(w.id, w.project_id, "SourceChanged", {
      paths: [path],
      repo_id: ws.repo_id,
      message: "工作区文件变化，相关实现和测试需要重新核验",
    });
  }
  close() {
    this.closed = true;
    this.engine.store.off("event", this.onEvent);
    for (const watch of this.watches.values()) watch.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
  }
}
