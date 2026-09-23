# DevFlow MiMo Code 与轻量工作流修复验证报告

日期：2026-09-23。状态：回归执行完成，2 处修复引入回归已修复，预存边界已记录。

## 1. 验证范围与边界

按[修复计划](C:/Code/system-handle/docs/plan/DevFlow-MiMo-Code与轻量工作流代码质量复核及完整修复计划-20260923.md)第 8 节验收顺序执行：相关单元与 Engine 集成 → 临时真实 Git → typecheck/build → 指定浏览器回归。

**已执行**：TypeScript 类型检查、构建、单元与集成测试、真实临时 Git 集成、Playwright 浏览器回归。

**未执行**：真实 MiMo V2.6 Pro/Flash 账号调用、真实活跃任务迁移、部署、提交或推送。MiMo 原生权限、会话续接与手动探测需在已授权独立环境验证；本轮只有夹具与参数级检查，**不以静态参数测试替代原生行为结论**。

## 2. 本轮发现并修复的验证问题

| 问题 | 性质 | 处理 |
| --- | --- | --- |
| `engine.ts` `let outcome` 闭包内 narrowing 丢失，`repairInstructions` 类型不匹配 | 修复引入（类型） | 提取 `const repairInstructions` |
| 迁移代码丢失「planner_takeover run 已完成 → 已接管」识别 | 修复引入回归 | 补 `takeoverCompleted` 判定，规划修复完成转执行测试不重复派规划接管 |
| 迁移代码只认带 `assignment_id` 绑定的完成，旧任务无绑定元数据时无法识别「整改完成待复核」 | 修复引入回归 | 补 `legacyRepairCompleted`：无绑定元数据时按调度位置还原（`REVIEW_QUEUED`/`REVIEWING` 算完成，`QUEUED` 保留唯一一次机会） |
| 集成候选提交冻结在 `repositoryInfo` 之后，仓库不可用时未冻结，重试会漂移到新 HEAD | 修复引入（违反 R07「固定本轮候选提交」） | 把 reported 提交冻结提前到任何 Git 读取之前 |
| 测试 mock 缺 `jobs`/`enqueue`/`jobStatus` | 测试基建 | 补 mock（不降级产品代码） |
| E2E 共享定位器与 UI 不匹配（按钮 accessible name、tab 式工具选择、radio 文案、模型选项容器） | 预存（UI 重构后 helper/spec 未同步） | 修正定位器，使相关浏览器回归可执行 |

## 3. 验证结果

### 3.1 类型检查与构建

- `tsc --noEmit`：**产品代码零错误**。
- `npm run build`：**成功**（tsc -p tsconfig.build.json + vite build）。
- 预存边界：`tests/integration/model-switch.test.ts` 3 个类型错误（`expected_run_id` 不匹配 `SwitchRequest`）。stash 后仍存在，属无关既有变更，未扩展修复。

### 3.2 单元与 Engine 集成（70/70 通过）

| 文件 | 结果 | 覆盖 |
| --- | --- | --- |
| `tests/integration/quality-policy-v2.test.ts` | 通过 | A01–A12 主链路 |
| `tests/integration/quality-policy-migration.test.ts` | 11/11 通过 | D01–D05 迁移（含新增 D01/D02 断言） |
| `tests/integration/planner-commit.test.ts` | 5/5 通过 | G01–G06 提交路由契约 |
| `tests/integration/planner-commit-git.test.ts` | 7/7 通过 | C01–C05、C07、C08 真实 Git |
| `tests/integration/repair-model-assignment.test.ts` | 通过 | Q07 策略 2 角色锁定 |
| `tests/unit/cli-invocation.test.ts` | 通过 | Q09 MiMo `--agent` 参数 |
| `tests/unit/mimo-model-configuration.test.ts` | 通过 | Q09/Q10 MiMo 配置与探测 |

新增断言（补能暴露行为错误的断言，不改写既有期望）：
- **D01** 初次开发完成、首次整改待开始（`QUEUED`）→ 不消耗唯一一次整改机会。
- **D01** 绑定完成 Run 的整改消耗机会，无关 `implement` 完成不消耗。
- **D02** 规划修复完成待续接 → `planner_repairs_only` 且派 `executor_test`，不重复派规划接管。
- **C04** 源仓库不可用 → 不产生 success/COMMITTED 假结果，候选提交仍冻结供重试。
- **C05** 结果重放 → 集成幂等，不重复 commit，候选提交不漂移。

### 3.3 真实临时 Git 行为（planner-commit-git.test.ts）

| 用例 | 场景 | 结果 |
| --- | --- | --- |
| C01 | existing_workspace 已有规划提交 | 通过：平台不生成第二次候选提交；保留无关 index/工作区内容；回执 source_root/target_branch 正确 |
| C02 | new_worktree 已提交，源分支可快进 | 通过：源分支包含完整任务历史；回执指向登记源工作区/分支；工作树保留 |
| C03 | 多仓库其中一个集成失败 | 通过：成功记录保留，COMMIT_PARTIAL，仅恢复失败仓库 |
| C04 | Git 命令失败/仓库不可用 | 通过：不产生 success 回执或 COMMITTED 假结果 |
| C05 | 已提交但断连/结果重放 | 通过：原提交与集成幂等，不重复 commit |
| C06 | 集成成功但清理失败 | 未验证：按 R07「任务完成后保留工作树；清理需要显式选择」，当前实现不自动清理 |
| C07 | 合并冲突需要代码修复与测试 | 通过：不 cherry-pick 最后一个提交；生成规划修复说明并停留 COMMIT_PARTIAL；不丢任务前面的提交 |
| C08 | 无须新提交、已有外部改动或工作树 | 通过：不伪造空提交；保留外部未提交改动 |

### 3.4 浏览器回归（6/6 通过，1 跳过）

| 用例 | 结果 |
| --- | --- |
| `quality-policy-v2.spec.ts` QP2-01 设置页可选 MiMo Code 并出现模型搜索 | 通过 |
| `quality-policy-v2.spec.ts` QP2-02 新策略用途文案 | 通过 |
| `quality-policy-v2.spec.ts` QP2-03 RepairModelPicker 策略 2 锁定职责组 | 跳过（夹具无修复批次） |
| `quality-policy-v2.spec.ts` QP2-04 MiMo 能力与新用途角色可见 | 通过 |
| `quality-policy-v2-feedback.spec.ts` API 直提功能问题派发 functional_fix | 通过 |
| `lightweight-feedback.spec.ts` 人工功能问题派发执行，不续接已完成质量审查 | 通过 |

断言随修复后的正确行为更新：`stage` 现反映真实用途（`functional_fix`），不再断言旧的 `execute`。

预存边界：`tests/e2e/native-delivery-display.spec.ts` SA-E24 仍失败。根因是 fixture 目录 scope 隔离（`PROBE_CLI` 与真实 CLI 路径不同导致 UI 侧目录为空）+ UI 重构后 helper 未同步，属 fixture 架构问题，非本次修复引入。已修正 helper 的 label/radio/模型选择器定位（可复用），未扩展 fixture 目录注入架构。

### 3.5 MiMo 原生路径

| 用例 | 结果 |
| --- | --- |
| D06 各用途首次/续接参数 | 夹具与参数检查通过（`--agent` 显式选择、provider/model、续接只用目标 session）；**真实账号调用未验证** |
| D07 只读 agent 原生权限 | 参数级验证只读 agent 被选中；**原生写工具被权限拒绝未在真实 CLI 验证** |
| D08 Pro/Flash 手动探测 | `buildMimoProbe` 入口可执行；**真实授权探测未运行** |

## 4. 计划第 10 节完成标准核对

| 标准 | 状态 |
| --- | --- |
| Q01–Q10 均有对应代码修复及本次相关行为验证 | 是（Q01–Q10 均有代码修复与行为验证；MiMo 真实调用除外） |
| 两条测试直达路径通过实际 Engine 调度验证 | 是（quality-policy-v2 集成 + planner-commit-git 真实 Git） |
| 规划修复不跑测试、规划提交实际提交 | 是（role-boundaries 指导 + C01/C02 真实 Git 集成） |
| 原生 MiMo Pro/Flash 均报告真实验证范围 | 是（已明确标注未验证范围） |
| 恢复/重复回调/迁移不丢用途 | 是（recovery + migration 测试） |
| Git 集成回执与实际操作一致，部分失败可恢复 | 是（C03/C04/C05/C07/C08） |
| 未增加运行时质量校验 | 是（未新增代码/测试/报告/模型声明校验） |

## 5. 交付状态

- 已完成：类型检查、构建、单元与集成回归（70/70）、真实临时 Git 验证（7/7）、浏览器回归（6/6）、验证中发现的 4 处相关问题修复。
- 未执行：真实 MiMo 调用、活跃任务迁移、部署、提交或推送。
- 预存边界（未扩展修复）：`model-switch.test.ts` 3 个类型错误；`model-routing.test.ts` 1 个失败；`lightweight-recovery-fixes.test.ts` 3 个失败；`native-delivery-display.spec.ts` SA-E24（fixture 目录 scope 架构）；`model-settings.spec.ts` label 与当前 UI 不匹配。
- 工作区其他 Agent 未提交修改均保留，未回滚或暂存。
