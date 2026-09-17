import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse } from "yaml";
const positive = z.number().int().positive();
export const ConfigSchema = z
  .object({
    schema_version: z.literal(1).default(1),
    server: z
      .object({
        host: z.literal("127.0.0.1").default("127.0.0.1"),
        port: positive.max(65535).default(4810),
        human_origin: z.string().url().default("http://localhost:4810"),
      })
      .strict()
      .prefault({}),
    retain_services_on_stop: z.boolean().default(false),
    storage_root: z.string().default(".devflow"),
    workspace_root: z.string().default(".devflow/worktrees"),
    models: z
      .object({
        executor: z.string().min(1).default("gemini-3.7-flash-high"),
        reviewer: z.string().min(1).default("gpt-6-astra"),
        effort: z.literal("high").default("high"),
        agy_executable: z.string().default("agy"),
        codex_executable: z.string().default("codex"),
        codex_prefix_args: z.array(z.string()).default([]),
      })
      .strict()
      .prefault({}),
    scheduler: z
      .object({
        executors: positive.max(16).default(1),
        reviewers: positive.max(4).default(1),
        heavy_tests: positive.max(8).default(1),
        live_environments: positive.max(16).default(1),
        aging_minutes: positive.default(10),
      })
      .strict()
      .prefault({}),
    ports: z
      .object({
        frontend: z
          .tuple([positive.max(65535), positive.max(65535)])
          .default([15173, 15272]),
        backend: z
          .tuple([positive.max(65535), positive.max(65535)])
          .default([18081, 18180]),
        bind_retries: positive.max(10).default(5),
      })
      .strict()
      .prefault({}),
    host: z
      .object({
        executable: z.string().default(""),
        required: z.boolean().default(true),
      })
      .strict()
      .prefault({}),
    opentabs: z
      .object({
        endpoint: z.string().url().default("http://127.0.0.1:9515/mcp"),
        secret_file: z.string().default(""),
        allowed_test_origins: z.array(z.string().url()).default([]),
      })
      .strict()
      .prefault({}),
    timeouts: z
      .object({
        agent_minutes: positive.default(60),
        idle_minutes: positive.default(10),
        stop_seconds: positive.default(5),
        heartbeat_seconds: positive.default(5),
      })
      .strict()
      .prefault({}),
    retention: z
      .object({
        logs_days: positive.default(30),
        failed_logs_days: positive.default(90),
        evidence_days: positive.default(180),
      })
      .strict()
      .prefault({}),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(file?: string): Config {
  file ??= existsSync("devflow.yaml") ? resolve("devflow.yaml") : undefined;
  const c = ConfigSchema.parse(file ? parse(readFileSync(file, "utf8")) : {});
  const base = file ? dirname(resolve(file)) : process.cwd();
  c.storage_root = resolve(base, c.storage_root);
  c.workspace_root = resolve(base, c.workspace_root);
  for (const [a, b] of [c.ports.frontend, c.ports.backend])
    if (a > b) throw new Error("端口池起点大于终点");
  if (
    c.ports.frontend[0] <= c.ports.backend[1] &&
    c.ports.backend[0] <= c.ports.frontend[1]
  )
    throw new Error("端口池不能重叠");
  const origin = new URL(c.server.human_origin);
  if (
    !["localhost", "127.0.0.1"].includes(origin.hostname) ||
    Number(origin.port || 80) !== c.server.port
  )
    throw new Error("人工入口必须是本机服务端口");
  return c;
}
