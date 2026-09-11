import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { ConfigSchema } from "../../packages/contracts/src/config.js";
import {
  ReviewSchema,
  requireCondition,
} from "../../packages/contracts/src/index.js";
import { Store } from "../../packages/store/src/store.js";
import { Engine } from "../../packages/core/src/engine.js";
import { LocalRuntime } from "../../packages/runtime/src/runtime.js";
import { now, redact } from "../../packages/core/src/util.js";
const file = process.argv[2];
requireCondition(file, "ARGUMENT", "需要已通过真实 agy 测试的 summary.json");
const summary = JSON.parse(readFileSync(file, "utf8"));
const acceptedE2E = process.argv[3] === "--accepted-e2e-fixture";
requireCondition(
  summary.state === "HUMAN_PENDING" ||
    (acceptedE2E && file.endsWith("e2e-state.json")),
  "FIXTURE_REQUIRED",
  "仅支持等待验收的联调夹具",
);
const output = resolve(".cache/live-codex/review-" + Date.now());
mkdirSync(output, { recursive: true });
const config = ConfigSchema.parse({
  storage_root: join(summary.root, "state"),
  workspace_root: join(summary.root, "worktrees"),
  host: {
    required: true,
    executable: resolve(
      "host/DevFlow.WinHost/bin/Release/net10.0-windows/DevFlow.WinHost.exe",
    ),
  },
  timeouts: { agent_minutes: 8 },
});
const store = new Store(join(config.storage_root, "devflow.sqlite")),
  engine = new Engine(store, config),
  runtime = new LocalRuntime(engine);
const flow = {
  ...engine.get(summary.workflow_id),
  review_request_id: "review-live-" + crypto.randomUUID(),
};
const run = {
  id: "codex-live-" + crypto.randomUUID(),
  workflow_id: flow.id,
  plan_revision: flow.plan_revision,
  adapter: "codex" as const,
  stage: "review",
  status: "running",
  started_at: now(),
  package_hash: "explicit-live-adapter-test",
};
const events: unknown[] = [];
store.on("event", (event) => {
  events.push(event);
  if (event.type === "ReviewOutput" || event.type === "ReviewDiagnostic")
    console.log(redact(JSON.stringify(event.payload)));
});
try {
  const report = ReviewSchema.parse(await runtime.review(flow, run));
  requireCondition(
    report.workflow_id === flow.id &&
      report.snapshot_id === flow.snapshot_id &&
      report.review_request_id === flow.review_request_id,
    "REVIEW_IDENTITY",
    "复核身份不匹配",
  );
  writeFileSync(join(output, "review.json"), JSON.stringify(report, null, 2));
  writeFileSync(
    join(output, "events.json"),
    redact(JSON.stringify(events, null, 2)),
  );
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(
      {
        model: config.models.reviewer,
        verdict: report.verdict,
        workflow_id: flow.id,
        snapshot_id: flow.snapshot_id,
        identity_roundtrip: true,
        no_human_acceptance_created:
          engine.get(flow.id).state === "HUMAN_PENDING",
        fixture_only: true,
        simulated_webauthn_acceptance: acceptedE2E,
        output,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      output,
      verdict: report.verdict,
      identity_roundtrip: true,
    }),
  );
} finally {
  writeFileSync(
    join(output, "events.json"),
    redact(JSON.stringify(events, null, 2)),
  );
  writeFileSync(
    join(output, "processes.json"),
    JSON.stringify(store.list("process_record", flow.id), null, 2),
  );
  await runtime.close();
  store.close();
}
