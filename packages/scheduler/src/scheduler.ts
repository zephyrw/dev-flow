import { Store } from "../../store/src/store.js";
import { requireCondition } from "../../contracts/src/index.js";
import { now } from "../../core/src/util.js";
export interface Lease {
  id: string;
  owner: string;
  run_id: string;
  fence: number;
  status: "active" | "suspect";
  heartbeat: number;
}
export class Scheduler {
  constructor(private store: Store) {}
  acquire(owner: string, run: string, keys: string[]): Lease[] | null {
    return this.store.transaction(() => {
      const sorted = [...new Set(keys)].sort();
      if (
        sorted.some((k) => {
          const l = this.store.get<Lease>("lease", k);
          return (
            l &&
            !(l.owner === owner && l.run_id === run && l.status === "active")
          );
        })
      )
        return null;
      return sorted.map((key) => {
        const existing = this.store.get<Lease>("lease", key);
        if (existing) return existing;
        const counter =
          (this.store.get<{ fence: number }>("fence", key)?.fence ?? 0) + 1;
        this.store.put("fence", key, "system", { fence: counter });
        const lease: Lease = {
          id: key,
          owner,
          run_id: run,
          fence: counter,
          status: "active",
          heartbeat: Date.now(),
        };
        this.store.put("lease", key, owner, lease);
        return lease;
      });
    });
  }
  release(owner: string, run: string, keys: string[], confirmed: boolean) {
    requireCondition(confirmed, "EXIT_UNCONFIRMED", "尚未核实资源使用者退出");
    this.store.transaction(() => {
      for (const key of keys) {
        const l = this.store.get<Lease>("lease", key);
        if (l && l.owner === owner && l.run_id === run)
          this.store.remove("lease", key);
      }
    });
  }
  heartbeat(owner: string, run: string) {
    for (const l of this.store.list<Lease>("lease", owner))
      if (l.run_id === run)
        this.store.put("lease", l.id, owner, { ...l, heartbeat: Date.now() });
  }
  suspectExpired(milliseconds = 30000) {
    for (const l of this.store.list<Lease>("lease"))
      if (Date.now() - l.heartbeat > milliseconds)
        this.store.put("lease", l.id, l.owner, { ...l, status: "suspect" });
  }
  capacity(prefix: string, count: number) {
    for (let i = 0; i < count; i++)
      if (!this.store.get("lease", `${prefix}:${i}`)) return `${prefix}:${i}`;
    return null;
  }
  assert(key: string, owner: string, run: string, fence?: number) {
    const l = this.store.get<Lease>("lease", key);
    requireCondition(
      l &&
        l.owner === owner &&
        l.run_id === run &&
        l.status === "active" &&
        (fence === undefined || l.fence === fence),
      "LEASE_INVALID",
      "资源租约无效",
      403,
    );
  }
  enqueue(workflow: string, project: string, priority = 0) {
    this.store.put("queue", workflow, project, {
      id: workflow,
      project,
      priority,
      created_at: now(),
    });
  }
  next(lastProject?: string, aging = 10, running?: Set<string> | string[]) {
    const entries = this.store.list<{
      id: string;
      project: string;
      priority: number;
      created_at: string;
    }>("queue");
    const runningSet =
      running instanceof Set
        ? running
        : new Set(running ? Array.from(running) : []);
    const projects = [...new Set(entries.map((e) => e.project))];
    const index = lastProject ? projects.indexOf(lastProject) : -1;
    const ordered = [
      ...projects.slice(index + 1),
      ...projects.slice(0, index + 1),
    ];
    for (const project of ordered) {
      const candidates = entries
        .filter((e) => e.project === project && !runningSet.has(e.id))
        .sort(
          (a, b) =>
            b.priority +
              Math.floor(
                (Date.now() - Date.parse(b.created_at)) / (aging * 60000),
              ) -
              (a.priority +
                Math.floor(
                  (Date.now() - Date.parse(a.created_at)) / (aging * 60000),
                )) || a.created_at.localeCompare(b.created_at),
        );
      if (candidates[0]) return candidates[0];
    }
    return undefined;
  }
}
