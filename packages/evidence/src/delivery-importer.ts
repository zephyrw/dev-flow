import { join } from "node:path";
import type { Store } from "../../store/src/store.js";
import type {
  Delivery,
  DeliveryManifest,
  InputManifest,
  TestExecution,
  Workspace,
} from "../../contracts/src/index.js";
import type { AttachmentArchiveRecord } from "../../contracts/src/tr-handoff.js";
import { id, now, objectHash } from "../../core/src/util.js";
import type { NativeRunRecordReader } from "./native-run-records.js";
import {
  createArchiveJobFromManifest,
  listAttachmentRecords,
} from "./archive-consumer.js";

export {
  attachmentArchiveKey,
  createArchiveJobFromManifest,
  drainArchiveOutbox,
  enqueueArchive,
  listAttachmentRecords,
} from "./archive-consumer.js";

export interface ImportDeliveryResult {
  delivery: Delivery;
  inputManifest: InputManifest;
  archivedReports: Map<
    string,
    { path: string; hash: string; rawContent: string }
  >;
  reportHashes: Record<string, string>;
  inputFingerprints: Record<string, string>;
  attachment_status?: AttachmentArchiveRecord[];
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
    deliveryId?: string;
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
    const existing = options.deliveryId
      ? this.store.get<Delivery>("delivery", options.deliveryId)
      : undefined;
    const deliveryId = existing?.id ?? id("del");
    const deliveryDir = join(this.storageRoot, "deliveries", deliveryId);
    const inputFingerprints: Record<string, string> = {};
    const inputManifest: InputManifest = existing?.input_manifest_id
      ? (this.store.get<InputManifest>(
          "input_manifest",
          existing.input_manifest_id,
        ) ?? {
          id: existing.input_manifest_id,
          workflow_id: workflowId,
          repo_id: workspaces[0]?.repo_id ?? "main",
          fingerprint: "",
          files: [],
          created_at: now(),
        })
      : {
          id: id("man"),
          workflow_id: workflowId,
          repo_id: workspaces[0]?.repo_id ?? "main",
          fingerprint: "",
          files: [],
          created_at: now(),
        };
    this.store.put("input_manifest", inputManifest.id, workflowId, inputManifest);
    this.writeTestExecutions({
      deliveryId,
      workflowId,
      runId,
      workspaces,
      manifest,
      hostRecordReader,
    });
    const delivery: Delivery = {
      ...existing,
      id: deliveryId,
      submission_id: manifest.submission_id,
      manifest_hash: objectHash(manifest),
      workflow_id: workflowId,
      run_id: runId,
      plan_revision: planRevision,
      plan_hash: manifest.plan_hash,
      status: existing?.status ?? "pending",
      input_manifest_id: existing?.input_manifest_id ?? inputManifest.id,
      archive_root: existing?.archive_root ?? deliveryDir,
      report_hashes: existing?.report_hashes,
      manifest,
      submitted_at: existing?.submitted_at ?? now(),
    };
    this.store.put("delivery", deliveryId, workflowId, delivery);
    createArchiveJobFromManifest(this.store, {
      deliveryId,
      workflowId,
      runId,
      workspaces,
      manifest,
    });
    return {
      delivery,
      inputManifest,
      archivedReports: new Map(),
      reportHashes: existing?.report_hashes ?? {},
      inputFingerprints,
      attachment_status: listAttachmentRecords(
        this.store,
        workflowId,
        deliveryId,
      ),
    };
  }

  private writeTestExecutions(options: {
    deliveryId: string;
    workflowId: string;
    runId: string;
    workspaces: Workspace[];
    manifest: DeliveryManifest;
    hostRecordReader?: NativeRunRecordReader;
  }): void {
    const { deliveryId, workflowId, runId, workspaces, manifest } = options;
    for (const item of manifest.test_executions ?? []) {
      const found = options.hostRecordReader?.getFact(item.tool_call_id);
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
  }
}
