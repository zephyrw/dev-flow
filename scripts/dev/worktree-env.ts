import { execFileSync, execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  join,
  resolve,
  sep,
  relative,
  isAbsolute,
} from "node:path";
import yaml from "yaml";
import {
  ConfigSchema,
  loadConfig,
} from "../../packages/contracts/src/config.js";

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

function physicalPath(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  return parent === path ? path : join(physicalPath(parent), basename(path));
}

function overlaps(a: string, b: string) {
  const left = normalizePath(physicalPath(resolve(a)));
  const right = normalizePath(physicalPath(resolve(b)));
  return (
    left === right ||
    left.startsWith(right + sep) ||
    right.startsWith(left + sep)
  );
}

function readRegistry(file: string): { instances: PortRegistryItem[] } {
  const registry = JSON.parse(readFileSync(file, "utf8"));
  if (
    !registry ||
    !Array.isArray(registry.instances) ||
    registry.instances.some(
      (item: PortRegistryItem) =>
        !item ||
        typeof item.instance_id !== "string" ||
        typeof item.worktree_path !== "string" ||
        typeof item.run_dir !== "string" ||
        typeof item.manifest_path !== "string" ||
        !item.ports ||
        ![item.ports.frontend, item.ports.backend, item.ports.test].every(
          (port) => Number.isInteger(port) && port > 0 && port <= 65535,
        ),
    )
  )
    throw new Error("端口登记损坏；保留原文件，请先恢复登记后重试");
  return registry;
}

function readManifest(
  file: string,
  root: string,
  instanceId?: string,
): WorktreeInstanceConfig | null {
  try {
    const config = JSON.parse(
      readFileSync(file, "utf8"),
    ) as WorktreeInstanceConfig;
    if (
      !config ||
      normalizePath(config.worktree_path) !== normalizePath(root) ||
      (instanceId && config.instance_id !== instanceId) ||
      !["dev", "test"].includes(config.instance_type)
    )
      return null;
    validateSafeRunDir(config.paths.run_dir, root);
    if (
      normalizePath(config.paths.instance_json) !==
        normalizePath(join(config.paths.run_dir, "instance.json")) ||
      normalizePath(config.paths.runtime_config) !==
        normalizePath(join(config.paths.run_dir, "devflow.runtime.yaml")) ||
      normalizePath(config.paths.state_dir) !==
        normalizePath(join(config.paths.run_dir, "state")) ||
      normalizePath(config.paths.storage_root) !==
        normalizePath(config.paths.state_dir) ||
      !existsSync(config.paths.runtime_config)
    )
      return null;
    const ports = [
      config.ports.frontend,
      config.ports.backend,
      config.ports.test,
    ];
    if (
      !ports.every(
        (port) => Number.isInteger(port) && port > 0 && port <= 65535,
      ) ||
      new Set(ports).size !== 3 ||
      config.origins.frontend !== `http://127.0.0.1:${config.ports.frontend}` ||
      config.origins.backend !== `http://127.0.0.1:${config.ports.backend}`
    )
      return null;
    // A copied current-dev pointer must still match the authoritative manifest.
    if (normalizePath(file) !== normalizePath(config.paths.instance_json)) {
      const actual = readManifest(
        config.paths.instance_json,
        root,
        config.instance_id,
      );
      if (!actual || JSON.stringify(actual) !== JSON.stringify(config))
        return null;
    }
    return config;
  } catch {
    return null;
  }
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

function atomicWriteJson(filePath: string, data: unknown): void {
  atomicWriteText(filePath, JSON.stringify(data, null, 2));
}

function atomicWriteText(filePath: string, text: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${randomUUID()}`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, text, "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, filePath);
  } finally {
    if (existsSync(tmp)) unlinkSync(tmp);
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
        // If initialization fails, remove only this newly-created empty lock.
        try {
          writeFileSync(
            ownerFile,
            JSON.stringify({
              token,
              pid: process.pid,
              created_at: Date.now(),
            }),
            "utf-8",
          );
        } catch (error) {
          if (existsSync(ownerFile)) unlinkSync(ownerFile);
          rmdirSync(this.lockDir);
          throw error;
        }
        return token;
      } catch (err: any) {
        if (err.code !== "EEXIST") throw err;

        // Never unlink a lock based on an earlier owner read: another waiter
        // could already have acquired it. Leave abandoned locks for recovery.
        if (Date.now() - start > this.timeoutMs) {
          throw new Error(
            `获取分配锁超时（已等待 ${this.timeoutMs}ms）: ${this.lockDir}`,
          );
        }

        // 异步非阻塞等待 50ms 让出事件循环
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
    }
  }

  release(token: string): void {
    const ownerFile = join(this.lockDir, "owner.json");
    try {
      if (!existsSync(ownerFile)) return;
      {
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
    ...(local
      ? [join(local, "agy"), join(local, "cursor-agent"), join(local, "Codex")]
      : []),
    ...(roaming ? [join(roaming, "Codex"), join(roaming, "agy")] : []),
  ].map((p) => normalizePath(p));
}

export function validateSafeRunDir(runDir: string, worktreeRoot: string): void {
  const normalized = normalizePath(physicalPath(resolve(runDir)));
  const segments = normalized.split(/[\\/]/);
  if (
    segments.includes("node_modules") ||
    segments.includes(".git")
  ) {
    throw new Error(`非法的运行目录: 不能指向 node_modules (${runDir})`);
  }

  // 检查主服务数据目录（例如生产的 .devflow）
  const productionDataRoot = normalizePath(join(worktreeRoot, ".devflow"));
  if (
    normalized === productionDataRoot ||
    normalized.startsWith(productionDataRoot + sep)
  ) {
    throw new Error(
      `非法的运行目录: 不能覆盖主服务数据目录 .devflow (${runDir})`,
    );
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
    const baseConfig = join(wt, "devflow.yaml");
    if (existsSync(baseConfig)) {
      const config = loadConfig(baseConfig);
      reserved.push(config.server.port);
    }
    // 1. 尝试读取 devflow.runtime.yaml
    const runtimeYamlPath = join(wt, "devflow.runtime.yaml");
    if (existsSync(runtimeYamlPath)) {
      try {
        const doc = yaml.parse(readFileSync(runtimeYamlPath, "utf-8"));
        if (typeof doc?.server?.port === "number")
          reserved.push(doc.server.port);
      } catch {}
    }
    // 2. 尝试读取 devflow.config.json
    const configJsonPath = join(wt, "devflow.config.json");
    if (existsSync(configJsonPath)) {
      try {
        const doc = JSON.parse(readFileSync(configJsonPath, "utf-8"));
        if (typeof doc?.server?.port === "number")
          reserved.push(doc.server.port);
        if (typeof doc?.ports?.backend === "number")
          reserved.push(doc.ports.backend);
        if (typeof doc?.ports?.frontend === "number")
          reserved.push(doc.ports.frontend);
      } catch {}
    }
    // 3. 尝试读取 current-dev.json
    const currentDevJsonPath = join(
      wt,
      ".cache",
      "devflow-local",
      "current-dev.json",
    );
    if (existsSync(currentDevJsonPath)) {
      try {
        const doc = JSON.parse(readFileSync(currentDevJsonPath, "utf-8"));
        if (typeof doc?.ports?.backend === "number")
          reserved.push(doc.ports.backend);
        if (typeof doc?.ports?.frontend === "number")
          reserved.push(doc.ports.frontend);
        if (typeof doc?.ports?.test === "number") reserved.push(doc.ports.test);
      } catch {}
    }
  }
  return reserved;
}

export async function reservePorts(
  options?: ReservePortsOptions,
): Promise<WorktreeInstanceConfig> {
  const root = options?.worktreeRoot
    ? resolve(options.worktreeRoot)
    : getWorktreeRoot();
  const gitCommonDir = options?.gitCommonDir
    ? resolve(options.gitCommonDir)
    : getGitCommonDir(root);
  const localDir = join(gitCommonDir, "devflow-local");
  const lockDir = join(localDir, "allocation.lock");
  const portsFile = join(localDir, "ports.json");

  mkdirSync(localDir, { recursive: true });

  const lock = new FileLock(lockDir);
  const lockToken = await lock.acquire();

  let registryWritten = false;
  let previousRegistry: { instances: PortRegistryItem[] } | undefined;
  let createdRunDir: string | undefined;
  let previousCurrent: string | undefined;
  let currentWritten = false;
  const currentDevJson = join(
    root,
    ".cache",
    "devflow-local",
    "current-dev.json",
  );
  let registry: { instances: PortRegistryItem[] } = { instances: [] };

  try {
    if (existsSync(portsFile)) {
      registry = readRegistry(portsFile);
    }
    previousRegistry = { instances: [...registry.instances] };

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

    const configPath = join(root, "devflow.yaml");
    const baseConfig = existsSync(configPath)
      ? loadConfig(configPath)
      : ConfigSchema.parse({});
    const frontendPort = await findAvailablePort(...baseConfig.ports.frontend);
    const backendPort = await findAvailablePort(...baseConfig.ports.backend);
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
        runDir = join(
          root,
          ".cache",
          "devflow-local",
          "tests",
          targetId,
          invocationId,
        );
      } else {
        instanceId =
          options?.instanceId ||
          `dev_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        runDir = join(root, ".cache", "devflow-local", "dev", instanceId);
      }
    }

    validateSafeRunDir(runDir, root);
    for (const value of [
      instanceId,
      options?.targetId,
      options?.invocationId,
    ]) {
      if (
        value !== undefined &&
        (!/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(value) ||
          value === "." ||
          value === "..")
      )
        throw new Error("实例和测试目标 ID 必须是单个安全路径段");
    }
    if (
      registry.instances.some(
        (item) =>
          (normalizePath(item.worktree_path) === normalizePath(root) &&
            item.instance_id === instanceId) ||
          overlaps(item.run_dir, runDir),
      )
    )
      throw new Error("实例 ID 或运行目录已被登记，不能覆盖现有实例");
    for (const wt of allWorktrees) {
      const file = join(wt, "devflow.yaml");
      if (existsSync(file) && overlaps(loadConfig(file).storage_root, runDir)) {
        // Historical managed checkouts may live under .devflow/worktrees.
        // Their own ignored cache remains separate from the controller DB.
        const cache = normalizePath(physicalPath(join(root, ".cache", "devflow-local")));
        const target = normalizePath(physicalPath(runDir));
        const managedCache = normalizePath(wt) !== normalizePath(root) &&
          allWorktrees.some((candidate) => normalizePath(candidate) === normalizePath(root)) &&
          target.startsWith(cache + sep);
        if (!managedCache) throw new Error("运行目录与已有服务数据目录重叠");
      }
    }
    const rel = relative(root, runDir);
    if (rel === "" || (!rel.startsWith(".." + sep) && !isAbsolute(rel))) {
      // Require ignored storage for a real checkout, including custom runDir.
      if (existsSync(join(root, ".git")))
        execFileSync("git", ["check-ignore", "--quiet", "--", runDir], {
          cwd: root,
          windowsHide: true,
        });
    }

    const stateDir = join(runDir, "state");
    const storageRoot = stateDir;
    const runtimeConfigFile = join(runDir, "devflow.runtime.yaml");
    const instanceJsonFile = join(runDir, "instance.json");

    mkdirSync(dirname(runDir), { recursive: true });
    mkdirSync(runDir); // exclusive ownership; never adopt an existing data root
    createdRunDir = runDir;
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
    // 写入当前实例文件
    atomicWriteJson(instanceJsonFile, instanceConfig);

    // 生成当前实例的 devflow.runtime.yaml
    const runtimeConfigYaml = {
      server: {
        port: backendPort,
        host: "127.0.0.1",
        human_origin: `http://127.0.0.1:${backendPort}`,
      },
      storage_root: storageRoot,
      workspace_root: join(runDir, "worktrees"),
    };
    atomicWriteText(runtimeConfigFile, yaml.stringify(runtimeConfigYaml));
    atomicWriteJson(portsFile, registry);
    registryWritten = true;
    if (instanceType === "dev") {
      previousCurrent = existsSync(currentDevJson)
        ? readFileSync(currentDevJson, "utf8")
        : undefined;
      atomicWriteJson(currentDevJson, instanceConfig);
      currentWritten = true;
    }

    return instanceConfig;
  } catch (err) {
    // 发生异常时回滚本次新增的登记
    if (registryWritten && previousRegistry)
      atomicWriteJson(portsFile, previousRegistry);
    if (currentWritten) {
      if (previousCurrent === undefined) unlinkSync(currentDevJson);
      else atomicWriteText(currentDevJson, previousCurrent);
    }
    if (createdRunDir) {
      for (const file of ["instance.json", "devflow.runtime.yaml"]) {
        const target = join(createdRunDir, file);
        if (existsSync(target)) unlinkSync(target);
      }
      // Only empty directories created by this allocation may be removed.
      try {
        rmdirSync(join(createdRunDir, "state"));
        rmdirSync(createdRunDir);
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
    const registry = readRegistry(portsFile);
    const normRoot = normalizePath(root);

    // 找到当前 worktree 下归属于该 instanceId 的条目
    const target = registry.instances.find(
      (item) =>
        normalizePath(item.worktree_path) === normRoot &&
        item.instance_id === instanceId,
    );

    if (!target) {
      // 不是当前 worktree 的实例或已释放，安全返回
      return;
    }
    if (target.allocated_pid !== process.pid) {
      let alive = true;
      try {
        process.kill(target.allocated_pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
      if (alive)
        throw new Error("实例运行器仍存活，必须由原运行器停止服务后释放登记");
    }
    if (
      typeof options === "object" &&
      options.runDir &&
      normalizePath(options.runDir) !== normalizePath(target.run_dir)
    )
      throw new Error("释放目录与登记所有者不匹配");
    const manifest = readManifest(target.manifest_path, root, instanceId);
    if (
      !manifest ||
      normalizePath(manifest.paths.run_dir) !== normalizePath(target.run_dir)
    )
      throw new Error("实例清单缺失或所有权不匹配，保留端口登记");

    registry.instances = registry.instances.filter(
      (item) =>
        !(
          normalizePath(item.worktree_path) === normRoot &&
          item.instance_id === instanceId
        ),
    );

    atomicWriteJson(portsFile, registry);

    // 清理该条目的 manifest 文件
    if (target.manifest_path && existsSync(target.manifest_path)) {
      try {
        unlinkSync(target.manifest_path);
      } catch {}
    }

    // 如果当前存在 current-dev.json 且属于该实例，清理它
    const currentDevJson = join(
      root,
      ".cache",
      "devflow-local",
      "current-dev.json",
    );
    if (existsSync(currentDevJson)) {
      try {
        const cur = JSON.parse(readFileSync(currentDevJson, "utf-8"));
        if (cur.instance_id === instanceId) {
          unlinkSync(currentDevJson);
        }
      } catch {}
    }

    // 兼容旧的单一 instance.json 位置
    const legacyInstanceJson = join(
      root,
      ".cache",
      "devflow-local",
      "instance.json",
    );
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
    return readManifest(customJson, root, options.instanceId);
  }

  // 1. 优先读取 current-dev.json
  const currentDevJson = join(
    root,
    ".cache",
    "devflow-local",
    "current-dev.json",
  );
  if (existsSync(currentDevJson)) {
    try {
      const current = readManifest(currentDevJson, root, options?.instanceId);
      if (current) return current;
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
          const candidate = readManifest(cand, root, options?.instanceId);
          if (candidate) return candidate;
        }
      }
    } catch {}
  }

  // 3. 兼容旧的单一 instance.json
  const legacyInstanceJson = join(
    root,
    ".cache",
    "devflow-local",
    "instance.json",
  );
  if (existsSync(legacyInstanceJson)) {
    try {
      return readManifest(legacyInstanceJson, root, options?.instanceId);
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
