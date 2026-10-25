import type { UserInteractionInput } from "../../contracts/src/user-interaction.js";

/** Compatibility with the exact platform recovery template; authored questions are unchanged. */
export function displayInteractionRequest(request: UserInteractionInput): UserInteractionInput {
  const start = "上次模型请求被服务端拒绝，尚未完成当前任务。请在原阶段检查并处理这个输入问题：\n";
  const end = "\n请自行检查相关输入和保存格式后继续原任务；不要重复已经完成的开发和测试。无法自行解决时，通过 need_user 和 user_interaction 说明具体问题并请求协助。";
  if (request.kind !== "action_required" || request.title !== "模型请求仍被拒绝，需要协助" ||
      request.action_label !== "已处理，继续原任务" || !request.message.startsWith(start) || !request.message.endsWith(end)) return request;
  return { ...request, message: "模型请求再次被拒绝，当前任务尚未完成。请检查输入格式及模型配置，处理后继续原任务；已有进度已保留。",
    details: request.details ?? request.message.slice(start.length, -end.length) };
}
