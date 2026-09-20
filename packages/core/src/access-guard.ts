import type { Store } from "../../store/src/store.js";
import {
  FlowError,
  ToolProfileSchema,
  type RoleOverrides,
  type ToolProfile,
} from "../../contracts/src/index.js";
import {
  ModelAccessService,
  type AccessIdentityInput,
} from "./model-access-service.js";
import { ModelCatalogService } from "./model-catalog-service.js";

function accessForStore(store: Store): ModelAccessService {
  return new ModelAccessService(store, {
    catalog: new ModelCatalogService(store),
  });
}

export function collectExplicitProfiles(
  planner: ToolProfile,
  executor: ToolProfile,
  overrides?: RoleOverrides,
): ToolProfile[] {
  const profiles = [planner, executor];
  if (!overrides) return profiles;
  for (const role of ["reviewer", "review_fixer", "functional_fixer"] as const) {
    const binding = overrides[role];
    if (binding.mode === "explicit") profiles.push(binding.profile);
  }
  return profiles;
}

export function assertProfilesVerified(
  store: Store,
  profiles: ToolProfile[],
  identity?: AccessIdentityInput,
): void {
  const access = accessForStore(store);
  for (const raw of profiles) {
    const profile = ToolProfileSchema.parse(raw);
    access.assertProfileSupported(profile);
    const resolvedIdentity = identity ?? access.identityFromProfile(profile);
    access.assertCachedAccess(profile, resolvedIdentity);
  }
}

export function seedVerifiedAccess(
  store: Store,
  profile: ToolProfile,
  identity?: AccessIdentityInput,
) {
  const access = accessForStore(store);
  return access.seedVerified(ToolProfileSchema.parse(profile), identity);
}

export function isModelAccessError(error: unknown): boolean {
  if (!(error instanceof FlowError)) return false;
  return (
    error.code === "MODEL_ACCESS_REQUIRED" ||
    error.code === "MODEL_LOGIN_REQUIRED" ||
    error.code === "MODEL_FORBIDDEN" ||
    error.code === "MODEL_UNAVAILABLE" ||
    error.code === "MODEL_NOT_LISTED" ||
    error.code === "VERIFICATION_ENVIRONMENT_UNAVAILABLE" ||
    error.code === "CLI_PARAMETER_UNSUPPORTED"
  );
}
