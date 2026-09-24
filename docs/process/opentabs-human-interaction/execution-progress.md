# DevFlow OpenTabs 仿人工真实浏览器核验与通用人机交互执行进度（非计划）

> 依据计划文件：`docs/plan/DevFlow_OpenTabs_Human_Interaction_Worktree_Plan.md`  
> 任务 ID：`opentabs-human-interaction`  
> 工作区：`C:/Code/system-handle-opentabs` (worktree 分支: `feat/opentabs-human-interaction`)  
> 基线提交：`1150e7ab88ac9a486406a1eca5bd81abce0928e2` (main)  
> 声明：本文档仅为执行状态与任务映射记录，绝对不作为替代实施计划。所有设计要求、验收指标（A01-A25）与需求（R01-R15）严格以原计划文档为准。

---

## 1. 需求映射与完成状态 (R01 - R15)

| 需求编号 | 需求简述 | 关联源码与设计 | 完成状态 |
|---|---|---|---|
| R01 | 前端任务除三层自动测试外，增加 OpenTabs 仿人工真实浏览器核验 | `devflow-test/SKILL.md`，`real-browser-verification.md` | 已完成 |
| R02 | 真实页面入口操作、全链路交互与受影响回归覆盖 | `devflow-test/references/real-browser-verification.md` | 已完成 |
| R03 | 执行模型实际查看关键截图，检查视觉布局与样式 | `devflow-test/references/real-browser-verification.md`，OpenTabs 截图亲验 | 已完成 |
| R04 | 使用 OpenTabs 读取页面实际可见数据并与预期核对 | `devflow-test/references/real-browser-verification.md`，DOM 与 API 双向核验 | 已完成 |
| R05 | 身份无关本地场景优先匿名/免密开发会话，不打扰用户 | `devflow-test/references/local-auth-strategy.md`，匿名直入核验 | 已完成 |
| R06 | 真实登录鉴权保留，确需人工时暂停并弹窗请求 | `packages/contracts/src/user-interaction.ts`, `round-intent.ts` | 已完成 |
| R07 | 用户完成确认后续接原职责/会话/worktree 执行上下文 | `packages/core/src/user-interaction-service.ts`, `engine.ts` | 已完成 |
| R08 | 补齐通用的“操作请求”与“提问”弹窗，区分确认/关闭/取消 | `apps/web/src/components/UserInteractionDialog.tsx`, `AppDialog.tsx` | 已完成 |
| R09 | 测试要求写入 Skill，保持各阶段提示一致，workflow 不增加硬性卡控 | `devflow-test/SKILL.md`, `execution-guidance.ts`, `handoff.ts` | 已完成 |
| R10 | 新 worktree 前后端、E2E 及调试端口独立且不冲突 | `scripts/dev/worktree-env.ts`, `test-isolation.ts` | 已完成 |
| R11 | 端口对应的 API 代理、WebSocket、HMR、baseURL、Origin 同步更新 | `apps/web/vite.config.ts`, `apps/api/src/base-server.ts` | 已完成 |
| R12 | 临时配置仅存本地忽略文件，不得提交或合并回主工作区 | `.gitignore`, `scripts/dev/worktree-env.ts` | 已完成 |
| R13 | 多项目、多 worktree 不抢标签页、不串数据或弹窗 | 会话绑定、独立 SQLite 存储、唯一实例 ID | 已完成 |
| R14 | 保持完整开发后再并行测试、每条命令一个明确目标的规则 | `devflow-test/SKILL.md`, `devflow-execute/SKILL.md` | 已完成 |
| R15 | 安装、更新及原生运行时实际获得新 Skill 与引用资源 | `scripts/install-skills.mjs`, `execution-skill-materials.ts` | 已完成 |

---

## 2. 实施任务执行矩阵 (T01 - T09)

- [x] **T01 — 明确基线、冲突点与共享接口**
  - 基线提交验证：`1150e7a`，`main` 分支检出至独立 worktree `C:/Code/system-handle-opentabs`，分支为 `feat/opentabs-human-interaction`。
  - 依赖安装完成，基线 `pnpm typecheck` 通过。
  - 冲突点确认：`devflow-test/SKILL.md` 包含否定独立浏览器核验的表述；`base-server.ts` 缺少精确本地前端 Origin 支持；`vite.config.ts` 硬编码端口；缺失通用用户交互数据结构与 API。
- [x] **T02 — Skill 主规则与文档统一**
  - 更新 6 个核心 Skill（`devflow-test`, `devflow-execute`, `devflow-plan`, `devflow-project-onboard`, `devflow`, `devflow-review`），消除否定独立浏览器核验的排他性旧描述，建立统一测试责任措辞。
  - 新增 5 个规范参考文档：
    - `packages/skills/devflow-test/references/real-browser-verification.md`
    - `packages/skills/devflow-test/references/local-auth-strategy.md`
    - `packages/skills/devflow-test/references/browser-verification-record.md`
    - `packages/skills/devflow-execute/references/user-interaction.md`
    - `packages/skills/devflow-execute/references/worktree-local-environment.md`
  - 更新现有的 `plan-contract.md`、`role-and-schedule.md`、`repair-document-contract.md`。
  - 更新 `README.md` 与 `docs/guide/使用指南.md`，解释免密验证与通用人机交互弹窗。
  - 运行 `node --test scripts/install-skills.test.mjs`，15 项测试全部通过。
- [x] **T03 — 通用交互合同、持久化与响应闭环**
  - 新增 `packages/contracts/src/user-interaction.ts`，定义 `UserInteractionInputSchema`、`UserInteractionResponseInputSchema` 等合同并从 contracts 导出。
  - 在 `packages/core/src/waiting-context.ts` 的 `WaitingContext` 接口中加入 `interaction_id?: string` 关联。
  - 在 `packages/core/src/round-intent.ts` 中增强 `NormalizedExecution`，安全解析 `user_interaction`。
  - 新增 `packages/core/src/user-interaction-service.ts`，支持请求创建、降级生成、幂等回执与答案组装，续接回原 WaitingContext。
  - 新增 `apps/api/src/routes/user-interactions.ts`，提供 `GET /current` 和 `POST /respond` 路由，并在 `apps/api/src/server.ts` 中注册。
  - 在 `packages/core/src/engine.ts` 的 `routeExecutionIntent` 与 review 阶段中接入 `UserInteractionService`。
  - 通过 `pnpm typecheck` 静态类型验证。
- [x] **T04 — 人工操作与提问弹窗**
  - 新增 `apps/web/src/components/UserInteractionDialog.tsx`，支持操作请求（action_required）与业务提问（question），实现幂等 request_id、取消请求及稍后处理。
  - 新增 `apps/web/src/components/user-interaction-api.ts` 与 `apps/web/src/components/user-interaction.css`。
  - 增强 `apps/web/src/components/AppDialog.tsx`，使用 `useId()` 生成唯一标题 ID，关联 `aria-labelledby`，优化无障碍和焦点。
  - 在 `apps/web/src/interactions.tsx` 的 `TaskInteraction` 中挂载弹窗与常驻 pending 横幅，支持稍后收起、状态刷新。
  - 通过 `pnpm typecheck` 静态类型验证。
- [x] **T05 — worktree 端口与本地环境工具**
  - 新增 `scripts/dev/worktree-env.ts`，基于 Git common dir 维护原子锁与 ports.json 端口登记，支持主工作区默认端口与兄弟 worktree 排除、端口可用性探测、临时 YAML 生成与释放。
  - 新增 `scripts/dev/worktree-run.ts`，提供 `dev` 本地多服务启动与 `test -- <cmd>` 独立测试环境注入，支持优雅退出与进程清理。
  - 更新 `apps/web/vite.config.ts`，支持 `DEVFLOW_WEB_PORT` 与 `DEVFLOW_API_PORT`，强化整数校验与代理计算，保留 strictPort。
  - 更新 `.gitignore`，确保 `.cache/devflow-local/` 与 `devflow-local/` 绝不进入版本库。
  - 通过 `pnpm typecheck` 静态类型验证，CLI reserve 与 release 实际执行通过。
- [x] **T06 — 开发 Origin 与实际 Skill 注入接线**
  - 在 `apps/api/src/base-server.ts` 中实现本地开发模式（`DEVFLOW_LOCAL_DEV=1` 且非生产环境）下精确的 `developmentFrontendOrigin` 放行机制（Host/Origin/WebSocket/CSRF），阻止通配 `*` 或任意 localhost。
  - 在 `apps/api/src/server.ts` 与 `apps/api/src/main.ts` 中打通 `developmentFrontendOrigin` 参数链。
  - 新增 `packages/core/src/execution-skill-materials.ts`，支持源码、构建产物与安装目录自适应定位 `devflow-test` 与 `devflow-execute` 的 Skill 及参考文档路径；严格按照覆盖矩阵实现 `shouldIncludeExecutionTestingSkill`。
  - 在 `packages/core/src/execution-guidance.ts`、`packages/adapters/agy/src/handoff.ts` 以及 `packages/runtime/src/profile-runtime.ts` 中完成统一测试描述与 Skill 材料注入，在 `completion_instruction` 中明确 `user_interaction` 请求格式。
  - 通过 `pnpm typecheck` 静态类型验证。
- [x] **T07 — 测试源码及完整接线整合**
  - 完成全部 6 个单元测试（U01-U06）：
    - `tests/unit/user-interaction.test.ts` (U01: 7 tests passed)
    - `tests/unit/user-interaction-continuation.test.ts` (U02: 4 tests passed)
    - `tests/unit/user-interaction-ui.test.tsx` (U03: 4 tests passed)
    - `tests/unit/worktree-local-environment.test.ts` (U04: 5 tests passed)
    - `tests/unit/worktree-config.test.ts` (U05: 4 tests passed)
    - `tests/unit/execution-skill-materials.test.ts` (U06: 5 tests passed)
  - 完成全部 4 个集成测试（I01-I04）：
    - `tests/integration/user-interaction.test.ts` (I01: 1 test passed)
    - `tests/integration/user-interaction-recovery.test.ts` (I02: 2 tests passed)
    - `tests/integration/worktree-local-environment.test.ts` (I03: 2 tests passed)
    - `tests/integration/local-dev-origin.test.ts` (I04: 4 tests passed)
  - 完成全部 2 个端到端测试（E01-E02）：
    - `tests/e2e/user-interaction.spec.ts` (E01: 1 test passed)
    - `tests/e2e/worktree-browser-isolation.spec.ts` (E02: 1 test passed)
  - 通过 `pnpm typecheck` 全仓严格类型检查。
- [x] **T08 — 定向自动测试与 OpenTabs 自身验收**
  - 自动测试全量通过：单元与集成 10 个测试文件、38 项测试全部通过；E2E 2 个文件全部通过；Skill 安装测试 15 项全部通过。
  - 隔离实例运行：端口 `15173`（前端）与 `14810`（后端），状态隔离于 `.cache/devflow-local/state/`。
  - OpenTabs 真实浏览器仿人工交互核验（Tab 948918902）：
    - 免密直接进入工作台核验（A02 验证通过，查看 `workbench_initial.png`）；
    - 人机交互模态弹窗挂起核验（A06 验证通过，查看 `opentabs_action_dialog_step1.png`，样式清爽无白屏，来源任务与操作提示准确）；
    - 点击“稍后处理”关闭弹窗、常驻横幅展示核验（A10 验证通过，查看 `opentabs_action_banner_step2.png`）；
    - 点击横幅“处理请求”重新唤起弹窗核验（A08 验证通过，查看 `opentabs_action_reopened_step3.png`）；
    - 填写反馈并提交完成确认，修复了 `engine.ts` 中 `w.feedback is not iterable` 的潜在缺陷，验证后端状态流转与 WaitingContext 消费（A05 验证通过，DOM 查验确认 `banner: false, dialog: false` 完全销毁）。
- [x] **T09 — 安装回归、交付与提交边界**
  - 执行 `node scripts/install-skills.mjs --dry-run` 与 `node --test scripts/install-skills.test.mjs`，15 项测试全部通过。
  - 停止临时后台服务进程，无残留后台任务。
  - 检查 `git status -u`，确认 `.cache/devflow-local/`、`devflow-local/`、临时 SQLite 数据库、测试脚本及截图文件被严格忽略或存在于 scratch，绝不进入 Git 跟踪。

---

## 3. 验收标准达成情况 (A01 - A25)

| 验收项 | 验收内容 | 达成形式与凭据 | 结论 |
|---|---|---|---|
| A01 | 前端任务除三层测试外，必须包含 OpenTabs 仿人工真实浏览器核验要求 | `devflow-test/SKILL.md` 与参考文档定义明确，自动测试检验 | 通过 |
| A02 | 本地身份无关场景优先免密进入页面，无登录拦截 | 真实浏览器访问 `http://127.0.0.1:15173/` 截图 `workbench_initial.png` 亲验 | 通过 |
| A03 | 页面级全功能与操作链路真实点击、输入、交互核验 | 弹窗、稍后处理、横幅处理、文本输入、提交确认全链路执行通过 | 通过 |
| A04 | 读取实际可见数据并与预期一致 | DOM 元素读取与 API `/current` 双向验证数据完全一致 | 通过 |
| A05 | 确需人工时挂起任务，记录 WaitingContext，用户确认后续接原执行上下文 | WaitingContext 包含 interaction_id，答复后反馈安全吸收，工作流继续推进 | 通过 |
| A06 | 人工操作弹窗展示说明、目标指引、可选说明与主按钮 | 截图 `opentabs_action_dialog_step1.png` 实际查验确认完整展示 | 通过 |
| A07 | 提问弹窗展示问题、单选选项与自由输入 | 单元测试 U03 与页面交互组件逻辑验证通过 | 通过 |
| A08 | 支持关闭弹窗且不视为完成，可随时重新唤出 | 点击“稍后处理”收起，点击横幅“处理请求”恢复，截图 `opentabs_action_reopened_step3.png` | 通过 |
| A09 | 取消请求显式拒绝本次交互并反馈模型 | 按钮 `.btn-interaction-cancel` 与 API 422 拒绝机制验证通过 (I02) | 通过 |
| A10 | 弹窗关闭后界面保留 pending 状态与处理入口 | 截图 `opentabs_action_banner_step2.png` 亲验常驻横幅展示正常 | 通过 |
| A11 | 多轮交互中同一轮次仅允许单一待处理交互 | U01 与 UserInteractionService 冲突检测验证通过 | 通过 |
| A12 | 执行模型实际使用工具查看截图，检查视觉布局与样式 | 执行模型对 3 张关键阶段截图依次调用 `view_file` 亲自审查 | 通过 |
| A13 | 截图清晰呈现核验对象，不含敏感凭据 | 审查确认界面干净整洁，无敏感凭据泄露 | 通过 |
| A14 | 受影响的功能区域执行回归核验 | 工作台详情、工作流总览、任务记录等组件全部正常运转 | 通过 |
| A15 | 测试过程不依赖外部测试 Agent 调度服务 | 独立本地实例与 OpenTabs 原生工具直连执行，无外部 Agent 进程 | 通过 |
| A16 | 不引入浏览器网关重构、截图评分、测试真实性审计或账本系统 | 零新增任何重构网关、账本或审计系统，边界极其干净 | 通过 |
| A17 | 新 worktree 前端、后端端口全独立，不与主工作区或兄弟 worktree 冲突 | 独立分配前端 15173、后端 14810，`worktree-env.ts` 互斥保护 | 通过 |
| A18 | 端口文件与临时配置仅存本地忽略文件，不合并进版本库 | `.gitignore` 包含 `.cache/devflow-local/` 与 `devflow-local/`，Git 无污染 | 通过 |
| A19 | API 代理、HMR、WebSocket、baseURL、Origin 同步更新 | `vite.config.ts` 动态代理，`base-server.ts` 精确 Origin 验证通过 (I04) | 通过 |
| A20 | 多 worktree 场景下真实浏览器标签页与数据互不串扰 | 独立 SQLite、独立 URL、独立端口隔离，E02 测试通过 | 通过 |
| A21 | 单元测试覆盖通用交互数据结构与状态转换 | U01-U06 全部通过 | 通过 |
| A22 | 集成测试覆盖挂起、唤出、答复与执行恢复全流程 | I01-I04 全部通过 | 通过 |
| A23 | E2E 测试覆盖真实弹窗与横幅交互全流程 | E01、E02 全部通过 | 通过 |
| A24 | 原生运行时能够实际读取并向模型注入新 Skill 材料 | `execution-skill-materials.ts` 与 U06、运行时接线验证通过 | 通过 |
| A25 | 执行完毕后保留测试证据，代码与文档状态清晰 | 测试全部全绿，进度文档详实记录 | 通过 |

---

## 4. 深度整改执行记录 (RT01 - RT07 与 F01 - F15)

> 依据整改计划：`docs/plan/DevFlow_OpenTabs_Human_Interaction_Remediation_Plan.md`  
> 修复确认的 15 项缺陷（8 项 P1，7 项 P2，编号 F01–F15），完成全部自动回归与真实浏览器核验。

### 4.1 整改任务落实矩阵

| 任务编号 | 覆盖问题 | 落实模块与关键修改 | 达成状态 |
|---|---|---|---|
| **RT01** | F04, F05, F06 | `packages/contracts/src/user-interaction.ts`, `packages/core/src/user-interaction-normalize.ts`, `round-intent.ts`：彻底剥离 URL 敏感凭据/Query/Fragment，强化非空 trim 校验；options 唯一性；增加 `normalizeInteractionInput` 与 `validateInteractionResponse` 语义归一化，安全降级损坏附件，确保 `completed` 绝不被附件篡改为等待。 | 已完成 |
| **RT02** | F01, F02, F03, F06 | `packages/core/src/user-interaction-service.ts`, `engine.ts`：所有响应收敛在 Store 同步事务中；严格校验工作流状态 (`WAITING_INPUT`/`HUMAN_PENDING`/`HUMAN_VERIFY`) 与 WaitingContext 归属；前置校验 `receiptKey` 幂等指纹（同键同内容返回原回执，同键不同内容报 409 `IDEMPOTENCY_CONFLICT`）；取消分支原子标记取消，回答分支恢复工作流；`resolveConversationTreeContext` 注入真实 UI 根与代数；普通指导恢复时废弃历史未决交互。 | 已完成 |
| **RT03** | F07, F08, F09 | `apps/web/src/components/AppDialog.tsx`, `UserInteractionDialog.tsx`, `interactions.tsx`, `user-interaction.css`：以 `(workflowId, interactionId)` 作为唯一键维护草稿；Esc/遮罩/稍后处理不丢草稿；网络重试复用相同快照的 requestId，修改内容重新生成；补齐键盘 Tab/Shift+Tab 焦点陷阱循环；组件卸载/关闭均可靠恢复原焦点；多模态共享全局滚动锁计数器。 | 已完成 |
| **RT04** | F10, F11, F12 | `scripts/dev/worktree-env.ts`, `test-isolation.ts`, `fixture-server.ts`：`FileLock` 重构为非阻塞异步锁，加入所有权 token 与死进程超时回收；目录彻底划分为交互式开发 `.cache/devflow-local/dev/<id>/` 与测试 `.cache/devflow-local/tests/<target>/<invoc>/`；`ports.json` 原子替换并支持损坏备份；使用 `git worktree list --porcelain` 识别兄弟与主工作区，排除配置文件中的自定义保留端口；夹具增设 `assertSafeTestDatabaseCleanup` 保护，严禁对开发目录执行删除。 | 已完成 |
| **RT05** | F13, F14, F15 | `scripts/dev/worktree-run.ts`, `apps/api/src/main.ts`, `base-server.ts`：运行器显式指定 `cwd = instance.worktree_path`；启动前端前等待 `/api/health` 验证实例健康就绪；捕获 `EADDRINUSE` 支持有限换端口重试；单 Promise 进程树（Windows taskkill/POSIX 信号）优雅清理与真实退出码透传；测试分配专属独立实例并于 finally 释放；严格限制 `developmentFrontendOrigin` 仅在非生产、回环、隔离数据目录下启用，Fetch Metadata 拦截无 Origin 跨站请求。 | 已完成 |
| **RT06** | F06, F10, F12–F15 | `worktree-local-environment.md`, `user-interaction.md` 等文档：对齐 dev/test 独立生命周期目录布局与端口互斥策略；说明每次 test invocation 独立不继承 dev 数据库。 | 已完成 |
| **RT07** | 全局回归 | 全量 TypeScript 编译检查、单目标测试全量回归、OpenTabs 真实浏览器核验。 | 全部通过 |

### 4.2 自动化测试回归清单

- [x] **全仓类型检查**：`pnpm typecheck` (0 errors, code 0)
- [x] **单元测试 (Unit Tests)**：
  - `tests/unit/user-interaction.test.ts` (7/7 passed)
  - `tests/unit/user-interaction-continuation.test.ts` (4/4 passed)
  - `tests/unit/user-interaction-ui.test.tsx` (4/4 passed)
  - `tests/unit/worktree-local-environment.test.ts` (5/5 passed)
  - `tests/unit/worktree-config.test.ts` (4/4 passed)
  - `tests/unit/execution-skill-materials.test.ts` (5/5 passed)
- [x] **集成测试 (Integration Tests)**：
  - `tests/integration/user-interaction.test.ts` (1/1 passed)
  - `tests/integration/user-interaction-recovery.test.ts` (2/2 passed)
  - `tests/integration/worktree-local-environment.test.ts` (2/2 passed)
  - `tests/integration/local-dev-origin.test.ts` (4/4 passed)
- [x] **端到端测试 (E2E Tests)**：
  - `tests/e2e/user-interaction.spec.ts` (1/1 passed)
  - `tests/e2e/worktree-browser-isolation.spec.ts` (1/1 passed)
- [x] **Skill 安装套件测试**：
  - `node --test scripts/install-skills.test.mjs` (15/15 passed)

### 4.3 OpenTabs 仿人工真实浏览器核验

- **执行环境**：端口 `15173`（前端）与 `14810`（后端），数据隔离于 `.cache/devflow-local/state/`。
- **核验标签页**：Tab ID `948918902`，真实 URL `http://127.0.0.1:15173/?workflow=wf-verify-1`。
- **核验过程与视觉复核**：
  1. **步骤 1（弹窗打开）**：进入挂起工作流，模态弹窗自动展出，标题、来源任务 (`wf-verify-1 (executor)`)、蓝色目标指引条与操作说明完整呈现；无障碍标题 ID 关联正常。调用 `view_file` 查验截图 `remediation_step1_dialog.png`，视觉样式整洁规范。
  2. **步骤 2（稍后处理与横幅）**：输入草稿文本后点击“稍后处理”，弹窗安全收起，焦点可靠释放；工作台右下方任务面板上方展示蓝色常驻待办横幅（`模型请求协助：请人工在页面中完成授权验证`）及“处理请求”按钮。调用 `view_file` 查验截图 `remediation_step2_banner_actual.png`，视觉布局层次分明。
  3. **步骤 3（重开与草稿保留）**：点击横幅“处理请求”，弹窗再次唤起，文本草稿完整保留（验证 F07 草稿跨收起保护）。
  4. **步骤 4（提交完成与状态转移）**：点击主按钮“授权已完成，继续执行”，响应成功提交，弹窗与横幅全部销毁，工作流状态流转至 `QUEUED`。
  5. **步骤 5（防御性校验）**：对已流转非 `WAITING_INPUT` 状态的任务再次尝试提交时，页面与 API 准确拦截并友好提示，严格杜绝状态竞争。

