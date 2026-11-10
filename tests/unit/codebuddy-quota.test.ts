import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseCodeBuddyCreditQuota } from "../../packages/adapters/codebuddy/src/credit-quota.js";
import { codeBuddyScope } from "../../packages/adapters/codebuddy/src/local-scope.js";

const pkg = (PackageCode: string, CycleRemainCapacity: unknown, CycleTotalCapacity?: unknown) =>
  ({ PackageCode, CycleRemainCapacity, CycleTotalCapacity });

it("keeps a real zero, sums disjoint credit groups, and only publishes known totals", () => {
  expect(parseCodeBuddyCreditQuota({ code: 0, data: { Packages: [
    pkg("monthly", "0", "500"), pkg("bonus", "17.23"),
  ] } })).toMatchObject({
    remaining: 17.23, total: undefined,
    packages: [{ code: "monthly", remaining: 0 }, { code: "bonus", remaining: 17.23 }],
  });
  expect(parseCodeBuddyCreditQuota({ data: { Packages: [pkg("monthly", 0)] } })?.remaining).toBe(0);
});

it("rejects duplicate groups and invalid or unauthenticated responses", () => {
  for (const data of [
    { Packages: [] },
    { Packages: [pkg("monthly", 12), pkg("monthly", 12)] },
    { Packages: [pkg("monthly", "")] },
    { Packages: [pkg("monthly", -1)] },
  ]) expect(parseCodeBuddyCreditQuota({ data })).toBeUndefined();
  expect(parseCodeBuddyCreditQuota({ code: 401, data: { Packages: [pkg("monthly", 0)] } })).toBeUndefined();
});

it("uses the official balance and named groups without adding the packages again", () => {
  expect(parseCodeBuddyCreditQuota({ data: {
    TotalCredits: "9.25",
    Packages: [pkg("package-a", 6, 10), pkg("package-b", 4, 5)],
    CreditGroups: [
      { Kind: "base", Name: "套餐积分", CycleRemainCapacity: "9.25", CapacityUnit: "credits", TotalCount: 2 },
      { Kind: "empty", Name: "其他积分", CycleRemainCapacity: 0, CapacityUnit: "credits", TotalCount: 0 },
    ],
  } })).toMatchObject({
    remaining: 9.25, total: 15, packages: [{ code: "base", name: "套餐积分", remaining: 9.25 }],
  });
});

it("keeps the account scope stable across token rotation and changes it on account switch or logout", () => {
  const home = mkdtempSync(join(tmpdir(), "devflow-codebuddy-auth-"));
  const parent = process.platform === "win32" ? join(home, "AppData", "Local")
    : process.platform === "darwin" ? join(home, "Library", "Application Support")
    : join(home, ".local", "share");
  const directory = join(parent, "CodeBuddyExtension", "Data", "Public", "auth");
  mkdirSync(directory, { recursive: true });
  const file = join(directory, "fixture.info");
  const auth = (uid: string, accessToken?: string) => writeFileSync(file, JSON.stringify({
    account: { uid },
    auth: { domain: "https://www.codebuddy.cn", accessToken, lastRefreshTime: Date.now() },
  }));
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEBUDDY_CONFIG_DIR", join(home, "config"));
  try {
    auth("fixture-one", "short");
    const first = codeBuddyScope();
    auth("fixture-one", "longer-refreshed-token");
    expect(codeBuddyScope()).toBe(first);
    auth("fixture-two", "longer-refreshed-token");
    const second = codeBuddyScope();
    expect(second).not.toBe(first);
    auth("fixture-two");
    expect(codeBuddyScope()).not.toBe(second);
  } finally {
    vi.unstubAllEnvs();
    rmSync(home, { recursive: true, force: true });
  }
});
