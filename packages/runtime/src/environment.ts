import net from "node:net";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "../../core/src/engine.js";
import {
  requireCondition,
  FlowError,
  type Project,
  type Workflow,
  type Workspace,
} from "../../contracts/src/index.js";
import { id, atomicWrite } from "../../core/src/util.js";
import type { ProcessManager } from "../../process/src/manager.js";
export interface Environment {
  id: string;
  workflow_id: string;
  revision: number;
  status: "starting" | "ready" | "stopped" | "failed";
  error?: string;
  identity: string;
  data_dir: string;
  services: {
    id: string;
    status?: "starting" | "ready";
    process_id: string;
    port: number;
    origin: string;
    health_url: string;
    identity_header: string;
    expected_identity: string;
    upstream_probe_url?: string;
    upstream_identity?: string;
  }[];
}
export async function portAvailable(port: number) {
  return new Promise<boolean>((done) => {
    const s = net.createServer();
    s.once("error", () => done(false));
    s.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
      s.close(() => done(true)),
    );
  });
}
export class Environments {
  constructor(
    private engine: Engine,
    private processes: ProcessManager,
  ) {}
  async ensure(
    workflow: Workflow,
    assertActive: () => void = () => {},
    trackProcess: (id: string) => void = () => {},
  ) {
    assertActive();
    const current = this.engine.store.get<Environment>(
      "environment",
      workflow.id,
    );
    if (current?.status === "ready") {
      await this.health(current);
      return current;
    }
    const project = this.engine.project(workflow.project_id);
    const slot = this.engine.scheduler.capacity(
      "environment",
      this.engine.config.scheduler.live_environments,
    );
    requireCondition(
      slot,
      "ENVIRONMENT_CAPACITY",
      "保留的测试环境已达到上限，请释放不用的环境",
    );
    const activity = (type: string, payload: Record<string, unknown>) =>
      this.engine.store.event(
        workflow.id,
        workflow.project_id,
        type,
        {
          ...payload,
          task_id: this.engine.store.get<any>("task_activity", workflow.id)
            ?.task_id,
        },
        workflow.run_id,
      );
    const env: Environment = {
      id: id("env"),
      workflow_id: workflow.id,
      revision: workflow.environment_revision + 1,
      status: "starting",
      identity: id("identity"),
      data_dir: join(this.engine.config.storage_root, "data", workflow.id),
      services: [],
    };
    requireCondition(
      this.engine.scheduler.acquire(workflow.id, env.id, [
        slot,
        ...(project.data.mode === "external_lock"
          ? ["data:" + project.data.resource_id]
          : []),
      ]),
      "DATA_BUSY",
      "测试数据资源正在使用",
    );
    try {
      this.engine.store.put("environment", workflow.id, workflow.id, env);
      mkdirSync(env.data_dir, { recursive: true });
      if (project.data.fixture_command_id) {
        activity("FixtureStarted", {});
        assertActive();
        const fixture = project.commands.find(
          (c) => c.id === project.data.fixture_command_id,
        )!;
        const workspaces = this.engine.store.list<Workspace>(
          "workspace",
          workflow.id,
        );
        const workspace = fixture.repo_id
          ? workspaces.find((w) => w.repo_id === fixture.repo_id)!
          : workspaces[0]!;
        const variables = {
          DEVFLOW_DATA_DIR: env.data_dir,
          DEVFLOW_WORKFLOW_ID: workflow.id,
        };
        const proc = this.processes.start({
          workflow_id: workflow.id,
          id: id("fixture"),
          executable: fixture.executable,
          args: fixture.args.map((a) => expand(a, variables)),
          cwd: fixture.cwd ? join(workspace.root, fixture.cwd) : workspace.root,
          env: { ...fixture.env, ...variables },
          timeout_ms: fixture.timeout_seconds * 1000,
        });
        trackProcess(proc.id);
        for (const stream of ["stdout", "stderr"] as const)
          proc.on(stream, (data: Buffer) =>
            this.engine.store.event(
              workflow.id,
              workflow.project_id,
              "FixtureOutput",
              { stream, text: data.toString("utf8") },
            ),
          );
        requireCondition(
          (await proc.completion).code === 0,
          "FIXTURE_FAILED",
          "测试数据初始化失败",
        );
        assertActive();
        activity("FixtureReady", {});
      }
      for (const service of [...project.services].sort((a, b) =>
        a.port_pool === "backend" ? -1 : b.port_pool === "backend" ? 1 : 0,
      )) {
        assertActive();
        const command = project.commands.find(
          (c) => c.id === service.command_id,
        )!;
        const ws = this.engine.store
          .list<Workspace>("workspace", workflow.id)
          .find((w) => w.repo_id === service.repo_id)!;
        let running = false;
        const attemptedPorts = new Set<number>();
        for (
          let attempt = 0;
          attempt < this.engine.config.ports.bind_retries;
          attempt++
        ) {
          const port = await this.allocate(
            workflow.id,
            env.id,
            service.port_pool,
            attemptedPorts,
          );
          attemptedPorts.add(port);
          assertActive();
          const processId = id("service");
          const origin = `http://127.0.0.1:${port}`;
          const variables = {
            DEVFLOW_PORT: String(port),
            PORT: String(port),
            DEVFLOW_IDENTITY: env.identity + ":" + service.id,
            DEVFLOW_SERVICE_ID: service.id,
            DEVFLOW_WORKFLOW_ID: workflow.id,
            DEVFLOW_DATA_DIR: env.data_dir,
            DEVFLOW_API_TARGET:
              env.services.find(
                (s) =>
                  project.services.find((p) => p.id === s.id)?.port_pool ===
                  "backend",
              )?.origin ?? "",
          };
          const args = command.args.map((a) => expand(a, variables));
          activity("ServiceStarting", {
            service_id: service.id,
            label: service.port_pool === "backend" ? "后端服务" : "前端服务",
            process_id: processId,
          });
          const proc = this.processes.start({
            workflow_id: workflow.id,
            id: processId,
            executable: command.executable,
            args,
            cwd: command.cwd ? join(ws.root, command.cwd) : ws.root,
            env: { ...command.env, ...variables },
            timeout_ms: 0,
          });
          trackProcess(proc.id);
          let output = "";
          for (const stream of ["stdout", "stderr", "diagnostic"])
            proc.on(stream, (data: Buffer | string) => {
              output = (output + data.toString()).slice(0, 16000);
            });
          const ended = proc.completion.then(({ code, signal }) => {
            throw new FlowError(
              /EADDRINUSE|address already in use/i.test(output)
                ? "PORT_IN_USE"
                : "SERVICE_EXITED",
              `本机验证服务 ${service.id} 提前退出（退出码 ${code ?? signal ?? "未知"}）：${output.trim() || "进程未输出诊断信息"}`,
            );
          });
          // Attach a handler before starting probes; a rejected process must
          // never become an unhandled rejection while another probe finishes.
          void ended.catch(() => {});
          const probe = new AbortController();
          proc.on("stdout", (b: Buffer) =>
            this.engine.store.event(
              workflow.id,
              workflow.project_id,
              "ServiceOutput",
              {
                service_id: service.id,
                process_id: processId,
                stream: "stdout",
                text: b.toString("utf8").slice(0, 16000),
              },
            ),
          );
          proc.on("stderr", (b: Buffer) =>
            this.engine.store.event(
              workflow.id,
              workflow.project_id,
              "ServiceOutput",
              {
                service_id: service.id,
                process_id: processId,
                stream: "stderr",
                text: b.toString("utf8").slice(0, 16000),
              },
            ),
          );
          const backend = env.services.find(
            (s) =>
              project.services.find((p) => p.id === s.id)?.port_pool ===
              "backend",
          );
          const entry: Environment["services"][number] = {
            id: service.id,
            process_id: processId,
            port,
            origin,
            health_url: origin + service.health_path,
            identity_header: service.identity_header,
            expected_identity: env.identity + ":" + service.id,
            ...(service.backend_probe_path && backend
              ? {
                  upstream_probe_url: origin + service.backend_probe_path,
                  upstream_identity: backend.expected_identity,
                }
              : {}),
          };
          try {
            env.services.push(entry);
            this.engine.store.put("environment", workflow.id, workflow.id, env);
            await Promise.race([
              ended,
              this.waitHealth(
                entry,
                entry.expected_identity,
                30000,
                assertActive,
                probe.signal,
              ),
            ]);
            assertActive();
            if (entry.upstream_probe_url)
              await Promise.race([
                ended,
                this.waitHealth(
                  { ...entry, health_url: entry.upstream_probe_url },
                  entry.upstream_identity!,
                  5000,
                  assertActive,
                  probe.signal,
                ),
              ]);
            assertActive();
            entry.status = "ready";
            this.engine.store.put("environment", workflow.id, workflow.id, env);
            activity("ServiceReady", {
              service_id: service.id,
              label: service.port_pool === "backend" ? "后端服务" : "前端服务",
              origin,
              process_id: processId,
            });
            running = true;
            break;
          } catch (error) {
            probe.abort();
            await proc.stop().catch(() => {});
            env.services = env.services.filter(
              (s) => s.process_id !== processId,
            );
            assertActive();
            this.engine.scheduler.release(
              workflow.id,
              env.id,
              ["port:" + port],
              true,
            );
            if (
              !(error instanceof FlowError && error.code === "PORT_IN_USE") ||
              attempt === this.engine.config.ports.bind_retries - 1
            )
              throw error;
          } finally {
            probe.abort();
          }
        }
        requireCondition(running, "SERVICE_START_FAILED", "服务启动失败");
      }
      assertActive();
      env.status = "ready";
      this.engine.store.put("environment", workflow.id, workflow.id, env);
      const w = this.engine.get(workflow.id);
      this.engine.store.put("workflow", w.id, w.project_id, {
        ...w,
        environment_revision: env.revision,
        version: w.version + 1,
      });
      this.engine.invalidate(w.id, "运行环境重新创建");
      atomicWrite(
        join(env.data_dir, "manifest.json"),
        JSON.stringify(env, null, 2),
      );
      return env;
    } catch (e) {
      // Cleanup must not replace the first failure with "stopped" or a
      // secondary teardown error.
      await this.stop(workflow.id).catch(() => {});
      assertActive();
      activity("EnvironmentFailed", {
        message: e instanceof Error ? e.message : String(e),
      });
      env.error = e instanceof Error ? e.message : String(e);
      env.status = "failed";
      this.engine.store.put("environment", workflow.id, workflow.id, env);
      throw e;
    }
  }
  async allocate(
    workflow: string,
    run: string,
    pool: "frontend" | "backend",
    excluded = new Set<number>(),
  ) {
    const [start, end] = this.engine.config.ports[pool];
    for (let port = start; port <= end; port++) {
      if (
        excluded.has(port) ||
        this.engine.store.get("lease", "port:" + port) ||
        !(await portAvailable(port))
      )
        continue;
      if (this.engine.scheduler.acquire(workflow, run, ["port:" + port]))
        return port;
    }
    throw new Error("没有可用测试端口");
  }
  async waitHealth(
    service: Environment["services"][number],
    identity: string,
    ms: number,
    assertActive: () => void = () => {},
    signal?: AbortSignal,
  ) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      assertActive();
      signal?.throwIfAborted();
      try {
        const response = await fetch(service.health_url, {
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(1000)])
            : AbortSignal.timeout(1000),
          redirect: "error",
        });
        if (
          response.ok &&
          response.headers.get(service.identity_header) === identity
        )
          return;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`健康检查或工作流身份不匹配：${service.health_url}`);
  }
  async health(env: Environment) {
    for (const service of env.services) {
      await this.waitHealth(service, service.expected_identity, 2000);
      if (service.upstream_probe_url)
        await this.waitHealth(
          { ...service, health_url: service.upstream_probe_url },
          service.upstream_identity!,
          2000,
        );
    }
  }
  async stop(workflow: string) {
    const env = this.engine.store.get<Environment>("environment", workflow);
    if (!env) return;
    for (const service of env.services)
      await this.processes.stop(service.process_id);
    const leases = this.engine.store
      .list<{ id: string; run_id: string }>("lease", workflow)
      .filter((l) => l.run_id === env.id);
    this.engine.scheduler.release(
      workflow,
      env.id,
      leases.map((l) => l.id),
      true,
    );
    this.engine.store.put("environment", workflow, workflow, {
      ...env,
      status: env.status === "failed" ? "failed" : "stopped",
    });
    if (this.engine.get(workflow).state !== "COMMITTED")
      this.engine.invalidate(workflow, "环境已停止");
    else
      this.engine.store.event(
        workflow,
        this.engine.get(workflow).project_id,
        "EnvironmentReleased",
        { environment_id: env.id },
      );
  }
}
export function expand(value: string, variables: Record<string, string>) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key: string) => {
    requireCondition(key in variables, "UNKNOWN_VARIABLE", `未知变量 ${key}`);
    return variables[key]!;
  });
}
