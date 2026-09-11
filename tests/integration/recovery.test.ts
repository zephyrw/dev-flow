import { it, expect } from "vitest";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { setup, repository, project } from "../helpers.js";
import { git } from "../../packages/git/src/git.js";
import { ProcessManager } from "../../packages/process/src/manager.js";
it("IT-14 exact multi-repository commit resumes after second branch update fails", async () => {
  const s = setup(),
    a = await repository(s.root, "a"),
    b = await repository(s.root, "b");
  const p = project(a.repo);
  p.repositories.push({ id: "second", path: b.repo });
  await s.engine.git.prepare(p, "wf-multi", "existing_workspace", {
    main: a.baseline,
    second: b.baseline,
  });
  writeFileSync(join(a.repo, "app.txt"), "after\n");
  writeFileSync(join(b.repo, "app.txt"), "after\n");
  const snapshot = await s.engine.git.snapshot("wf-multi", 0);
  const lock = join(b.repo, ".git/refs/heads/task/fixture.lock");
  writeFileSync(lock, "test lock");
  try {
    await expect(
      s.engine.git.commit(snapshot, p, "fix: 两仓局部修改"),
    ).rejects.toThrow();
    const first = await git(a.repo, ["rev-parse", "HEAD"]);
    expect(first).not.toBe(a.baseline);
    expect(await git(b.repo, ["rev-parse", "HEAD"])).toBe(b.baseline);
    unlinkSync(lock);
    await git(a.repo, ["read-tree", a.baseline]);
    expect(await s.engine.git.matches(snapshot)).toBe(true);
    const result = await s.engine.git.commit(
      snapshot,
      p,
      "ignored retry message",
    );
    expect(result).toHaveLength(2);
    expect(await git(a.repo, ["rev-parse", "HEAD"])).toBe(first);
    for (const r of [a, b]) {
      expect(await git(r.repo, ["status", "--porcelain"])).toBe("");
      expect(await git(r.repo, ["log", "-1", "--format=%s"])).toBe(
        "fix: 两仓局部修改",
      );
    }
  } finally {
    s.store.close();
  }
}, 120000);
it("IT-15 named job reconciliation distinguishes active process trees from terminated ones", async () => {
  const s = setup(),
    host = resolve(
      "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
    ),
    manager = new ProcessManager(host, true),
    key = "recovery-" + crypto.randomUUID();
  const process = manager.start({
    id: key,
    executable: globalThis.process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    cwd: s.root,
    env: {},
    timeout_ms: 15000,
  });
  try {
    await new Promise<void>((r) => process.on("host", () => r()));
    const query = () =>
      JSON.parse(
        execFileSync(host, ["job-status", key], {
          encoding: "utf8",
          windowsHide: true,
          env: {
            ...globalThis.process.env,
            DOTNET_ROOT: resolve(".cache/dotnet"),
          },
        }),
      );
    expect(query().alive).toBe(true);
    await process.stop();
    expect(query()).toMatchObject({ alive: false, active_processes: 0 });
  } finally {
    await manager.close();
    s.store.close();
  }
}, 20000);
