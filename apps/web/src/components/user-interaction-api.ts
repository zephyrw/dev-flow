import type {
  UserInteractionRecord,
  UserInteractionResponseInput,
} from "../../../../packages/contracts/src/user-interaction.js";

export async function getCurrentUserInteraction(
  workflowId: string,
  signal?: AbortSignal,
): Promise<UserInteractionRecord | null> {
  const res = await fetch(
    `/api/workflows/${encodeURIComponent(workflowId)}/user-interactions/current`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
      },
      signal,
    },
  );

  if (!res.ok) {
    throw new Error(`获取人工交互请求失败 (${res.status})`);
  }

  const data = await res.json();
  return data.interaction ?? null;
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
