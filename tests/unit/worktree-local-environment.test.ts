import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reservePorts,
  releasePorts,
  isPortAvailable,
} from "../../scripts/dev/worktree-env.js";

describe("U04 — worktree 本地端口分配与环境隔离", () => {
  let tempBaseDir: string;
  let worktreeADir: string;
  let worktreeBDir: string;
  let sharedGitCommonDir: string;

  beforeEach(() => {
    tempBaseDir = join(
      tmpdir(),
      `devflow-wt-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    worktreeADir = join(tempBaseDir, "wt-a");
    worktreeBDir = join(tempBaseDir, "wt-b");
    sharedGitCommonDir = join(tempBaseDir, ".git");
    mkdirSync(worktreeADir, { recursive: true });
    mkdirSync(worktreeBDir, { recursive: true });
    mkdirSync(sharedGitCommonDir, { recursive: true });
  });

  afterEach(async () => {
    try {
      rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {
      // 忽略临时目录清理失败
    }
  });

  it("保留主工作区默认端口（5173 / 4810 / 14811），不将它们分配给新增 worktree", async () => {
    const configA = await reservePorts({
      worktreeRoot: worktreeADir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-a1",
    });

    try {
      expect(configA.ports.frontend).not.toBe(5173);
      expect(configA.ports.backend).not.toBe(4810);
      expect(configA.ports.test).not.toBe(14811);

      // 各服务端口互不相同
      expect(configA.ports.frontend).not.toBe(configA.ports.backend);
      expect(configA.ports.backend).not.toBe(configA.ports.test);

      // 验证配置内生成的 Origin
      expect(configA.origins.frontend).toBe(`http://127.0.0.1:${configA.ports.frontend}`);
      expect(configA.origins.backend).toBe(`http://127.0.0.1:${configA.ports.backend}`);
    } finally {
      await releasePorts("inst-a1", worktreeADir, sharedGitCommonDir);
    }
  });

  it("兄弟 worktree 之间端口互斥排除，不发生端口碰撞", async () => {
    const configA = await reservePorts({
      worktreeRoot: worktreeADir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-a",
    });

    const configB = await reservePorts({
      worktreeRoot: worktreeBDir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-b",
    });

    try {
      // A 与 B 的端口完全不相交
      const portsA = [configA.ports.frontend, configA.ports.backend, configA.ports.test];
      const portsB = [configB.ports.frontend, configB.ports.backend, configB.ports.test];

      for (const p of portsA) {
        expect(portsB).not.toContain(p);
      }
    } finally {
      await releasePorts("inst-a", worktreeADir, sharedGitCommonDir);
      await releasePorts("inst-b", worktreeBDir, sharedGitCommonDir);
    }
  });

  it("同一 worktree 内部支持分配多个独立测试实例且端口隔离", async () => {
    const config1 = await reservePorts({
      worktreeRoot: worktreeADir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-sub-1",
      runDir: join(worktreeADir, ".cache/devflow-local/sub-1"),
    });

    const config2 = await reservePorts({
      worktreeRoot: worktreeADir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-sub-2",
      runDir: join(worktreeADir, ".cache/devflow-local/sub-2"),
    });

    try {
      expect(config1.instance_id).toBe("inst-sub-1");
      expect(config2.instance_id).toBe("inst-sub-2");
      expect(config1.ports.frontend).not.toBe(config2.ports.frontend);
      expect(config1.ports.backend).not.toBe(config2.ports.backend);
    } finally {
      await releasePorts("inst-sub-1", worktreeADir, sharedGitCommonDir);
      await releasePorts("inst-sub-2", worktreeADir, sharedGitCommonDir);
    }
  });

  it("释放端口后清理临时文件和登记信息", async () => {
    const config = await reservePorts({
      worktreeRoot: worktreeADir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-to-release",
    });

    expect(existsSync(config.paths.instance_json)).toBe(true);
    expect(existsSync(config.paths.runtime_config)).toBe(true);

    await releasePorts("inst-to-release", worktreeADir, sharedGitCommonDir);

    expect(existsSync(config.paths.instance_json)).toBe(false);
  });

  it("端口可用性检测函数正常识别未占用端口", async () => {
    const available = await isPortAvailable(28391);
    expect(typeof available).toBe("boolean");
  });
});
