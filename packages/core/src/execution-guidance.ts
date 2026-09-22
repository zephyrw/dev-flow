import { executionScopeInstructions } from "./role-boundaries.js";

/** Shared development order and parallel subagent testing with one target per invocation. */
export const batchExecutionInstructions =
  executionScopeInstructions +
  "开发阶段将原计划中互不依赖的任务分配给多个子 Agent 并行实现，明确任务编号、可修改文件、接口与真实依赖；主 Agent 协调共享代码及资源并整合结果，不虚构依赖把无关开发串行化。子 Agent 直接遵守原计划，不另建替代计划。" +
  "先完成正式计划中的全部开发任务，包括功能实现、端到端接线、异常与边界处理及测试代码，再进入单元、集成和 E2E 测试阶段。将独立测试目标分配给多个子 Agent 并行执行，各子 Agent 每条命令只指定一个测试类、文件或用例，并负责相关问题的定位、修复和重跑。某个目标失败不阻塞其他无关目标；不同测试层之间不设固定先后顺序。仅有真实依赖或共享资源冲突的目标需要协调、隔离或局部串行。禁止无筛选的全量命令、全库通配符和一次拼接多个测试目标；受影响回归也按独立目标分派并行，不因局部修改重跑整个套件。" +
  "初次开发与正式整改先完成正式范围，不把单个功能伪装成计划完成；进入测试阶段后允许逐个定位和修复。" +
  "主 Agent 明确各子 Agent 的目标、文件和资源归属；共享代码问题指定一个负责人修复，通知受影响 Agent 定向回归。只协调实际代码或资源冲突，无关目标继续推进。通过且不受本次修改影响的目标不重复执行。" +
  "无关问题只记录，不扩大范围或顺手重构。该规则由执行模型落实，平台不增加测试粒度或证明校验。完成开发和自测后说明结果，直接交代码审查；不为调用 ID、清单或 hash 重跑测试。";

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
