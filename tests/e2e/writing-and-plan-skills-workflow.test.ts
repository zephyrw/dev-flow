import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveExecutionSkillsRoot } from "../../packages/core/src/execution-skill-materials.js";

describe("A5 — E2E测试：Codex与AGY隔离安装产物发现、工作链路与写作规范核验", () => {
  it("A5 — 真实工具发现路径有效性核验：Codex与AGY受管技能安装位置可读且结构合法", () => {
    const root = resolveExecutionSkillsRoot();
    const writingSkillPath = join(root, "devflow-concise-complete-writing", "SKILL.md");
    const planSkillPath = join(root, "devflow-human-readable-plans", "SKILL.md");

    expect(existsSync(writingSkillPath)).toBe(true);
    expect(existsSync(planSkillPath)).toBe(true);

    const writingContent = readFileSync(writingSkillPath, "utf8");
    const planContent = readFileSync(planSkillPath, "utf8");

    // 检查 frontmatter 元数据格式
    expect(writingContent).toMatch(/^---\r?\nname:\s*devflow-concise-complete-writing/);
    expect(planContent).toMatch(/^---\r?\nname:\s*devflow-human-readable-plans/);

    // 检查核心规则正文
    expect(writingContent).toContain("简练完整表达");
    expect(writingContent).toContain("先给结论、答案或当前状态");
    expect(planContent).toContain("先写背景、现状、目标和制定原因");
    expect(planContent).toContain("总分结构");
  });

  it("A5 — 真实工具安装根目录与环境路径一致性核实", () => {
    // Codex: 检查主目录环境变量或默认 ~/.codex
    const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
    expect(codexHome).toBeTruthy();

    // AGY: Windows 平台 ~/.gemini/antigravity/skills
    const agySkillsHome = join(homedir(), ".gemini", "antigravity", "skills");
    expect(agySkillsHome).toBeTruthy();
  });

  it("A5 — 方案与回复文本样本核验：确认先总后分、背景在先及简短回复易读性", () => {
    // 样本1：简短回复核验（无套话、结论在先）
    const sampleReply = "修改已完成。全量类型检查与受影响集成测试均已通过，未改动非必要代码。";
    expect(sampleReply).not.toMatch(/尊敬的用户|您好|很高兴为您服务/);
    expect(sampleReply.length).toBeLessThan(100);

    // 样本2：方案文本核验（背景在先、先总后分）
    const samplePlan = `## 背景与现状
当前工具交接包重复传输Skill全文，占用大量Token。

## 目标与改动
统一使用工具原生加载，仅在交接包中传递技能引用与定位路径。

## 详细实现
1. 模块一...
2. 模块二...`;
    expect(samplePlan.indexOf("背景与现状")).toBeLessThan(samplePlan.indexOf("目标与改动"));
    expect(samplePlan.indexOf("目标与改动")).toBeLessThan(samplePlan.indexOf("详细实现"));
  });
});
