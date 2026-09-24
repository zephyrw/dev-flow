# 执行进度（非计划）——DevFlow 一行安装与 README 产品化改造

> 本文件是执行进度事实清单、协调记录与测试证据索引，不是计划文档。
> 唯一执行依据：`docs/plan/DevFlow_一行安装与README产品化改造计划_最终版.md`（下称“原计划”）。
> 基线：`1150e7ab88ac9a486406a1eca5bd81abce0928e2`。工作分支：`worktree-devflow-one-line-install`。
> 测试证据目录：`docs/test/evidence/devflow-one-line-install-20260923/<轮次>/`。

## DFP-00 基线和差异核对（已完成）

| 项 | 读取结果 | 时间 |
|---|---|---|
| worktree HEAD | `1150e7ab88ac9a486406a1eca5bd81abce0928e2`，与原计划固定基线一致，无差异需回归 | 2026-09-23 |
| 本地工具链 | Node v22.23.2 / pnpm 11.7.0，与 `package.json` engines 锁定值一致 | 2026-09-23 |
| 本地 typecheck / build | `pnpm typecheck` 通过；`pnpm build` 通过 | 2026-09-23 |
| CI run `35825395387`（基线提交） | 三平台（windows/ubuntu/macos）均 completed/failure，失败步骤均为 **Unit and integration tests**；Windows 结果已出（原计划 2.3 记录时仍在跑，现确认失败）。日志 API 需仓库管理员权限（403），改为本地复现定位 | 2026-09-23 |
| GitHub Releases 列表 | `[]` 空，与原计划 [S20] 一致；公开安装入口仍为交付缺口（DFP-10） | 2026-09-23 |

## 原编号/章节 → 实现位置 → 测试情况 → 状态

| 原编号 | 章节 | 实现位置（落地后回填） | 测试情况 | 状态 |
|---|---|---|---|---|
| DFP-00 | §12.1 | 本文件 DFP-00 节 | 无需代码测试 | 完成 |
| DFP-01 | §9、§11 README/文档行 | 见本文件「执行进度（非计划）· DFP-01」 | 文档验收 D-01～D-04 自查（见该节） | 完成 |
| DFP-02 | §2.3、§12.1 | （待回填） | 本地复现 vitest 失败并回归 | 进行中 |
| DFP-03 | §5 | （待回填） | 打包/构建身份/manifest 测试（待测） | 进行中 |
| DFP-04 | §4.2～4.4 | （待回填） | bootstrap 参数/退出状态测试（待测） | 进行中 |
| DFP-05 | §4.5、§6.3～6.6 | （待回填） | CLI/入口/服务识别测试（待测） | 进行中 |
| DFP-06 | §8 | （待回填） | 首次设置向导测试（待测） | 进行中 |
| DFP-07 | §7 | （待回填） | 升级/恢复 U-01～U-12（待测） | 进行中 |
| DFP-08 | §10 | `compatibility.json`、`tests/unit/compatibility-schema.test.ts` | `pnpm exec vitest run tests/unit/compatibility-schema.test.ts` 5/5 通过 | 代码完成（docs 一致性转流 A） |
| DFP-09 | §13 | （待回填） | 成品回归与真实任务验收 | 未开始（依赖 DFP-02～08 整合） |
| DFP-10 | §5.7、§14 | （待回填） | 匿名安装验收 | 未开始（依赖真实公开发布；本环境无发布权限时如实标注） |

## 复用项（原计划已明确不重复开发，只做回归）

动态版本读取（installer）、安装后 native 自检、`koffi`/SQLite 打包前加载检查、配置 schema 2 迁移（config-migration）、控制器锁与 `assertQuiescent()`、数据库备份、`runtime_backend`/`runtime_root` 服务身份校验、先 build 再 runtime tests 的 CI 顺序。落地时不得写成“新增完成”。

## 并行分工与文件唯一负责人（协调约定，非新计划）

| 流 | 原任务 | 唯一可修改范围 |
|---|---|---|
| A | DFP-01 | `README.md`、`docs/guide/**`、`docs/development/**`、`CONTRIBUTING.md` |
| B | DFP-08 | `compatibility.json` 及其全部消费者、相关测试 |
| C | DFP-03 | `scripts/release/**`、`package.json`（仅 scripts 发布校验）、`scripts/release/runtime-files.json`（新增唯一运行与合规清单） |
| D | DFP-04 | `scripts/bootstrap/install.sh`、`scripts/bootstrap/install.ps1` |
| E | DFP-05 | `packages/cli/src/**`、`packages/installer/src/main.ts`、`packages/installer/src/components.ts`、`packages/installer/src/state.ts`、`packages/installer/src/launchers.ts`（新增）、`packages/service/src/**` |
| F | DFP-07 | `packages/installer/src/upgrade.ts`、`packages/installer/src/transaction.ts`（新增）、`apps/api/src/base-server.ts`、`apps/api/src/routes/**`（维护路由）、`scripts/install-windows.ps1` |
| G | DFP-06 | `apps/web/src/components/FirstRunSetup.tsx`（新增）及其样式/接线、`apps/web/src/**`（向导相关）、`apps/api/src/model-routes.ts`（仅向导所需补接口） |
| H | DFP-02 | 基线既有失败测试及其源码修复（复现后确定范围，避免与上表重叠时由主 Agent 裁决） |
| I | DFP-09 | `tests/**` 横切场景扩充（开发完成后整合） |

## 共享接口约定（协调用）

1. **`build-info.json`**（C 产出；E/F 消费；装入成品包根）：`application_version`、`build_revision`、`build_tag`、`built_at`、`platform`、`node_version`、`runtime_backend: "node-v1"`、`native_dependencies`（如 `{koffi, better-sqlite3}` 实际版本）、`config_schema_range`（当前 2）、`service_protocol_version`、`runner_protocol_version`、`credential_worker_protocol: "3.0.0-node"`。
2. **`scripts/release/runtime-files.json`**（C 产出唯一运行与合规文件清单；E 安装复制消费包根副本；C 构建校验、测试共用）。条目形状：`{ "path": "<相对包根>", "category": "app|runtime|native|compliance|skills", "required": true | { "platforms": [...] } }`（C 可微调但须在报告写明最终 schema）。
3. **`current.json`**（E 产出/写入；D 的 `entry.mjs` 与既有 `writeAccountsLauncher()` 读取）：**保留现有键** `config`（配置文件路径）、`root`（当前版本目录）、`node`（版本内置 Node 路径）——`packages/installer/src/upgrade.ts` 的账号入口脚本按这三个键消费，不得改名；可增补 `schema`、`application_version`、`build_revision`、`updated_at`。引导层仅解析受信任安装位置下的路径。
4. **`transactions/<txid>.json`**（F 产出）：`id`、`kind`、`source_version/digest`、`target_version/digest`、`config_digest_before`、`pointer_digest_before`、`backup_paths`、`phase`、`new_state_write_possible`、`managed_client_changes`、时间戳。禁止密钥/令牌。
5. **健康接口与维护路由**（F 写入 `apps/api/src/base-server.ts`；E 的 launcher 消费）：`/api/health` 现有 `ok`/`version`/`runtime_backend`/`runtime_root`/`mode`/`features`/`service`/`instance` 之外，新增 `application_version`、`build_revision`、`service_protocol_version`（`version` 停用硬编码，改读 build-info/package.json）。维护路由 `/api/maintenance/prepare`、`/api/maintenance/status`、`/api/maintenance/quiesce`，沿用既有来源与权限保护（human origin 等），不绕过认证。
6. **`UpgradeManager`（F，`packages/installer/src/upgrade.ts`）新增导出**（既有 `assertQuiescent`/`backupData`/`atomicSwitchCurrent`/`migrateAccountConfiguration`/`writeAccountsLauncher` 签名保持兼容；E 的 `main.ts` 按下述名字调用更新路径）：
   - `prepareCandidate(meta: {sourceDir: string; targetVersion: string}): Promise<{targetDir: string; digest: string}>`（预下载/校验候选包，不改当前状态）
   - `requestMaintenance(): Promise<void>`（经 API/锁请求进入维护准备）
   - `waitForQuiescent(options: {onActiveTasks: "wait" | "pause-and-update"}): Promise<void>`（禁新派发→等进程与资源对账）
   - `runUpgradeStateMachine(options): Promise<UpgradeResult>`（§7.3 状态机编排：Prepared→…→Verified / SafeAbort / RecoveryRequired）
   - `transaction.ts` 新增 `beginUpgradeTransaction` / `recordTransactionPhase` / `commitUpgradeTransaction` / `failUpgradeTransaction`（§7.4 边界表）
   锁顺序红线（§7.2）：更新器不得先抢服务持有的控制器锁再要求服务停止；安装事务所有权（防两个安装器）与运行控制器所有权（服务退出后交接）分开。
7. **`state.json` 结果视图**（E 产出；G 展示）：`result: { software: {status, detail?}, setup: {status, detail?}, capability: {status, scope, detail?} }`（§6.1 三维；`status` 例：software=`installed|failed|downloading`，setup=`not_started|pending_login|pending_verification|done`，capability=`discovered|verified|workflow_verified|unknown`）。不新建第二份模型默认配置。
8. **CLI 契约**（E）：原计划 §6.5 表；退出码细分保留（`INSTALL_EXIT_CODES`：0/10/20/30/40/50，含 `NEEDS_USER_ACTION=10` 兼容——内部旧调用依赖 10 的行为不得全局替换掉）。
9. **安装脚本参数**（D）：原计划 §4.4 表；`--require-ready` 之外模型未配置不作为失败；ps1 不得顶层 `exit` 终止宿主窗口；默认不指定客户端合法（E 的 installer 侧 `tools` 空数组必须放行，不再默认 `["codex"]`）。
10. **`compatibility.json`**（B）：字段含义与消费者同流迁移；未知保持未知。
11. **版本注入占位符**（D 脚本 × C 打包）：脚本头部保留 `DEVFLOW_RELEASE_TAG="@TAG@"` 形式占位符，C 打包时注入实际标签；正式资产不得残留未替换占位符。

## 补齐说明（必要补齐，关联原任务）

- DFP-03 落地 `runtime-files.json` 为 §5.3“唯一的运行与合规文件清单”的具体形态，供构建校验、安装复制、测试三方共用（原任务 DFP-03/DFP-05 共同要求，单点定义避免清单分叉）。
- 各流按原计划第 13 节为自己范围补测试代码；跨切场景归 DFP-09。

## DFP-08 兼容性元信息与证据体系（执行进度，非计划）

| 项 | 事实 |
|---|---|
| 消费者检索 | 代码侧（`packages/`、`apps/`、`scripts/`、`tests/**/*.ts`）无对 `compatibility.json` 字段的读取方；`tests/unit/agy-account-service-mode.test.ts`、`tests/unit/review-output.test.ts` 不消费 compatibility 字段（分别为 service-mode 与 review schema），无需改断言。`tests/live/devflow-v2-matrix.ts` 自产探测报告中的同名概念字段，非本文件读取方，未改。docs/README 引用转流 A。 |
| schema 修订 | 分层：`layers.application_build`（权威 `build-info.json`）、`layers.runtime_backend: node-v1`、`layers.runner_protocol: 1.0.0`（来源 runner-entry ready 握手）、`layers.credential_worker_protocol: 3.0.0-node`（来源 credential-worker capabilities）；平台四类 `install_verification`（§10.2）；工具保持 `adapter_implemented` / `live_workflow_verified: false` + 空 `evidence`。 |
| 旧字段迁移 | 移除 `auth_host_protocol`、`required_process_capabilities`、`official_cli_dual_window_verified`、`cross_account_resume_verified`、`disabled_until_runtime_capabilities_verified`；账号侧改为 `process_capability_model`（Node 真实能力）+ `verifications[]`（类型/状态/证据），全部 `unverified`，不因迁移抬级。 |
| 测试 | 新增 `tests/unit/compatibility-schema.test.ts`（zod schema、必填/枚举、live 需 evidence、旧字段名反向断言、不抬级断言）；`pnpm exec vitest run tests/unit/compatibility-schema.test.ts` → 5 passed。 |
| 未改范围 | `docs/**`、`README.md`、`packages/**`、`apps/**`、`scripts/**` 均未改。 |

## 测试证据索引

（测试阶段回填：`docs/test/evidence/devflow-one-line-install-20260923/<轮次>/`）

---

## 执行进度（非计划）· DFP-01 流 A 文档（2026-09-23）

> 本节仅记录 DFP-01 事实，不改写上文共享接口约定。执行依据：原计划 §9、§11 README/文档行、§9.8、§12.1 DFP-01、§13.6 D-01～D-04。

### 修改/新增文件

| 文件 | 说明 |
|---|---|
| `README.md` | 产品化重写：六问结构、§9.3 表达转换、§9.4 文案、§9.5 mermaid、§9.6 预览态安装（一行命令仅作“发布后”预告）、§9.7 FAQ；删除 Go Host/Go 环境与前后架构矛盾；无虚构截图 |
| `docs/guide/执行约定.md` | **新增**：迁移并原样保留「指定计划权威规则」（含 `devflow-plan-authority:v1` 标记） |
| `docs/guide/使用指南.md` | 移除开头执行约定，人类指南从第一条任务起；补兼容性/安装交叉引用；保留原有人类章节与锚点 |
| `docs/guide/使用与恢复指南.md` | 与成品视角一致；去掉默认回源码构建、.NET/Go Host 表述；`install-windows.ps1` 标开发者源码安装 |
| `docs/guide/安装与恢复.md` | 对齐 Node 运行时与新安装体系；安装入口指向「安装与升级」；历史架构标历史 |
| `docs/guide/安装与升级.md` | **新增**：一行安装目标态（未发布）、固定版本/本地包、§4.4 参数表、支持条件、更新/恢复/卸载（§4、§7 用户视角） |
| `docs/guide/客户端兼容性.md` | **新增**：§10.2 四种验证、平台/工具现状（以 `compatibility.json` 为准，未改该文件） |
| `docs/guide/pnpm开发与构建指南.md` | 归并为指向「开发指南」的短页，避免两套开发者文档 |
| `docs/development/开发指南.md` | **新增**：Node≥22.23.2 / pnpm 11.7.0、先构建后测试、koffi/better-sqlite3；无 Go 构建；开发者源码安装边界 |
| `CONTRIBUTING.md` | **新增**：开发指南与贡献流程入口 |

### 原任务 → 实现位置 → 验证 → 状态

| 原任务 | 实现位置 | 验证方式 | 状态 |
|---|---|---|---|
| §9.1～9.7 README 产品化 | `README.md` | 人工通读前六屏结构；grep 确认无 Go 要求、无假图、无占位版本；一行命令标明未上线 | 完成 |
| §9.6 发布前状态 | `README.md`「开始使用」、`docs/guide/安装与升级.md` | 均写明「开发预览，正式安装包尚未发布」；§4.2 命令仅作预告 | 完成 |
| §9.4 已验证入口占位符 | `README.md`「试试第一个任务」 | 写明 Codex 为当前已验证入口，并链兼容性说明其余未认证 | 完成 |
| §9.8 执行约定迁移 | `docs/guide/执行约定.md`；两份使用指南开头删除并回链 | 标记与正文原样保留；grep 确认规则仅存于执行约定（Skill 内嵌副本不在本流范围） | 完成 |
| §9.8 Go/安装脚本清理 | README、开发指南、安装与恢复、使用与恢复 | 用户主路径无 Go 环境要求；`install-windows.ps1` 均标「开发者源码安装」 | 完成 |
| §11 文档分层 | 上表各文件 | 相对链接均指向真实文件（已脚本核对无 MISSING）；`docs/assets/` 无真实脱敏素材故 README 不引用任何图片 | 完成 |
| D-01 | README | 前几屏可读出用途/好处/安装状态/第一条任务 | 自查通过 |
| D-02 | README + 使用/安装指南 | 普通路径不要求 Go、源码构建、pnpm、GIT_INDEX_FILE、手改 YAML（内部机制仅在恢复文档说明） | 自查通过 |
| D-03 | `docs/development/开发指南.md` | Node/pnpm 与 engines 一致；先构建后测试；无 Host 命令推荐 | 自查通过 |
| D-04 | 全部交付文档 | 无占位版本/假图；兼容性描述对齐 `compatibility.json` 现状；未宣称 Releases 可下载 | 自查通过 |

### 需主 Agent 裁决的范围外补齐

1. `packages/skills/**` 内嵌「指定计划权威规则」未改（非本流范围）。建议后续由 Skill 负责人流在保留条款前提下，增加对 `docs/guide/执行约定.md` 的引用，避免多处分叉维护。
2. `docs/design/DevFlow入口与运行方式修正.md` 仍写 `scripts/install-windows.ps1` 为「当前用户安装/更新入口」（历史设计文档）。本流未改 `docs/design/**`；若需全局一致，建议主 Agent 裁决是否加「历史」标注。
3. ~~`compatibility.json` 仍含 `auth_host_protocol` 与旧能力名~~ **已撤销**：流 B（DFP-08）已完成 schema 迁移；流 A 已将 `docs/guide/客户端兼容性.md` §4/§5 对齐 `matrix_version: 3.0.0`（`verifications[]`、`process_capability_model`、`credential_worker_protocol: 3.0.0-node`、`feature_boundary`），未抬高验证等级。
4. README「真实工作台截图」槽位按 §9.7 因无脱敏素材而省略；待有真实素材后再由文档流或主 Agent 决定是否放入（`docs/assets/` 不在本流唯一范围）。

### 未解决问题

- D-01～D-04 为文档阅读路径与静态自查，不是匿名安装或真实工作流验收；安装可用性仍待 DFP-04/05/10。
- `devflow` 统一 CLI、开始菜单等入口文档按目标态书写并标注「发布后提供」；实现落地前不得把本文当作已上线证明。
