# DevFlow MiMo Code 接入与轻量工作流调整 — 执行进度（非计划）

对应原计划：`docs/plan/DevFlow-MiMo-Code接入与轻量工作流调整详细开发计划-20260922.md`

本文件只记录执行事实，不重新定义范围或验收标准。

## 原编号映射

| 原编号 | 实现位置 | 测试情况 | 状态 |
| --- | --- | --- | --- |
| D01 契约与模板 | `packages/contracts/src/execution-spec.ts`（SupportedAdapters + mimo-code、quality_policy_version、template_revision 默认 7）；`model-routing.ts`（purpose + executor_test/planner_commit）；`model-catalog.ts`（TOOL_DISPLAY_ORDER + MiMo Code）；`quality.ts`（QualityFlow、CodeReviewResult、PlannerRepairResult、ExecutorTestResult、PlannerCommitResult）；`index.ts`（Workflow.quality_policy_version）；`packages/core/src/templates/default-template.ts`（revision 7、quality_policy_version 2）；`create-workflow.ts`；`run-profile.ts`（RunPurpose 扩展、PLANNER/EXECUTOR 用途集合） | typecheck 通过 | 完成 |
| D02 MiMo 基础 adapter | `packages/adapters/mimo/src/{adapter,model-configuration,conversation-source}.ts`；SDK `index.ts` 注册；`registry.ts` mimo-code:"mimo"；`launch.ts` @mimo-ai/cli；`invocation.ts` mimo-code 分支（MIMOCODE_CONFIG_CONTENT + MIMOCODE_DISABLE_AUTOUPDATE=1，stdin 提示词，不用 OPENCODE_CONFIG_CONTENT） | `tests/unit/mimo-model-configuration.test.ts` 5 通过；`tests/unit/mimo-conversation-source.test.ts` 5 通过 | 完成 |
| D03 模型目录与冻结配置 | `model-catalog-service.ts`（parseMimoModelCatalog、models --verbose、allowSlash、detectMimoVariantEncoding）；`model-selection.ts` mimo-code + --variant；`probe-terminal.ts` 剥 #variant；`catalog-parse.ts` DISCOVERY_AUTH_REQUIRED | 同上单测；fixture `tests/fixtures/model-catalog/mimo-code/*` | 完成 |
| D04 新质量路由 | `packages/core/src/quality-flow.ts`（纯函数 nextQualityAction）；`quality-policy-migration.ts`（read/write/routeQualityEvent）；`engine.ts` finalizeNativeDelivery/dispatchPolicy2AfterImplement/applyPolicy2Action/commitPolicy2RepairDecision | `tests/unit/quality-flow.test.ts` 12 通过（F01–F12 路由） | 完成 |
| D05 角色路由与恢复 | `run-profile.ts` resolveRoutingRole（executor_test→executor、planner_commit→planner）；`conversation-recovery.ts` asRunPurpose；`recovery.ts` resolveResumeTarget（executor_test/planner_commit 不回落 implement） | typecheck 通过；恢复回归待 D11 | 主体完成 |
| D06 规划实际提交 | `delivery-coordinator.ts` integrateCommittedDelivery()；`engine.ts` completePlannerCommit()；receiveReview 策略 2 派发 planner_commit 不调 executeDelivery | 单元/集成待 D11 | 主体完成 |
| D07 反馈与人工确认 | `engine.ts` accept() 策略 2 不调 assertPassed、human_functional_passed→after_human 最终复核；functional_fix 完成回 HUMAN_PENDING 不自动关问题 | 路由覆盖于 quality-flow 单测 | 主体完成 |
| D08 角色提示与 Skill | `role-boundaries.ts` roleBoundaryInstructionsFor(purpose)（规划复核/规划修复/执行测试/规划提交/功能修复） | typecheck 通过 | 部分完成（Skill 全文同步未做） |
| D09 API 与工作台 | 子 Agent ContentFilterError 中断；`renderers/mimo.ts`、`clients/installer.ts` mimo 配置目录已补 | 未跑 e2e | 部分完成 |
| D10 迁移与运维 | `quality-policy-migration.ts` migrateWorkflowQualityPolicy（11.1 映射表：active_run_frozen / git_in_flight / terminal_readonly / takeover→planner_repairs_only / repairDone→executor_repair_completed） | 待 D11 | 主体完成 |
| D11 自动测试 | 已跑：mimo-model-configuration、mimo-conversation-source、quality-flow；typecheck 全仓通过 | 集成/e2e/受影响旧断言未全跑 | 部分完成 |
| D12 真实验收与文档 | 本进度文档；真实 CLI 联调未做（本机 Get-Command mimo 未找到） | 未做 | 未完成 |

## 测试执行记录

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm exec vitest run tests/unit/quality-flow.test.ts` | 12 passed |
| `pnpm exec vitest run tests/unit/mimo-model-configuration.test.ts` | 5 passed |
| `pnpm exec vitest run tests/unit/mimo-conversation-source.test.ts` | 5 passed |

## 必要补齐说明

- `RunPurpose`/`DispatchContext.purpose` 同步加入 `executor_test`、`planner_commit`，否则新用途无法派发。
- `asRunPurpose`、`resolveResumeTarget` 补新用途，避免恢复回落 implement。
- 鉴权失败归为 `DISCOVERY_AUTH_REQUIRED`（与 `DISCOVERY_ENVIRONMENT_UNAVAILABLE` 区分，符合 M08）。
- `step_finish` 不等于任务 completed；只有 `result` 显式完成才结束 Run。
- JSON 多行元数据用 JSON.parse 判定完整，避免嵌套 `}` 提前 flush。

## 未完成项

1. D08：packages/skills/devflow* 全文与 role-and-schedule.md 的“三次接管”表述同步；execution-guidance/review-completion 文案；profile-runtime 注入 roleBoundaryInstructionsFor。
2. D09：ModelProfileEditor/ModelSettingsDrawer/ToolModelDrawer/RepairModelPicker/ConversationStatusBar/CurrentRuntime/workbench 新策略文案与 MiMo 展示。
3. D06：planner_commit 结果解析接线到 completePlannerCommit 的 repositories 字段；多仓部分提交恢复细测。
4. D11：集成/e2e（quality-policy-v2、planner-commit、migration、受影响旧用例）与 `pnpm run build`。
5. D12：真实 MiMo CLI 联调（本机未安装 mimo）；`tests/live/mimo-workflow.ts`。
6. Skill 实际安装目标更新与备份回滚演练。
