export interface ApprovalTarget {
  workflowId: string;
  workflowVersion: number;
  planRevision: number;
  planHash: string | null;
  snapshotId?: string | null;
  environmentRevision?: number;
  planTitle?: string;
  planSummary?: string;
  executorProfileDescription?: string;
}

export function normalizeInstructionsText(rawText?: string | null): string {
  if (rawText === undefined || rawText === null) return "";
  const normalized = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (normalized.length > 20000) {
    throw new Error(`执行指令文本过长: 最大允许 20000 字符, 当前 ${normalized.length} 字符`);
  }
  return normalized;
}

export async function computeInstructionsHash(text: string): Promise<string> {
  const normalized = normalizeInstructionsText(text);
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
