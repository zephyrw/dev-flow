import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../packages/store/src/store.js";
import { WorkflowVisibilityService } from "../../packages/core/src/workflow-visibility-service.js";

describe("W05: 任务归档与可见性管理单元测试", () => {
  let tmpDir: string;
  let store: Store;
  let service: WorkflowVisibilityService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "devflow-w05-"));
    store = new Store(join(tmpDir, "store.db"));
    service = new WorkflowVisibilityService(store);
  });

  afterEach(() => {
    store.close();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("1. 默认投影：未归档任务读取时返回 archived=false, revision=0", () => {
    const vis = service.read("wf-new-1");
    expect(vis.workflow_id).toBe("wf-new-1");
    expect(vis.archived).toBe(false);
    expect(vis.revision).toBe(0);
    expect(vis.archived_at).toBeNull();
    expect(vis.restored_at).toBeNull();
  });

  it("2. 正常归档与恢复状态机：revision递增，archived_at与restored_at正确记录", () => {
    const wfId = "wf-test-1";
    // 假装已有该 workflow
    store.put("workflow", wfId, wfId, {
      id: wfId,
      project_id: "p1",
      title: "任务1",
      state: "PLANNING",
      version: 1,
    });

    // 首次归档 (expected revision 0)
    const archiveRes = service.setArchived(wfId, {
      request_id: "req-archive-1",
      expected_visibility_revision: 0,
      archived: true,
    });

    expect(archiveRes.changed).toBe(true);
    expect(archiveRes.visibility.archived).toBe(true);
    expect(archiveRes.visibility.revision).toBe(1);
    expect(archiveRes.visibility.archived_at).toBeTruthy();
    expect(archiveRes.visibility.restored_at).toBeNull();

    const firstArchivedAt = archiveRes.visibility.archived_at;

    // 恢复任务 (expected revision 1)
    const restoreRes = service.setArchived(wfId, {
      request_id: "req-restore-1",
      expected_visibility_revision: 1,
      archived: false,
    });

    expect(restoreRes.changed).toBe(true);
    expect(restoreRes.visibility.archived).toBe(false);
    expect(restoreRes.visibility.revision).toBe(2);
    // 保留上一次归档时间
    expect(restoreRes.visibility.archived_at).toBe(firstArchivedAt);
    expect(restoreRes.visibility.restored_at).toBeTruthy();

    // 验证原 workflow 实体毫发无伤
    const originalWf = store.get<any>("workflow", wfId)!;
    expect(originalWf.state).toBe("PLANNING");
    expect(originalWf.version).toBe(1);
  });

  it("3. 幂等性控制：同 request_id 同参数返回相同回执；同 request_id 换参数抛出 409", () => {
    const wfId = "wf-idempotent-1";
    store.put("workflow", wfId, wfId, { id: wfId, state: "EXECUTING", version: 2 });

    const req1 = {
      request_id: "req-idem-1",
      expected_visibility_revision: 0,
      archived: true,
    };
    const res1 = service.setArchived(wfId, req1);
    expect(res1.changed).toBe(true);
    expect(res1.visibility.revision).toBe(1);

    // 同参数重放
    const res2 = service.setArchived(wfId, req1);
    expect(res2).toEqual(res1);

    // 同 request_id 改变参数
    expect(() =>
      service.setArchived(wfId, {
        request_id: "req-idem-1",
        expected_visibility_revision: 0,
        archived: false,
      }),
    ).toThrow(/已用于不同的可见性操作/);
  });

  it("4. CAS 并发防护：expected_visibility_revision 不匹配抛出 409", () => {
    const wfId = "wf-cas-1";
    store.put("workflow", wfId, wfId, { id: wfId, state: "QUEUED", version: 1 });

    service.setArchived(wfId, {
      request_id: "req-cas-1",
      expected_visibility_revision: 0,
      archived: true,
    });

    // 此时当前 revision 为 1，若客户端仍传 0，应被拒绝
    expect(() =>
      service.setArchived(wfId, {
        request_id: "req-cas-2",
        expected_visibility_revision: 0,
        archived: false,
      }),
    ).toThrow(/可见性版本冲突/);
  });

  it("5. 工作流列表过滤：准确按 visible / archived / all 分割", () => {
    const w1: any = { id: "w1", project_id: "p1", title: "可见1" };
    const w2: any = { id: "w2", project_id: "p1", title: "归档2" };
    const w3: any = { id: "w3", project_id: "p2", title: "可见3" };

    store.put("workflow", "w1", "w1", w1);
    store.put("workflow", "w2", "w2", w2);
    store.put("workflow", "w3", "w3", w3);

    service.setArchived("w2", {
      request_id: "req-w2",
      expected_visibility_revision: 0,
      archived: true,
    });

    const all = [w1, w2, w3];
    const visibleList = service.filterWorkflows(all, "visible");
    expect(visibleList.map((w) => w.id)).toEqual(["w1", "w3"]);

    const archivedList = service.filterWorkflows(all, "archived");
    expect(archivedList.map((w) => w.id)).toEqual(["w2"]);

    const allList = service.filterWorkflows(all, "all");
    expect(allList.map((w) => w.id)).toEqual(["w1", "w2", "w3"]);
  });
});
