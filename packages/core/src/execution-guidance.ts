import { executionScopeInstructions } from "./role-boundaries.js";
import { REAL_BROWSER_VERIFICATION_PROMPT } from "./execution-skill-materials.js";

/** Shared development order and parallel subagent testing with one target per invocation. */
export const batchExecutionInstructions =
  executionScopeInstructions +
  "沿用原计划。任务和测试的顺序、并行方式及测试时机由执行模型自主决定；只协调真实依赖和共享资源冲突。" +
  "按受影响目标定向运行测试，每条命令只指定一个测试类、文件或用例。保留仍适用于当前代码的结果，避免无筛选全量命令。" +
  REAL_BROWSER_VERIFICATION_PROMPT +
  "主 Agent 明确各子 Agent 的目标与真实资源依赖；发现共享修改点时协调负责人，通知受影响 Agent 定向回归，不预设可修改文件范围。只协调实际代码或资源冲突，无关目标继续推进。通过且不受本次修改影响的目标不重复执行。" +
  "无关问题只记录，不扩大范围或顺手重构。该规则由执行模型落实，平台不增加测试粒度或证明校验。完成开发和自测后说明结果，直接交代码审查；不为调用 ID、清单或 hash 重跑测试。" +
  "交付说明逐项对应原计划测试场景，说明已完成、失败、跳过和受阻项；单元测试不能代替原计划的真实接口、持久化、集成、E2E或真实浏览器场景，也不能把这些场景关联到仅验证其他层面的命令后声称通过。复用已完成且未受影响的结果，只补做尚未完成的场景。原计划必要测试未完成时不得声明整轮completed；可继续完成的由你继续，需要外部条件时报告具体缺项与need_user，不交给代码审查模型代做或核验测试。";

export {
  asideRecoveryGuidance,
  executeRecoveryGuidance,
  planningBridgeInstructions,
  planningRecoveryGuidance,
  repairRecoveryGuidance,
  reviewBridgeInstructions,
  reviewRecoveryGuidance,
} from "./conversation-guidance.js";
export type {
  RecoveryGuidanceAttachment,
  RecoveryGuidanceOptions,
  RecoveryGuidanceRole,
} from "./conversation-guidance.js";

export {
  EXECUTION_TESTING_RESOURCE_PATHS,
  REAL_BROWSER_VERIFICATION_PROMPT,
  resolveExecutionSkillsRoot,
  getExecutionSkillResources,
  getExecutionSkillFilePaths,
  shouldIncludeExecutionTestingSkill,
} from "./execution-skill-materials.js";
