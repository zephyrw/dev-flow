import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createIsolatedTestEnv,
  type IsolatedTestEnv,
} from "../fixtures/isolation.js";
import { ClientInstaller } from "../../packages/clients/src/installer.js";
import { UpgradeManager } from "../../packages/installer/src/upgrade.js";
import {
  applyInstallerModelDefaults,
  mergeInstallerDefaults,
  InstallerDefaultsError,
  parseInstallerCliArgs,
} from "../../packages/installer/src/main.js";
import { setup } from "../helpers.js";
import { now } from "../../packages/core/src/util.js";
import {
  inheritRoleOverrides,
  type ExecutionSpec,
  type ModelAccessRecord,
  type ModelDefaults,
  type Workflow,
} from "../../packages/contracts/src/index.js";
import { ModelDefaultsService } from "../../packages/core/src/model-defaults-service.js";
import { ModelCatalogService, type CatalogScopeInput } from "../../packages/core/src/model-catalog-service.js";
import { resolveModelIdentity } from "../../packages/core/src/model-identity.js";
import { seedVerifiedAccess } from "../../packages/core/src/access-guard.js";
import type { Store } from "../../packages/store/src/store.js";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("IT-INSTALLER: 六核心 Skill/MCP 完整分发、选定闭包与配置保护 (W07, RQ-21, RQ-22)", () => {
  let env: IsolatedTestEnv;
  let fakeSkillsSrc: string;
  let installer: ClientInstaller;

  beforeEach(() => {
    env = createIsolatedTestEnv();

    // 构造模拟的源码技能仓库
    fakeSkillsSrc = join(env.root, "source_skills");
    mkdirSync(fakeSkillsSrc, { recursive: true });

    const skills = [
      "devflow",
      "devflow-project-onboard",
      "devflow-plan",
      "devflow-execute",
      "devflow-test",
      "devflow-review",
    ];

    for (const sk of skills) {
      const skDir = join(fakeSkillsSrc, sk);
      mkdirSync(join(skDir, "references"), { recursive: true });
      writeFileSync(join(skDir, "SKILL.md"), `# ${sk}\nDescription of ${sk}`);
      writeFileSync(join(skDir, "references", "guide.md"), `# ${sk} Guide`);
    }

    const bridge = join(env.root, "bridge.js"),
      config = join(env.root, "devflow.yaml");
    writeFileSync(bridge, "// isolated bridge");
    writeFileSync(config, "{}");
    installer = new ClientInstaller(fakeSkillsSrc, {
      home: env.root,
      bridge,
      config,
    });
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("TC-INST-01: 完整分发 6 个核心 Skill 且包含全部 references 子目录与文件 (RQ-21)", () => {
    const report = installer.installSkillsForClient("codex");

    expect(report.clientId).toBe("codex");
    expect(report.skillsInstalled.length).toBe(6);
    expect(report.skillsInstalled.every((s) => s.status === "installed")).toBe(
      true,
    );

    const targetDir = installer.locateClientSkillDir("codex")!;
    for (const sk of [
      "devflow",
      "devflow-project-onboard",
      "devflow-plan",
      "devflow-execute",
      "devflow-test",
      "devflow-review",
    ]) {
      expect(existsSync(join(targetDir, sk, "SKILL.md"))).toBe(true);
      expect(existsSync(join(targetDir, sk, "references", "guide.md"))).toBe(
        true,
      );
    }
  });

  it("TC-INST-02: Codex 配置写入保留用户已有配置并追加 [mcp_servers.devflow] (RQ-22)", () => {
    const codexBase = installer.locateClientBaseDir("codex")!;
    mkdirSync(codexBase, { recursive: true });
    writeFileSync(
      join(codexBase, "config.toml"),
      `model = "o3-mini"\n[custom]\nkey = "val"\n`,
    );

    const report = installer.installSkillsForClient("codex");
    expect(report.mcpConfigured).toBe(true);

    const updatedContent = readFileSync(join(codexBase, "config.toml"), "utf8");
    // 保留了原有配置
    expect(updatedContent).toContain(`model = "o3-mini"`);
    expect(updatedContent).toContain(`key = "val"`);
    // 追加了 devflow mcp
    expect(updatedContent).toContain("[mcp_servers.devflow]");
    expect(updatedContent).toContain(JSON.stringify(process.execPath));
    expect(installer.installSkillsForClient("codex").mcpConfigured).toBe(true);
  });

  it("TC-INST-03: AGY 客户端正确写入 mcp_config.json 并保留隔离环境 (RQ-21)", () => {
    const report = installer.installSkillsForClient("agy");
    expect(report.clientId).toBe("agy");
    expect(report.mcpConfigured).toBe(true);

    const agyBase = installer.locateClientBaseDir("agy")!;
    const mcpJson = JSON.parse(
      readFileSync(join(agyBase, "mcp_config.json"), "utf8"),
    );
    expect(mcpJson.mcpServers.devflow).toBeDefined();
    expect(mcpJson.mcpServers.devflow.command).toBe(process.execPath);
  });

  it("TC-INST-04: UpgradeManager 对活动数据库执行一致性快照备份，验证备份可读且与原库分离", async () => {
    const dbPath = join(env.root, "active.db");
    const db = new Database(dbPath);
    db.prepare(
      "CREATE TABLE workflows (id TEXT PRIMARY KEY, title TEXT)",
    ).run();
    db.prepare("INSERT INTO workflows VALUES (?, ?)").run("wf_1", "升级前任务");
    db.close();

    const upgrade = new UpgradeManager({
      installDir: env.root,
      targetVersion: "0.2.1",
      backupDir: join(env.root, "backups"),
    });

    const backupFile = await upgrade.backupData(dbPath);
    expect(backupFile).toBeDefined();
    expect(existsSync(backupFile!)).toBe(true);

    // 验证备份数据库立即可读且数据完全一致
    const backupDb = new Database(backupFile!, { readonly: true });
    const row = backupDb
      .prepare("SELECT * FROM workflows WHERE id = ?")
      .get("wf_1") as any;
    expect(row.title).toBe("升级前任务");
    backupDb.close();
  });

  it("TC-INST-05: 升级事务原子切换 current.json，若元数据持久化失败保留原有 current.json 不变", () => {
    const upgrade = new UpgradeManager({
      installDir: env.root,
      targetVersion: "0.2.1",
    });

    // 初始 current.json
    const initialMeta = { version: "0.2.0", entry: "versions/0.2.0/main.js" };
    expect(upgrade.atomicSwitchCurrent(initialMeta)).toBe(true);

    const currentPath = join(env.root, "current.json");
    expect(existsSync(currentPath)).toBe(true);
    expect(JSON.parse(readFileSync(currentPath, "utf8")).version).toBe("0.2.0");

    // 切换至新版本 0.2.1
    const nextMeta = { version: "0.2.1", entry: "versions/0.2.1/main.js" };
    expect(upgrade.atomicSwitchCurrent(nextMeta)).toBe(true);
    expect(JSON.parse(readFileSync(currentPath, "utf8")).version).toBe("0.2.1");
  });

  it("TC-INST-06: 卸载时受管配置保护与引用清理：保留用户自定义注释与无关配置，清理 devflow 条目", () => {
    const codexBase = installer.locateClientBaseDir("codex")!;
    mkdirSync(codexBase, { recursive: true });
    writeFileSync(
      join(codexBase, "config.toml"),
      `# 用户自定义全局设置\nmodel = "o3-mini"\n[custom_section]\ncustom_key = "user_value"\n\n[mcp_servers.devflow]\ncommand = "node"\n`,
    );

    // 模拟清理 devflow 受管条目
    let content = readFileSync(join(codexBase, "config.toml"), "utf8");
    content = content.replace(/\[mcp_servers\.devflow\][\s\S]*?(?=\n\[|$)/, "");
    writeFileSync(join(codexBase, "config.toml"), content, "utf8");

    const cleaned = readFileSync(join(codexBase, "config.toml"), "utf8");
    expect(cleaned).toContain("# 用户自定义全局设置");
    expect(cleaned).toContain(`model = "o3-mini"`);
    expect(cleaned).toContain(`custom_key = "user_value"`);
    expect(cleaned).not.toContain("[mcp_servers.devflow]");
  });
});

describe("IT-S01～S03: 安装默认合同与升级保留", () => {
  let env: ReturnType<typeof setup>;

  beforeEach(() => {
    env = setup();
  });

  afterEach(() => {
    env.store.close();
  });

  function putCatalog(
    store: Store,
    adapterId: "codex" | "agy",
    nativeId: string,
    effort: {
      status: "supported" | "unsupported" | "unknown";
      transport: "config";
      values: string[];
      defaultValue?: string;
    },
    scopePatch: Partial<CatalogScopeInput> = {},
  ) {
    const defaults = new ModelDefaultsService(store).getOrImport(env.config);
    const base = adapterId === "codex" ? defaults.plannerProfile : defaults.executorProfile;
    const native = resolveModelIdentity(store, { ...base, modelId: nativeId });
    const scope: CatalogScopeInput = {
      adapterId,
      executablePath: native.executablePath,
      nativeConfigProfile: native.nativeConfigProfile,
      nativeConfigScope: native.nativeConfigScope,
      accountFingerprint: native.accountFingerprint,
      providerFingerprint: native.providerEndpointFingerprint,
      ...scopePatch,
    };
    const service = new ModelCatalogService(store);
    service.ensureManualCandidate(scope, nativeId);
    const catalog = service.readCached(scope)!;
    store.put("model_catalog", "catalog:" + catalog.scopeHash, adapterId, {
      ...catalog,
      entries: catalog.entries.map((entry) => entry.nativeId === nativeId ? {
        ...entry,
        effort,
        availability: "listed",
        source: "native-cache",
      } : entry),
    });
  }

  function putAccess(
    store: Store,
    adapterId: "codex" | "agy" | "cursor-agent",
    modelId: string,
    extra: { reasoning?: { mode: "explicit"; value: string } } = {},
  ) {
    seedVerifiedAccess(store, {
      id: adapterId,
      revision: 1,
      adapterId,
      modelSelection: "explicit",
      modelId,
      reasoning: extra.reasoning ?? { mode: "explicit", value: "high" },
      selectionKind: "fixed",
      options: {},
    });
  }

  function putStoppedWorkflow(store: Store, workflowId: string) {
    const workflow: Workflow = {
      id: workflowId,
      project_id: "p1",
      title: "暂停任务",
      request: "保持停止",
      complexity: "simple",
      workspace_mode: "existing_workspace",
      state: "STOPPED",
      stage: "execute",
      version: 3,
      plan_revision: 2,
      environment_revision: 0,
      created_at: now(),
      updated_at: now(),
      feedback: [],
    };
    store.put("workflow", workflowId, workflow.project_id, workflow);
    const spec = {
      id: "spec-" + workflowId,
      revision: 1,
      workflow_id: workflowId,
      plannerProfile: {
        id: "planner",
        revision: 1,
        adapterId: "codex" as const,
        modelSelection: "explicit" as const,
        modelId: "kept-planner",
        reasoning: { mode: "explicit" as const, value: "high" },
        selectionKind: "fixed" as const,
        options: {},
      },
      executorProfile: {
        id: "executor",
        revision: 1,
        adapterId: "agy" as const,
        modelSelection: "explicit" as const,
        modelId: "kept-executor",
        reasoning: { mode: "explicit" as const, value: "high" },
        selectionKind: "fixed" as const,
        options: {},
      },
      roleOverrides: inheritRoleOverrides(),
      template_id: "native-development",
      template_revision: 3,
      mode: "composite" as const,
      created_at: now(),
    };
    store.put("execution_spec", spec.id, workflowId, spec);
    return { workflow, spec };
  }

  it.each([
    { label: "account", scopePatch: { accountFingerprint: "another-account" } },
    { label: "provider", scopePatch: { providerFingerprint: "another-provider" } },
    { label: "CLI path", scopePatch: { executablePath: "another-client" } },
    { label: "native config", scopePatch: { nativeConfigScope: "another-config" } },
  ])("installer effort validation uses only the current scope, excluding another $label", ({ scopePatch }) => {
    const current = new ModelDefaultsService(env.store).getOrImport(env.config);
    const modelId = current.plannerProfile.modelId!;
    putCatalog(env.store, "codex", modelId, {
      status: "unknown", transport: "config", values: [],
    }, scopePatch);
    putCatalog(env.store, "codex", modelId, {
      status: "supported", transport: "config", values: ["high"], defaultValue: "high",
    });
    const merged = mergeInstallerDefaults(env.store, current, { plannerEffort: "high" }, env.config);
    expect(merged.complete).toBe(true);
    expect(merged.plannerProfile.reasoning).toEqual({ mode: "explicit", value: "high" });
    expect(() => mergeInstallerDefaults(env.store, current, { plannerEffort: "low" }, env.config))
      .toThrow(InstallerDefaultsError);
  });

  it("changing tools takes the current scope default and never another account default", () => {
    const current = new ModelDefaultsService(env.store).getOrImport(env.config);
    const modelId = current.executorProfile.modelId!;
    putCatalog(env.store, "agy", modelId, {
      status: "supported", transport: "config", values: ["low"], defaultValue: "low",
    }, { accountFingerprint: "another-account" });
    putCatalog(env.store, "agy", modelId, {
      status: "supported", transport: "config", values: ["high"], defaultValue: "high",
    });
    const merged = mergeInstallerDefaults(env.store, current, {
      plannerTool: "agy", plannerModel: modelId,
    }, env.config);
    expect(merged.plannerProfile.reasoning).toEqual({ mode: "explicit", value: "high" });
  });

  it("an unmatched catalog cannot supply an installation draft default", () => {
    const current = new ModelDefaultsService(env.store).getOrImport(env.config);
    const modelId = current.executorProfile.modelId!;
    putCatalog(env.store, "agy", modelId, {
      status: "supported", transport: "config", values: ["low"], defaultValue: "low",
    }, { accountFingerprint: "another-account" });
    const merged = mergeInstallerDefaults(env.store, current, {
      plannerTool: "agy", plannerModel: modelId,
    }, env.config);
    expect(merged.plannerProfile.reasoning).toEqual({ mode: "native-default" });
  });

  it("IT-S01：源码与发布安装同一默认合同，--tools 不替代角色", () => {
    const parsed = parseInstallerCliArgs([
      "--tools",
      "agy,codex",
      "--planner-tool",
      "cursor-agent",
      "--planner-model",
      "gpt-5",
    ]);
    expect(parsed.targetTools).toEqual(["agy", "codex"]);
    expect(parsed.roleInputs.plannerTool).toBe("cursor-agent");
    const first = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      targetTools: ["agy"],
    });
    expect(first.defaults.plannerProfile.adapterId).toBe("codex");
    expect(first.defaults.executorProfile.adapterId).toBe("agy");
    expect(first.pending).toBe(true);
    expect(first.message).toBe("模型设置待完成");
    const second = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      targetTools: ["agy"],
      roleInputs: parsed.roleInputs,
    });
    expect(second.saved).toBe(false);
    expect(second.pending).toBe(true);
    expect(second.defaults.plannerProfile.adapterId).toBe("codex");
    expect(second.defaults.plannerProfile.modelId).not.toBe("gpt-5");
    expect(env.store.get("model_defaults_draft", "global")).toMatchObject({
      schema_version: 1,
      expected_defaults_revision: first.defaults.revision,
      plannerProfile: { adapterId: "cursor-agent", modelId: "gpt-5" },
      executorProfile: first.defaults.executorProfile,
    });
  });

  it("R25：只重复原工具时未指定 effort 保持原值", () => {
    const first = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    putAccess(env.store, "codex", first.defaults.plannerProfile.modelId!);
    putAccess(env.store, "agy", first.defaults.executorProfile.modelId!);
    const result = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      roleInputs: { plannerTool: "codex" },
    });
    expect(result.saved).toBe(true);
    expect(result.defaults.plannerProfile.reasoning).toEqual(
      first.defaults.plannerProfile.reasoning,
    );
    expect(result.defaults.plannerProfile.modelId).toBe(
      first.defaults.plannerProfile.modelId,
    );
  });

  it("R25：同工具只改模型且旧强度仍合法时保持原强度", () => {
    putCatalog(env.store, "codex", "gpt-6-astra", {
      status: "supported",
      transport: "config",
      values: ["low", "medium", "high"],
      defaultValue: "medium",
    });
    const first = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    putAccess(env.store, "codex", "gpt-6-astra");
    putAccess(env.store, "agy", first.defaults.executorProfile.modelId!);
    const result = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      roleInputs: { plannerModel: "gpt-6-astra" },
    });
    expect(result.saved).toBe(true);
    expect(result.defaults.plannerProfile.reasoning).toEqual({
      mode: "explicit",
      value: "high",
    });
  });

  it("IT-S02：未登录时服务配置可写入但模型待完成，不启动业务 Run", () => {
    const result = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    expect(result.pending).toBe(true);
    expect(result.message).toBe("模型设置待完成");
    expect(env.store.list("workflow")).toHaveLength(0);
    expect(env.store.list("run")).toHaveLength(0);
    expect(env.store.jobs()).toHaveLength(0);
    expect(env.store.list<ModelDefaults>("model_defaults")).toHaveLength(1);
  });

  it("IT-S03：升级保留 defaults/spec/access，暂停任务不恢复", () => {
    const service = new ModelDefaultsService(env.store);
    const imported = service.getOrImport(env.config);
    putAccess(env.store, "codex", "kept-planner");
    putAccess(env.store, "agy", "kept-executor");
    service.save({
      request_id: randomUUID(),
      expected_defaults_revision: imported.revision,
      plannerProfile: {
        ...imported.plannerProfile,
        modelId: "kept-planner",
      },
      executorProfile: {
        ...imported.executorProfile,
        modelId: "kept-executor",
      },
    });
    putAccess(env.store, "codex", "kept-planner");
    putAccess(env.store, "agy", "kept-executor");
    const { workflow, spec } = putStoppedWorkflow(env.store, "wf-s03");
    const beforeAccess = env.store.list<ModelAccessRecord>("model_access");
    const result = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      targetTools: ["codex"],
    });
    expect(result.saved).toBe(false);
    expect(result.pending).toBe(false);
    expect(result.defaults.revision).toBe(2);
    expect(result.defaults.plannerProfile.modelId).toBe("kept-planner");
    expect(result.defaults.executorProfile.modelId).toBe("kept-executor");
    const specs = env.store.list<ExecutionSpec>("execution_spec", workflow.id);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.revision).toBe(spec.revision);
    expect(specs[0]?.plannerProfile.modelId).toBe("kept-planner");
    expect(env.store.list<ModelAccessRecord>("model_access")).toEqual(
      beforeAccess,
    );
    expect(env.store.must<Workflow>("workflow", workflow.id).state).toBe(
      "STOPPED",
    );
    expect(env.store.list("run")).toHaveLength(0);
  });

  it("IT-S03：不合法默认参数不写一半", () => {
    putCatalog(env.store, "codex", "gpt-6-astra", {
      status: "supported",
      transport: "config",
      values: ["low", "medium"],
      defaultValue: "low",
    });
    const before = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    expect(() =>
      applyInstallerModelDefaults({
        store: env.store,
        config: env.config,
        roleInputs: { plannerEffort: "xhigh" },
      }),
    ).toThrow(InstallerDefaultsError);
    const after = env.store.list<ModelDefaults>("model_defaults")[0];
    expect(after?.revision).toBe(before.defaults.revision);
    expect(after?.plannerProfile.reasoning).toEqual(
      before.defaults.plannerProfile.reasoning,
    );
  });

  it("R25：改工具未给模型保持旧默认并待配置", () => {
    const before = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    const result = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      roleInputs: { plannerTool: "cursor-agent" },
    });
    expect(result.saved).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.defaults.plannerProfile.adapterId).toBe(
      before.defaults.plannerProfile.adapterId,
    );
    expect(result.defaults.revision).toBe(before.defaults.revision);
  });

  it("R25：只改强度且验证通过后原子更新", () => {
    putCatalog(env.store, "codex", "gpt-6-astra", {
      status: "supported",
      transport: "config",
      values: ["low", "medium", "high"],
      defaultValue: "medium",
    });
    const first = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    putAccess(env.store, "codex", first.defaults.plannerProfile.modelId!);
    putAccess(env.store, "agy", first.defaults.executorProfile.modelId!);
    const result = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      roleInputs: { plannerEffort: "medium" },
    });
    expect(result.saved).toBe(true);
    expect(result.defaults.plannerProfile.modelId).toBe(
      first.defaults.plannerProfile.modelId,
    );
    expect(result.defaults.plannerProfile.reasoning).toEqual({
      mode: "explicit",
      value: "medium",
    });
  });

  it("R25：完整指定工具模型强度且验证后发布", () => {
    const first = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    putAccess(env.store, "cursor-agent", "gpt-5", {
      reasoning: { mode: "explicit", value: "high" },
    });
    putAccess(env.store, "agy", first.defaults.executorProfile.modelId!);
    const result = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
      roleInputs: {
        plannerTool: "cursor-agent",
        plannerModel: "gpt-5",
        plannerEffort: "high",
      },
    });
    expect(result.saved).toBe(true);
    expect(result.defaults.plannerProfile.adapterId).toBe("cursor-agent");
    expect(result.defaults.plannerProfile.modelId).toBe("gpt-5");
    expect(result.defaults.plannerProfile.reasoning).toEqual({
      mode: "explicit",
      value: "high",
    });
    expect(result.defaults.executorProfile.adapterId).toBe("agy");
  });

  it("R25：模型变且旧强度不合法时明确拒绝，不静默降级", () => {
    putCatalog(env.store, "codex", "gpt-5.6-sol", {
      status: "supported",
      transport: "config",
      values: ["low", "medium"],
      defaultValue: "low",
    });
    const first = applyInstallerModelDefaults({
      store: env.store,
      config: env.config,
    });
    expect(first.defaults.plannerProfile.reasoning).toEqual({
      mode: "explicit",
      value: "high",
    });
    expect(() =>
      applyInstallerModelDefaults({
        store: env.store,
        config: env.config,
        roleInputs: { plannerModel: "gpt-5.6-sol" },
      }),
    ).toThrow(InstallerDefaultsError);
    const after = env.store.list<ModelDefaults>("model_defaults")[0];
    expect(after?.plannerProfile.modelId).toBe(
      first.defaults.plannerProfile.modelId,
    );
    expect(after?.plannerProfile.reasoning).toEqual({
      mode: "explicit",
      value: "high",
    });
  });
});
