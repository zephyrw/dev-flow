import { z } from "zod";
import type { Store } from "../../store/src/store.js";
import type { Config } from "../../contracts/src/config.js";
import {
  FlowError,
  MutationReceiptSchema,
  ModelDefaultsSchema,
  ToolProfileSchema,
  RoleBindingSchema,
  parseStoredToolProfile,
  type ModelDefaults,
  type MutationReceipt,
  type ToolProfile,
  type RoleBinding,
} from "../../contracts/src/index.js";
import { assertProfilesVerified } from "./access-guard.js";
import { now, objectHash } from "./util.js";

const DEFAULTS_KIND = "model_defaults";
const DEFAULTS_ID = "global";
const OPERATION_KIND = "model_config_operation";
const PREFILL_PLANNER_MODEL = "gpt-6-astra";
// Gemini 3.8 Flash 思考强度最高只有 high；预填默认执行模型对齐产品要求（不再用 3.7）。
const LEGACY_PREFILL_EXECUTOR_MODEL = "gemini-3.7-flash-high";
const PREFILL_EXECUTOR_MODEL = "gemini-3.8-flash-high";

/**
 * 存量迁移：仅当 source 为 legacy-import 且执行模型恰为旧预填默认值 3.7 时升级到 3.8。
 * 用户手动保存（source:"user"）的配置不强制覆盖。
 */
export function migrateLegacyExecutorModel(defaults: ModelDefaults): ModelDefaults {
  if (defaults.source !== "legacy-import") return defaults;
  if (defaults.executorProfile.modelId !== LEGACY_PREFILL_EXECUTOR_MODEL) {
    return defaults;
  }
  const nextRevision = (defaults.revision ?? 1) + 1;
  const nextProfileRevision = (defaults.executorProfile.revision ?? 1) + 1;
  return ModelDefaultsSchema.parse({
    ...defaults,
    revision: nextRevision,
    updated_at: now(),
    executorProfile: {
      ...defaults.executorProfile,
      revision: nextProfileRevision,
      modelId: PREFILL_EXECUTOR_MODEL,
    },
  });
}

export type SaveModelDefaultsRequest = {
  request_id: string;
  expected_defaults_revision: number;
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  reviewerBinding?: RoleBinding;
  reviewer_binding?: RoleBinding;
  expected_version?: unknown;
  role_overrides?: unknown;
  roleOverrides?: unknown;
};

type DefaultsOperation = {
  id: string;
  operation_type: "save_defaults";
  entity_id: string;
  request_id: string;
  request_hash: string;
  status: "prepared" | "committed" | "rejected";
  receipt?: MutationReceipt;
  created_at: string;
  updated_at: string;
};

export function plannerProfileFromConfig(config?: Config): ToolProfile {
  return ToolProfileSchema.parse({
    id: "planner",
    revision: 1,
    adapterId: "codex",
    executableRef: config?.models.codex_executable ?? "codex",
    modelSelection: "explicit",
    modelId: config?.models.reviewer ?? PREFILL_PLANNER_MODEL,
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  });
}

export function executorProfileFromConfig(config?: Config): ToolProfile {
  return ToolProfileSchema.parse({
    id: "executor",
    revision: 1,
    adapterId: "agy",
    executableRef: config?.models.agy_executable ?? "agy",
    modelSelection: "explicit",
    modelId: config?.models.executor ?? PREFILL_EXECUTOR_MODEL,
    reasoning: { mode: "explicit", value: "high" },
    selectionKind: "fixed",
    options: {},
  });
}

function parseDefaults(raw: unknown): ModelDefaults {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new FlowError("INVALID_REQUEST", "系统默认配置无法读取", 500);
  }
  const input = { ...(raw as Record<string, unknown>) };
  if (input.plannerProfile) {
    input.plannerProfile = parseStoredToolProfile(input.plannerProfile);
  }
  if (input.executorProfile) {
    input.executorProfile = parseStoredToolProfile(input.executorProfile);
  }
  if (input.reviewerBinding) {
    const rb = input.reviewerBinding as any;
    if (rb.mode === "explicit" && rb.profile) {
      input.reviewerBinding = {
        mode: "explicit",
        profile: parseStoredToolProfile(rb.profile),
      };
    }
  } else {
    input.reviewerBinding = { mode: "inherit" };
  }
  return ModelDefaultsSchema.parse(input);
}

function defaultsOperationId(requestId: string): string {
  return (
    "op-" +
    objectHash({ type: "save_defaults", entity: DEFAULTS_ID, requestId })
  ).slice(0, 80);
}

function rejectAmbiguousDefaultsFields(req: SaveModelDefaultsRequest) {
  const hasExpectedVersion = Object.prototype.hasOwnProperty.call(
    req,
    "expected_version",
  );
  const revision = req.expected_defaults_revision;
  const hasRevision =
    typeof revision === "number" && Number.isInteger(revision) && revision >= 0;
  if (hasExpectedVersion && !hasRevision) {
    throw new FlowError(
      "AMBIGUOUS_VERSION_FIELD",
      "请使用 expected_defaults_revision，不要再传 expected_version",
      422,
    );
  }
  if (Object.prototype.hasOwnProperty.call(req, "role_overrides")) {
    throw new FlowError("INVALID_REQUEST", "系统默认不接受角色覆盖", 422);
  }
  if (Object.prototype.hasOwnProperty.call(req, "roleOverrides")) {
    throw new FlowError("INVALID_REQUEST", "系统默认不接受角色覆盖", 422);
  }
}

function parseSaveRequest(req: SaveModelDefaultsRequest) {
  rejectAmbiguousDefaultsFields(req);
  const requestId = z.string().uuid().parse(req.request_id);
  const expected = z
    .number()
    .int()
    .nonnegative()
    .parse(req.expected_defaults_revision);
  const rawBinding = req.reviewerBinding ?? req.reviewer_binding;
  const reviewerBinding = rawBinding
    ? RoleBindingSchema.parse(rawBinding)
    : undefined;
  return {
    request_id: requestId,
    expected_defaults_revision: expected,
    plannerProfile: ToolProfileSchema.parse(req.plannerProfile),
    executorProfile: ToolProfileSchema.parse(req.executorProfile),
    reviewerBinding,
  };
}

function hashSaveRequest(parsed: {
  expected_defaults_revision: number;
  plannerProfile: ToolProfile;
  executorProfile: ToolProfile;
  reviewerBinding?: RoleBinding;
}) {
  return objectHash({
    expected_defaults_revision: parsed.expected_defaults_revision,
    plannerProfile: parsed.plannerProfile,
    executorProfile: parsed.executorProfile,
    reviewerBinding: parsed.reviewerBinding,
  });
}

function committedReceipt(
  operationId: string,
  requestId: string,
  revision: number,
): MutationReceipt {
  return MutationReceiptSchema.parse({
    operation_id: operationId,
    request_id: requestId,
    status: "committed",
    entity_revision: revision,
    changed: true,
    effective_from: "new-workflows",
    current_run_id: null,
    pending_roles: [],
  });
}

export class ModelDefaultsService {
  constructor(private store: Store) {}

  getOrImport(config?: Config): ModelDefaults {
    return this.store.transaction(() => {
      const raw = this.store.get<unknown>(DEFAULTS_KIND, DEFAULTS_ID);
      if (raw) {
        const existing = parseDefaults(raw);
        if (
          existing.source === "legacy-import" &&
          existing.executorProfile.modelId === LEGACY_PREFILL_EXECUTOR_MODEL
        ) {
          const migrated = migrateLegacyExecutorModel(existing);
          this.store.put(DEFAULTS_KIND, DEFAULTS_ID, "global", migrated);
          this.store.event("global", "global", "model_defaults_migrated", {
            previous_revision: existing.revision,
            revision: migrated.revision,
            executor: migrated.executorProfile.modelId,
          });
          return migrated;
        }
        return existing;
      }
      const imported = this.buildImported(config);
      this.store.put(DEFAULTS_KIND, DEFAULTS_ID, "global", imported);
      this.store.event("global", "global", "model_defaults_imported", {
        revision: imported.revision,
        source: imported.source,
      });
      return imported;
    });
  }

  save(req: SaveModelDefaultsRequest): MutationReceipt {
    const parsed = parseSaveRequest(req);
    const operationId = defaultsOperationId(parsed.request_id);
    const requestHash = hashSaveRequest(parsed);
    return this.store.transaction(() =>
      this.commitSave(parsed, operationId, requestHash),
    );
  }

  private readExisting(): ModelDefaults | undefined {
    const raw = this.store.get<unknown>(DEFAULTS_KIND, DEFAULTS_ID);
    return raw ? parseDefaults(raw) : undefined;
  }

  private buildImported(config?: Config): ModelDefaults {
    return ModelDefaultsSchema.parse({
      schema_version: 2,
      revision: 1,
      plannerProfile: plannerProfileFromConfig(config),
      executorProfile: executorProfileFromConfig(config),
      reviewerBinding: { mode: "inherit" },
      updated_at: now(),
      source: "legacy-import",
    });
  }

  private commitSave(
    parsed: ReturnType<typeof parseSaveRequest>,
    operationId: string,
    requestHash: string,
  ): MutationReceipt {
    const prior = this.store.get<DefaultsOperation>(
      OPERATION_KIND,
      operationId,
    );
    if (prior) {
      if (prior.request_hash !== requestHash) {
        throw new FlowError(
          "IDEMPOTENCY_CONFLICT",
          "同一请求不能修改为不同内容",
          409,
        );
      }
      if (prior.status === "committed" && prior.receipt) {
        return MutationReceiptSchema.parse(prior.receipt);
      }
    }
    const current = this.readExisting();
    const currentRevision = current?.revision ?? 0;
    if (parsed.expected_defaults_revision !== currentRevision) {
      throw new FlowError(
        "DEFAULTS_VERSION_CONFLICT",
        "系统默认配置版本已变化",
        409,
      );
    }

    const effectiveReviewerBinding =
      parsed.reviewerBinding ?? current?.reviewerBinding ?? { mode: "inherit" };

    const profilesToVerify = [
      parsed.plannerProfile,
      parsed.executorProfile,
      ...(effectiveReviewerBinding.mode === "explicit" &&
      effectiveReviewerBinding.profile
        ? [effectiveReviewerBinding.profile]
        : []),
    ];
    // 相同完整 profile 语义哈希只核验一次，按顺序执行
    const seenHashes = new Set<string>();
    const uniqueProfilesToVerify: ToolProfile[] = [];
    for (const p of profilesToVerify) {
      const pHash = objectHash(p);
      if (!seenHashes.has(pHash)) {
        seenHashes.add(pHash);
        uniqueProfilesToVerify.push(p);
      }
    }
    assertProfilesVerified(this.store, uniqueProfilesToVerify);

    const next = ModelDefaultsSchema.parse({
      schema_version: 2,
      revision: currentRevision + 1,
      plannerProfile: parsed.plannerProfile,
      executorProfile: parsed.executorProfile,
      reviewerBinding: effectiveReviewerBinding,
      updated_at: now(),
      source: "user",
    });
    this.store.put(DEFAULTS_KIND, DEFAULTS_ID, "global", next);
    this.store.remove("model_defaults_draft", "global");
    this.store.event("global", "global", "model_defaults_updated", {
      revision: next.revision,
      previous_revision: currentRevision,
    });
    const receipt = committedReceipt(
      operationId,
      parsed.request_id,
      next.revision,
    );
    const record: DefaultsOperation = {
      id: operationId,
      operation_type: "save_defaults",
      entity_id: DEFAULTS_ID,
      request_id: parsed.request_id,
      request_hash: requestHash,
      status: "committed",
      receipt,
      created_at: prior?.created_at ?? now(),
      updated_at: now(),
    };
    this.store.put(OPERATION_KIND, operationId, "global", record);
    return receipt;
  }
}
