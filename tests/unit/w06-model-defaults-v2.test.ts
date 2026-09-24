import { describe, expect, it, beforeEach } from "vitest";
import { setup, repository } from "../helpers.js";
import { ModelDefaultsService } from "../../packages/core/src/model-defaults-service.js";
import { CreateWorkflowService } from "../../packages/core/src/create-workflow.js";
import { ExecutionSpecService } from "../../packages/core/src/execution-spec-service.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import type { ToolProfile } from "../../packages/contracts/src/index.js";
import { buildServer } from "../../apps/api/src/server.js";

const dummyProfile1: ToolProfile = {
  id: "p1",
  revision: 1,
  adapterId: "codex",
  modelId: "gpt-4o",
  modelSelection: "explicit",
  selectionKind: "fixed",
  options: {},
};

const dummyProfile2: ToolProfile = {
  id: "p2",
  revision: 1,
  adapterId: "agy",
  modelId: "gemini-2.5-pro",
  modelSelection: "explicit",
  selectionKind: "fixed",
  options: {},
};

const dummyReviewerProfile: ToolProfile = {
  id: "p3",
  revision: 1,
  adapterId: "codex",
  modelId: "o3-mini",
  modelSelection: "explicit",
  selectionKind: "fixed",
  options: {},
};

describe("W06: 三阶段默认模型与工作流创建绑定测试", () => {
  let env: ReturnType<typeof setup>;
  let service: ModelDefaultsService;

  beforeEach(() => {
    env = setup();
    service = new ModelDefaultsService(env.store);
    seedVerifiedAccess(env.store, dummyProfile1);
    seedVerifiedAccess(env.store, dummyProfile2);
    seedVerifiedAccess(env.store, dummyReviewerProfile);
  });

  it("ModelDefaultsService 正确保存并读取 V2 默认模型，包含 reviewerBinding", () => {
    // 首次导入/初始化
    const current = service.getOrImport();
    expect(current.schema_version).toBe(2);
    expect(current.reviewerBinding).toEqual({ mode: "inherit" });

    // 保存三阶段配置，其中复核为 explicit
    const saveReq = {
      request_id: crypto.randomUUID(),
      expected_defaults_revision: current.revision,
      plannerProfile: dummyProfile1,
      executorProfile: dummyProfile2,
      reviewerBinding: {
        mode: "explicit" as const,
        profile: dummyReviewerProfile,
      },
    };

    const receipt = service.save(saveReq);
    expect(receipt.entity_revision).toBe(current.revision + 1);

    const updated = service.getOrImport();
    expect(updated.revision).toBe(receipt.entity_revision);
    expect(updated.plannerProfile.modelId).toBe("gpt-4o");
    expect(updated.executorProfile.modelId).toBe("gemini-2.5-pro");
    expect(updated.reviewerBinding.mode).toBe("explicit");
    if (updated.reviewerBinding.mode === "explicit") {
      expect(updated.reviewerBinding.profile.modelId).toBe("o3-mini");
    }

    // CAS 版本冲突检测
    expect(() =>
      service.save({
        request_id: crypto.randomUUID(),
        expected_defaults_revision: current.revision, // 过期的 revision
        plannerProfile: dummyProfile1,
        executorProfile: dummyProfile2,
        reviewerBinding: { mode: "inherit" },
      }),
    ).toThrow();
  });

  it("创建新工作流时自动继承全局 defaults.reviewerBinding，且后续全局修改不影响已有工作流", async () => {
    const repo = await repository(env.root);
    // 1. 设置全局默认模型，reviewer 为 explicit
    const current = service.getOrImport();
    service.save({
      request_id: crypto.randomUUID(),
      expected_defaults_revision: current.revision,
      plannerProfile: dummyProfile1,
      executorProfile: dummyProfile2,
      reviewerBinding: {
        mode: "explicit",
        profile: dummyReviewerProfile,
      },
    });

    const createService = new CreateWorkflowService(env.store, env.config);
    const wfResult1 = createService.execute({
      request_id: crypto.randomUUID(),
      request_text: "完成需求1",
      workspace_root: repo.repo,
    });

    // 验证新创建的工作流 spec 中的 reviewer 是否为 explicit 且对应 o3-mini
    const specService = new ExecutionSpecService(env.store, env.config);
    const spec1 = specService.getLatestSpec(wfResult1.workflow.id);
    expect(spec1).toBeDefined();
    expect(spec1?.roleOverrides?.reviewer?.mode).toBe("explicit");
    if (spec1?.roleOverrides?.reviewer?.mode === "explicit") {
      expect(spec1.roleOverrides.reviewer.profile.modelId).toBe("o3-mini");
    }

    // 2. 将全局默认模型修改回 inherit
    const latest = service.getOrImport();
    service.save({
      request_id: crypto.randomUUID(),
      expected_defaults_revision: latest.revision,
      plannerProfile: dummyProfile1,
      executorProfile: dummyProfile2,
      reviewerBinding: { mode: "inherit" },
    });

    // 3. 验证已有工作流 1 的 spec 完全不受影响
    const spec1After = specService.getLatestSpec(wfResult1.workflow.id);
    expect(spec1After?.roleOverrides?.reviewer?.mode).toBe("explicit");
    if (spec1After?.roleOverrides?.reviewer?.mode === "explicit") {
      expect(spec1After.roleOverrides.reviewer.profile.modelId).toBe("o3-mini");
    }

    // 4. 创建新工作流 2（独立工作区），此时应继承 inherit
    const repo2 = await repository(env.root, "repo2");
    const wfResult2 = createService.execute({
      request_id: crypto.randomUUID(),
      request_text: "完成需求2",
      workspace_root: repo2.repo,
    });
    const spec2 = specService.getLatestSpec(wfResult2.workflow.id);
    expect(spec2?.roleOverrides?.reviewer?.mode).toBe("inherit");
  });

  it("API /api/settings/model-defaults 返回正确结构并能更新", async () => {
    const app = await buildServer(env.engine);

    // 1. GET 默认模型
    const getRes = await app.inject({
      method: "GET",
      url: "/api/settings/model-defaults",
      headers: { host: "localhost:14810", origin: "http://localhost:14810" },
    });
    expect(getRes.statusCode).toBe(200);
    const getData = JSON.parse(getRes.body);
    expect(getData.defaults).toBeDefined();
    expect(getData.readiness).toBeDefined();
    expect(getData.readiness.reviewer).toBeDefined();

    // 2. PUT 更新默认模型
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/settings/model-defaults",
      headers: {
        host: "localhost:14810",
        origin: "http://localhost:14810",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        request_id: crypto.randomUUID(),
        expected_defaults_revision: getData.defaults.revision,
        planner_profile: dummyProfile1,
        executor_profile: dummyProfile2,
        reviewer_binding: {
          mode: "explicit",
          profile: dummyReviewerProfile,
        },
      }),
    });
    if (putRes.statusCode !== 200) {
      console.log("PUT Error response:", putRes.body);
    }
    expect(putRes.statusCode).toBe(200);

    // 再次 GET 验证已更新
    const getRes2 = await app.inject({
      method: "GET",
      url: "/api/settings/model-defaults",
      headers: { host: "localhost:14810", origin: "http://localhost:14810" },
    });
    const getData2 = JSON.parse(getRes2.body);
    expect(getData2.defaults.reviewerBinding.mode).toBe("explicit");
    expect(getData2.defaults.reviewerBinding.profile.modelId).toBe("o3-mini");

    await app.close();
  });
});
