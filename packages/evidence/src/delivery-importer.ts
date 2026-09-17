import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { Store } from "../../store/src/store.js";
import type {
  Delivery,
  DeliveryManifest,
  InputManifest,
  TestExecution,
  Workspace,
} from "../../contracts/src/index.js";
import { id, now, objectHash } from "../../core/src/util.js";
import { safePath } from "../../workspace/src/files.js";
import { WorkspaceFingerprintService } from "../../workspace/src/fingerprint.js";
import type { NativeRunRecordReader } from "./native-run-records.js";
import { reportKey } from "./native-execution-observer.js";

export interface ImportDeliveryResult {
  delivery: Delivery;
  inputManifest: InputManifest;
  archivedReports: Map<
    string,
    { path: string; hash: string; rawContent: string }
  >;
  reportHashes: Record<string, string>;
  inputFingerprints: Record<string, string>;
}
export class DeliveryImporter {
  constructor(
    private store: Store,
    private storageRoot: string,
  ) {}
  importDelivery(options: {
    workflowId: string;
    runId: string;
    planRevision: number;
    workspaceRoot: string;
    workspaces?: Workspace[];
    manifest: DeliveryManifest;
    hostRecordReader?: NativeRunRecordReader;
  }): ImportDeliveryResult {
    const {
      workflowId,
      runId,
      planRevision,
      workspaceRoot,
      manifest,
      hostRecordReader,
    } = options;
    const workspaces = options.workspaces?.length
      ? options.workspaces
      : [{ repo_id: "main", root: workspaceRoot } as Workspace];
    const deliveryId = id("del");
    const deliveryDir = join(this.storageRoot, "deliveries", deliveryId);
    const inputFingerprints: Record<string, string> = {};
    let inputManifest!: InputManifest;
    // This is explicitly a delivery-time snapshot, never a fabricated test batch.
    for (const ws of workspaces) {
      const fp = WorkspaceFingerprintService.compute(ws.root);
      const im: InputManifest = {
        id: id("man"),
        workflow_id: workflowId,
        repo_id: ws.repo_id,
        fingerprint: fp.fingerprint,
        files: fp.files,
        created_at: fp.timestamp,
      };
      this.store.put("input_manifest", im.id, workflowId, im);
      inputManifest ??= im;
      inputFingerprints[ws.repo_id] = fp.fingerprint;
    }
    const archivedReports: ImportDeliveryResult["archivedReports"] = new Map();
    const reportHashes: Record<string, string> = {};
    for (const execution of manifest.test_executions) {
      const ws = workspaces.find(
        (w) =>
          w.repo_id ===
          (execution.repo_id ??
            (workspaces.length === 1 ? workspaces[0]!.repo_id : undefined)),
      );
      if (!ws) continue;
      for (const path of execution.report_paths) {
        const key = reportKey(ws.repo_id, execution.tool_call_id, path);
        if (archivedReports.has(key)) continue;
        let source: string;
        try {
          source = safePath(ws.root, path);
        } catch {
          continue;
        }
        if (!existsSync(source)) continue;
        const stat = statSync(source);
        if (!stat.isFile() || stat.size > 32 * 1024 * 1024) continue;
        const bytes = readFileSync(source);
        const hash = createHash("sha256").update(bytes).digest("hex");
        // Identity never becomes an unchecked filesystem path.
        const archiveName =
          createHash("sha256").update(key).digest("hex") + ".report";
        const target = join(deliveryDir, "reports", archiveName);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes);
        archivedReports.set(key, {
          path: target,
          hash,
          rawContent: bytes.toString("utf8"),
        });
        reportHashes[archiveName] = hash;
      }
    }
    for (const item of manifest.test_executions) {
      const found = hostRecordReader?.getFact(item.tool_call_id);
      const fact = found?.run_id === runId ? found : undefined;
      const record: TestExecution = {
        id: id("tex"),
        delivery_id: deliveryId,
        workflow_id: workflowId,
        run_id: runId,
        tool_call_id: item.tool_call_id,
        command: fact?.command ?? item.command,
        cwd: fact?.cwd ?? item.cwd,
        repo_id:
          item.repo_id ??
          (workspaces.length === 1 ? workspaces[0]!.repo_id : undefined),
        started_at: fact?.started_at ?? "",
        ended_at: fact?.ended_at ?? "",
        exit_code: fact?.exit_code ?? -1,
        output_path: fact?.output_path,
        report_paths: item.report_paths,
        input_fingerprints: fact?.input_fingerprints,
        report_hashes: fact?.report_hashes,
      };
      this.store.put("test_execution", record.id, workflowId, record);
    }
    const delivery: Delivery = {
      id: deliveryId,
      submission_id: manifest.submission_id,
      manifest_hash: objectHash(manifest),
      workflow_id: workflowId,
      run_id: runId,
      plan_revision: planRevision,
      plan_hash: manifest.plan_hash,
      status: "pending",
      input_manifest_id: inputManifest.id,
      archive_root: deliveryDir,
      report_hashes: reportHashes,
      manifest,
      submitted_at: now(),
    };
    this.store.put("delivery", deliveryId, workflowId, delivery);
    return {
      delivery,
      inputManifest,
      archivedReports,
      reportHashes,
      inputFingerprints,
    };
  }
}
