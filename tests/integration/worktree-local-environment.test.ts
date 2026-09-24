import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  reservePorts,
  releasePorts,
} from "../../scripts/dev/worktree-env.js";

describe("I03 — worktree 本地多实例环境隔离与冲突重试", () => {
  let baseTempDir: string;
  let worktree1Dir: string;
  let worktree2Dir: string;
  let sharedGitCommonDir: string;
  let occupiedServer: Server | null = null;

  beforeEach(() => {
    baseTempDir = join(
      tmpdir(),
      `devflow-i03-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    worktree1Dir = join(baseTempDir, "worktree-1");
    worktree2Dir = join(baseTempDir, "worktree-2");
    sharedGitCommonDir = join(baseTempDir, ".git");
    mkdirSync(worktree1Dir, { recursive: true });
    mkdirSync(worktree2Dir, { recursive: true });
    mkdirSync(sharedGitCommonDir, { recursive: true });
  });

  afterEach(async () => {
    if (occupiedServer) {
      await new Promise<void>((res) => occupiedServer?.close(() => res()));
      occupiedServer = null;
    }
    try {
      rmSync(baseTempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("两个临时 worktree 同时分配独立端口与独立状态目录，停止一个不影响另一个", async () => {
    const config1 = await reservePorts({
      worktreeRoot: worktree1Dir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-1",
    });

    const config2 = await reservePorts({
      worktreeRoot: worktree2Dir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-2",
    });

    try {
      // 1. 验证端口不重复
      expect(config1.ports.frontend).not.toBe(config2.ports.frontend);
      expect(config1.ports.backend).not.toBe(config2.ports.backend);
      expect(config1.ports.test).not.toBe(config2.ports.test);

      // 2. 验证状态目录与实例文件独立
      expect(config1.paths.state_dir).not.toBe(config2.paths.state_dir);
      expect(config1.paths.storage_root).not.toBe(config2.paths.storage_root);
      expect(existsSync(config1.paths.instance_json)).toBe(true);
      expect(existsSync(config2.paths.instance_json)).toBe(true);

      // 3. 停止并释放实例 1
      await releasePorts("inst-1", worktree1Dir, sharedGitCommonDir);

      // 验证实例 1 释放清理，而实例 2 保持完好
      expect(existsSync(config1.paths.instance_json)).toBe(false);
      expect(existsSync(config2.paths.instance_json)).toBe(true);
    } finally {
      await releasePorts("inst-2", worktree2Dir, sharedGitCommonDir);
    }
  });

  it("遇到端口预占时，自动跳过占用端口并完成有效分配", async () => {
    // 预先占用一个固定高位端口
    const candidatePort = 15201;
    occupiedServer = createServer();
    await new Promise<void>((res) => {
      occupiedServer?.listen(candidatePort, "127.0.0.1", () => res());
    });

    const config = await reservePorts({
      worktreeRoot: worktree1Dir,
      gitCommonDir: sharedGitCommonDir,
      instanceId: "inst-retry",
    });

    try {
      // 分配到的端口绝不应是预占的那个端口
      expect(config.ports.frontend).not.toBe(candidatePort);
      expect(config.ports.backend).not.toBe(candidatePort);
      expect(config.ports.test).not.toBe(candidatePort);
    } finally {
      await releasePorts("inst-retry", worktree1Dir, sharedGitCommonDir);
    }
  });
});
