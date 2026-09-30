import type { FileInputCapability } from "./conversation.js";

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
