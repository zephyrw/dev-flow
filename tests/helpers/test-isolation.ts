import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { loadConfig } from "../../packages/contracts/src/config.js";

export const DEFAULT_TEST_PORT = 14811;
export const PRODUCTION_SERVER_PORT = 4810;

export interface TestInstanceConfig {
  port: number;
  humanOrigin: string;
  usesCustomRunDir: boolean;
  runDirResolved: string;
  stateFile: string;
  sqliteFile: string;
  storageRoot: string;
  workspaceRoot: string;
  inputDir: string;
  nativeSessionDir: string;
  reportJson: string;
  htmlReport: string;
  outputDir: string;
  downloadsDir: string;
  traceDir: string;
}

export function loadTestInstanceConfig(
  env: NodeJS.ProcessEnv = process.env,
): TestInstanceConfig {
  const port = parseTestPort(env.DEVFLOW_TEST_PORT);
  const runDirRaw = env.DEVFLOW_TEST_RUN_DIR?.trim();
  const usesCustomRunDir = Boolean(runDirRaw);
  const runDirResolved = resolve(runDirRaw || ".cache");
  if (usesCustomRunDir) rejectUnsafeRunDir(runDirResolved);
  assertTestManifest(runDirResolved);
  const storageRoot = join(runDirResolved, "state");
  const outputDir = usesCustomRunDir
    ? join(runDirResolved, "test-results")
    : resolve("test-results");
  return {
    port,
    humanOrigin: `http://localhost:${port}`,
    usesCustomRunDir,
    runDirResolved,
    stateFile: usesCustomRunDir
      ? join(runDirResolved, "e2e-state.json")
      : resolve(".cache", "e2e-state.json"),
    sqliteFile: join(storageRoot, "devflow.sqlite"),
    storageRoot,
    workspaceRoot: join(runDirResolved, "worktrees"),
    inputDir: join(runDirResolved, "inputs"),
    nativeSessionDir: join(runDirResolved, "native-sessions"),
    reportJson: usesCustomRunDir
      ? join(runDirResolved, "e2e-report.json")
      : resolve(".cache", "e2e-report.json"),
    htmlReport: usesCustomRunDir
      ? join(runDirResolved, "playwright-report")
      : resolve("playwright-report"),
    outputDir,
    downloadsDir: usesCustomRunDir
      ? join(runDirResolved, "downloads")
      : join(outputDir, "downloads"),
    traceDir: usesCustomRunDir ? join(runDirResolved, "trace") : outputDir,
  };
}

export function ensureTestInstanceDirs(config: TestInstanceConfig) {
  const dirs = [
    dirname(config.stateFile),
    dirname(config.reportJson),
    config.outputDir,
    config.downloadsDir,
  ];
  if (config.usesCustomRunDir) {
    dirs.push(
      config.runDirResolved,
      config.storageRoot,
      config.workspaceRoot,
      config.inputDir,
      config.nativeSessionDir,
      config.traceDir,
      config.htmlReport,
    );
  }
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
}

export function playwrightWebServerEnv(
  config: TestInstanceConfig,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) next[key] = value;
  }
  next.DEVFLOW_TEST_PORT = String(config.port);
  if (config.usesCustomRunDir)
    next.DEVFLOW_TEST_RUN_DIR = config.runDirResolved;
  return next;
}

export function assertTestPortAvailable(port: number): Promise<void> {
  return new Promise((resolveReady, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EADDRINUSE") {
        reject(
          new Error(
            `DEVFLOW_TEST_PORT ${port} 已被占用，请换一个空闲端口后再启动隔离实例`,
          ),
        );
        return;
      }
      reject(error);
    });
    server.once("listening", () => {
      server.close((closeError) => {
        if (closeError) reject(closeError);
        else resolveReady();
      });
    });
    server.listen(port, "127.0.0.1");
  });
}

export function usesIsolatedTestRoot(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(env.DEVFLOW_TEST_RUN_DIR?.trim());
}

function parseTestPort(raw: string | undefined): number {
  if (!raw?.trim()) return DEFAULT_TEST_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error(`DEVFLOW_TEST_PORT 无效: ${raw}`);
  if (port === PRODUCTION_SERVER_PORT)
    throw new Error("DEVFLOW_TEST_PORT 不能使用生产端口 4810");
  return port;
}

export function assertSafeTestDatabaseCleanup(
  sqlitePath: string,
  runDir: string,
): void {
  const ownedTest = assertTestManifest(runDir);
  if (resolve(sqlitePath) !== resolve(runDir, "state", "devflow.sqlite"))
    throw new Error("拒绝清理测试数据库: 数据库不属于本次运行目录");
  rejectUnsafeRunDir(runDir);
  if (existsSync(runDir)) rejectUnsafeRunDir(realpathSync(runDir));
  if (
    existsSync(dirname(sqlitePath)) &&
    existsSync(runDir) &&
    !isInside(realpathSync(dirname(sqlitePath)), realpathSync(runDir))
  )
    throw new Error("拒绝清理测试数据库: state 目录链接指向运行目录外");
  const normalizedRunDir = resolve(runDir);
  const normalizedSqlite = resolve(sqlitePath);
  if (
    isDevInstancePath(normalizedRunDir) ||
    isDevInstancePath(normalizedSqlite)
  ) {
    throw new Error(
      `拒绝清理测试数据库: 路径位于开发实例目录中 (${sqlitePath})，严禁删除开发数据`,
    );
  }
  const productionRoot = resolve(".devflow");
  const configFile = resolve("devflow.yaml");
  if (existsSync(configFile)) {
    const configuredRoot = loadConfig(configFile).storage_root;
    if (normalizedSqlite.toLowerCase() === configuredRoot.toLowerCase() || isInside(normalizedSqlite, configuredRoot))
      throw new Error("DEVFLOW_TEST_RUN_DIR 不能使用当前服务配置的数据目录");
  }
  if (
    normalizedSqlite === productionRoot ||
    isInside(normalizedSqlite, productionRoot)
  ) {
    throw new Error("拒绝清理测试数据库: 不能操作生产数据库目录 .devflow");
  }
  const isIsolatedTest =
    ownedTest ||
    hasPathSegment(normalizedRunDir, "tests") ||
    hasPathSegment(normalizedRunDir, "test") ||
    hasPathSegment(normalizedRunDir, ".cache") ||
    hasPathSegment(normalizedRunDir, "tmp") ||
    hasPathSegment(normalizedRunDir, "temp");
  if (!isIsolatedTest) {
    throw new Error(`拒绝清理测试数据库: 运行目录非测试隔离目录 (${runDir})`);
  }
}

function assertTestManifest(runDir: string): boolean {
  const root = resolve(runDir);
  for (let dir = root; ; dir = dirname(dir)) {
    const file = join(dir, "instance.json");
    if (existsSync(file)) {
      const manifest = JSON.parse(readFileSync(file, "utf8"));
      if (
        manifest.instance_type !== "test" ||
        resolve(manifest.paths?.run_dir ?? "") !== root ||
        resolve(manifest.paths?.storage_root ?? "") !== join(root, "state")
      )
        throw new Error("拒绝复用非本次测试实例的数据目录");
      return true;
    }
    if (dirname(dir) === dir) return false;
  }
}

function rejectUnsafeRunDir(dir: string) {
  const normalized = resolve(dir);
  if (hasPathSegment(normalized, "node_modules"))
    throw new Error("DEVFLOW_TEST_RUN_DIR 不能指向 node_modules");
  if (isDevInstancePath(normalized))
    throw new Error("DEVFLOW_TEST_RUN_DIR 不能指向开发实例目录 dev");
  const productionRoot = resolve(".devflow");
  if (
    normalized === productionRoot ||
    isInside(normalized, productionRoot)
  )
    throw new Error("DEVFLOW_TEST_RUN_DIR 不能使用生产数据库目录 .devflow");
  for (const forbidden of forbiddenAuthRoots()) {
    if (normalized === forbidden || isInside(normalized, forbidden))
      throw new Error("DEVFLOW_TEST_RUN_DIR 不能使用真实工具认证目录");
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
  ].map((item) => resolve(item));
}

function hasPathSegment(dir: string, name: string): boolean {
  return dir.toLowerCase().split(/[\\/]/).includes(name.toLowerCase());
}

function isDevInstancePath(dir: string): boolean {
  return /(?:^|[\\/])devflow-local[\\/]dev(?:[\\/]|$)/i.test(dir);
}

function isInside(target: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.toLowerCase().startsWith(prefix.toLowerCase());
}
