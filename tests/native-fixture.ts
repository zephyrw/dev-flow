import type { Engine } from "../packages/core/src/engine.js";
import type {
  DeliveryManifest,
  Workspace,
  Run,
} from "../packages/contracts/src/index.js";
import { NativeRunRecordReader } from "../packages/evidence/src/native-run-records.js";
import {
  captureInputs,
  captureReports,
} from "../packages/evidence/src/native-execution-observer.js";

/** Explicit synthetic host receipt for isolated gate tests. Production receipts
 * come only from observed start/end host events; never from the manifest. */
export function attestFixture(
  engine: Engine,
  key: string,
  manifest: DeliveryManifest,
  reader: NativeRunRecordReader,
  completed = true,
) {
  const w = engine.get(key);
  const run = engine.store.must<Run>("run", w.run_id!);
  const conversation = "fixture-conversation-" + key;
  engine.store.put("conversation", key, key, { id: conversation });
  if (completed)
    engine.store.put("run", run.id, key, {
      ...run,
      status: "completed",
      ended_at: new Date().toISOString(),
    });
  Object.assign(manifest, {
    schema_version: "v2",
    submission_id: "submission-" + key,
    workflow_id: key,
    run_id: run.id,
    conversation_id: conversation,
    plan_revision: w.plan_revision,
    plan_hash: w.plan_hash,
  });
  const workspaces = engine.store.list<Workspace>("workspace", key);
  const inputs = captureInputs(workspaces);
  const reports = Object.fromEntries(
    Object.entries(captureReports(workspaces)).map(([k, v]) => [k, v.hash]),
  );
  return new NativeRunRecordReader(
    reader.getAllFacts().map((f) => ({
      ...f,
      workflow_id: key,
      run_id: run.id,
      conversation_id: conversation,
      plan_hash: w.plan_hash,
      started_at: f.started_at ?? f.ended_at ?? new Date().toISOString(),
      ended_at: f.ended_at ?? new Date().toISOString(),
      input_fingerprints: inputs,
      report_hashes: reports,
    })),
  );
}
