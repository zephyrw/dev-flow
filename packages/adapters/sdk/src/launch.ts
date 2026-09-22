import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { requireCondition } from "../../../contracts/src/index.js";

/** Resolve known package shims without evaluating shell text or interpolating prompts into a shell. */
export function nativeLaunch(
  path: string,
  adapterId: string,
): { executable: string; prefix: string[] } {
  const ext = extname(path).toLowerCase();
  if ([".js", ".cjs", ".mjs"].includes(ext))
    return { executable: process.execPath, prefix: [path] };
  if (process.platform !== "win32" || ext === ".exe")
    return { executable: path, prefix: [] };
  const dir = dirname(path);
  const packageNames: Record<string, string> = {
    codex: "@openai/codex",
    "claude-code": "@anthropic-ai/claude-code",
    opencode: "opencode-ai",
    "kimi-code": "@moonshot-ai/kimi-code",
    "mimo-code": "@mimo-ai/cli",
  };
  const packageName = packageNames[adapterId];
  if (packageName) {
    const base = join(dir, "node_modules", packageName),
      manifest = join(base, "package.json");
    const native = join(base, "bin", "opencode.exe");
    if (adapterId === "opencode" && existsSync(native))
      return { executable: native, prefix: [] };
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8"));
      const bin =
        typeof pkg.bin === "string" ? pkg.bin : Object.values(pkg.bin ?? {})[0];
      if (typeof bin === "string" && existsSync(join(base, bin)))
        return nativeLaunch(join(base, bin), adapterId);
    }
    const oc = join(base, "bin", "opencode.exe");
    if (adapterId === "opencode" && existsSync(oc))
      return { executable: oc, prefix: [] };
  }
  if (adapterId === "cursor-agent") {
    const versions = join(dir, "versions");
    const candidates = [
      dir,
      ...(existsSync(versions)
        ? readdirSync(versions)
            .filter((n) => /^\d{4}\.\d{1,2}\.\d{1,2}.*-[a-f0-9]+$/.test(n))
            .sort()
            .reverse()
            .map((n) => join(versions, n))
        : []),
    ];
    for (const d of candidates)
      if (existsSync(join(d, "node.exe")) && existsSync(join(d, "index.js")))
        return {
          executable: join(d, "node.exe"),
          prefix: [join(d, "index.js")],
        };
  }
  requireCondition(
    false,
    "UNSUPPORTED_SHIM",
    "请配置实际 CLI 二进制或 Node 入口；不通过 shell 执行：" + path,
  );
  return { executable: path, prefix: [] };
}
