import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("node:os", () => ({ homedir: () => "C:/fixture-user" }));
vi.mock("node:fs", () => ({
  existsSync: (path: string) => files.has(path),
  readFileSync: (path: string) => {
    const text = files.get(path);
    if (text === undefined) throw new Error("fixture file absent");
    return text;
  },
}));

import {
  identityInputFromProfile,
  nativeProfileSupported,
} from "../../packages/adapters/sdk/src/native-identity.js";

beforeEach(() => {
  files.clear();
  vi.stubEnv("CODEX_HOME", "");
});
afterEach(() => vi.unstubAllEnvs());

describe("native model identity", () => {
  it("uses the stable nested account id across token refreshes", () => {
    const path = join("C:/fixture-user", ".codex", "auth.json");
    files.set(
      path,
      JSON.stringify({
        tokens: { account_id: "account-a", access_token: "fixture-first" },
      }),
    );
    const first = identityInputFromProfile({ adapterId: "codex" });
    files.set(
      path,
      JSON.stringify({
        tokens: { account_id: "account-a", access_token: "fixture-refreshed" },
      }),
    );
    expect(identityInputFromProfile({ adapterId: "codex" })).toEqual(first);
    expect(first).toMatchObject({
      accountId: "account-a",
      identityConfidence: "account",
    });
    expect(JSON.stringify(first)).not.toContain("fixture-first");
  });

  it("uses the same configured Codex home as native discovery", () => {
    vi.stubEnv("CODEX_HOME", "C:/fixture-codex");
    files.set(
      join("C:/fixture-codex", "auth.json"),
      JSON.stringify({ tokens: { account_id: "custom-account" } }),
    );
    files.set(
      join("C:/fixture-codex", "config.toml"),
      [
        'model_provider = "public"',
        "[profiles.work]",
        'model_provider = "work"',
        "[model_providers.work]",
        'base_url = "https://fixture.invalid/api"',
        'api_key = "fixture-not-an-identity"',
      ].join("\n"),
    );
    expect(
      identityInputFromProfile({
        adapterId: "codex",
        nativeConfigProfile: "work",
      }),
    ).toEqual({
      nativeConfigScope: expect.stringMatching(/^codex-config:/),
      accountId: "custom-account",
      identityConfidence: "account",
      providerEndpoint: "https://fixture.invalid/api",
    });
  });

  it("never treats analytics ids or token strings as an account", () => {
    files.set(
      join("C:/fixture-user", ".claude.json"),
      JSON.stringify({
        statsigUserID: "telemetry",
        access_token: "fixture-secret",
      }),
    );
    expect(identityInputFromProfile({ adapterId: "claude-code" })).toEqual({
      nativeConfigScope: "default",
      identityConfidence: "profile-scope",
    });
  });

  it("isolates configuration homes without account ids and normalizes the same root", () => {
    vi.stubEnv("CODEX_HOME", "C:/fixture-codex-a");
    const first = identityInputFromProfile({ adapterId: "codex" });
    vi.stubEnv("CODEX_HOME", "C:/fixture-codex-a/child/..");
    expect(identityInputFromProfile({ adapterId: "codex" })).toEqual(first);
    vi.stubEnv("CODEX_HOME", "C:/fixture-codex-b");
    const second = identityInputFromProfile({ adapterId: "codex" });
    expect(second.identityConfidence).toBe("profile-scope");
    expect(second.nativeConfigScope).not.toBe(first.nativeConfigScope);
    expect(second.nativeConfigScope).not.toContain("fixture-codex-b");
    const named = identityInputFromProfile({ adapterId: "codex", nativeConfigProfile: "work" });
    expect(named.nativeConfigScope).not.toBe(second.nativeConfigScope);
  });

  it("does not advertise unsupported native profile selectors", () => {
    expect(nativeProfileSupported("codex")).toBe(true);
    for (const adapter of [
      "agy",
      "claude-code",
      "cursor-agent",
      "grok-build",
      "kimi-code",
      "opencode",
      "qoder",
    ]) {
      expect(nativeProfileSupported(adapter)).toBe(false);
    }
  });
});
