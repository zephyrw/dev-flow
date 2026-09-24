import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import yaml from "yaml";

export interface PortRegistryItem {
  instance_id: string;
  worktree_path: string;
  instance_type: "dev" | "test";
  ports: {
    frontend: number;
    backend: number;
    test: number;
  };
  run_dir: string;
  manifest_path: string;
  allocated_pid: number;
  service_pid?: number | null;
  created_at: string;
}

export interface WorktreeInstanceConfig {
  instance_id: string;
  instance_type: "dev" | "test";
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

export interface ReservePortsOptions {
  instanceType?: "dev" | "test";
  instanceId?: string;
  targetId?: string;
  invocationId?: string;
  worktreeRoot?: string;
  gitCommonDir?: string;
  runDir?: string;
  reservedPorts?: number[];
}

function normalizePath(p: string): string {
  const resolved = resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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

export function listAllWorktrees(cwd: string = process.cwd()): string[] {
  try {
    const raw = execSync("git worktree list --porcelain", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const paths: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("worktree ")) {
        const wtPath = line.slice("worktree ".length).trim();
        if (wtPath) {
          paths.push(resolve(wtPath));
        }
      }
    }
    return paths.length > 0 ? paths : [getWorktreeRoot(cwd)];
  } catch {
    return [getWorktreeRoot(cwd)];
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

function isPidAlive(pid: number): boolean {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === "EPERM";
  }
}

function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 6)}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  try {
    // Windows 下如果目标已存在，renameSync 可能失败，但现代 Node 在同卷移动时大多数支持覆盖
    // 为保险起见，若失败先重试
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
    if (existsSync(tmp)) unlinkSync(tmp);
  } catch {
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  }
}

export class FileLock {
  constructor(
    private lockDir: string,
    private timeoutMs: number = 15000,
  ) {}

  async acquire(): Promise<string> {
    const start = Date.now();
    const token = randomUUID();
    const parentDir = dirname(this.lockDir);
    mkdirSync(parentDir, { recursive: true });
    const ownerFile = join(this.lockDir, "owner.json");

    while (true) {
      try {
        mkdirSync(this.lockDir);
        // 成功建立锁目录，写入 owner 信息
        writeFileSync(
          ownerFile,
          JSON.stringify({
            token,
            pid: process.pid,
            created_at: Date.now(),
          }),
          "utf-8",
        );
        return token;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;

        // 检查陈旧锁
        if (existsSync(ownerFile)) {
          try {
            const raw = readFileSync(ownerFile, "utf-8");
            const owner = JSON.parse(raw);
            const age = Date.now() - (owner.created_at || 0);

            if (age > this.timeoutMs) {
              const alive = owner.pid ? isPidAlive(owner.pid) : false;
              if (!alive) {
                // 拥有者进程已死亡，属于陈旧死锁，安全回收
                try {
                  unlinkSync(ownerFile);
                  rmdirSync(this.lockDir);
                } catch {
                  // 可能已被并发竞争者删除
                }
              }
            }
          } catch {
            // owner.json 损坏或正在写入
          }
        }

        if (Date.now() - start > this.timeoutMs) {
          throw new Error(`获取分配锁超时（已等待 ${this.timeoutMs}ms）: ${this.lockDir}`);
        }

        // 异步非阻塞等待 50ms 让出事件循环
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
  }

  release(token: string): void {
    const ownerFile = join(this.lockDir, "owner.json");
    try {
      if (existsSync(ownerFile)) {
        const raw = readFileSync(ownerFile, "utf-8");
        const owner = JSON.parse(raw);
        if (owner.token !== token) {
          // 不是自己持有的锁，严禁释放
          return;
        }
        unlinkSync(ownerFile);
      }
      rmdirSync(this.lockDir);
    } catch {
      // 忽略清理失败
    }
  }
}

function forbiddenAuthRoots(): string[] {
  const home = homedir();
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  return [
    join(home, ".codex"),
    join(home, ".agy"),
    join(home, ".claude"),
    join(home, ".cursor"),
    join(home, ".kimi"),
    ...(local ? [join(local, "agy"), join(local, "cursor-agent"), join(local, "Codex")] : []),
    ...(roaming ? [join(roaming, "Codex"), join(roaming, "agy")] : []),
  ].map((p) => normalizePath(p));
}

export function validateSafeRunDir(runDir: string, worktreeRoot: string): void {
  const normalized = normalizePath(runDir);
  const segments = normalized.split(/[\\/]/);
  if (segments.includes("node_modules")) {
    throw new Error(`非法的运行目录: 不能指向 node_modules (${runDir})`);
  }

  // 检查主服务数据目录（例如生产的 .devflow）
  const productionDataRoot = normalizePath(join(worktreeRoot, ".devflow"));
  if (normalized === productionDataRoot || normalized.startsWith(productionDataRoot + sep)) {
    throw new Error(`非法的运行目录: 不能覆盖主服务数据目录 .devflow (${runDir})`);
  }

  // 检查工具凭据目录
  for (const forbidden of forbiddenAuthRoots()) {
    if (normalized === forbidden || normalized.startsWith(forbidden + sep)) {
      throw new Error(`非法的运行目录: 不能指向真实工具认证目录 (${runDir})`);
    }
  }
}

function collectWorktreeReservedPorts(worktreeRoots: string[]): number[] {
  const reserved: number[] = [];
  for (const wt of worktreeRoots) {
    // 1. 尝试读取 devflow.runtime.yaml
    const runtimeYamlPath = join(wt, "devflow.runtime.yaml");
    if (existsSync(runtimeYamlPath)) {
      try {
        const doc = yaml.parse(readFileSync(runtimeYamlPath, "utf-8"));
        if (typeof doc?.server?.port === "number") reserved.push(doc.server.port);
      } catch {}
    }
    // 2. 尝试读取 devflow.config.json
    const configJsonPath = join(wt, "devflow.config.json");
    if (existsSync(configJsonPath)) {
      try {
        const doc = JSON.parse(readFileSync(configJsonPath, "utf-8"));
        if (typeof doc?.server?.port === "number") reserved.push(doc.server.port);
        if (typeof doc?.ports?.backend === "number") reserved.push(doc.ports.backend);
        if (typeof doc?.ports?.frontend === "number") reserved.push(doc.ports.frontend);
      } catch {}
    }
    // 3. 尝试读取 current-dev.json
    const currentDevJsonPath = join(wt, ".cache", "devflow-local", "current-dev.json");
    if (existsSync(currentDevJsonPath)) {
      try {
        const doc = JSON.parse(readFileSync(currentDevJsonPath, "utf-8"));
        if (typeof doc?.ports?.backend === "number") reserved.push(doc.ports.backend);
        if (typeof doc?.ports?.frontend === "number") reserved.push(doc.ports.frontend);
        if (typeof doc?.ports?.test === "number") reserved.push(doc.ports.test);
      } catch {}
    }
  }
  return reserved;
}

export async function reservePorts(
  options?: ReservePortsOptions,
): Promise<WorktreeInstanceConfig> {
  const root = options?.worktreeRoot ? resolve(options.worktreeRoot) : getWorktreeRoot();
  const gitCommonDir = options?.gitCommonDir ? resolve(options.gitCommonDir) : getGitCommonDir(root);
  const localDir = join(gitCommonDir, "devflow-local");
  const lockDir = join(localDir, "allocation.lock");
  const portsFile = join(localDir, "ports.json");

  mkdirSync(localDir, { recursive: true });

  const lock = new FileLock(lockDir);
  const lockToken = await lock.acquire();

  let allocatedInstanceId: string | null = null;
  let registry: { instances: PortRegistryItem[] } = { instances: [] };

  try {
    if (existsSync(portsFile)) {
      try {
        const raw = readFileSync(portsFile, "utf-8");
        registry = JSON.parse(raw);
        if (!Array.isArray(registry.instances)) {
          registry = { instances: [] };
        }
      } catch (parseErr) {
        // ports.json 损坏，备份原文件
        const corruptedPath = `${portsFile}.corrupted.${Date.now()}`;
        try {
          copyFileSync(portsFile, corruptedPath);
          console.warn(`[worktree-env] 警告: ports.json 已损坏，已备份至 ${corruptedPath}`);
        } catch {}
        registry = { instances: [] };
      }
    }

    // 建立端口排除集合（F12）
    const excludedPorts = new Set<number>([
      5173, // 主工作区前端默认端口
      4810, // 主工作区后端默认端口
      14811, // 主工作区测试默认端口
    ]);

    // 主工作区及所有兄弟 worktree 的配置文件中声明的自定义保留端口
    const allWorktrees = listAllWorktrees(root);
    for (const p of collectWorktreeReservedPorts(allWorktrees)) {
      excludedPorts.add(p);
    }

    // 调用者显式提供的保留端口
    if (options?.reservedPorts) {
      for (const p of options.reservedPorts) {
        excludedPorts.add(p);
      }
    }

    // 已经登记的活跃端口
    for (const inst of registry.instances) {
      if (inst.ports) {
        excludedPorts.add(inst.ports.frontend);
        excludedPorts.add(inst.ports.backend);
        excludedPorts.add(inst.ports.test);
      }
    }

    // 分配可用端口（在候选范围内）
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

    const instanceType = options?.instanceType || "dev";
    let instanceId: string;
    let runDir: string;

    if (options?.runDir) {
      runDir = resolve(options.runDir);
      instanceId =
        options.instanceId ||
        `${instanceType}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    } else {
      if (instanceType === "test") {
        const targetId = options?.targetId || "e2e";
        const invocationId =
          options?.invocationId ||
          `inv_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        instanceId = options?.instanceId || `${targetId}_${invocationId}`;
        runDir = join(root, ".cache", "devflow-local", "tests", targetId, invocationId);
      } else {
        instanceId =
          options?.instanceId ||
          `dev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        runDir = join(root, ".cache", "devflow-local", "dev", instanceId);
      }
    }

    validateSafeRunDir(runDir, root);
    allocatedInstanceId = instanceId;

    const stateDir = join(runDir, "state");
    const storageRoot = stateDir;
    const runtimeConfigFile = join(runDir, "devflow.runtime.yaml");
    const instanceJsonFile = join(runDir, "instance.json");

    mkdirSync(runDir, { recursive: true });
    mkdirSync(stateDir, { recursive: true });

    const instanceConfig: WorktreeInstanceConfig = {
      instance_id: instanceId,
      instance_type: instanceType,
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

    // 登记主键为 (normalized worktree + instanceId)
    const normRoot = normalizePath(root);
    registry.instances = registry.instances.filter((item) => {
      return !(normalizePath(item.worktree_path) === normRoot && item.instance_id === instanceId);
    });

    registry.instances.push({
      instance_id: instanceId,
      worktree_path: root,
      instance_type: instanceType,
      ports: instanceConfig.ports,
      run_dir: runDir,
      manifest_path: instanceJsonFile,
      allocated_pid: process.pid,
      created_at: instanceConfig.created_at,
    });

    // 原子写入 ports.json
    atomicWriteJson(portsFile, registry);

    // 写入当前实例文件
    writeFileSync(
      instanceJsonFile,
      JSON.stringify(instanceConfig, null, 2),
      "utf-8",
    );

    // 如果是 dev 实例，同时在 .cache/devflow-local/current-dev.json 建立指向
    if (instanceType === "dev") {
      const currentDevJson = join(root, ".cache", "devflow-local", "current-dev.json");
      writeFileSync(
        currentDevJson,
        JSON.stringify(instanceConfig, null, 2),
        "utf-8",
      );
    }

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
  } catch (err) {
    // 发生异常时回滚本次新增的登记
    if (allocatedInstanceId) {
      const normRoot = normalizePath(root);
      registry.instances = registry.instances.filter((item) => {
        return !(normalizePath(item.worktree_path) === normRoot && item.instance_id === allocatedInstanceId);
      });
      try {
        atomicWriteJson(portsFile, registry);
      } catch {}
    }
    throw err;
  } finally {
    lock.release(lockToken);
  }
}

export async function releasePorts(
  instanceId: string,
  cwd: string = process.cwd(),
  options?: { gitCommonDirOverride?: string; runDir?: string } | string,
): Promise<void> {
  const root = getWorktreeRoot(cwd);
  const gitCommonDir =
    typeof options === "string"
      ? resolve(options)
      : options?.gitCommonDirOverride
        ? resolve(options.gitCommonDirOverride)
        : getGitCommonDir(root);
  const localDir = join(gitCommonDir, "devflow-local");
  const lockDir = join(localDir, "allocation.lock");
  const portsFile = join(localDir, "ports.json");

  if (!existsSync(portsFile)) return;

  const lock = new FileLock(lockDir);
  const lockToken = await lock.acquire();

  try {
    const raw = readFileSync(portsFile, "utf-8");
    const registry: { instances: PortRegistryItem[] } = JSON.parse(raw);
    const normRoot = normalizePath(root);

    // 找到当前 worktree 下归属于该 instanceId 的条目
    const target = registry.instances.find(
      (item) => normalizePath(item.worktree_path) === normRoot && item.instance_id === instanceId,
    );

    if (!target) {
      // 不是当前 worktree 的实例或已释放，安全返回
      return;
    }

    registry.instances = registry.instances.filter(
      (item) => !(normalizePath(item.worktree_path) === normRoot && item.instance_id === instanceId),
    );

    atomicWriteJson(portsFile, registry);

    // 清理该条目的 manifest 文件
    if (target.manifest_path && existsSync(target.manifest_path)) {
      try {
        unlinkSync(target.manifest_path);
      } catch {}
    }

    // 如果当前存在 current-dev.json 且属于该实例，清理它
    const currentDevJson = join(root, ".cache", "devflow-local", "current-dev.json");
    if (existsSync(currentDevJson)) {
      try {
        const cur = JSON.parse(readFileSync(currentDevJson, "utf-8"));
        if (cur.instance_id === instanceId) {
          unlinkSync(currentDevJson);
        }
      } catch {}
    }

    // 兼容旧的单一 instance.json 位置
    const legacyInstanceJson = join(root, ".cache", "devflow-local", "instance.json");
    if (existsSync(legacyInstanceJson)) {
      try {
        const cur = JSON.parse(readFileSync(legacyInstanceJson, "utf-8"));
        if (cur.instance_id === instanceId) {
          unlinkSync(legacyInstanceJson);
        }
      } catch {}
    }
  } finally {
    lock.release(lockToken);
  }
}

export function readInstanceConfig(
  cwd: string = process.cwd(),
  options?: { runDir?: string; instanceId?: string },
): WorktreeInstanceConfig | null {
  const root = getWorktreeRoot(cwd);

  if (options?.runDir) {
    const customJson = join(resolve(options.runDir), "instance.json");
    if (existsSync(customJson)) {
      try {
        return JSON.parse(readFileSync(customJson, "utf-8"));
      } catch {
        return null;
      }
    }
  }

  // 1. 优先读取 current-dev.json
  const currentDevJson = join(root, ".cache", "devflow-local", "current-dev.json");
  if (existsSync(currentDevJson)) {
    try {
      return JSON.parse(readFileSync(currentDevJson, "utf-8"));
    } catch {}
  }

  // 2. 检查 dev 目录下最新的实例
  const devDir = join(root, ".cache", "devflow-local", "dev");
  if (existsSync(devDir)) {
    try {
      const dirs = readdirSync(devDir);
      for (const d of dirs.reverse()) {
        const cand = join(devDir, d, "instance.json");
        if (existsSync(cand)) {
          return JSON.parse(readFileSync(cand, "utf-8"));
        }
      }
    } catch {}
  }

  // 3. 兼容旧的单一 instance.json
  const legacyInstanceJson = join(root, ".cache", "devflow-local", "instance.json");
  if (existsSync(legacyInstanceJson)) {
    try {
      return JSON.parse(readFileSync(legacyInstanceJson, "utf-8"));
    } catch {
      return null;
    }
  }

  return null;
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
