import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../packages/store/src/store.js";
import { Engine } from "../../packages/core/src/engine.js";
import { ConfigSchema } from "../../packages/contracts/src/config.js";

export interface IsolatedTestEnv {
  root: string;
  repoRoot: string;
  fakeHome: string;
  store: Store;
  engine: Engine;
  cleanup: () => Promise<void> | void;
}

/**
 * 创建完全隔离的测试运行环境，防止修改当前环境配置或污染用户真实目录
 */
export function createIsolatedTestEnv(): IsolatedTestEnv {
  const root = mkdtempSync(join(tmpdir(), "devflow-isolated-"));
  const repoRoot = join(root, "repo");
  mkdirSync(repoRoot, { recursive: true });
  const fakeHome = join(root, "fake-home");
  mkdirSync(fakeHome, { recursive: true });

  const oldCodexHome = process.env.CODEX_HOME;
  const oldHome = process.env.HOME;
  const oldUserProfile = process.env.USERPROFILE;
  process.env.CODEX_HOME = join(fakeHome, ".codex");
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;

  const dbPath = join(root, "devflow.sqlite");
  const store = new Store(dbPath);
  const cfg = ConfigSchema.parse({
    storage_root: join(root, "state"),
    workspace_root: join(root, "worktrees"),
    server: {
      port: 10000 + Math.floor(Math.random() * 40000),
      human_origin: "http://localhost:14810",
    },
    host: { required: false },
  });
  const engine = new Engine(store, cfg);

  const cleanup = () => {
    try {
      store.close();
    } catch {}

    if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = oldCodexHome;
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;

    if (oldUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = oldUserProfile;

    try {
      rmSync(root, { recursive: true, force: true });
    } catch {}
  };

  return {
    root,
    repoRoot,
    fakeHome,
    store,
    engine,
    cleanup,
  };
}
