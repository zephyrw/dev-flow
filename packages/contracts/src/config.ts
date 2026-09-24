import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse } from "yaml";
import { AgyAccountSettingsSchema } from "./agy-account.js";
const positive = z.number().int().positive();

export function normalizeLegacyConfig(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value as Record<string, unknown>;
  if (
    input.schema_version !== undefined &&
    input.schema_version !== 1 &&
    input.schema_version !== 2
  )
    throw new Error("UNSUPPORTED_CONFIG_VERSION");
  const legacy = input.schema_version !== 2;
  const result = { ...input };
  const known = (value: unknown, auth: boolean) => {
    if (value === undefined || value === "") return;
    if (typeof value !== "string")
      throw new Error("LEGACY_CUSTOM_HOST_UNSUPPORTED");
    const normalized = value
      .replace(/\\/g, "/")
      .replace(/^\.\//, "")
      .toLowerCase();
    const names = auth
      ? ["devflow-auth-host.exe"]
      : ["devflow-host.exe", "devflow-host", "devflow.winhost.exe"];
    const paths = names.map(name => "dist/host/" + name);
    if (!auth) paths.push("host/devflow.winhost/bin/release/net10.0-windows/devflow.winhost.exe");
    const absolute = normalized.startsWith("/") || /^[a-z]:\//.test(normalized);
    if (
      !paths.some(
        (path) => normalized === path || (absolute && normalized.endsWith("/" + path)),
      )
    )
      throw new Error("LEGACY_CUSTOM_HOST_UNSUPPORTED");
  };
  if (Object.hasOwn(input, "host")) {
    if (
      !legacy ||
      !input.host ||
      typeof input.host !== "object" ||
      Array.isArray(input.host)
    )
      throw new Error("LEGACY_HOST_INVALID");
    const host = input.host as Record<string, unknown>;
    if (
      Object.keys(host).some(
        (key) => !["executable", "required"].includes(key),
      ) ||
      (host.required !== undefined && typeof host.required !== "boolean")
    )
      throw new Error("LEGACY_HOST_INVALID");
    known(host.executable, false);
    delete result.host;
  }
  if (
    input.agy_accounts &&
    typeof input.agy_accounts === "object" &&
    !Array.isArray(input.agy_accounts)
  ) {
    const accounts = { ...(input.agy_accounts as Record<string, unknown>) };
    if (Object.hasOwn(accounts, "auth_host_executable")) {
      if (!legacy) throw new Error("LEGACY_HOST_INVALID");
      known(accounts.auth_host_executable, true);
      delete accounts.auth_host_executable;
    }
    result.agy_accounts = accounts;
  }
  result.schema_version = 2;
  return result;
}

const RuntimeConfigSchema = z
  .object({
    schema_version: z.literal(2).default(2),
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
    agy_accounts: AgyAccountSettingsSchema.omit({
      realm_id: true,
      revision: true,
      updated_at: true,
    })
      .extend({ enabled: z.boolean().default(false) })
      .strict()
      .prefault({}),
    workspace_root: z.string().default(".devflow/worktrees"),
    models: z
      .object({
        executor: z.string().min(1).default("gemini-3.8-flash-high"),
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
export const ConfigSchema = z.preprocess(
  (value, context) => {
    try {
      return normalizeLegacyConfig(value);
    } catch (error) {
      context.addIssue({
        code: "custom",
        message: error instanceof Error ? error.message : "INVALID_CONFIG",
      });
      return z.NEVER;
    }
  },
  RuntimeConfigSchema.superRefine((config, context) => {
    for (const [a, b] of [config.ports.frontend, config.ports.backend])
      if (a > b)
        context.addIssue({
          code: "custom",
          message: "端口池起点大于终点",
          path: ["ports"],
        });
    if (
      config.ports.frontend[0] <= config.ports.backend[1] &&
      config.ports.backend[0] <= config.ports.frontend[1]
    )
      context.addIssue({
        code: "custom",
        message: "端口池不能重叠",
        path: ["ports"],
      });
    let origin: URL;
    try { origin = new URL(config.server.human_origin); }
    catch { return; } // z.string().url() already reports malformed URLs.
    if (
      !["localhost", "127.0.0.1"].includes(origin.hostname) ||
      origin.protocol !== "http:" ||
      Number(origin.port || 80) !== config.server.port
    )
      context.addIssue({
        code: "custom",
        message: "人工入口必须是本机服务端口",
        path: ["server", "human_origin"],
      });
  }),
);
export type Config = z.infer<typeof ConfigSchema>;
export function loadConfig(file?: string): Config {
  file ??= existsSync("devflow.yaml") ? resolve("devflow.yaml") : undefined;
  const raw = file ? parse(readFileSync(file, "utf8")) : {};
  const c = ConfigSchema.parse(raw);
  const base = file ? dirname(resolve(file)) : process.cwd();
  c.storage_root = resolve(base, c.storage_root);
  c.workspace_root = resolve(base, c.workspace_root);
  return c;
}
