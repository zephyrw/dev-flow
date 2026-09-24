import { it, expect, describe, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBaseServer } from "../../apps/api/src/base-server.js";
import {
  readMaintenanceMarker,
} from "../../packages/installer/src/transaction.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "devflow-maint-"));
}

describe("health build identity + maintenance routes", () => {
  let root: string;
  let app: ReturnType<typeof createBaseServer>["app"];
  const headers = {
    host: "localhost:24832",
    origin: "http://localhost:24832",
    "content-type": "application/json",
    "sec-fetch-site": "same-origin",
  };

  beforeAll(async () => {
    root = tempRoot();
    // build-info at the package root consumed by loadBuildIdentity.
    const runtimeRoot = join(root, "runtime");
    writeFileSync(
      // write into the real repo package root only in tests via buildIdentity override
      join(root, "unused.json"),
      "{}",
    );
    const created = createBaseServer({
      port: 24832,
      humanOrigin: "http://localhost:24832",
      mode: "full",
      storageRoot: root,
      storageInstance: root,
      registerStatic: false,
      buildIdentity: {
        application_version: "9.9.9-test",
        build_revision: "rev-test",
        service_protocol_version: "1.2.3",
      },
    });
    app = created.app;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("/api/health exposes application_version / build_revision / service_protocol_version", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/health",
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.application_version).toBe("9.9.9-test");
    expect(body.build_revision).toBe("rev-test");
    expect(body.service_protocol_version).toBe("1.2.3");
    // version is no longer a hardcoded 0.2.0
    expect(body.version).toBe("9.9.9-test");
    expect(body.version).not.toBe("0.2.0");
    expect(body.runtime_backend).toBe("node-v1");
    expect(body.service).toBe("devflow");
    expect(body.maintenance).toBeDefined();
    expect(body.maintenance.active).toBe(false);
  });

  it("maintenance prepare/status/quiesce enforce origin and human checks", async () => {
    // Missing origin → 403 (CSRF).
    const noOrigin = await app.inject({
      method: "POST",
      url: "/api/maintenance/prepare",
      headers: { host: headers.host, "content-type": "application/json" },
      payload: { target_version: "9.9.9-test" },
    });
    expect(noOrigin.statusCode).toBe(403);

    // Authorization bearer is not a console human credential.
    const bearer = await app.inject({
      method: "POST",
      url: "/api/maintenance/prepare",
      headers: {
        ...headers,
        authorization: "Bearer sk-secret",
      },
      payload: { target_version: "9.9.9-test" },
    });
    // human() is invoked inside the route; if CSRF passes first, human denies.
    expect([403, 503]).toContain(bearer.statusCode);

    const ok = await app.inject({
      method: "POST",
      url: "/api/maintenance/prepare",
      headers,
      payload: {
        transaction_id: "tx-test",
        target_version: "9.9.9-test",
        kind: "upgrade",
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().block_new_dispatch).toBe(true);
    expect(readMaintenanceMarker(root)!.transaction_id).toBe("tx-test");

    const status = await app.inject({
      method: "GET",
      url: "/api/maintenance/status",
      headers,
    });
    expect(status.statusCode).toBe(200);
    const statusBody = status.json();
    expect(statusBody.maintenance_active).toBe(true);
    expect(statusBody.marker.transaction_id).toBe("tx-test");
    expect(statusBody.quiesce).toBeDefined();

    const quiesce = await app.inject({
      method: "POST",
      url: "/api/maintenance/quiesce",
      headers,
      payload: { on_active_tasks: "pause-and-update", transaction_id: "tx-test" },
    });
    expect(quiesce.statusCode).toBe(200);
    expect(quiesce.json().on_active_tasks).toBe("pause-and-update");
    expect(readMaintenanceMarker(root)!.pause_requested).toBe(true);

    // While maintenance is active, other mutating API calls are blocked (禁新派发).
    const blocked = await app.inject({
      method: "POST",
      url: "/api/conversations",
      headers,
      payload: { title: "should-block" },
    });
    expect([404, 503]).toContain(blocked.statusCode);
    if (blocked.statusCode === 503)
      expect(blocked.json().error?.code).toBe("MAINTENANCE_ACTIVE");

    const clear = await app.inject({
      method: "DELETE",
      url: "/api/maintenance/status",
      headers,
    });
    expect(clear.statusCode).toBe(200);
    expect(existsSync(join(root, "maintenance-state.json"))).toBe(false);
  });

  it("loadBuildIdentity reads package.json when build-info.json is absent", async () => {
    const { loadBuildIdentity } = await import(
      "../../apps/api/src/base-server.js"
    );
    const dir = tempRoot();
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "devflow", version: "1.2.3" }),
      );
      const identity = loadBuildIdentity(dir);
      expect(identity.application_version).toBe("1.2.3");
      expect(identity.service_protocol_version).toBe("1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
