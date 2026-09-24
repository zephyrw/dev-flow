import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import yaml from "yaml";

export interface PortRegistryItem {
  instance_id: string;
  worktree_path: string;
  ports: {
    frontend: number;
    backend: number;
    test: number;
  };
  pid: number;
  created_at: string;
}

export interface WorktreeInstanceConfig {
  instance_id: string;
  worktree_path: string;
  ports: {
    frontend: number;
    backend: number;
    test: number;
  };
  origins: {
    frontend: string;
    backend: string;
  };
  paths: {
    run_dir: string;
    state_dir: string;
    storage_root: string;
    runtime_config: string;
    instance_json: string;
  };
  created_at: string;
}

export function getGitCommonDir(cwd: string = process.cwd()): string {
  try {
    const raw = execSync("git rev-parse --git-common-dir", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return resolve(cwd, raw);
  } catch {
    return resolve(cwd, ".git");
  }
}

export function getWorktreeRoot(cwd: string = process.cwd()): string {
  try {
    const raw = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return resolve(raw);
  } catch {
    return resolve(cwd);
  }
}

export async function isPortAvailable(
  port: number,
  host: string = "127.0.0.1",
): Promise<boolean> {
  return new Promise((res) => {
    const server = createServer();
    server.unref();
    server.once("error", () => res(false));
    server.once("listening", () => {
      server.close(() => res(true));
    });
    server.listen(port, host);
  });
}

class FileLock {
  constructor(private lockDir: string, private timeoutMs: number = 10000) {}

  acquire(): void {
    const start = Date.now();
    mkdirSync(dirname(this.lockDir), { recursive: true });

    while (true) {
      try {
        mkdirSync(this.lockDir);
        return;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;
        if (Date.now() - start > this.timeoutMs) {
          // 锁超时，尝试清除陈旧锁
          try {
            rmdirSync(this.lockDir);
            mkdirSync(this.lockDir);
            return;
          } catch {
            throw new Error(`获取分配锁超时: ${this.lockDir}`);
          }
        }
        // 同步等待一小段时间
        const sleepEnd = Date.now() + 50;
        while (Date.now() < sleepEnd) {
          // busy wait 50ms
        }
      }
    }
  }

  release(): void {
    try {
      rmdirSync(this.lockDir);
    } catch {
      // 忽略锁已被释放错误
    }
  }
}

export async function reservePorts(options?: {
  instanceId?: string;
  worktreeRoot?: string;
  gitCommonDir?: string;
  runDir?: string;
}): Promise<WorktreeInstanceConfig> {
  const root = options?.worktreeRoot ? resolve(options.worktreeRoot) : getWorktreeRoot();
  const gitCommonDir = options?.gitCommonDir ? resolve(options.gitCommonDir) : getGitCommonDir(root);
  const localDir = join(gitCommonDir, "devflow-local");
  const lockDir = join(localDir, "allocation.lock");
  const portsFile = join(localDir, "ports.json");

  mkdirSync(localDir, { recursive: true });

  const lock = new FileLock(lockDir);
  lock.acquire();

  try {
    let registry: { instances: PortRegistryItem[] } = { instances: [] };
    if (existsSync(portsFile)) {
      try {
        registry = JSON.parse(readFileSync(portsFile, "utf-8"));
      } catch {
        registry = { instances: [] };
      }
    }

    // 建立排除集合
    const excludedPorts = new Set<number>([
      5173, // 主工作区前端默认端口
      4810, // 主工作区后端默认端口
      14811, // 主工作区测试默认端口
    ]);

    for (const inst of registry.instances) {
      if (inst.ports) {
        excludedPorts.add(inst.ports.frontend);
        excludedPorts.add(inst.ports.backend);
        excludedPorts.add(inst.ports.test);
      }
    }

    // 分配可用端口
    const findAvailablePort = async (
      min: number,
      max: number,
    ): Promise<number> => {
      for (let p = min; p <= max; p++) {
        if (!excludedPorts.has(p)) {
          const ok = await isPortAvailable(p);
          if (ok) {
            excludedPorts.add(p);
            return p;
          }
        }
      }
      throw new Error(`在范围 ${min}-${max} 中未找到可用端口`);
    };

    const frontendPort = await findAvailablePort(15173, 15300);
    const backendPort = await findAvailablePort(14810, 14950);
    const testPort = await findAvailablePort(24811, 24950);

    const instanceId =
      options?.instanceId ||
      `inst_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const runDir = options?.runDir
      ? resolve(options.runDir)
      : join(root, ".cache", "devflow-local");
    const stateDir = join(runDir, "state");
    const storageRoot = stateDir;
    const runtimeConfigFile = join(runDir, "devflow.runtime.yaml");
    const instanceJsonFile = join(runDir, "instance.json");

    mkdirSync(runDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    const instanceConfig: WorktreeInstanceConfig = {
      instance_id: instanceId,
      worktree_path: root,
      ports: {
        frontend: frontendPort,
        backend: backendPort,
        test: testPort,
      },
      origins: {
        frontend: `http://127.0.0.1:${frontendPort}`,
        backend: `http://127.0.0.1:${backendPort}`,
      },
      paths: {
        run_dir: runDir,
        state_dir: stateDir,
        storage_root: storageRoot,
        runtime_config: runtimeConfigFile,
        instance_json: instanceJsonFile,
      },
      created_at: new Date().toISOString(),
    };

    // 写入 ports.json 登记
    registry.instances = registry.instances.filter(
      (item) => item.instance_id !== instanceId,
    );
    registry.instances.push({
      instance_id: instanceId,
      worktree_path: root,
      ports: instanceConfig.ports,
      pid: process.pid,
      created_at: instanceConfig.created_at,
    });
    writeFileSync(portsFile, JSON.stringify(registry, null, 2), "utf-8");

    // 写入当前实例文件
    writeFileSync(
      instanceJsonFile,
      JSON.stringify(instanceConfig, null, 2),
      "utf-8",
    );

    // 生成当前实例的 devflow.runtime.yaml
    const runtimeConfigYaml = {
      server: {
        port: backendPort,
        host: "127.0.0.1",
        human_origin: `http://127.0.0.1:${backendPort}`,
      },
      storage_root: storageRoot,
      workspace_root: root,
    };
    writeFileSync(
      runtimeConfigFile,
      yaml.stringify(runtimeConfigYaml),
      "utf-8",
    );

    return instanceConfig;
  } finally {
    lock.release();
  }
}

export async function releasePorts(
  instanceId: string,
  cwd: string = process.cwd(),
  gitCommonDirOverride?: string,
): Promise<void> {
  const root = getWorktreeRoot(cwd);
  const gitCommonDir = gitCommonDirOverride ? resolve(gitCommonDirOverride) : getGitCommonDir(root);
  const localDir = join(gitCommonDir, "devflow-local");
  const lockDir = join(localDir, "allocation.lock");
  const portsFile = join(localDir, "ports.json");

  if (!existsSync(portsFile)) return;

  const lock = new FileLock(lockDir);
  lock.acquire();

  try {
    const raw = readFileSync(portsFile, "utf-8");
    const registry: { instances: PortRegistryItem[] } = JSON.parse(raw);
    registry.instances = registry.instances.filter(
      (item) => item.instance_id !== instanceId,
    );
    writeFileSync(portsFile, JSON.stringify(registry, null, 2), "utf-8");

    // 清理本地 instance.json
    const runDir = join(root, ".cache", "devflow-local");
    const instanceJson = join(runDir, "instance.json");
    if (existsSync(instanceJson)) {
      try {
        unlinkSync(instanceJson);
      } catch {
        // 忽略删除失败
      }
    }
  } finally {
    lock.release();
  }
}

export function readInstanceConfig(
  cwd: string = process.cwd(),
): WorktreeInstanceConfig | null {
  const root = getWorktreeRoot(cwd);
  const instanceJson = join(root, ".cache", "devflow-local", "instance.json");
  if (!existsSync(instanceJson)) return null;
  try {
    return JSON.parse(readFileSync(instanceJson, "utf-8"));
  } catch {
    return null;
  }
}

// CLI 执行入口
if (process.argv[1] && process.argv[1].endsWith("worktree-env.ts")) {
  const command = process.argv[2] || "show";
  if (command === "reserve") {
    reservePorts().then((config) => {
      console.log(JSON.stringify(config, null, 2));
    });
  } else if (command === "show") {
    const config = readInstanceConfig();
    if (config) {
      console.log(JSON.stringify(config, null, 2));
    } else {
      console.log("当前 worktree 未检测到已分配的实例配置");
    }
  } else if (command === "release") {
    const config = readInstanceConfig();
    if (config) {
      releasePorts(config.instance_id).then(() => {
        console.log(`已成功释放实例 ${config.instance_id} 的端口登记`);
      });
    } else {
      console.log("当前 worktree 没有需要释放的配置");
    }
  }
}
