import { it, expect } from "vitest";
import { writeFileSync, readFileSync, mkdirSync, linkSync } from "node:fs";
import { join } from "node:path";
import {
  prepared,
  proof,
  setup,
  repository,
  project,
  plan,
} from "../helpers.js";
import { hash, id, now, objectHash } from "../../packages/core/src/util.js";
import { git } from "../../packages/git/src/git.js";
import { FileBroker, safePath } from "../../packages/workspace/src/files.js";
import { buildServer } from "../../apps/api/src/server.js";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
it("IT-04 rejects outside scope, stale writes, hardlinks and freezes writes during tests", async () => {
  const s = await prepared();
  const { broker, root } = s.engine.files(
    s.principal,
    s.workflow.id,
    "main",
    true,
  );
  expect(() =>
    broker.apply(root, s.engine.plan(s.workflow.id).plan.scope, [
      { path: ".git/config", expected_hash: null, content: "bad" },
    ]),
  ).toThrow();
  expect(() =>
    broker.apply(root, s.engine.plan(s.workflow.id).plan.scope, [
      { path: "app.txt", expected_hash: "wrong", content: "after\n" },
    ]),
  ).toThrow();
  broker.apply(root, s.engine.plan(s.workflow.id).plan.scope, [
    { path: "app.txt", expected_hash: hash("before\n"), content: "after\n" },
  ]);
  s.engine.claimTask(
    s.principal,
    s.workflow.id,
    "T01",
    "已经将文本修改为 after 并保留换行",
  );
  await s.engine.freeze(s.workflow.id, s.principal);
  expect(() =>
    s.engine.files(s.principal, s.workflow.id, "main", true),
  ).toThrow(/禁止修改/);
  expect(s.engine.taskStatus(s.workflow.id)[0]?.status).toBe("claimed");
  s.store.close();
});
it("IT-05 independently prepares two worktrees in one shared repository", async () => {
  const s = setup(),
    r = await repository(s.root);
  const p = project(r.repo);
  s.store.put("project", p.id, p.id, p);
  const a = await s.engine.git.prepare(p, "wf-a", "new_worktree", {
    main: r.baseline,
  });
  const b = await s.engine.git.prepare(p, "wf-b", "new_worktree", {
    main: r.baseline,
  });
  expect(a[0]!.root).not.toBe(b[0]!.root);
  expect(a[0]!.common_dir).toBe(b[0]!.common_dir);
  expect(a[0]!.branch).not.toBe(b[0]!.branch);
  writeFileSync(join(a[0]!.root, "app.txt"), "one");
  expect(readFileSync(join(b[0]!.root, "app.txt"), "utf8")).toBe("before\n");
  s.store.close();
});
it("IT-10 snapshot detects source changes and task declarations never substitute for evidence", async () => {
  const s = await prepared();
  s.engine.claimTask(
    s.principal,
    s.workflow.id,
    "T01",
    "声明完成仅仅是实现报告并不构成通过证据",
  );
  const snapshot = await s.engine.freeze(s.workflow.id, s.principal);
  expect(() => s.engine.verifyEvidence(s.workflow.id)).toThrow(/证据/);
  writeFileSync(join(s.repo, "app.txt"), "external change");
  expect(await s.engine.git.matches(snapshot)).toBe(false);
  s.store.close();
});
it("IT-13 pass review commits only the accepted exact tree and leaves a clean index", async () => {
  const s = await prepared();
  const key = s.workflow.id;
  const f = s.engine.files(s.principal, key, "main", true);
  f.broker.apply(f.root, s.engine.plan(key).plan.scope, [
    { path: "app.txt", expected_hash: hash("before\n"), content: "after\n" },
  ]);
  s.engine.claimTask(
    s.principal,
    key,
    "T01",
    "实际修改 app.txt 为 after 并保留换行",
  );
  const snapshot = await s.engine.freeze(key, s.principal);
  const evidenceFile = join(s.root, "evidence.json");
  writeFileSync(evidenceFile, '{"fixture":"explicit simulation"}');
  s.store.put("evidence", "e1", key, {
    id: "e1",
    workflow_id: key,
    run_id: "run-test",
    snapshot_id: snapshot.id,
    environment_revision: 0,
    test_id: "UT01",
    layer: "unit",
    status: "passed",
    case_ids: ["updates content"],
    passed: 1,
    failed: 0,
    skipped: 0,
    discovered: 1,
    exit_code: 0,
    files: [{ path: evidenceFile, hash: hash(readFileSync(evidenceFile)) }],
    created_at: now(),
  });
  s.engine.transition(key, ["VERIFYING"], "HUMAN_PENDING", "manual_acceptance");
  const a = proof(s.engine, key, "accept");
  await s.engine.accept(key, a.proof, a.binding);
  s.engine.transition(key, ["REVIEW_QUEUED"], "REVIEWING", "review", {
    review_request_id: "review-test",
  });
  await s.engine.receiveReview(key, {
    schema_version: 1,
    review_request_id: "review-test",
    workflow_id: key,
    plan_revision: 1,
    snapshot_id: snapshot.id,
    verdict: "pass",
    coverage: {
      all_changed_files_reviewed: true,
      all_requirements_checked: true,
      upstream_downstream_checked: true,
      security_checked: true,
      tests_validity_checked: true,
      files: ["main:app.txt"],
    },
    findings: [],
    unresolved_questions: [],
    repair_plan: null,
    commit_message: "fix: 更新文本",
  });
  expect(s.engine.get(key).state).toBe("COMMITTED");
  expect(await git(s.repo, ["status", "--porcelain"])).toBe("");
  expect(await git(s.repo, ["rev-parse", "HEAD^{tree}"])).toBe(
    snapshot.repositories[0]!.tree,
  );
  s.store.close();
});
it("IT-03 API rejects untrusted Host, foreign Origin, allow local access and reject planner-as-human", async () => {
  const s = setup();
  const app = await buildServer(s.engine);
  expect(
    (
      await app.inject({
        url: "/api/projects",
        headers: { host: "localhost:14810" },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        url: "/api/health",
        headers: { host: "evil.example" },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await app.inject({
        method: "POST",
        url: "/api/workflows/fixture/approve",
        headers: {
          host: "localhost:14810",
          origin: "http://evil.example",
          "content-type": "application/json",
        },
        payload: { binding: {} },
      })
    ).statusCode,
  ).toBe(403);
  const token = s.engine.auth.issue({ role: "planner" });
  expect(
    (
      await app.inject({
        url: "/api/projects",
        headers: {
          host: "localhost:14810",
          authorization: `Bearer ${token}`,
        },
      })
    ).statusCode,
  ).toBe(403);
  await app.close();
  s.store.close();
});
it("IT-03 MCP exposes planning tools without any human-approval capability", async () => {
  const s = setup();
  const app = await buildServer(s.engine);
  await app.listen({ host: "127.0.0.1", port: 14810 });
  const token = s.engine.auth.issue({ role: "planner" });
  const client = new Client({ name: "test-client", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:14810/mcp"), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }),
  );
  const tools = (await client.listTools()).tools.map((t) => t.name);
  expect(tools).toContain("devflow_submit_plan");
  expect(tools.some((t) => /approve|accept|commit/.test(t))).toBe(false);
  await client.close();
  await app.close();
  s.store.close();
});
it("IT-09 large Chinese plan and tool contracts traverse bounded MCP pages without temp-file fallback", async () => {
  const s = await prepared(),
    app = await buildServer(s.engine);
  await app.listen({ host: "127.0.0.1", port: 14810 });
  const record = s.engine.plan(s.workflow.id);
  record.plan.markdown +=
    "\n" + "需要完整传递的中文计划。".repeat(2000) + "\nMARKER-END-92814";
  s.store.put("plan", record.id, s.workflow.id, record);
  const token = s.engine.auth.issue({
    role: "worker",
    workflow_id: s.workflow.id,
    run_id: s.principal.run_id,
  });
  const client = new Client({ name: "paged-context-test", version: "1" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:14810/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + token } },
      }),
    );
    let text = "",
      offset = 0;
    for (let n = 0; n < 100; n++) {
      const result: any = await client.callTool({
        name: "devflow_execute_context",
        arguments: { section: "plan", offset },
      });
      expect(result.isError).not.toBe(true);
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(6500);
      const page = JSON.parse(result.content[0].text);
      text += page.text;
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    expect(text).toBe(record.plan.markdown);
    const result: any = await client.callTool({
      name: "devflow_execute_context",
      arguments: { section: "tool", id: "devflow_run_check" },
    });
    expect(JSON.parse(result.content[0].text).text).toContain("test_id");
  } finally {
    await client.close();
    await app.close();
    s.store.close();
  }
}, 30000);
