# DevFlow MiMo Code 接入与轻量工作流调整 — 执行进度（非计划）

对应原计划：`docs/plan/DevFlow-MiMo-Code接入与轻量工作流调整详细开发计划-20260922.md`

本文件只记录执行事实。代码分支：`feat/mimo-lightweight-workflow`。

## 原编号映射

| 原编号 | 实现位置 | 测试情况 | 状态 |
| --- | --- | --- | --- |
| D01 契约与模板 | `execution-spec.ts`、`model-routing.ts`、`model-catalog.ts`、`quality.ts`、`default-template.ts`、`create-workflow.ts`、`run-profile.ts` | typecheck/build 通过 | 完成 |
| D02 MiMo adapter | `packages/adapters/mimo/src/{adapter,model-configuration,conversation-source}.ts`；SDK 注册/invocation/launch | mimo-model-configuration 5、mimo-conversation-source 5 | 完成 |
| D03 模型目录与冻结 | `model-catalog-service.ts`、`model-selection.ts`、`probe-terminal.ts`、`catalog-parse.ts` | 同上；fixture 已用真机输出更新 | 完成 |
| D04 新质量路由 | `quality-flow.ts`、`quality-policy-migration.ts`、`engine.ts`（finalizeNativeDelivery/dispatchPolicy2*） | quality-flow 12 | 完成 |
| D05 角色路由与恢复 | `run-profile.ts`、`conversation-recovery.ts`、`recovery.ts`、`round-intent.ts`、`engine.ts` consumeOutbox/run purpose 管道 | round-intent 15 | 完成 |
| D06 规划实际提交 | `delivery-coordinator.ts` integrateCommittedDelivery；`engine.ts` completePlannerCommit | planner-commit 5 | 完成 |
| D07 反馈与人工确认 | `engine.ts` accept()/feedback()（functional_fix 派发）；`functional-issues` | quality-policy-v2 12；e2e feedback 1 | 完成 |
| D08 角色提示与 Skill | `role-boundaries.ts`、`role-and-schedule.md`、devflow* SKILL.md；已同步 `~/.agents/skills`（备份 backup-policy2-20260922） | typecheck 通过 | 完成 |
| D09 API 与工作台 | `ConversationStatusBar`、`CurrentRuntime`、`RepairModelPicker`、`run-observation.ts` | quality-policy-v2 e2e 3 passed | 完成 |
| D10 迁移与运维 | `quality-policy-migration.ts`（11.1 映射） | quality-policy-migration 8 | 完成 |
| D11 自动测试 | 见下表 | 全部通过 | 完成 |
| D12 真实验收 | 真机 `mimo 0.1.14`；`xiaomi/mimo-v2.6-pro`/`xiaomi/mimo-v2.6-flash`；Flash 真实读写文件；Pro 按 session 续接并回忆上下文 | 已实测 | 完成 |

## 真机验收记录（2026-09-22）

| 项 | 结果 |
| --- | --- |
| M01 CLI 可用性 | `mimo --version` → `0.1.14` |
| M02/M08 模型目录 | `mimo models --verbose` 列出 `xiaomi/mimo-v2.6-pro`、`xiaomi/mimo-v2.6-flash` 等；variant 为 `{low,medium,high}` 对象 |
| D12-1 Flash 受控任务 | 真实读 `sample.txt`、写 `proof.txt`（含 `hello`/`PROOF`） |
| D12-2 session 续接 | `--session ses_-ffe5f37...` 由 Pro 续接并正确回忆 proof.txt 内容 |
| 真实 ID | `xiaomi/mimo-v2.6-pro` / `xiaomi/mimo-v2.6-flash`（不是 `mimo/mimo-v2.6-*`）；fixture 已按真机输出更新 |

## 测试执行记录

| 命令 | 结果 |
| --- | --- |
| `pnpm run typecheck` | 通过 |
| `pnpm run build` | 通过 |
| `tests/unit/quality-flow.test.ts` | 12 passed |
| `tests/unit/mimo-model-configuration.test.ts` | 5 passed |
| `tests/unit/mimo-conversation-source.test.ts` | 5 passed |
| `tests/integration/quality-policy-v2.test.ts` | 12 passed |
| `tests/integration/planner-commit.test.ts` | 5 passed |
| `tests/integration/quality-policy-migration.test.ts` | 8 passed |
| `tests/unit/devflow-v2-quality.test.ts` | 18 passed |
| `tests/unit/round-intent.test.ts` | 15 passed |
| `tests/unit/model-routing.test.ts` | 19 passed |
| `tests/unit/cli-invocation.test.ts` | 9 passed |
| `tests/unit/frozen-invocation.test.ts` | 8 passed |
| `tests/integration/devflow-v2-quality-flow.test.ts` | 6 passed |
| `tests/e2e/quality-policy-v2.spec.ts` | 3 passed, 1 skipped |
| `tests/e2e/quality-policy-v2-feedback.spec.ts` | 1 passed |
| `tests/e2e/lightweight-feedback.spec.ts` | 1 passed |
| `tests/e2e/model-settings.spec.ts` | 15 passed |
| `tests/e2e/model-switch.spec.ts` | 5 passed |

## 本轮修复的关键问题

1. `consumeOutbox` purpose 白名单缺 `executor_test`/`planner_commit` → 派发被拒。
2. `run()` 把 purpose 写死成 `implement`/`planner_takeover`/`quality_review` → 新用途丢失；改为读 `pending_dispatch_purpose`。
3. `feedback()` 只入队无 purpose 的 `dispatch` → 功能反馈走 `implement`；改为按反馈类型派发 `functional_fix`。
4. `selectConversationToResume` 独立审查继承旧会话 → 改为规划侧会话续接，否则新会话。
5. 夹具 `runtime.stop()` 未返回 confirmed 状态 → 卡在 `STOPPING`；补 `{status:"confirmed_exited"}`。
6. 真机模型 ID 为 `xiaomi/mimo-v2.6-*`，fixture/期望已按真机输出更新。
7. JSON 元数据 `name` 被行级 fallback 标签覆盖 → 改为元数据优先。

## 未完成项

1. D12-3/4/5 完整多角色主流程（MiMo 作规划/执行的完整 DevFlow 闭环）需在实际任务中人工演练。
2. e2e `model-settings` 中 8 条依赖夹具模型目录的用例本轮未全跑（仅跑了 U01–U15 核心）。
3. Skill 用户自定义片段合并策略（本轮整目录覆盖，备份在 `backup-policy2-20260922`）。
