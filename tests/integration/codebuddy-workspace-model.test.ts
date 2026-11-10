import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { buildServer } from "../../apps/api/src/server.js";
import { setAdapterExecutableResolver } from "../../packages/adapters/sdk/src/registry.js";
import { ToolProfileSchema } from "../../packages/contracts/src/index.js";
import { assertProfilesVerified } from "../../packages/core/src/access-guard.js";
import { ModelCatalogService } from "../../packages/core/src/model-catalog-service.js";
import { repository, setup, testConsoleHeaders } from "../helpers.js";

it("discovers and verifies project-only CodeBuddy models without sharing the proof across projects", async () => {
  const s = setup();
  const { repo } = await repository(s.root);
  const fixture = resolve("tests/fixtures/codebuddy-cli.mjs");
  const restore = setAdapterExecutableResolver(adapter => adapter === "codebuddy-code" ? fixture : undefined);
  const projectDir = join(repo, ".codebuddy");
  mkdirSync(projectDir, { recursive: true });
  const modelsFile = join(projectDir, "models.json");
  const modelId = "fixture-project/local";
  writeFileSync(modelsFile, JSON.stringify({ models: [{ id: modelId, name: "项目专属模型" }] }));
  const profile = ToolProfileSchema.parse({
    id: "project-codebuddy", adapterId: "codebuddy-code", modelSelection: "explicit", modelId,
  });
  const catalog = new ModelCatalogService(s.store, { workingDirectory: projectDir });
  const app = await buildServer(s.engine);
  try {
    const scope = "workspace:" + repo;
    const refresh = await app.inject({
      method: "POST", url: "/api/model-tools/codebuddy-code/models/refresh", headers: testConsoleHeaders(),
      payload: { request_id: randomUUID(), scope_id: scope },
    });
    expect(refresh.statusCode, refresh.body).toBe(202);
    expect((await catalog.waitForOperation(refresh.json().id)).status).toBe("committed");
    const listing = await app.inject({
      url: "/api/model-tools/codebuddy-code/models?scope_id=" + encodeURIComponent(scope),
      headers: testConsoleHeaders(),
    });
    expect(listing.json().entries.map((entry: { nativeId: string }) => entry.nativeId)).toContain(modelId);
    const verify = await app.inject({
      method: "POST", url: "/api/model-access/verify", headers: testConsoleHeaders(),
      payload: { request_id: randomUUID(), profile, scope_id: scope },
    });
    expect(verify.statusCode, verify.body).toBe(202);
    await vi.waitFor(async () => {
      const result = await app.inject({
        url: "/api/model-access/verifications/" + verify.json().id, headers: testConsoleHeaders(),
      });
      expect(result.json().status).toBe("verified");
    }, { timeout: 12_000 });
    expect(() => assertProfilesVerified(s.store, [profile], undefined, repo)).not.toThrow();
    expect(() => assertProfilesVerified(s.store, [profile], undefined, projectDir)).toThrow();
    writeFileSync(modelsFile, "{}");
    expect(() => assertProfilesVerified(s.store, [profile], undefined, repo)).toThrow();
  } finally {
    await app.close();
    await catalog.close();
    restore();
    s.store.close();
  }
}, 30_000);
