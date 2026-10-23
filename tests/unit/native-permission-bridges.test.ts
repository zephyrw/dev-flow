import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareClaudePermissionBridge } from "../../packages/adapters/claude/src/permission-hook.js";
import { openCodePermissionInvocation, openCodePermissionAskConfig } from "../../packages/adapters/opencode/src/permission-driver.js";
import { writePermissionArtifacts } from "../../packages/adapters/sdk/src/permission-artifacts.js";
import type { PreparedInvocation } from "../../packages/adapters/sdk/src/interface.js";

function openCodeInvocation(): PreparedInvocation {
  return {
    executable: process.execPath,
    args: ["opencode-entry.mjs", "run", "--format", "json", "--session", "ses_original",
      "--model", "provider/custom-model", "--variant", "medium", "--agent", "devflow-review", "继续原任务\n保留用户原文"],
    cwd: process.cwd(), env: { OPENCODE_CONFIG_CONTENT: "{}" }, conversationId: "ses_original",
  };
}

describe("permission bridge invocation boundaries", () => {
  it("preserves allowed reads and adds only the approved external directory ask rule", () => {
    const original = { permission: { read: "deny" }, agent: {
      "devflow-review": { mode: "primary", permission: { "*": "deny", read: "allow", bash: "deny" } },
      "devflow-review-child": { mode: "subagent", permission: { "*": "deny", read: "allow" } },
    } };
    const target = resolve(process.cwd(), "..", "approved.txt");
    const scoped = openCodePermissionAskConfig(JSON.stringify(original), "devflow-review",
      { calls: [{ name: "read", parameters: { filePath: target } }] }, true, process.cwd());
    const config = JSON.parse(scoped.content);
    expect(config.permission).toEqual(original.permission);
    expect(config.agent["devflow-review-child"]).toEqual(original.agent["devflow-review-child"]);
    expect(config.agent["devflow-review"].permission).toEqual({ "*": "deny", bash: "deny", read: "allow",
      external_directory: { [join(dirname(target), "*").replaceAll("\\", "/")]: "ask" } });
    expect(scoped.unmappedTools).toEqual([]);
  });

  it("maps exact write paths to edit but preserves unsupported and inherited native rules", () => {
    const original = { agent: { "devflow-executor": { mode: "primary", permission: { "*": "deny", read: "allow" } } } };
    const scoped = openCodePermissionAskConfig(JSON.stringify(original), "devflow-executor",
      { calls: [{ name: "write", parameters: { filePath: "approved.txt" } }] }, false, process.cwd());
    const permission = JSON.parse(scoped.content).agent["devflow-executor"].permission;
    expect(permission.edit).toEqual({ [relative(process.cwd(), resolve("approved.txt"))]: "ask" });
    expect(permission.read).toBe("allow");
    expect(permission["*"]).toBe("deny");
    expect(permission.write).toBeUndefined();
    expect(permission.doom_loop).toBeUndefined();
    const unknown = openCodePermissionAskConfig(JSON.stringify(original), "devflow-executor",
      { calls: [{ name: "server_tool" }, { name: "bash", parameters: { command: "echo hello" } },
        { name: "apply_patch", parameters: { patchText: "patch" } }] }, false, process.cwd());
    expect(JSON.parse(unknown.content)).toEqual(original);
    expect(unknown.unmappedTools).toEqual(["server_tool", "bash", "apply_patch"]);
    const inherited = { permission: { external_directory: "allow" }, agent: {
      "devflow-executor": { mode: "primary", permission: { read: "allow" } },
    } };
    const inheritedResult = openCodePermissionAskConfig(JSON.stringify(inherited), "devflow-executor",
      { calls: [{ name: "read", parameters: { filePath: resolve(process.cwd(), "..", "approved.txt") } }] }, false, process.cwd());
    expect(JSON.parse(inheritedResult.content)).toEqual(inherited);
    expect(inheritedResult.unmappedTools).toEqual(["read"]);
    expect(() => openCodePermissionAskConfig(JSON.stringify(original), "devflow-executor", { calls: [{ name: "write" }] }, true, process.cwd())).toThrow(/read-only/);
  });

  it.skipIf(process.platform !== "win32")("rejects an unresolved Windows shell wrapper", () => {
    for (const executable of ["opencode.cmd", "opencode.bat", "opencode.ps1"])
      expect(() => openCodePermissionInvocation({ ...openCodeInvocation(), executable }, true, "ses_original")).toThrow(/resolved Windows executable/);
  });

  it("cleans partial artifact creation without deleting a pre-existing file", () => {
    const root = mkdtempSync(join(tmpdir(), "devflow-permission-partial-"));
    try {
      const first = join(root, "first.mjs");
      const existing = join(root, "existing.json");
      writeFileSync(existing, "preserved");
      expect(() => writePermissionArtifacts([
        { path: first, content: "partial" }, { path: existing, content: "replacement" },
      ])).toThrow();
      expect(existsSync(first)).toBe(false);
      expect(readFileSync(existing, "utf8")).toBe("preserved");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves the original executable prefix, session, model, variant, agent and prompt", () => {
    const invocation = openCodeInvocation();
    const parsed = openCodePermissionInvocation(invocation, true, "ses_original");
    expect(parsed).toEqual({ executable: process.execPath, prefix: ["opencode-entry.mjs"], cwd: process.cwd(),
      session: "ses_original", prompt: "继续原任务\n保留用户原文", model: { providerID: "provider", modelID: "custom-model" },
      variant: "medium", agent: "devflow-review", readonly: true });
    expect(invocation.args.at(-1)).toBe("继续原任务\n保留用户原文");
  });

  it("refuses another session, unknown options, and a writable agent for a read-only run", () => {
    const invocation = openCodeInvocation();
    expect(() => openCodePermissionInvocation(invocation, true, "ses_other")).toThrow();
    expect(() => openCodePermissionInvocation({ ...invocation, args: [...invocation.args, "--auto"] }, true, "ses_original")).toThrow();
    expect(() => openCodePermissionInvocation({ ...invocation,
      args: invocation.args.map(arg => arg === "devflow-review" ? "devflow-executor" : arg),
    }, true, "ses_original")).toThrow();
  });

  it("adds a Claude hook in separate Run settings and cleans only its two files", () => {
    const root = mkdtempSync(join(tmpdir(), "devflow-permission-bridge-"));
    try {
      const directory = join(root, "claude-session");
      mkdirSync(directory);
      const settings = join(directory, "settings.json");
      const original = JSON.stringify({ hooks: { SubagentStart: [{ hooks: [] }] }, env: { KEEP: "value" } });
      writeFileSync(settings, original);
      const invocation: PreparedInvocation = { executable: "claude", cwd: root, env: {}, args: ["--settings", settings, "--", "prompt"] };
      const bridge = prepareClaudePermissionBridge(invocation, root, { calls: [{ name: "Read" }] }, true, "session-original");
      const generated = bridge.invocation.args[bridge.invocation.args.indexOf("--settings") + 1]!;
      const config = JSON.parse(readFileSync(generated, "utf8"));
      expect(config.env).toEqual({ KEEP: "value" });
      expect(config.hooks.SubagentStart).toEqual([{ hooks: [] }]);
      expect(config.hooks.PreToolUse[0].hooks[0]).toMatchObject({ command: process.execPath, onFailure: "block" });
      expect(config.hooks.PreToolUse[0].hooks[0].args).toEqual([join(root, "claude-permission-hook.mjs")]);
      bridge.cleanup();
      expect(existsSync(generated)).toBe(false);
      expect(existsSync(join(root, "claude-permission-hook.mjs"))).toBe(false);
      expect(readFileSync(settings, "utf8")).toBe(original);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("refuses to replace Claude settings outside the current Run", () => {
    const root = mkdtempSync(join(tmpdir(), "devflow-permission-boundary-"));
    try {
      const invocation: PreparedInvocation = { executable: "claude", cwd: root, env: {}, args: ["--settings", join(root, "..", "user-settings.json")] };
      expect(() => prepareClaudePermissionBridge(invocation, root, { calls: [{ name: "Read" }] }, true, "session-original")).toThrow(/outside its Run/);
      expect(existsSync(join(root, "claude-permission-hook.mjs"))).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
