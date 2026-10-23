import { describe, expect, it } from "vitest";
import type { ModelEntry, ToolProfile } from "../../packages/contracts/src/index.js";
import { normalizeDefaultsEffort, normalizeProfileEffort, type EffortCatalog, type ModelDefaultsDraft } from "../../apps/web/src/components/model-profile-effort.js";

const selected: ToolProfile = {
  id: "planner", revision: 1, adapterId: "claude-code",
  modelSelection: "explicit", modelId: "deepseek-v4.1-flash",
  selectionKind: "fixed", reasoning: { mode: "explicit", value: "medium" }, options: {},
};

describe("model profile effort after catalog resolution", () => {
  it("preserves a supported explicit selection without changing the profile", () => {
    expect(normalizeProfileEffort(selected, {
      effortStatus: "supported", effortValues: ["low", "medium", "high"],
    })).toBe(selected);
  });

  it.each([
    { effortStatus: "unknown" as const, effortValues: ["medium"] },
    { effortStatus: "supported" as const, effortValues: ["high"] },
    null,
  ])("drops an unconfirmed explicit effort without mutating the original selection", (choice) => {
    const normalized = normalizeProfileEffort(selected, choice);
    expect(normalized).toEqual({ ...selected, reasoning: { mode: "native-default" } });
    expect(selected.reasoning).toEqual({ mode: "explicit", value: "medium" });
    expect(normalizeProfileEffort(normalized, choice)).toBe(normalized);
  });

  it("marks an explicitly unsupported effort as not applicable", () => {
    expect(normalizeProfileEffort(selected, {
      effortStatus: "unsupported", effortValues: [],
    }).reasoning).toEqual({ mode: "not-applicable" });
  });

  it("preserves native defaults and profiles awaiting model selection", () => {
    const nativeDefault: ToolProfile = { ...selected, reasoning: { mode: "native-default" } };
    const unselected: ToolProfile = { ...selected, modelId: undefined };
    expect(normalizeProfileEffort(nativeDefault, null)).toBe(nativeDefault);
    expect(normalizeProfileEffort(unselected, null)).toBe(unselected);
  });
});

describe("default model draft effort before save", () => {
  const entry = (adapterId: ModelEntry["adapterId"], status: ModelEntry["effort"]["status"]): ModelEntry => ({
    entryId: `${adapterId}/deepseek-v4.1-flash`, adapterId, nativeId: "deepseek-v4.1-flash",
    label: "DeepSeek V4.1 Flash", selectionKind: "fixed", source: "native-config",
    discoveredAt: "2026-10-23T00:00:00.000Z", hidden: false, availability: "listed",
    capabilityRevision: `effort-${status}`,
    effort: { status, transport: "flag", values: status === "supported" ? ["medium"] : [] },
  });
  const draft: ModelDefaultsDraft = {
    plannerProfile: selected,
    executorProfile: { ...selected, id: "executor", adapterId: "opencode" },
    reviewerBinding: { mode: "explicit", profile: { ...selected, id: "reviewer", adapterId: "opencode" } },
  };
  const catalog = (adapter: ModelEntry["adapterId"], status: ModelEntry["effort"]["status"]): EffortCatalog => ({
    status: "fresh", discoveryStatus: "complete", entries: [entry(adapter, status)],
  });

  it.each(["unsupported", "unknown"] as const)("normalizes unopened executor and explicit reviewer with %s effort", status => {
    const normalized = normalizeDefaultsEffort(draft, new Map([
      ["claude-code", catalog("claude-code", "supported")],
      ["opencode", catalog("opencode", status)],
    ]));
    const reasoning = { mode: status === "unsupported" ? "not-applicable" : "native-default" };
    const explicitReviewer = (b?: ModelDefaultsDraft["reviewerBinding"]) => b?.mode === "explicit" ? b.profile : undefined;
    expect(normalized.plannerProfile).toBe(draft.plannerProfile);
    expect(normalized.executorProfile.reasoning).toEqual(reasoning);
    expect(explicitReviewer(normalized.reviewerBinding)?.reasoning).toEqual(reasoning);
    expect(normalized.executorProfile.modelId).toBe(draft.executorProfile.modelId);
    // The source may also be referenced by a running invocation; it stays intact.
    expect(draft.executorProfile.reasoning).toEqual({ mode: "explicit", value: "medium" });
    expect(explicitReviewer(draft.reviewerBinding)?.reasoning).toEqual({ mode: "explicit", value: "medium" });
  });

  it.each([
    { status: "failed", discoveryStatus: "complete" },
    { status: "stale", discoveryStatus: "complete" },
    { status: "refreshing", discoveryStatus: "complete" },
    { status: "fresh", discoveryStatus: "missing" },
    { status: "fresh", discoveryStatus: "partial" },
  ])("preserves all role selections while the catalog is unusable: %j", state => {
    const explicitReviewer = (b?: ModelDefaultsDraft["reviewerBinding"]) => b?.mode === "explicit" ? b.profile : undefined;
    const normalized = normalizeDefaultsEffort(draft, new Map([
      ["claude-code", { ...catalog("claude-code", "unsupported"), ...state }],
      ["opencode", { ...catalog("opencode", "unsupported"), ...state }],
    ]));
    expect(normalized.plannerProfile).toBe(draft.plannerProfile);
    expect(normalized.executorProfile).toBe(draft.executorProfile);
    expect(explicitReviewer(normalized.reviewerBinding)).toBe(explicitReviewer(draft.reviewerBinding));
  });

  it("keeps inherited reviewer binding and missing catalogs unchanged", () => {
    const inherited: ModelDefaultsDraft = { ...draft, reviewerBinding: { mode: "inherit" } };
    const normalized = normalizeDefaultsEffort(inherited, new Map());
    expect(normalized.plannerProfile).toBe(inherited.plannerProfile);
    expect(normalized.executorProfile).toBe(inherited.executorProfile);
    expect(normalized.reviewerBinding).toBe(inherited.reviewerBinding);
  });
});
