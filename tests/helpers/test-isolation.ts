import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

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

function rejectUnsafeRunDir(dir: string) {
  const normalized = resolve(dir);
  if (hasPathSegment(normalized, "node_modules"))
    throw new Error("DEVFLOW_TEST_RUN_DIR 不能指向 node_modules");
  const productionRoot = resolve(".devflow");
  if (normalized === productionRoot || isInside(normalized, productionRoot))
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
  return dir.split(/[\\/]/).includes(name);
}

function isInside(target: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : root + sep;
  return target.startsWith(prefix);
}
