import { z } from "zod";

export const TaskNameSchema = z.string().trim().min(1, "任务名称必填")
  .refine((value) => Array.from(value).length <= 20, "任务名称最多 20 字");
export const GeneratedTaskNameSchema = TaskNameSchema.describe(
  "由模型根据完整需求概括约 10 字的任务名称，最多 20 字；不要截取需求正文或保留 Markdown 标记",
);
