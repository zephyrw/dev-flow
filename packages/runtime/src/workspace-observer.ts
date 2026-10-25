import { watch, realpathSync, type FSWatcher } from "node:fs";
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

/** Watch task location hints only. File checks happen after changes, never
 * while rendering a page. Delivery still performs a full snapshot check. */
export class WorkspaceObserver {
  private watches = new Map<string, { watcher: FSWatcher; workspaces: Workspace[] }>();
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
    const desired = new Map<string, Workspace[]>();
    for (const w of this.engine.list()) {
      if (["COMMITTED", "COMPLETED"].includes(w.state)) continue;
      for (const ws of this.engine.store.list<Workspace>("workspace", w.id)) {
        try {
          const path = realpathSync.native(ws.root), key = process.platform === "win32" ? path.toLowerCase() : path;
          desired.set(key, [...(desired.get(key) ?? []), ws]);
        } catch { /* Missing workspaces are handled by preparation. */ }
      }
    }
    for (const [root, workspaces] of desired) {
        const existing = this.watches.get(root);
        if (existing) { existing.workspaces = workspaces; continue; }
        try {
          const watcher = watch(
            workspaces[0]!.root,
            { recursive: true },
            (_event, file) => {
              if (!file || this.closed) return;
              const normalized = file.toString().replaceAll("\\", "/");
              if (normalized.split("/").some(part => [".git", "node_modules", "dist", ".cache"].includes(process.platform === "win32" ? part.toLowerCase() : part))) return;
              for (const ws of this.watches.get(root)?.workspaces ?? []) {
              const current = this.engine.get(ws.workflow_id);
              if (!current.plan_revision || ["COMMITTED", "COMPLETED"].includes(current.state)) continue;
              const plan = this.engine.plan(current.id).plan;
              const path = plan.tasks
                .filter(task => !task.repo_id || task.repo_id === ws.repo_id)
                .flatMap(task => task.paths)
                .find(p => process.platform === "win32" ? p.toLowerCase() === normalized.toLowerCase() : p === normalized);
              if (!path) continue;
              const key = ws.id + ":" + path;
              clearTimeout(this.timers.get(key));
              this.timers.set(
                key,
                setTimeout(() => {
                  this.timers.delete(key);
                  void this.changed(ws, path).catch(() => {});
                }, 150),
              );
              }
            },
          );
          watcher.on("error", () => {
            watcher.close();
            this.watches.delete(root);
          });
          this.watches.set(root, { watcher, workspaces });
        } catch {
          /* A missing workspace is handled by preparation/recovery. */
        }
    }
    for (const [root, entry] of this.watches) if (!desired.has(root)) {
      entry.watcher.close(); this.watches.delete(root);
    }
    const ids = [...desired.values()].flat().map(ws => ws.id);
    for (const [key, timer] of this.timers) if (!ids.some(id => key.startsWith(id + ":"))) { clearTimeout(timer); this.timers.delete(key); }
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
    if (["COMMITTED", "COMPLETED"].includes(w.state)) return;
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
    for (const entry of this.watches.values()) entry.watcher.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.watches.clear(); this.timers.clear();
  }
}
