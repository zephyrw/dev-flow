import type { ModelEntry, ToolProfile } from "../../../../packages/contracts/src/index.js";
import { buildModelChoices, type ModelChoice } from "../../../../packages/presentation/src/model-display.js";
import type { DefaultsSnapshot } from "./model-api.js";

export type ModelDefaultsDraft = Pick<DefaultsSnapshot, "plannerProfile" | "executorProfile" | "reviewerBinding">;
export type EffortCatalog = { entries: ModelEntry[]; status?: string; discoveryStatus?: string };

export function findProfileModelChoice(profile: ToolProfile, choices: ModelChoice[]): ModelChoice | null {
  if (!profile.modelId) return null;
  return choices.find(choice =>
    choice.choiceId === profile.modelId || choice.nativeId === profile.modelId ||
    choice.entryIds.some(id => id.endsWith(`/${profile.modelId}`)) ||
    Object.values(choice.variantByEffort).includes(profile.modelId!),
  ) ?? null;
}

/** Normalize editable defaults only; never mutate a profile held by a frozen run. */
export function normalizeDefaultsEffort(
  draft: ModelDefaultsDraft,
  catalogs: ReadonlyMap<string, EffortCatalog>,
): ModelDefaultsDraft {
  const normalize = (profile: ToolProfile) => {
    const catalog = catalogs.get(profile.adapterId);
    if (!catalog || catalog.status !== "fresh" ||
        catalog.discoveryStatus === "missing" || catalog.discoveryStatus === "partial") return profile;
    return normalizeProfileEffort(profile, findProfileModelChoice(profile, buildModelChoices(catalog.entries)));
  };
  return {
    plannerProfile: normalize(draft.plannerProfile),
    executorProfile: normalize(draft.executorProfile),
    reviewerBinding: draft.reviewerBinding?.mode === "explicit" && draft.reviewerBinding.profile
      ? { ...draft.reviewerBinding, profile: normalize(draft.reviewerBinding.profile) }
      : draft.reviewerBinding,
  };
}

/** Call only after the current catalog has finished loading successfully. */
export function normalizeProfileEffort(
  profile: ToolProfile,
  choice: Pick<ModelChoice, "effortStatus" | "effortValues"> | null,
): ToolProfile {
  if (!profile.modelId || profile.reasoning?.mode !== "explicit") return profile;
  if (choice?.effortStatus === "supported" &&
      choice.effortValues.includes(profile.reasoning.value)) return profile;
  return {
    ...profile,
    reasoning: choice?.effortStatus === "unsupported"
      ? { mode: "not-applicable" }
      : { mode: "native-default" },
  };
}
