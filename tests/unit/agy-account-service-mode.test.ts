import { describe, it, expect } from "vitest";
import { assertServiceMode } from "../../packages/service/src/service-mode.js";
describe("service mode compatibility", () => {
  it("reuses full mode for accounts only with the advertised feature", () => {
    expect(() =>
      assertServiceMode(
        { mode: "full", features: { agy_accounts: true } },
        "accounts",
      ),
    ).not.toThrow();
    expect(() => assertServiceMode({ mode: "full" }, "accounts")).toThrow(
      /更新/,
    );
  });
  it("rejects using accounts-only mode for workflow requests", () => {
    expect(() =>
      assertServiceMode(
        { mode: "accounts", features: { agy_accounts: true } },
        "full",
      ),
    ).toThrow(/SERVICE_MODE_CONFLICT/);
  });
  it("keeps older workflow-only services compatible with full requests", () => {
    expect(() => assertServiceMode({}, "full")).not.toThrow();
  });
});
