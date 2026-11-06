import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunModel } from "../../packages/group-chat/src/model-runner.js";

export const groupChatFixtureModel: RunModel = async ({ member, prompt, cwd, execute, signal }) => {
  signal.throwIfAborted();
  const ids = [...prompt.matchAll(/\[ID ([a-f0-9-]+)\]/g)].map(match => match[1]!);
  if (prompt.includes("返回 JSON 数组")) return JSON.stringify(ids.map(id => ({
    id, points: [8, 9, 7, 9, 8], good: "会话隔离", issue: "恢复需要明确", change: "增加恢复步骤",
  })));
  if (prompt.includes("只有一张推荐票")) return JSON.stringify({
    choice: ids[0], reasons: ids.map(id => ({ id, reason: "取舍明确" })), abstainReason: null,
  });
  if (prompt.includes("options 为 2–4")) return JSON.stringify({
    title: "主人公如何作出决定？", markdown: "这个选择决定故事结局。", options: ["主动坦白", "保留秘密", "寻找证人"],
  });
  if (prompt.includes("一句话故事点子")) return JSON.stringify({
    title: member.nickname + "的点子", markdown: "一位修表匠发现自己的时间正在倒流，必须在天亮前决定能否挽救旧友。",
  });
  if (prompt.includes("独立写一份完整方案")) return "# 独立方案\n\n使用独立目录并保留用户决定。\n\n## 验收\n\n检查不同会话之间的隔离。";
  if (prompt.includes("完整 Markdown 成稿")) return "# 最终稿\n\n已纳入恢复步骤。";
  if (prompt.includes("可动笔的大纲")) return "# 小说大纲\n\n主人公选择坦白并承担后果。";
  if (prompt.includes("为本次用户请求创建文本文件")) return JSON.stringify({ summary: "已准备文件", files: [{ path: "drafts/notes.md", content: "成员文件" }] });
  if (execute) writeFileSync(join(cwd, "work.md"), "# 独立工作");
  return "# 回复\n\n" + member.nickname + "完成本轮任务。";
};
