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
  async waitForResources(
    owner: string,
    run: string,
    keys: string[],
    assertActive: () => void,
    waitId = owner,
  ) {
    let announced = false;
    try {
      for (;;) {
        assertActive();
        const leases = this.acquire(owner, run, keys);
        if (leases) return leases;
        if (!announced) {
          const leases = this.store
            .list<Lease>("lease")
            .filter(l => keys.some(key => this.conflicts(key, l.id)));
          const message = `等待共享资源：${keys.join("、")}`;
          this.store.put("resource_wait", waitId, owner, {
            resource: keys.join("、"),
            message,
            owners: leases.map((l) => l.owner),
            run_id: run,
          });
          const w = this.store.get<{ project_id: string }>("workflow", owner);
          if (w)
            this.store.event(
              owner,
              w.project_id,
              "ResourceWaiting",
              { message, resource: keys.join("、") },
              run,
            );
          announced = true;
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    } finally {
      this.store.remove("resource_wait", waitId);
    }
  }
  acquire(owner: string, run: string, keys: string[]): Lease[] | null {
    return this.store.transaction(() => {
      const sorted = [...new Set(keys)].sort();
      if (
        sorted.some((k) => {
          return this.store.list<Lease>("lease").some(l => this.conflicts(k, l.id) &&
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
  conflicts(key: string, other: string) {
    if (key === other) return true;
    const root = (value: string) => value.startsWith("read:")
      ? value.slice(5, value.lastIndexOf("::"))
      : value.startsWith("write:") ? value.slice(6) : undefined;
    const a = root(key), b = root(other);
    return a !== undefined && b !== undefined && a === b &&
      (key.startsWith("write:") || other.startsWith("write:"));
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
