import { z } from "zod";
import { Id, RelativePath, Layer, ScopeSchema } from "./base.js";

/**
 * native-v2 模块定义
 */
export const NativeModuleSchema = z
  .object({
    id: Id,
    title: z.string().min(1),
    description: z.string().optional(),
    paths: z.array(RelativePath).default([]),
  })
  .strict();
export type NativeModule = z.infer<typeof NativeModuleSchema>;

/**
 * native-v2 业务工作项定义（精简版，不含长正文或逐项 completion_checks）
 */
export const NativeWorkItemSchema = z
  .object({
    id: Id,
    module_id: Id.optional(),
    repo_id: Id.optional(),
    title: z.string().min(1),
    description: z.string().optional(),
    paths: z.array(RelativePath).min(1),
    depends_on: z.array(Id).default([]),
    acceptance_ids: z.array(Id).default([]),
  })
  .strict();
export type NativeWorkItem = z.infer<typeof NativeWorkItemSchema>;

/**
 * native-v2 验收场景与标准定义（业务场景 ID 与测试执行分离）
 */
export const NativeAcceptanceItemSchema = z
  .object({
    id: Id,
    work_item_ids: z.array(Id).min(1),
    module_id: Id.optional(),
    layer: Layer,
    scenario: z.string().min(1),
    expected_outcome: z.string().min(1),
    timeout_seconds: z.number().int().positive().max(7200).default(300),
  })
  .strict();
export type NativeAcceptanceItem = z.infer<typeof NativeAcceptanceItemSchema>;

/**
 * native-v2 确定设计正文引用（正文单独存储按哈希去重）
 */
export const DesignReferenceSchema = z
  .object({
    content_hash: z.string().min(1),
    summary: z.string().min(1),
    file_ref: z.string().optional(),
  })
  .strict();
export type DesignReference = z.infer<typeof DesignReferenceSchema>;

/**
 * native-v2 精简计划合同
 */
export const NativePlanSchema = z
  .object({
    task_model: z.literal("native-v2"),
    revision: z.number().int().positive().default(1),
    design_ref: DesignReferenceSchema,
    modules: z.array(NativeModuleSchema).min(1),
    work_items: z.array(NativeWorkItemSchema).min(1),
    acceptance_items: z.array(NativeAcceptanceItemSchema).min(1),
    scope: ScopeSchema,
    baselines: z.record(Id, z.string().regex(/^[a-f0-9]{40,64}$/)),
    project_config_hash: z.string().min(1),
    feedback_cursor: z.number().int().default(0),
  })
  .strict();
export type NativePlan = z.infer<typeof NativePlanSchema>;
