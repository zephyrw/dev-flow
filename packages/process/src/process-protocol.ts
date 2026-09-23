import { randomUUID } from "node:crypto";
import { getNative, getNativeAsync } from "./native/index.js";
export interface ProcessIdentity {
  backend: "node-v1";
  id: string;
  attempt_id: string;
  pid?: number;
  launcher_pid?: number;
  creation_time?: string;
  launcher_creation_time?: string;
  job_name?: string;
  pgid?: number;
}
export interface StopObservation {
  state: "running" | "confirmed_exited" | "unknown" | "not_owned";
  active_processes?: number;
  reason?: string;
}
export function generateAttemptId(): string {
  return randomUUID();
}
export function generateJobName(prefix = "DevFlow"): string {
  return `Local\\${prefix}.${randomUUID()}`;
}
export function isValidAttemptId(value: string): boolean {
  return /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
}
export function isValidJobName(value: string): boolean {
  return /^Local\\[A-Za-z0-9_-]+\.[a-f0-9-]{36}$/.test(value);
}
export function extractIdentity(
  record: Record<string, unknown>,
): ProcessIdentity | null {
  const value = record.identity as ProcessIdentity | undefined;
  if (
    !value ||
    value.backend !== "node-v1" ||
    !isValidAttemptId(value.attempt_id) ||
    typeof value.id !== "string"
  )
    return null;
  return value;
}
export function mergeIdentity(
  record: Record<string, unknown>,
  identity: ProcessIdentity,
): Record<string, unknown> {
  return { ...record, identity, updated_at: new Date().toISOString() };
}
export function isCurrentAttempt(
  record: Record<string, unknown>,
  attempt: string,
): boolean {
  return extractIdentity(record)?.attempt_id === attempt;
}
export async function observeProcessRecord(
  record: Record<string, unknown>,
): Promise<StopObservation> {
  try {
    await getNativeAsync();
  } catch {
    return { state: "unknown", reason: "NATIVE_UNAVAILABLE" };
  }
  return observeProcessRecordSync(record);
}
export function observeProcessRecordSync(
  record: Record<string, unknown>,
): StopObservation {
  // Only records written after whole-tree observation may use this terminal marker.
  if (
    (record.status === "exited" || record.status === "failed") &&
    record.confirmed === true
  )
    return { state: "confirmed_exited" };
  const identity = extractIdentity(record);
  if (!identity)
    return { state: "unknown", reason: "PROCESS_IDENTITY_MISSING" };
  try {
    const native = getNative();
    if ("createJob" in native) {
      if (identity.job_name !== `Local\\DevFlow.${identity.attempt_id}`)
        return { state: "unknown", reason: "JOB_IDENTITY_INVALID" };
      const job = native.openJob(identity.job_name);
      if (!job) return { state: "confirmed_exited", active_processes: 0 };
      try {
        const count = native.queryJobActiveCount(job);
        if (count < 0) return { state: "unknown", reason: "JOB_QUERY_FAILED" };
        return {
          state: count === 0 ? "confirmed_exited" : "running",
          active_processes: count,
        };
      } finally {
        native.closeHandle(job);
      }
    }
    if (
      !identity.pgid ||
      identity.pgid !== identity.launcher_pid ||
      !identity.launcher_creation_time
    )
      return { state: "unknown", reason: "GROUP_IDENTITY_MISSING" };
    if (!native.isProcessGroupAlive(identity.pgid))
      return { state: "confirmed_exited" };
    const current = native.getProcessCreationTime(identity.launcher_pid);
    if (current && current !== identity.launcher_creation_time)
      return { state: "not_owned" };
    return { state: "running" };
  } catch {
    return { state: "unknown", reason: "PROCESS_QUERY_FAILED" };
  }
}
