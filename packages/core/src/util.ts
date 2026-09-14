import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { dirname } from "node:path";
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const objectHash = (value: unknown) => hash(canonical(value));
export const id = (prefix: string) => `${prefix}-${randomUUID()}`;
export const now = () => new Date().toISOString();
export const secret = () => randomBytes(32).toString("base64url");
export function atomicWrite(file: string, content: string | Buffer) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + "." + randomUUID() + ".tmp";
  const fd = openSync(temp, "wx", 0o600);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}
export function redact(text: string) {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(
      /((?:token|secret|password|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi,
      "$1[REDACTED]",
    );
}

/** Redact values, never serialized JSON syntax. Also handles nested tool JSON. */
export function publicEvent(value: unknown): any {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object")
        return JSON.stringify(publicEvent(parsed));
    } catch {
      /* Ordinary text, including incomplete streamed JSON. */
    }
    if (/[\u0000-\u0008\u000e-\u001f]/.test(value)) return "[已省略二进制内容]";
    return redact(value);
  }
  if (Array.isArray(value)) return value.map(publicEvent);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/thought|reasoning/i.test(key))
        .map(([key, item]) => [
          key,
          /secret|token|password|api[_-]?key/i.test(key)
            ? "[REDACTED]"
            : publicEvent(item),
        ]),
    );
  return value;
}
