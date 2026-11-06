import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resolveAdapterExecutable,
  setAdapterExecutableResolver,
} from "../../packages/adapters/sdk/src/registry.js";

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

describe("isolated executable lookup", () => {
  it("uses the embedding resolver for both defaults and explicit paths", () => {
    const resolver = vi.fn(() => "C:/fixture/probe.mjs");
    restore = setAdapterExecutableResolver(resolver);
    expect(resolveAdapterExecutable("cursor-agent")).toBe(
      "C:/fixture/probe.mjs",
    );
    expect(resolveAdapterExecutable("codex", "custom-cli")).toBe(
      "C:/fixture/probe.mjs",
    );
    expect(resolver.mock.calls).toEqual([
      ["cursor-agent", undefined],
      ["codex", "custom-cli"],
    ]);
  });

  it("never falls back to an installed host executable on an injected miss", () => {
    restore = setAdapterExecutableResolver(() => undefined);
    expect(resolveAdapterExecutable("codex", process.execPath)).toBeUndefined();
  });

  it("uses the OpenCode executable selected by PATH ahead of system fallbacks", () => {
    const directory = mkdtempSync(join(tmpdir(), "devflow-opencode-path-"));
    const path = join(directory, process.platform === "win32" ? "opencode.exe" : "opencode");
    writeFileSync(path, "", { mode: 0o700 });
    vi.stubEnv("PATH", directory);
    try { expect(normalize(resolveAdapterExecutable("opencode")!)).toBe(path); }
    finally { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); }
  });

  it("restores the prior resolver after a nested embedding scope", () => {
    restore = setAdapterExecutableResolver(() => "outer");
    const restoreInner = setAdapterExecutableResolver(() => "inner");
    expect(resolveAdapterExecutable("agy")).toBe("inner");
    restoreInner();
    expect(resolveAdapterExecutable("agy")).toBe("outer");
  });
});
