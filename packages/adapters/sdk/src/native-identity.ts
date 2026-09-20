import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ToolProfile } from "../../../contracts/src/execution-spec.js";
import type { NonSecretIdentity } from "../../../contracts/src/model-access.js";
import type { IdentityContext } from "./interface.js";

const ACCOUNT_KEYS = [
  "account_id",
  "accountId",
  "accountUuid",
  "user_id",
  "userId",
  "emailAddress",
  "email",
];
const SECRET_KEYS = [
  "access_token",
  "refresh_token",
  "id_token",
  "api_key",
  "apiKey",
  "token",
  "secret",
  "password",
];

export function readNativeIdentity(
  context: IdentityContext,
): Promise<NonSecretIdentity> {
  return Promise.resolve(readNativeIdentitySync(context));
}

export function nativeProfileSupported(adapterId: string): boolean {
  return adapterId === "codex";
}

export function identityInputFromProfile(
  profile: Pick<
    ToolProfile,
    "adapterId" | "nativeConfigProfile" | "providerConfigRef" | "modelId"
  >,
): {
  nativeConfigScope: string;
  providerEndpoint?: string;
  accountId?: string;
  identityConfidence?: NonSecretIdentity["identityConfidence"];
} {
  const nativeConfigScope = profile.nativeConfigProfile?.trim() || "default";
  const accountId = readAccountId(profile.adapterId, nativeConfigScope);
  const providerEndpoint =
    profile.providerConfigRef ?? readCodexProviderScope(profile);
  return {
    nativeConfigScope,
    ...(providerEndpoint ? { providerEndpoint } : {}),
    ...(accountId
      ? { accountId, identityConfidence: "account" as const }
      : { identityConfidence: "profile-scope" as const }),
  };
}

export function readNativeIdentitySync(
  context: IdentityContext,
): NonSecretIdentity {
  const nativeConfigScope = context.nativeConfigScope?.trim() || "default";
  const adapterId = context.adapterId as NonSecretIdentity["adapterId"];
  const accountId = readAccountId(adapterId, nativeConfigScope);
  return {
    adapterId,
    nativeConfigScope,
    accountFingerprint: hashIdentity(accountId ?? `scope:${nativeConfigScope}`),
    identityConfidence: accountId ? "account" : "profile-scope",
    ...(context.executablePath ? { displayLabel: context.executablePath } : {}),
  };
}

function readAccountId(
  adapterId: string,
  nativeConfigScope: string,
): string | undefined {
  for (const file of identityFiles(adapterId, nativeConfigScope)) {
    const value = accountIdFromFile(file);
    if (value) return value;
  }
  return undefined;
}

function identityFiles(adapterId: string, nativeConfigScope: string): string[] {
  const home = homedir();
  if (adapterId === "codex") {
    // A Codex profile is a name in config.toml, not an arbitrary auth directory.
    const root = process.env.CODEX_HOME?.trim() || join(home, ".codex");
    return [join(root, "auth.json")];
  }
  if (adapterId === "claude-code") {
    // Analytics user identifiers are not authentication account identifiers.
    return [join(home, ".claude.json")];
  }
  return [];
}

function hashIdentity(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function accountIdFromFile(file: string): string | undefined {
  if (!existsSync(file)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
  return firstAccountId(parsed);
}

function firstAccountId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstAccountId(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ACCOUNT_KEYS) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim() && !isSecretKey(key)) {
      return raw.trim();
    }
  }
  for (const [key, nested] of Object.entries(record)) {
    // Existing native identity files keep stable account fields in nested
    // containers too. Never use a token string as an account identifier.
    if (isSecretKey(key) && (nested === null || typeof nested !== "object"))
      continue;
    const found = firstAccountId(nested);
    if (found) return found;
  }
  return undefined;
}

function isSecretKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SECRET_KEYS.some((item) => lower.includes(item));
}

function readCodexProviderScope(
  profile: Pick<ToolProfile, "adapterId" | "nativeConfigProfile">,
): string | undefined {
  if (profile.adapterId !== "codex") return undefined;
  let text: string;
  try {
    text = readFileSync(
      join(
        process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"),
        "config.toml",
      ),
      "utf8",
    );
  } catch {
    return undefined;
  }
  const tables = new Map<string, Record<string, string>>([["", {}]]);
  let table = "";
  for (const raw of text.split(/\r?\n/)) {
    const header = raw.trim().match(/^\[([^\]]+)\]\s*(?:#.*)?$/);
    if (header) {
      table = header[1]!.replace(/"([^"\\]+)"|'([^']+)'/g, "$1$2");
      if (!tables.has(table)) tables.set(table, {});
      continue;
    }
    // Only non-secret provider selection and endpoint fields are inspected.
    const field = raw.match(
      /^\s*(model_provider|base_url)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/,
    );
    if (!field) continue;
    try {
      tables.get(table)![field[1]!] = field[2]!.startsWith('"')
        ? (JSON.parse(field[2]!) as string)
        : field[2]!.slice(1, -1);
    } catch {
      /* Unknown scalar encodings are not inferred. */
    }
  }
  const named =
    profile.nativeConfigProfile && profile.nativeConfigProfile !== "default"
      ? tables.get(`profiles.${profile.nativeConfigProfile}`)
      : undefined;
  const provider = named?.model_provider ?? tables.get("")?.model_provider;
  if (!provider) return undefined;
  return tables.get(`model_providers.${provider}`)?.base_url ?? provider;
}
