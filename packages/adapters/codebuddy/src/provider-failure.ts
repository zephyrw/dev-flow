import { z } from "zod";

const terminalFailure = z.object({
  type: z.literal("result"),
  subtype: z.literal("error_during_execution"),
  is_error: z.literal(true),
  errors: z.array(z.string()),
  errors_info: z.array(z.object({
    status: z.number().optional(),
    code: z.union([z.number(), z.string()]).optional(),
  }).nullable()).optional(),
});
const exhaustedCodes = new Set([14001, 14012, 14013, 14014, 14018, 14019, 14022, 14023]);

export function classifyCodeBuddyQuotaFailure(event: unknown, nativeService: boolean) {
  const terminal = terminalFailure.safeParse(event);
  if (!terminal.success) return;
  const { errors, errors_info: information } = terminal.data;
  if (nativeService && information?.length === errors.length) {
    // CodeBuddy's own gateway shares HTTP 429 across rate, quota and account errors.
    for (const error of information.toReversed()) {
      if (error?.status !== 429) continue;
      const code = Number(error.code);
      if (exhaustedCodes.has(code)) return "MODEL_CREDITS_EXHAUSTED";
      if (code === 14003 || (Number.isInteger(code) && code >= 6000 && code <= 6008))
        return "MODEL_RATE_LIMIT";
    }
  }
  const detail = errors.join("\n");
  if (/no available credits|(?:insufficient|exhausted) credits|credits? (?:exhausted|depleted)|quota exhausted|额度已用尽|积分(?:不足|耗尽|已用尽)/i.test(detail))
    return "MODEL_CREDITS_EXHAUSTED";
  if (/\brate[ _-]limit(?:ed)?\b|too many requests|(?:请求|调用)(?:频率|速率)(?:超限|受限)|限流/i.test(detail))
    return "MODEL_RATE_LIMIT";
}
