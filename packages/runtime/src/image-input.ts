import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, win32 } from "node:path";
import { inflateSync } from "node:zlib";

/** Inspect bytes, never rewrite files or prescribe which tool the model must use. */
export function localImageProblem(path: string, mime?: string): string | undefined {
  const format = mime?.split(";")[0]?.toLowerCase() || extname(path).toLowerCase();
  if (!["image/png", ".png", "image/jpeg", "image/jpg", ".jpg", ".jpeg"].includes(format)) return;
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return;
    const bytes = readFileSync(path);
    if (validPng(bytes) || validJpeg(bytes)) return;
    return `本地的 ${path} 图片损坏，请检查保存格式。`;
  } catch {
    // File access failures belong to the file tool; they are not proof of corruption.
    return;
  }
}

export function imagePathsInArguments(value: unknown): string[] {
  const paths = new Set<string>();
  const visit = (item: unknown, depth = 0) => {
    if (depth > 8) return;
    if (typeof item === "string" && item.length < 4096 && !/[\r\n]/.test(item) &&
        (isAbsolute(item) || win32.isAbsolute(item)) && /\.(?:png|jpe?g)$/i.test(item)) paths.add(item);
    else if (Array.isArray(item)) item.forEach(child => visit(child, depth + 1));
    else if (item && typeof item === "object") Object.values(item).forEach(child => visit(child, depth + 1));
  };
  visit(value);
  return [...paths];
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validPng(bytes: Buffer): boolean {
  if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return false;
  let offset = 8, header = false;
  const data: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size;
    if (end > bytes.length) return false;
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) return false;
    if (!header) {
      if (type !== "IHDR" || size !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) return false;
      header = true;
    }
    if (type === "IDAT") data.push(bytes.subarray(offset + 8, end - 4));
    if (type === "IEND") {
      if (size !== 0 || !data.length) return false;
      try { inflateSync(Buffer.concat(data), { maxOutputLength: 256 * 1024 * 1024 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ERR_BUFFER_TOO_LARGE") return false; }
      return true;
    }
    offset = end;
  }
  return false;
}

function validJpeg(bytes: Buffer): boolean {
  if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) return false;
  let offset = 2, frame = false, scan = false;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) { if (scan) continue; return false; }
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) return frame && scan;
    if (marker === 0x01) continue;
    if (scan && (marker === 0 || (marker! >= 0xd0 && marker! <= 0xd7))) continue;
    if (offset + 2 > bytes.length) return false;
    const size = bytes.readUInt16BE(offset);
    if (size < 2 || offset + size > bytes.length) return false;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker!)) frame = true;
    if (marker === 0xda) scan = true;
    offset += size;
  }
  return false;
}
