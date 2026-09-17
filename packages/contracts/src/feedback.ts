import { z } from "zod";
import { Id } from "./base.js";

export type FeedbackKind = "planning" | "execution" | "functional";
export type RefKind = "file" | "directory";

/**
 * 结构化引用模型（支持未跟踪、未提交、隐藏文件及目录）
 */
export const WorkspaceReferenceSchema = z
  .object({
    ref_id: Id,
    repo_id: z.string().min(1),
    relative_path: z.string().min(1),
    kind: z.enum(["file", "directory"]),
    label: z.string().optional(),
    selected_at: z.string().optional(),
    resolved_revision: z.string().optional(),
    availability: z
      .enum(["available", "missing", "outside_workspace", "unreadable"])
      .default("available"),
  })
  .strict();
export type WorkspaceReference = z.infer<typeof WorkspaceReferenceSchema>;

/**
 * 用户反馈消息合同
 */
export const FeedbackMessageSchema = z
  .object({
    message_id: Id,
    client_request_id: z.string().min(1),
    seq: z.number().int().positive(),
    workflow_id: Id,
    kind: z.enum(["planning", "execution", "functional"]),
    text: z.string().min(1),
    refs: z.array(WorkspaceReferenceSchema).default([]),
    target_document_revision: z.number().int().nonnegative().default(0),
    status: z.enum(["pending", "acknowledged", "resolved"]).default("pending"),
    ack_run: z.string().optional(),
    resolved_by_revision: z.number().int().optional(),
    created_at: z.string().min(1),
  })
  .strict();
export type FeedbackMessage = z.infer<typeof FeedbackMessageSchema>;

/**
 * 人工核验阶段的功能问题追踪
 */
export type FunctionalIssueStatus =
  | "open"
  | "queued"
  | "fixing"
  | "ready_for_retest"
  | "confirmed";

export const FunctionalIssueSchema = z
  .object({
    issue_id: Id,
    workflow_id: Id,
    created_seq: z.number().int().positive(),
    description: z.string().min(1),
    refs: z.array(WorkspaceReferenceSchema).default([]),
    status: z
      .enum(["open", "queued", "fixing", "ready_for_retest", "confirmed"])
      .default("open"),
    fix_delivery_id: z.string().optional(),
    retest_feedback: z.string().optional(),
    confirmed_at: z.string().optional(),
    created_at: z.string().min(1),
  })
  .strict();
export type FunctionalIssue = z.infer<typeof FunctionalIssueSchema>;

/**
 * /btw 临时只读提问会话合同
 */
export const AsideSessionSchema = z
  .object({
    id: Id,
    workflow_id: Id,
    profile_revision: z.string().min(1),
    context_ref: z.string().min(1),
    question: z.string().min(1),
    refs: z.array(WorkspaceReferenceSchema).default([]),
    status: z
      .enum(["active", "queued", "completed", "expired", "cancelled"])
      .default("queued"),
    answer: z.string().optional(),
    created_at: z.string().min(1),
    expires_at: z.string().min(1),
    completed_at: z.string().optional(),
  })
  .strict();
export type AsideSession = z.infer<typeof AsideSessionSchema>;
