import type { FileInputCapability } from "./conversation.js";
import type { ConversationFile, ResolvedInputAttachment } from "./conversation-input.js";

const INLINE_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"]);
const TEXT_MIMES = new Set([
  "application/json", "application/javascript", "application/xml", "application/yaml",
  "application/x-yaml", "application/toml", "application/sql", "application/graphql",
  "application/xhtml+xml", "image/svg+xml", "application/x-sh", "application/x-httpd-php",
]);

export function normalizeAttachmentMime(mime: string | undefined): string {
  return (mime ?? "").split(";")[0]!.trim().toLowerCase();
}

export function isOfficeMime(mime: string): boolean {
  const value = normalizeAttachmentMime(mime);
  return value === "application/msword" || value === "application/rtf" ||
    value.startsWith("application/vnd.ms-") ||
    value.startsWith("application/vnd.openxmlformats-officedocument.") ||
    value.startsWith("application/vnd.oasis.opendocument.");
}

export function isPdfMime(mime: string): boolean {
  return normalizeAttachmentMime(mime) === "application/pdf";
}

export function resolveEffectiveMime(file: ConversationFile): string {
  const detected = normalizeAttachmentMime(file.detected_mime);
  const declared = normalizeAttachmentMime(file.declared_mime);
  if (detected === "application/zip" && isOfficeMime(declared)) return declared;
  if (detected && detected !== "application/octet-stream") return detected;
  return declared || detected || "application/octet-stream";
}

export function classifyAttachmentReadMode(mime: string): ResolvedInputAttachment["read_mode"] {
  const value = normalizeAttachmentMime(mime);
  if (INLINE_IMAGE_MIMES.has(value)) return "image";
  if (value.startsWith("text/") || TEXT_MIMES.has(value) || value.endsWith("+json") || value.endsWith("+xml")) return "text";
  return "binary";
}

export const AGY_IMAGE_FILE_INPUT: FileInputCapability = {
  text: false,
  image: true,
  binary: false,
  image_mime_types: ["image/png", "image/jpeg"],
};

export const AGY_IMAGE_FORMAT_UNSUPPORTED =
  "AGY 当前支持 PNG/JPEG 图片，此格式尚未接入";

export function normalizeInputMime(mime: string): string {
  const value = mime.split(";")[0]!.trim().toLowerCase();
  return value === "image/jpg" ? "image/jpeg" : value;
}

export function supportsAttachmentInput(
  kind: "text" | "image" | "binary",
  capability: FileInputCapability,
  mime = "",
): boolean {
  return capability[kind] && (kind !== "image" ||
    !capability.image_mime_types ||
    capability.image_mime_types.includes(normalizeInputMime(mime)));
}
