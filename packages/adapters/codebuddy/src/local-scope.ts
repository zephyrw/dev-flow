import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const configNames = ["models.json", "settings.json", "settings.local.json"];

export function codeBuddyConfigRoot(): string {
  return resolve(process.env.CODEBUDDY_CONFIG_DIR || join(homedir(), ".codebuddy"));
}

function authFiles(): string[] {
  const home = homedir();
  const parent = process.platform === "win32" ? join(home, "AppData", "Local")
    : process.platform === "darwin" ? join(home, "Library", "Application Support")
    : join(home, ".local", "share");
  const root = join(parent, "CodeBuddyExtension", "Data", "Public", "auth");
  try {
    return readdirSync(root, { withFileTypes: true }).filter(file => file.isFile() && file.name.endsWith(".info"))
      .map(file => join(root, file.name)).sort();
  } catch { return []; }
}

function fileRevision(path: string) {
  try {
    const { mtimeMs, size } = statSync(path);
    return [path, mtimeMs, size];
  } catch { return [path]; }
}

function nativeAuthIdentity(path: string) {
  const record = readConfig(path) as {
    account?: {
      uid?: string | number;
      oneidAccountId?: string;
      accountType?: string;
      isCurrentOneIdEnterprise?: boolean;
    };
    auth?: { domain?: string; accessToken?: string; refreshToken?: string };
  } | undefined;
  const account = record?.account;
  const auth = record?.auth;
  // CLI startup refreshes the token in place. Scope changes only when the
  // effective account, service or signed-in state changes.
  return [path, account?.uid, account?.oneidAccountId, account?.accountType,
    account?.isCurrentOneIdEnterprise, auth?.domain, Boolean(auth?.accessToken || auth?.refreshToken)];
}

export function codeBuddyScope(cwd?: string): string {
  const root = codeBuddyConfigRoot();
  const project = cwd ? join(resolve(cwd), ".codebuddy") : undefined;
  const files = [root, ...(project ? [project] : [])]
    .flatMap(dir => configNames.map(name => join(dir, name)));
  const revision = JSON.stringify([
    authFiles().map(nativeAuthIdentity),
    files.map(fileRevision),
    process.env.CODEBUDDY_INTERNET_ENVIRONMENT,
    process.env.CODEBUDDY_BASE_URL,
    // Hash process-provided auth configuration in memory. Its value never enters the cache.
    process.env.CODEBUDDY_API_KEY,
    process.env.CODEBUDDY_AUTH_TOKEN,
  ]);
  return "codebuddy:" + createHash("sha256").update(revision).digest("hex");
}

export function sameCodeBuddyProjectConfig(verifiedRoot: string, runtimeRoot: string): boolean {
  if (resolve(verifiedRoot) === resolve(runtimeRoot)) return true;
  const read = (root: string, name: string): Buffer | undefined => {
    try { return readFileSync(join(root, ".codebuddy", name)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  return configNames.every(name => {
    const verified = read(verifiedRoot, name);
    const actual = read(runtimeRoot, name);
    return verified ? !!actual?.equals(verified) : actual === undefined;
  });
}

function readConfig(path: string): unknown {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return undefined; }
}

export function isCodeBuddyExternalModel(cwd: string, modelId?: string): boolean {
  if (process.env.CODEBUDDY_BASE_URL || process.env.CODEBUDDY_API_KEY || process.env.CODEBUDDY_AUTH_TOKEN) return true;
  for (const dir of [join(cwd, ".codebuddy"), codeBuddyConfigRoot()]) {
    const config = readConfig(join(dir, "models.json"));
    if (!config || typeof config !== "object" || !("models" in config) || !Array.isArray(config.models)) continue;
    if (config.models.some(model => model?.id === modelId && (model.url || model.apiKey))) return true;
  }
  return false;
}

export function codeBuddyBillingRegion(uid: string): "internal" | undefined {
  const region = process.env.CODEBUDDY_INTERNET_ENVIRONMENT;
  if (region) return region === "internal" ? region : undefined;
  for (const path of authFiles()) {
    const record = readConfig(path);
    if (!record || typeof record !== "object") continue;
    const { account, auth } = record as { account?: { uid?: unknown }; auth?: { domain?: unknown } };
    if (String(account?.uid) === uid && typeof auth?.domain === "string" &&
        /^(https:\/\/)?(?:www\.)?(?:codebuddy\.cn|copilot\.tencent\.com|workbuddy\.cn)\/?$/i.test(auth.domain))
      return "internal";
  }
  return undefined;
}
