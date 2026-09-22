import { z } from "zod";
import { Id } from "./base.js";
import { WorkspaceReferenceSchema } from "./feedback.js";

export const CONVERSATION_FILE_LIMITS = {
  maxFilesPerMessage: 10,
  maxFileBytes: 20 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  summaryChars: 500,
  publicMessageChars: 16000,
  commandChars: 32000,
  draftTtlMs: 24 * 60 * 60 * 1000,
} as const;

export const ConversationInputModeSchema = z.enum(["formal", "aside"]);
export type ConversationInputMode = z.infer<typeof ConversationInputModeSchema>;

export const ConversationFileStatusSchema = z.enum([
  "pending",
  "uploading",
  "ready",
  "failed",
  "deleted",
]);
export type ConversationFileStatus = z.infer<typeof ConversationFileStatusSchema>;

export const ConversationFileSchema = z
  .object({
    id: Id,
    workflow_id: Id,
    project_id: Id,
    request_id: z.string().min(1),
    display_name: z.string().min(1).max(255),
    declared_mime: z.string().min(1),
    detected_mime: z.string().optional(),
    size: z.number().int().nonnegative(),
    sha256: z.string().optional(),
    status: ConversationFileStatusSchema,
    created_at: z.string().min(1),
    ready_at: z.string().optional(),
    referenced_message_ids: z.array(Id).default([]),
  })
  .strict();
export type ConversationFile = z.infer<typeof ConversationFileSchema>;

export const CreateConversationFileRequestSchema = z
  .object({
    request_id: z.string().min(1),
    display_name: z.string().min(1).max(255),
    size: z.number().int().nonnegative().max(CONVERSATION_FILE_LIMITS.maxFileBytes),
    declared_mime: z.string().min(1),
  })
  .strict();
export type CreateConversationFileRequest = z.infer<
  typeof CreateConversationFileRequestSchema
>;

export const ConversationMessageSchema = z
  .object({
    id: Id,
    workflow_id: Id,
    request_id: z.string().min(1),
    root_conversation_id: Id,
    expected_generation: z.number().int().nonnegative(),
    mode: ConversationInputModeSchema,
    text: z.string(),
    refs: z.array(WorkspaceReferenceSchema).default([]),
    attachment_ids: z.array(Id).default([]),
    target_workflow_id: Id,
    feedback_message_id: Id.optional(),
    aside_id: Id.optional(),
    functional_issue_id: Id.optional(),
    created_at: z.string().min(1),
  })
  .strict();
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

export const ConversationMessageRequestSchema = z
  .object({
    request_id: z.string().min(1),
    root_conversation_id: Id,
    expected_generation: z.number().int().nonnegative(),
    text: z.string(),
    refs: z.array(WorkspaceReferenceSchema).default([]),
    attachment_ids: z.array(Id).default([]),
    client_mode: ConversationInputModeSchema.optional(),
  })
  .strict();
export type ConversationMessageRequest = z.infer<
  typeof ConversationMessageRequestSchema
>;

export const ConversationMessageResponseSchema = z
  .object({
    message_id: Id,
    mode: ConversationInputModeSchema,
    target_workflow_id: Id,
    accepted: z.boolean(),
    aside_id: Id.optional(),
  })
  .strict();

export const DEFAULT_ATTACHMENT_PROMPT =
  "请查看本次附件，结合当前任务处理";

export const ResolvedInputAttachmentSchema = z
  .object({
    id: Id,
    display_name: z.string().min(1),
    sha256: z.string().min(1),
    absolute_path: z.string().min(1),
    mime: z.string().min(1),
    read_mode: z.enum(["text", "image", "binary"]),
    size: z.number().int().nonnegative(),
  })
  .strict();
export type ResolvedInputAttachment = z.infer<
  typeof ResolvedInputAttachmentSchema
>;

export const ConversationRuntimeDisplaySchema = z
  .object({
    model_label: z.string().min(1),
    effort_label: z.string().min(1),
    model_source: z.enum(["actual", "requested", "unreported", "not_applicable"]),
    effort_source: z.enum(["actual", "requested", "unreported", "not_applicable"]),
  })
  .strict();
export type ConversationRuntimeDisplay = z.infer<
  typeof ConversationRuntimeDisplaySchema
>;

export const ConversationSendStateSchema = z
  .object({
    can_send: z.boolean(),
    reason: z.string().optional(),
    default_text: z.string().optional(),
  })
  .strict();
export type ConversationSendState = z.infer<typeof ConversationSendStateSchema>;

export function fileWithinConversationLimits(params: {
  fileCount: number;
  fileBytes: number;
  totalBytes: number;
}): "ok" | "too_many" | "file_too_large" | "total_too_large" {
  if (params.fileCount > CONVERSATION_FILE_LIMITS.maxFilesPerMessage)
    return "too_many";
  if (params.fileBytes > CONVERSATION_FILE_LIMITS.maxFileBytes)
    return "file_too_large";
  if (params.totalBytes > CONVERSATION_FILE_LIMITS.maxTotalBytes)
    return "total_too_large";
  return "ok";
}
