import { z } from "zod";

export const tools = ["codex", "agy", "claude-code", "opencode"] as const;
export const scenes = ["open", "fiction", "design"] as const;
export const stages = ["reply", "summary", "ideas", "idea_vote", "questions", "question_vote", "outline", "plans", "reviews", "final"] as const;
export type Stage = (typeof stages)[number];
export const nickname = z.string().trim().min(1).max(32);
export const key = z.string().uuid();
export const modelInput = z.object({
  nickname, tool: z.enum(tools), model: z.string().trim().min(1).max(200),
  effort: z.string().trim().min(1).max(40).optional(),
}).strict();
export type Model = z.infer<typeof modelInput> & { id: string };
export type Roster = { human: string; admin: string; members: Model[] };
export type Group = Roster & { id: string; title: string; version: number };
export type Session = Roster & {
  id: string; group: string; title: string; scene: (typeof scenes)[number]; version: number;
  created: string; updated: string; archived: boolean; deleting?: boolean; deletionError?: string;
  round?: string; brief?: string; premise?: string; answers: { question: string; answer: string }[];
  chosenQuestion?: string; adopted?: string; rejected?: string; pending?: string;
};
export type Message = { id: string; author: string; text: string; recipients: string[]; created: string; artifact?: string };
export type Artifact = {
  id: string; round: string; stage: Stage; member: string; author: string; title: string; hash?: string;
  options?: string[]; ballot?: Ballot; scores?: Score[];
};
export const ballotSchema = z.object({
  choice: key.nullable(), reasons: z.array(z.object({ id: key, reason: z.string().trim().min(1).max(400) })).min(1),
  abstainReason: z.string().trim().max(400).nullish().transform(reason => reason ?? undefined),
});
export type Ballot = z.infer<typeof ballotSchema>;
export const scoreSchema = z.object({
  id: key, points: z.array(z.number().finite().min(0).max(10)).length(5),
  good: z.string().trim().min(1).max(500), issue: z.string().trim().min(1).max(500),
  change: z.string().trim().min(1).max(500),
});
export type Score = z.infer<typeof scoreSchema>;
export const scoreWeights = [30, 25, 20, 15, 10];
export function scoreTotal(score: Score) {
  return score.points.reduce((sum, point, index) => sum + point * scoreWeights[index]! / 10, 0);
}
export type Job = {
  member: string; state: "queued" | "running" | "done" | "failed" | "skipped";
  error?: string; artifact?: string;
};
export type Round = {
  id: string; stage: Stage; status: "running" | "waiting" | "done" | "paused";
  request: string; candidates: string[]; jobs: Job[]; execute?: boolean; context: string; selected?: string; returnTo?: string;
};
export const actionInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("send"), text: z.string().trim().min(1).max(20_000), targets: z.array(key).max(16).optional(), all: z.boolean().optional(), mode: z.enum(["scene", "reply", "record", "execute"]).default("scene") }),
  z.object({ action: z.literal("restart"), text: z.string().trim().max(3000).default("") }),
  z.object({ action: z.literal("premise"), artifact: key.optional(), text: z.string().trim().min(1).max(3000).optional() }),
  z.object({ action: z.literal("question"), artifact: key }),
  z.object({ action: z.literal("answer"), text: z.string().trim().min(1).max(3000) }),
  z.object({ action: z.enum(["outline", "final"]), member: key.optional(), artifact: key.optional(), text: z.string().trim().max(4000).default("") }),
  z.object({ action: z.literal("adopt"), artifact: key }),
  z.object({ action: z.enum(["retry", "skip"]), member: key }),
  z.object({ action: z.enum(["pause", "resume", "cancel", "sync", "archive", "restore", "summary"]) }),
  z.object({ action: z.literal("scene"), scene: z.enum(scenes) }),
]);
export type Action = z.infer<typeof actionInput>;
