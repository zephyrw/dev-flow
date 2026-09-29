import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readSkill = (path: string) => readFileSync(resolve("packages/skills", path), "utf8");
const planningMaterials = [
  "devflow/SKILL.md",
  "devflow-plan/SKILL.md",
  "devflow-plan/references/plan-contract.md",
  "devflow-execute/SKILL.md",
  "devflow-review/SKILL.md",
  "devflow-review/references/review-contract.md",
  "devflow-review/references/repair-document-contract.md",
  "devflow-project-onboard/SKILL.md",
];

describe("planning Skill output and original-document authority", () => {
  it.each(planningMaterials)("%s preserves the original instead of generating a recovery replacement", (path) => {
    const text = readSkill(path);
    expect(text).toMatch(/不能(?:用[^。]+)?覆盖原(?:始开发)?计划|不能因此覆盖原计划/);
    expect(text).toContain("不另建版本或副本");
    expect(text).toContain("checkbox");
    expect(text).toMatch(/实际完成|真实完成/);
    expect(text).not.toMatch(/现有版本\/hash|原文和版本|修订原计划的正式版本/);
  });

  it("describes behavior, impacts and necessary design without prescribing unfinished implementation", () => {
    for (const path of ["devflow-plan/SKILL.md", "devflow-plan/references/plan-contract.md"]) {
      const text = readSkill(path);
      for (const topic of ["现状", "目标从什么变成什么", "功能与逻辑变化", "关联影响", "数据设计", "技术坑", "细项 checkbox"]) {
        expect(text).toContain(topic);
      }
      expect(text).toContain("半成品代码");
      expect(text).toContain("只有实际完成才将 `[ ]` 改为 `[x]`");
      expect(text).toContain("普通实现");
    }
  });

  it("keeps scheduling rules in Skills rather than forcing boilerplate into every plan", () => {
    for (const path of ["devflow/SKILL.md", "devflow-plan/SKILL.md", "devflow-plan/references/plan-contract.md", "devflow-test/SKILL.md"]) {
      const text = readSkill(path);
      expect(text).toContain("不要求复制到计划正文");
      expect(text).toContain("多个子 Agent 并行");
      expect(text).toMatch(/每条命令(只指定一个|一个)测试类、文件或用例/);
      expect(text).toContain("真实依赖");
      expect(text).not.toMatch(/计划正文必须|规划模型必须将|正文必须明确写出|计划正文还必须/);
    }
  });

  it("preserves internal submission identity and the four independent test responsibilities", () => {
    expect(readSkill("devflow-plan/references/plan-contract.md")).toContain("内部审批身份与并发字段");
    const planning = readSkill("devflow-plan/SKILL.md");
    expect(planning).toContain("单元、集成、E2E、OpenTabs 四项");
    expect(planning).toContain("不能将 OpenTabs 并入 E2E");
    expect(planning).toContain("仅安排缺项或实际受影响的回归");
    expect(planning).toContain("不新增平台门禁或测试证明要求");
    expect(readSkill("devflow-test/SKILL.md")).toContain("不为补第四项重跑前三项");
  });
});
