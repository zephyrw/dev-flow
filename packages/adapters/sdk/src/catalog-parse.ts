import {
  CATALOG_FRESH_MS,
  CATALOG_OUTPUT_LIMIT,
  ModelCatalogSchema,
  type ModelCatalog,
  type ModelEntry,
  type ModelSource,
} from "../../../contracts/src/model-catalog.js";
import type { SupportedAdapterId } from "../../../contracts/src/execution-spec.js";
import { FlowError } from "../../../contracts/src/index.js";

export type CatalogParseInput = {
  stdout: string;
  stderr?: string;
  source?: ModelSource;
  discoveredAt?: string;
  cliPath?: string;
  cliVersion?: string;
  nativeConfigScope?: string;
  scopeHash?: string;
  truncated?: boolean;
};

export type CatalogLineSplit = {
  text: string;
  lines: string[];
  truncated: boolean;
  overLimit: boolean;
};

const ANSI_CSI = /\u001B\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g;
const ANSI_SIMPLE = /\u001B[@-Z\\-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(ANSI_SIMPLE, "");
}

export function stripBoxDrawing(text: string): string {
  return text.replace(/[\u2500-\u257F]/g, " ");
}

export function inspectCatalogOutput(raw: string): {
  text: string;
  truncated: boolean;
  overLimit: boolean;
} {
  const buf = Buffer.from(raw, "utf8");
  if (buf.byteLength <= CATALOG_OUTPUT_LIMIT) {
    return { text: raw, truncated: false, overLimit: false };
  }
  let end = CATALOG_OUTPUT_LIMIT;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return {
    text: buf.subarray(0, end).toString("utf8"),
    truncated: true,
    overLimit: true,
  };
}

export function splitCompleteLines(
  text: string,
  truncated = false,
): string[] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const trailingNewline = normalized.endsWith("\n");
  const parts = normalized.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  if (truncated && !trailingNewline && parts.length > 0) {
    parts.pop();
  }
  return parts;
}

export function prepareCatalogText(
  raw: string,
  truncated = false,
): CatalogLineSplit {
  const inspected = inspectCatalogOutput(raw);
  const cleaned = stripBoxDrawing(stripAnsi(inspected.text));
  const effectiveTruncated = truncated || inspected.truncated;
  return {
    text: cleaned,
    lines: splitCompleteLines(cleaned, effectiveTruncated),
    truncated: effectiveTruncated,
    overLimit: inspected.overLimit,
  };
}

export function isDiscoveryEnvironmentError(text: string): boolean {
  if (!text.trim()) return false;
  if (
    /login[_\s-]?required|not logged in|unauthoriz|authentication required/i.test(
      text,
    )
  ) {
    return false;
  }
  return /eacces|eperm|permission denied|access is denied|dpapi|目录不可读|cannot read.*(dir|directory|log|cache)|users?[\\/].*(denied|unreadable)/i.test(
    text,
  );
}

export function classifyDiscoveryFailure(
  stdout: string,
  stderr = "",
): { code: string; message: string } | undefined {
  const combined = `${stdout}\n${stderr}`;
  if (isDiscoveryEnvironmentError(combined)) {
    return {
      code: "DISCOVERY_ENVIRONMENT_UNAVAILABLE",
      message: "本机目录或权限不可用，不能判定账号未授权",
    };
  }
  if (/timed? ?out|超时/i.test(combined)) {
    return {
      code: "MODEL_PROBE_TIMEOUT",
      message: "读取模型目录超时",
    };
  }
  return undefined;
}

export function assertCatalogNotOverLimit(prepared: CatalogLineSplit): void {
  if (prepared.overLimit) {
    throw new FlowError(
      "CATALOG_OUTPUT_TRUNCATED",
      "模型目录输出超过 2MiB 上限，不能当作完整目录",
      422,
    );
  }
}

export function makeEntryId(
  adapterId: string,
  providerId: string | undefined,
  catalogId: string,
): string {
  return `${adapterId}/${providerId ?? "default"}/${catalogId}`;
}

export function catalogClock(discoveredAt?: string): {
  discoveredAt: string;
  staleAfter: string;
} {
  const at = discoveredAt ?? new Date().toISOString();
  return {
    discoveredAt: at,
    staleAfter: new Date(Date.parse(at) + CATALOG_FRESH_MS).toISOString(),
  };
}

export function visibleModelEntries(entries: ModelEntry[]): ModelEntry[] {
  return entries.filter((entry) => !entry.hidden);
}

export function failedModelCatalog(
  adapterId: SupportedAdapterId,
  input: CatalogParseInput,
  errorCode: string,
  errorMessage: string,
): ModelCatalog {
  const clock = catalogClock(input.discoveredAt);
  const catalog: {
    adapterId: SupportedAdapterId;
    scopeHash: string;
    cliPath?: string;
    cliVersion?: string;
    nativeConfigScope?: string;
    status: "failed";
    discoveredAt: string;
    staleAfter: string;
    entries: [];
    errorCode: string;
    errorMessage: string;
  } = {
    adapterId,
    scopeHash: input.scopeHash ?? "unscoped",
    status: "failed",
    discoveredAt: clock.discoveredAt,
    staleAfter: clock.staleAfter,
    entries: [],
    errorCode,
    errorMessage,
  };
  if (input.cliPath) catalog.cliPath = input.cliPath;
  if (input.cliVersion) catalog.cliVersion = input.cliVersion;
  if (input.nativeConfigScope) catalog.nativeConfigScope = input.nativeConfigScope;
  return ModelCatalogSchema.parse(catalog);
}

export function freshModelCatalog(
  adapterId: SupportedAdapterId,
  input: CatalogParseInput,
  entries: ModelEntry[],
): ModelCatalog {
  const clock = catalogClock(input.discoveredAt);
  const catalog: {
    adapterId: SupportedAdapterId;
    scopeHash: string;
    cliPath?: string;
    cliVersion?: string;
    nativeConfigScope?: string;
    status: "fresh";
    discoveredAt: string;
    staleAfter: string;
    entries: ModelEntry[];
  } = {
    adapterId,
    scopeHash: input.scopeHash ?? "unscoped",
    status: "fresh",
    discoveredAt: clock.discoveredAt,
    staleAfter: clock.staleAfter,
    entries,
  };
  if (input.cliPath) catalog.cliPath = input.cliPath;
  if (input.cliVersion) catalog.cliVersion = input.cliVersion;
  if (input.nativeConfigScope) catalog.nativeConfigScope = input.nativeConfigScope;
  return ModelCatalogSchema.parse(catalog);
}

export function discoveryFailureFromInput(
  input: CatalogParseInput,
): { code: string; message: string } | undefined {
  const prepared = prepareCatalogText(
    `${input.stdout}\n${input.stderr ?? ""}`,
    input.truncated,
  );
  if (prepared.overLimit) {
    return {
      code: "CATALOG_OUTPUT_TRUNCATED",
      message: "模型目录输出超过 2MiB 上限，不能当作完整目录",
    };
  }
  return classifyDiscoveryFailure(input.stdout, input.stderr);
}
