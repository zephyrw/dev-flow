import { z } from "zod";
import {
  UserInteractionInputSchema,
  UserInteractionStatusSchema,
  type UserInteractionRecord,
  type UserInteractionResponseInput,
} from "../../../../packages/contracts/src/user-interaction.js";

const CurrentInteractionSchema = z.object({
  interaction: z
    .object({
      id: z.string().min(1),
      workflow_id: z.string().min(1),
      source_run_id: z.string(),
      source_plan_revision: z.number(),
      purpose: z.string(),
      role: z.string(),
      request: UserInteractionInputSchema,
      status: UserInteractionStatusSchema,
      created_at: z.string(),
    })
    .passthrough()
    .nullable(),
});

export class InteractionQueryError extends Error {
  constructor(
    message: string,
    readonly category:
      | "network"
      | "permission"
      | "service"
      | "http"
      | "response",
    readonly retryable: boolean,
    readonly status?: number,
    readonly code?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "InteractionQueryError";
  }
}

export async function getCurrentUserInteraction(
  workflowId: string,
  signal?: AbortSignal,
): Promise<UserInteractionRecord | null> {
  let res: Response;
  try {
    res = await fetch(
      `/api/workflows/${encodeURIComponent(workflowId)}/user-interactions/current`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal,
      },
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new InteractionQueryError(
      "无法连接本机服务，交互查询暂时不可用，请稍后重试",
      "network",
      true,
    );
  }

  if (!res.ok) {
    let code: string | undefined;
    let requestId: string | undefined;
    let serverMessage: string | undefined;
    try {
      const body = await res.json();
      if (typeof body?.error?.code === "string") code = body.error.code;
      if (typeof body?.error?.message === "string")
        serverMessage = body.error.message;
      const id = body?.error?.request_id ?? body?.request_id;
      if (typeof id === "string") requestId = id;
    } catch (error) {
      if (signal?.aborted) throw error;
    }
    const permission = res.status === 401 || res.status === 403;
    const service = res.status >= 500;
    const reason = permission
      ? "交互查询被拒绝，请检查本机访问权限"
      : service
        ? "本机服务暂时异常，无法查询交互请求"
        : "交互查询请求失败";
    throw new InteractionQueryError(
      `${reason}（HTTP ${res.status}）${serverMessage ? `：${serverMessage}` : ""}`,
      permission ? "permission" : service ? "service" : "http",
      service || res.status === 408 || res.status === 429,
      res.status,
      code,
      requestId,
    );
  }

  try {
    const data = CurrentInteractionSchema.parse(await res.json());
    if (data.interaction && data.interaction.workflow_id !== workflowId) {
      throw new Error("交互归属不匹配");
    }
    return data.interaction as UserInteractionRecord | null;
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof TypeError) {
      throw new InteractionQueryError(
        "读取交互数据时连接中断，请稍后重试",
        "network",
        true,
        res.status,
      );
    }
    throw new InteractionQueryError(
      "本机服务返回的交互数据格式异常，请刷新界面后重试",
      "response",
      false,
      res.status,
    );
  }
}

export async function respondUserInteraction(
  workflowId: string,
  interactionId: string,
  payload: UserInteractionResponseInput,
): Promise<{ success: boolean; interaction: UserInteractionRecord }> {
  const res = await fetch(
    `/api/workflows/${encodeURIComponent(
      workflowId,
    )}/user-interactions/${encodeURIComponent(interactionId)}/respond`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
    },
  );

  if (!res.ok) {
    let message = `提交交互响应失败 (${res.status})`;
    try {
      const errorJson = await res.json();
      if (errorJson?.error?.message) {
        message = errorJson.error.message;
      }
    } catch {
      // 保持默认错误信息
    }
    throw new Error(message);
  }

  return res.json();
}
