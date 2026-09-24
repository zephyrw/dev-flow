import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  FileLock,
  readInstanceConfig,
  releasePorts,
  reservePorts,
} from "../../scripts/dev/worktree-env.js";
import { assertSafeTestDatabaseCleanup } from "../helpers/test-isolation.js";

describe("隔离环境复查回归", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  function setup() {
    const root = mkdtempSync(join(tmpdir(), "devflow-review-"));
    roots.push(root);
    const gitCommonDir = join(root, "registry");
    const worktreeRoot = join(root, "worktree");
    mkdirSync(worktreeRoot);
    return { root, gitCommonDir, worktreeRoot };
  }

  it("损坏登记不能被空登记覆盖", async () => {
    const s = setup();
    mkdirSync(join(s.gitCommonDir, "devflow-local"), { recursive: true });
    const file = join(s.gitCommonDir, "devflow-local", "ports.json");
    writeFileSync(file, '{"instances":');
    await expect(reservePorts(s)).rejects.toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"instances":');
  });

  it("同 ID 和重叠目录不能覆盖实例；自定义 dev 目录拒绝数据库清理", async () => {
    const s = setup();
    const first = await reservePorts({
      ...s,
      instanceId: "shared",
      runDir: join(s.root, "custom"),
    });
    const before = readFileSync(first.paths.instance_json, "utf8");
    await expect(reservePorts({ ...s, instanceId: "shared" })).rejects.toThrow(
      /已被登记/,
    );
    await expect(
      reservePorts({
        ...s,
        instanceId: "other",
        runDir: join(first.paths.run_dir, "child"),
      }),
    ).rejects.toThrow(/已被登记/);
    expect(readFileSync(first.paths.instance_json, "utf8")).toBe(before);
    expect(() =>
      assertSafeTestDatabaseCleanup(
        join(first.paths.state_dir, "devflow.sqlite"),
        first.paths.run_dir,
      ),
    ).toThrow(/非本次测试实例/);
    await expect(
      releasePorts(first.instance_id, s.worktreeRoot, {
        gitCommonDirOverride: s.gitCommonDir,
        runDir: join(s.root, "wrong"),
      }),
    ).rejects.toThrow(/不匹配/);
    expect(existsSync(first.paths.instance_json)).toBe(true);
    await releasePorts(first.instance_id, s.worktreeRoot, {
      gitCommonDirOverride: s.gitCommonDir,
      runDir: first.paths.run_dir,
    });
  });

  it("同进程第二次申请锁超时，不阻塞或移除第一持有者", async () => {
    const s = setup();
    const path = join(s.root, "allocation.lock");
    const first = new FileLock(path, 75);
    const token = await first.acquire();
    try {
      await expect(new FileLock(path, 75).acquire()).rejects.toThrow(/超时/);
      expect(
        JSON.parse(readFileSync(join(path, "owner.json"), "utf8")).token,
      ).toBe(token);
    } finally {
      first.release(token);
    }
    expect(existsSync(path)).toBe(false);
  });

  it("读取实例清单拒绝错误工作区与错误实例 ID", async () => {
    const s = setup();
    const instance = await reservePorts({ ...s, instanceId: "owned" });
    expect(
      readInstanceConfig(s.worktreeRoot, {
        runDir: instance.paths.run_dir,
        instanceId: "different",
      }),
    ).toBeNull();
    const other = join(s.root, "other");
    mkdirSync(other);
    expect(
      readInstanceConfig(other, { runDir: instance.paths.run_dir }),
    ).toBeNull();
    await releasePorts(instance.instance_id, s.worktreeRoot, s.gitCommonDir);
  });
});
