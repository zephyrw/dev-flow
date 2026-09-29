> 当前状态：规划质量修复 run-0f4ff1ce-680a-4e89-8a88-db7fd3e79744 已吸收固定目标 184c29a，完成 AGY 进程退出竞态修改及测试源码阅读，保持待提交 merge。未运行测试、构建、lint、typecheck 或测试证明脚本；completed 仅指本轮合并整改完成。




# DevFlow 代码复核整改实施与测试执行进度说明

> 任务工作流：`wf-39b43a87-9f21-4dcc-8abc-be7b2495956f`  
> 基线提交：`8f9d304fcff0f04ca9545cd5b1822f3f29f3b139`  
> 当前执行 Run：`run-e8eadb6a-52bf-4516-8c60-7518a4c3d1af`  
> 审计/整改参考审查 Run：`run-3b0c878d-7f0c-42ef-905b-72f09fa37ef4`  
> 日期：2026-09-28  

---

## 一、切号协调与指导落实情况

1. **凭据协调确认**：
   - 跨工作流凭据切号协调已完全闭环，保留自动选择模式选中的可用额度最多账号 `blakevaron5280665`（切换前周额度 99%、五小时 100%），真实模型验证成功，保留该账号不切回旧账号。
   - 不再并发修改共享 AGY 凭据，额度耗尽触发由隔离集成用例验证，不声称现场人为耗尽额度。
2. **工作区与原计划继承**：
   - 保留原批准计划 `docs/plan/wf-39b43a87-9f21-4dcc-8abc-be7b2495956f/DevFlow_代码复核与整改开发计划_2026-09-28.md` 及已有修改。
   - 不新建替代计划，按问题编号逐项闭环复核指出的 16 项代码与配置缺陷。

---

## 二、代码复核 16 项缺陷整改落实详情

### 模块一：测试基础设施（PR-02）
1. **F14_WINDOWS_HOOK（`tests/integration/hook.test.ts`）**：
   - 修复内容：服务端口改为独立随机分配端口（`14820 + Math.random() * 20000`）；共享协议行为改用跨平台受控入口（`spawn(process.execPath, [hookScript], ...)`），保证在 Windows/Linux/macOS 下均正常运行，杜绝非 Windows 环境直接调用 `cmd.exe` 报 ENOENT 的问题。
2. **F13_SHARED_FIXTURE_STORAGE（`tests/helpers.ts`）**：
   - 修复内容：在 `setup()` 中，当处于 `usesIsolatedTestRoot()` 时，保留任务级受保护根目录 `instance.runDirResolved`，但在其下为每个 fixture 创建唯一子目录（`mkdtempSync(join(instance.runDirResolved, "fix-"))`），派生独立的 sqliteFile、storageRoot、workspaceRoot，避免多个 fixture 并发争用同一个数据库文件。
3. **F13_CLEANUP_ERRORS（`tests/fixtures/isolation.ts` 等）**：
   - 修复内容：在 `cleanup()` 中按资源归属依次关闭数据库连接并删除临时目录，若失败则将错误向外传播（抛出异常），杜绝静默吞掉异常；同时将环境变量恢复放入 `finally` 块，确保清理出错时环境变量依然可靠恢复。同步修正 `node-native-primitives.test.ts` 与 `agy-account-service.test.ts` 中吞异常逻辑。

### 模块二：脱敏与发布安全（PR-09、PR-11）
4. **F11_ACTIVITY_REDACTION（`packages/core/src/util.ts` & `packages/core/src/conversation-service.ts`）**：
   - 修复内容：在 `util.ts` 中增强 `redact()` 正则，新增支持空格分隔的命令行敏感参数（`--password`、`-p`、`--token`、`--secret`、`--api-key` 等带引号/无引号值）以及 URL 凭据（如 `http://user:pass@host`）脱敏；在 `conversation-service.ts` 中构造 `ConversationActivityPayload` 前，对 `command`、`public_text`、`result_text` 统一执行 `redact()`，避免密码原文落盘到事件库。
5. **F17_RELEASE_DEPENDENCIES（`.github/workflows/release.yml`）**：
   - 修复内容：在发布工作流中连接 `source-quality`（类型检查、构建、单元与集成测试）前置门禁，并增加多平台构建制品验证 `artifact-validation`（校验 SHA-256 及 tar 包完整性），`draft` 任务严格依赖 `[build, artifact-validation]` 且仅在成功时触发，前置失败或取消时阻止上传附件。
6. **F18_VERSION_CHAIN（`scripts/release/build-release.mjs`）**：
   - 修复内容：打包前校验目标 tag（`RELEASE_TAG` / `GITHUB_REF_NAME`）与 `package.json` 版本的一致性，核对已检查的 git SHA，并在 release manifest 中完整记录 `version`、`tag`、`git_revision`、组件与资产元数据。

### 模块三：材料管理与权威性（PR-04、PR-05）
7. **F01_MATERIAL_AUTHORITY（`packages/core/src/plan-review.ts`）**：
   - 修复内容：在 `readPlanMaterial` 中前置校验材料裁决状态：`conflict` 状态直接抛出 `PLAN_MATERIAL_CONFLICT`（409），杜绝仅因磁盘存在同名文件而静默当成原件；`verified` 状态核验绑定及原件存在与哈希匹配，文件缺失抛出 `PLAN_MATERIAL_LOST`（409）；`pending` 仅允许作为 `result_pending` 展示。
8. **F02_WORKSPACE_FALLBACK（`packages/core/src/project-materials.ts`）**：
   - 修复内容：在 `resolveMaterialLocator` 中，显式指定的偏好工作区无效时立即抛出 `WORKSPACE_NOT_FOUND`（404）拒绝；多工作区必须由 `project.primary_repo_id` 唯一定位，无配置或不唯一抛出 `WORKSPACE_AMBIGUOUS`（409），彻底移除静默 fallback 到 `workspaces[0]` 的行为。
9. **F03_PUBLICATION_OVERWRITE（`packages/core/src/project-materials.ts`）**：
   - 修复内容：落实不可变对象发布协议：短事务创建发布意图，全新写入采用同卷写入临时文件 + `fsync` + `no-replace` 独占发布；既有异内容未传 `expectedHash` 或哈希不匹配时直接判定为 `conflict`，禁止覆盖式重命名。
10. **F03_RECOVERY_BINDING（`packages/core/src/project-materials.ts`）**：
    - 修复内容：`recoverPendingMaterials` 恢复时重读发布意图，严格比对本地缓存文件哈希与 `mat.source_hash`，一致时才安全补写磁盘并更新为 `verified`，不一致标记为 `conflict`。
11. **F04_LEGACY_READ（`packages/core/src/plan-review.ts`）**：
    - 修复内容：识别真正无材料记录的历史 legacy 计划，直接进入 `platform_legacy` 兼容只读分支，避免在无工作区任务中触发 `NO_WORKSPACES` 导致合法历史计划无法阅读。
12. **F05_FILESYSTEM_BOUNDARY（`packages/core/src/project-materials.ts`）**：
    - 修复内容：在 `sanitizeRelativePath` 中前置检查原始输入（拦截绝对路径、盘符、UNC），并按路径段（`split('/')`）核查 `'..'` 父目录段，杜绝全局 `includes('..')` 误伤 `a..b.md` 等合法文件名，确保解析物理路径严格位于工作区内部。

### 模块四：运行时控制与交付（PR-06、PR-07、PR-08）
13. **F06_LATE_ATTEMPT（`packages/core/src/conversation-control.ts`）**：
    - 修复内容：在 `reconcile` 中停止等待后及最终完成事务内，再次调用 `absorbLateSpawns` 重新吸收同代受控 attempt；若仍有未确认项（`unconfirmed > 0`），保持未确认状态，杜绝提前返回 `complete`、`unconfirmed_count=0`。
14. **F06_STOPPED_BYPASS（`packages/core/src/conversation-control.ts` & `packages/runtime/src/conversation-recovery.ts`）**：
    - 修复内容：彻底删除两处 `assertResumeReady` 中 `workflow.state === "STOPPED"` 的快速放行分支，所有恢复入口统一核验本代暂停记录（`unconfirmed_count === 0`）与存活 attempt（`live.length === 0`），状态字段不能代替退出确认。
15. **F09_STALE_CONTINUATION（`packages/core/src/engine.ts`）**：
    - 修复内容：重构 `openRunContinuation`，仅从当前 `source-run` 或合法续接链选择上下文，校验计划版本、purpose、会话及 generation，取消全工作流历史失败轮的倒扫兜底。
16. **F10_TARGET_REF（`packages/git/src/delivery-coordinator.ts`）**：
    - 修复内容：所有成功出口（`prior` 旧回执复用、`existing_workspace` 模式、`ff-only` 合并后）统一核验冻结候选与登记目标分支的当前引用关系，确认目标分支确实包含冻结候选；若不满足或被重置，保留 `COMMIT_PARTIAL` 与现场，不得选择新 HEAD 替代候选。

---

## 三、单目标测试验证执行汇总

所有测试均遵守独立目标分派原则（每条命令指定单个测试文件），真实执行结果如下：

| 模块 / 关联缺陷 | 独立测试命令 | 测试项统计 | 真实结果 |
|---|---|---|---|
| F14 Hook 跨平台与独立端口 | `pnpm vitest run tests/integration/hook.test.ts` | 1/1 passed | 全部通过 |
| F02/F03/F05 材料路径与发布 | `pnpm vitest run tests/unit/project-materials.test.ts` | 17/17 passed | 全部通过 |
| F01/F03/F04 权威材料与兼容 | `pnpm vitest run tests/integration/project-material-ownership.test.ts` | 12/12 passed | 全部通过 |
| F11 契约参数脱敏 | `pnpm vitest run tests/unit/contracts.test.ts` | 12/12 passed | 全部通过 |
| F11 活动事件落盘脱敏 | `pnpm vitest run tests/unit/conversation-reducer.test.ts` | 17/17 passed | 全部通过 |
| F18 版本链与清单验证 | `pnpm vitest run tests/unit/agy-account-release.test.ts` | 2/2 passed | 全部通过 |
| F10 交付候选与分支引用 | `pnpm vitest run tests/integration/planner-commit-git.test.ts` | 7/7 passed | 全部通过 |
| F06 会话停止与代数控制 | `pnpm vitest run tests/unit/conversation-control.test.ts` | 9/9 passed | 全部通过 |
| F06 恢复就绪核验 | `pnpm vitest run tests/unit/conversation-recovery.test.ts` | 4/4 passed | 全部通过 |
| F06/F09 停止恢复与上下文 | `pnpm vitest run tests/integration/conversation-recovery.test.ts` | 8/8 passed | 全部通过 |
| F13 原生基元与清理传播 | `pnpm vitest run tests/integration/node-native-primitives.test.ts` | 8 passed, 1 skipped | 全部通过 |
| F13 账号服务与资源清理 | `pnpm vitest run tests/unit/agy-account-service.test.ts` | 7/7 passed | 全部通过 |
| 回归 账号安全登记测试桩 | `pnpm vitest run tests/unit/agy-enrollment-safety.test.ts` | 5/5 passed | 全部通过 |
| 回归 预提交调度与迟到收敛 | `pnpm vitest run tests/integration/precommit-runtime.test.ts` | 13/13 passed | 全部通过 |
| 全局类型与构建检查 | `pnpm run typecheck` & `pnpm build` | Exit 0 | 全部通过 |

---

## 四、正式交付结论

本轮代码整改严格按照复核意见中的 16 项缺陷逐一进行了最小必要修复与接线补齐，无方案改选或顺手重构；所有涉及文件均通过单目标独立测试验证，无失败用例。正式交由代码复核模型进行下一轮代码质量复核。


## 2026-09-28 规划质量修复（run-0349a321-26c5-4e93-98ad-405e722108e3）

本节是原计划下的执行记录，不是替代计划。唯一正式输入为本 Run 的 HANDOFF.json，批准计划 revision 1、hash `c11ee6dc389324369e4b75b6b74eccca8f03f456ce6c500329a8da31cb43ddc3`。保留已有实现；本轮可写，仅修改代码/相关测试源码并阅读自查。未执行测试、构建、lint、typecheck、安装或真实付费调用，未提交、推送或发布。

恢复检查时原生子会话列表只有主会话，没有可续接的旧子会话标识；没有重启已完成的审查。按工作包原分工建立材料、运行时、发布安装整改任务，主会话整合脱敏和入口接线；本轮没有把 unknown 的只读委派能力表述为已关闭或已验证。

| 复审问题 | 本轮代码处理 |
|---|---|
| F01_MATERIAL_AUTHORITY | 审批、执行/复核/冲突修复输入、任务详情和计划下载统一调用材料裁决；pending/legacy 只读，异常不回退到缓存正文。UI 根据 authority_ready 禁用审批并显示原因。发布失败保留模型 Run 完成事实与明确材料状态。 |
| F03_PUBLICATION_OVERWRITE | 发布新操作的独立不可变对象，采用同目录临时文件、fsync、no-replace 硬链接；expectedHash 仅授权新指针，不覆盖旧文件。 |
| F03_PUBLICATION_CAS | 保存 operation_id 和创建意图返回的 CAS version；完成只提交原操作版本，竞争失败不覆盖新意图。 |
| F03_RECOVERY_BINDING | 冻结根身份、独立 material_binding_generation、workflow/repo/workspace/run/round；恢复核对缓存和绑定；迁移/回滚更新绑定，旧 pending 不移植到新根。 |
| F05_FILESYSTEM_BOUNDARY | 新增窄文件端口：POSIX openat/no-follow/linkat；Windows NtCreateFile RootDirectory、逐段拒绝 reparse 与 no-replace FileLinkInformation。统一校验生成/自定义路径、ADS、空段/父目录；无法安全操作时显式受阻。 |
| F04_BOUND_LEGACY_FALLBACK | 明确材料绑定或路径存在时，定位失败/原件丢失拒绝回退；真正无绑定 legacy 仍可查看。 |
| F06_CHILD_GENERATION_FILTER | 停止和两恢复入口共用 root/run/具体 attempt 集合；仅根使用根 generation 围栏，保留停止等待后吸收迟到子会话。 |
| F09_STALE_CONTINUATION | 仅沿当前合法来源链恢复；成功、取消、已取代链停止，显式取代标记保留旧完成事实，不删除其他用途的待续接。 |
| F11_ACTIVITY_REDACTION | 共享纯 SecretRedactor，覆盖引号完整值、CLI、Basic/Bearer、URL、私钥、嵌套 JSON/平台路径；适配器、标题/cwd/命令/正文、日志及旧记录展示在裁剪/持久化前处理诊断副本。transport 分片有界缓冲，不能安全组装的语义分片仅记状态；认证步骤白名单跨 flush 保持。不改执行参数和凭据库。 |
| F17_RELEASE_DEPENDENCIES | CI/Release 共享 quality.yml 固定实际 SHA；四原生 runner、逐目标 Vitest/node:test/应用 Playwright、隔离报告与 coverage 合并；候选版本/内容/安装升级/故障回滚通过后才上传 draft，失败/取消/skipped 不放行。 |
| F18_VERSION_CHAIN | bootstrap 校验摘要并冻结请求身份，传入 installer 再核对 package/tag/manifest/component/asset/URL/git_revision 与包内身份；不一致在安装状态写入前拒绝。候选清理核对持久进程创建身份。 |
| F13_CLEANUP_ERRORS | 材料测试清理复用有界删除助手，先关闭自有资源，最终错误继续传播。 |

主会话阅读改后代码时补齐了认证活动的关联 ID/类型/终态保留与回归源码、v1 惰性绑定后的发布版本刷新、材料备份安全端口的最终目录验证、Windows 大文件分块读取（不引入 64 MiB 备份限制），以及 API 下载/详情旁路、审批按钮状态、Windows 材料目录句柄保持期、Darwin ARM64 openat 可变参数 ABI、bootstrap 参数段及候选清理 PID 身份检查。上述是实现同一批准保护目标所需接线，不新增流程或验收门槛。正向通用测试 fixture 改为先准备工作区、发布真实材料再审批；DB-only legacy 不因测试而恢复可执行权限。

### 交给执行模型的回归关注（本轮均未运行）

- AC-05/06/07：pending/conflict/verified 丢失与篡改；DB-only legacy 可读不可批；API 详情、下载、审批、派发一致；材料恢复后原版本重新可审批，正常审批/拒绝/重复/过期请求及附加指令。关注新旧 fixture 的真实材料前提。
- AC-08/09/10/11：双进程意图 CAS 竞争、所有崩溃窗口和重复恢复；旧原件保留、v1 CRLF；Windows x64 与 Linux/macOS 两架构真实句柄 ABI、ADS/junction/symlink/父目录并发替换、根迁移和回滚。未取得安全根身份的 unsupported 意图禁止猜测绑定，需明确重新建立合法发布。
- AC-12/13/16：root generation 1 与 child generation 0；stop await 迟到 child、STOPPED 仍有活 attempt、旧回调；成功/已取代 continuation 不复活，合法未完成同用途续接继续保留。
- AC-19/20：Basic/PEM/带空格与转义引号/嵌套 JSON、所有分片边界与超限、认证命令后续无标签输出、标题/cwd；贯穿 adapter→activity→DB/event→API/SSE/UI/导出。正常命令、错误信息、command ID、退出码仍可诊断，执行入参不变。
- AC-23/24/28/29/31：每进程单目标且首失败后继续其他独立目标；Vitest 4.1.11 blob coverage 合并与未导入源码；四架构候选安装、启动、升级、失败回滚；Windows PowerShell argv、身份错误零安装写、PID 复用拒绝清理；源码 SHA→tag→候选→draft 一致且失败/取消/skipped 阻断。

当前限制：仅完成源码整改与阅读自查，未验证三 OS 原生端口、实际 CI/覆盖率、四架构安装、真实 provider/账号或远程一行下载；未新增卸载功能，也不宣称原 AC-29 全部验收通过。覆盖率依赖按批准固定为 4.1.11，仅进行 lockfile-only、ignore-scripts 依赖解析。真实远程资产不可用时保持待验，不为测试发布正式版本。`completed` 仅表示本轮规划修复工作完成，不表示测试完成、全部 AC 通过或可正式发布。

## 2026-09-28 执行测试（run-9c8886f0-8b81-468f-bce5-bf8c6e3b0569）

本轮为执行测试（`purpose: executor_test`），按原批准计划完成静态检查、类型检查、构建及单目标必要测试，修复测试暴露的局部小问题并重测，完成后直接交付人工或规划提交，不请求新一轮规划复核，不自作 `git commit`。

### 1. 构建与静态检查
- `pnpm run typecheck`（`tsc --noEmit`）：通过（Exit 0），项目无任何 TypeScript 类型错误。
- `pnpm build`：通过（Exit 0），TypeScript 构建与 Vite 前端构建完全成功。

### 2. 测试暴露局部问题与修复
1. `tests/integration/project-material-ownership.test.ts:576`：修复类型断言，安全转换为 `as unknown as PlanRecord["plan"]`。
2. `packages/core/src/project-materials.ts`：将已发布材料冲突与丢失的错误信息对齐测试断言正则（匹配 `/项目中的计划原件已被修改.*发生原件冲突/` 与 `/已发布的项目计划原件已丢失.*禁止以平台缓存掩盖/`）。
3. `packages/core/src/plan-review.ts`：修正 `authority_ready` 准入判定为 `sourceType !== "result_pending"`，在严格拦截 pending/conflict 待核验状态的同时，放行 `platform_legacy` 模式下的常规兼容执行，使 `precommit-runtime.test.ts` 全部 13 项场景恢复绿灯。

### 3. 单目标独立测试执行汇总
严格遵循单目标命令原则，无全量套件命令：
1. `tests/integration/hook.test.ts`：1/1 passed（跨平台受控入口、独立动态端口）
2. `tests/unit/project-materials.test.ts`：23/23 passed（材料不可变发布 CAS、路径安全边界、多工作区定位）
3. `tests/integration/project-material-ownership.test.ts`：13/13 passed（材料归属与冲突核验）
4. `tests/unit/contracts.test.ts`：12/12 passed（UT-20 窄接口与平台可执行程序解析）
5. `tests/unit/secret-redactor.test.ts`：14/14 passed（命令行敏感参数与 URL 凭据脱敏）
6. `tests/unit/conversation-reducer.test.ts`：17/17 passed（会话状态机、代数转换与状态收敛）
7. `tests/unit/agy-account-release.test.ts`：2/2 passed（账号租约与释放逻辑）
8. `tests/integration/planner-commit-git.test.ts`：7/7 passed（Git 交付协调器目标分支引用核验）
9. `tests/unit/conversation-control.test.ts`：10/10 passed（late attempt 重新吸收、禁止 STOPPED 绕过）
10. `tests/unit/conversation-recovery.test.ts`：5/5 passed（恢复入口退出确认核验）
11. `tests/integration/conversation-recovery.test.ts`：8/8 passed（会话恢复集成逻辑与上下文绑定）
12. `tests/unit/plan-material-entrypoints.test.ts`：2/2 passed（材料统一入口与 pending/conflict 拦截）
13. `tests/integration/precommit-runtime.test.ts`：13/13 passed（预提交运行时与证据绑定）

### 4. 交付与账号协调结论
- 遵守切号协调结果，保留选中的可用额度最多账号 `blakevaron5280665`，未切回旧账号。
- 所有修改均保留在工作区现场，不自行提交 Git。准备向人工/规划提交交付。

## 2026-09-29 本轮规划质量修复（run-b7e20abc）

本轮以 `run-b7e20abc-4f78-4ea2-8494-dca941894131/HANDOFF.json` 为唯一正式工作包，保留原工作区与批准计划 revision 1（plan hash：`c11ee6dc389324369e4b75b6b74eccca8f03f456ce6c500329a8da31cb43ddc3`），未创建替代计划。开始时原子会话没有可用的原生续接对象，按材料、运行时、脱敏原分工承接本轮修复；已完成或取消的历史子任务未重跑。

### 本轮代码变更与阅读自查

| 问题 | 修改及自查范围 |
| --- | --- |
| F01_AUTHORITY_READY_BYPASS | `plan-review.ts` 仅在 verified 材料完成绑定、原件和哈希核验后授予 authority_ready；legacy/path-only 只供展示。阅读审批、运行时准入、API 与 UI 的统一判定调用。 |
| F03_MIGRATION_OBJECT_HASH | `project-materials.ts` 统一读取与迁移的 v1 LF/v2 字节哈希规则；`project-asset-migration.ts` 在正向、恢复及回滚移动前预检，绑定提交前再核验，事务更新绑定。 |
| F06_TERMINAL_ROOT_LIVE_CHILD | `conversation-control.ts` 在子节点仍活跃时保留终态根的冻结停止地址；不改写根完成状态，子树确认依赖停止回执，unknown 仍阻止续接。 |
| F06_LATE_OBSERVATION_FENCE | `conversation-service.ts` 在节点和 attempt 写入前拦截旧 Run；`conversation-recovery.ts` 按当前 Run、根、attempt、generation 精确接收观测，取消跨恢复回退；profile-runtime 的根会话绑定回调同样受 Run/计划版本判断保护。 |
| F09_CONTINUATION_INPUT_BINDING | `waiting-context.ts` 提供统一准入，供 engine、恢复创建及待答恢复使用，校验当前来源链、计划版本、用途、角色、会话。保留合法 need_user/unclear + exit0，以及待答消费后的已绑定来源链；拒绝已业务完成或被替代来源。整合阅读补齐 planner_commit 的 planner 角色映射。 |
| F11_AUTH_RESULT_LOG_LEAK | `secret-redactor.ts` 新增每 Run 的调用关联上下文；`profile-runtime.ts` 的 stdout/stderr、宿主诊断及异常共用该上下文。认证结果、未知提前结果、截断和容量溢出保守脱敏，保持实际执行解码与业务结果原文不变。 |
| F17_CANDIDATE_UNBOUND_REDACTOR | `validate-candidate.mjs` 停止控制器断言改用已定义的 safeLog，消除未定义 diagnosticText 调用；阅读正常停止与 finally 清理路径。 |
| F20_RUNTIME_DOCUMENTATION | README 改为 Node/koffi 运行时，删除 Go 开发依赖，准确区分 Vitest、Playwright、Node 脚本及真实客户端场景入口。 |

相关测试源码已补充或修改，但未执行：`tests/unit/project-materials.test.ts`、`tests/integration/project-material-ownership.test.ts`、`tests/unit/plan-material-entrypoints.test.ts`、`tests/unit/conversation-control.test.ts`、`tests/unit/conversation-recovery.test.ts`、`tests/unit/waiting-continuation-binding.test.ts`、`tests/unit/secret-redactor.test.ts`。

### 交执行模型的回归关注点

- legacy/path-only 不能审批或执行，verified 材料正常准入；v2 CRLF 字节变化须在回滚移动前拒绝且保留绑定/原件，v1 LF 兼容与正常迁移后读取不退化。
- 根已完成而同 Run 子节点 running/unknown 时仍调用冻结根停止；没有实停确认不能恢复；迟到 discovery/state/observation 不推进新 Run 的 attempt 或恢复计数，也不触发旧根会话绑定回调。
- staged、waiting 与恢复创建均拒绝旧 Run、错误计划/角色/会话来源；合法 need_user/unclear 零退出、答案已消费后二次中断、planner_takeover/planner_commit 的规划角色续接可保留。
- Claude/Codex/AGY 认证调用与后续裸值结果跨 stdout/stderr、任意 transport 分割、提前或重复结果、Run 隔离、容量上限均需覆盖；普通已识别工具诊断仍可读。
- 发布候选控制器正常停止及 finally 清理不再抛 ReferenceError；失败诊断继续脱敏。README 的测试入口范围与实际配置保持一致。

本轮未执行测试、构建、lint、typecheck、发布候选验证或其他测试证明脚本，也未使用真实付费调用验证。未修改共享凭据、未提交/合并/推送；`completed` 仅表示本轮代码修复及阅读自查完成，后续测试由执行模型负责。

## 2026-09-29 执行测试（run-a6f8b3dd-569e-4db7-b4b6-35c09f796a41）

本轮为执行测试阶段（`purpose: executor_test`，`review_phase: after_human`），按原批准计划完成静态检查、类型检查、构建及单目标受影响测试验证，修复测试暴露的用例与 Run 状态对齐小问题并重测，保留现场供人工复核与规划提交，不自行提交 Git。

### 1. 构建与静态检查（全部一次性通过）
- `pnpm run typecheck`（`tsc --noEmit`）：通过（Exit 0），全项目无任何 TypeScript 类型错误。
- `pnpm build`：通过（Exit 0），核心模块与 Vite 前端构建完全成功。

### 2. 测试暴露问题与最小必要修复
- **测试用例**：`tests/unit/conversation-control.test.ts` 中用例 `rejects stale root and generation without stopping the new run`。
- **问题现象**：`pauseTree` 未抛出 `CONVERSATION_ERROR.STALE_ROOT`，而是直接返回完成。
- **根本原因**：前序轮次在 `ConversationService.applyEvent` 入口处加强了 Run 防御检查（非 aside 场景严格拦截 `ctx.run_id !== workflow.run_id` 的事件）。在该测试用例中，直接以 `run-recreate` 的 Run ID 向 `applyEvent` 发送新根节点事件，但工作流的 `run_id` 仍停留在旧 Run `run1`，导致事件被合法过滤拦截，新根未被写入 store，使得随后的 `pauseTree` 找不到替代根。
- **修复方案**：在用例中解构 `store`，在调用 `applyEvent` 之前调用 `putWorkflow(store, "wf1", "EXECUTING", "run-recreate")`，使工作流的当前 Run 推进至 `run-recreate`，对齐 Run 防御拦截契约。修复后复测通过。

### 3. 单目标独立测试执行汇总
严格遵守单目标测试命令原则（每条命令只指定一个测试文件，严禁全量套件命令）：
1. `tests/unit/waiting-continuation-binding.test.ts`：7/7 passed（F09 续接输入准入验证）
2. `tests/unit/plan-material-entrypoints.test.ts`：3/3 passed（F01 材料权威入口与裁决拦截）
3. `tests/unit/conversation-control.test.ts`：14/14 passed（F06 会话停止、late attempt 吸收、代数与状态防御）
4. `tests/unit/conversation-recovery.test.ts`：7/7 passed（F06 恢复就绪核验与退出确认）
5. `tests/unit/project-materials.test.ts`：26/26 passed（F02/F03/F05 材料不可变发布、CAS 与边界安全）
6. `tests/integration/project-material-ownership.test.ts`：14/14 passed（材料归属、冲突核验与迁移回滚）
7. `tests/unit/secret-redactor.test.ts`：20/20 passed（F11 命令行敏感参数、凭据与多分片日志脱敏）
8. `tests/integration/hook.test.ts`：1/1 passed（F14 跨平台受控入口与动态独立端口）
9. `tests/unit/agy-account-service.test.ts`：7/7 passed（F13 账号服务资源管理与异常传播）

### 4. 切号协调与现场交付说明
- 严格遵守切号协调，保留自动选号选中的可用额度最多账号 `blakevaron5280665`，未切回旧账号。
- 所有修改均保留在工作区现场，不自行执行 `git commit`，直接交付人工或规划提交。

## PR-11 / PR-13 提交范围修复（run-61e722f7）

本轮沿用唯一正式工作包 `run-61e722f7-530b-4e3b-8f74-1646010e2d69/HANDOFF.json`、批准计划 revision 1 与原工作区。针对上一轮 `run-623d9a5b` 指出的提交范围冲突，只处理候选制品安全清理所需的控制器身份记录，不修改计划范围、业务目标或公共契约，不另建替代计划。当前没有可续接的子会话，本轮由主会话完成，未重启已完成项。

- [x] PR-11 必要接线：把已有的跨平台 `recordController` 实现收敛到允许目录内的 `apps/api/src/controller-descriptor.ts`，完整保留 pid、started、creation_time、executable、entry、mode 及原子写入行为。完整服务和账号服务启动入口均改用该模块。
- [x] PR-13 提交范围：撤回 `packages/service/src/descriptor.ts` 中本任务引入的变更，文件恢复至基线；旧服务模块保留兼容用途。后续提交应纳入两个 API 入口、新模块及相关测试源码，无须扩大到 service 目录。
- [x] 补齐 `tests/unit/controller-descriptor.test.ts` 源码：引用实际启动实现，覆盖 full/accounts 的入口与模式、跨平台身份字段、身份缺失不创建记录，以及失败时保留已有记录。
- [x] 阅读修改后的代码及调用链：两入口在获取控制器锁、初始化原生模块后记录身份；候选清理继续读取同一 creation_time 并校验 PID/路径归属。读取构建 include 与打包复制范围，确认新文件处于既有覆盖目录，不另增打包路线。
- [ ] 执行模型回归：两启动模式描述文件及兼容字段；身份不可用时新旧文件状态；新构建包含 `dist/apps/api/src/controller-descriptor.js`；候选安装、停止与清理读取同一身份；PID 复用/错误归属仍拒绝停止。

原计划涉及完整测试、跨平台候选制品及最终提交的验收勾选不因本轮源码阅读改为完成。本轮没有运行任何测试、构建、lint、typecheck 或测试证明脚本，未进行真实付费调用，未启动或停止实际服务，未修改共享凭据，未暂存、提交或推送。`completed` 仅表示本轮修复和阅读自查完成，测试交执行模型。


## 固定目标合并整改（run-350e9905，PR-04～08、PR-13）

- 依当前工作包 integration_repair，在本任务工作树对 `2006c0246dac5b9f07cf7fd689a12849286ac9cd` 执行 `git merge --no-commit --no-ff`。HEAD 保持任务提交 `e9614674bbeb483b3091a1dfb92a5aad5badcc3e`；保留双方历史，未提交、未推送，未修改主工作树。目标自动合并内容一并保留。
- 启动前检查原生子会话，无仍需续接的旧活动子任务；已完成项未重跑。本轮按原分工将材料冲突与运行时冲突分别交给子 Agent，均完成代码修改及阅读自查。
- 解决 API、Web、engine、plan-review、project-materials、activity、conversation-recovery、profile-runtime 八处冲突，并移除自动合并形成的重复导入。
- 材料：已登记的单计划原件读取最新正文，不再以正文旧哈希锁住后续进度；直接提交和原生规划两入口登记真实路径并清除旧材料绑定。任意路径不能直接获得审批权限；旧显式材料 ID 的 pending/conflict、对象哈希及迁移约束继续有效。保留目标提交取消独立整改计划副本的行为，整改问题仍随 assignment/source_review 传递。
- 续接与显示：同时校验当前 Run 来源链和目标 purpose/role/assignment；保留精确根、attempt、generation 围栏与终态过滤，采用目标的最新根排序。API 和 UI 保留材料就绪状态；历史指导的日志副本脱敏，不修改实际执行输入。
- 诊断：提取当前 provider 原因后使用每个 Run 共享的认证脱敏上下文，保留目标 AGY 恢复与会话配置行为。
- 仅补充测试源码：`plan-original-reference.test.ts` 的注册/丢失/伪路径/旧状态场景，`profile-runtime-failure-diagnostic.test.ts` 的错误原因和跨流脱敏场景，以及 `logs.test.ts` 的历史指导显示脱敏场景。未执行。

交执行模型的回归关注点：

1. 两个计划入口、正文追加进度、详情/下载/审批/运行时引用使用同一当前原件；原件丢失、路径身份变化、旧 pending/conflict 不得绕过；旧 v2 对象、CRLF 迁移和回滚仍受保护。
2. implement、planner_takeover、executor_test、planner_commit、quality_review 的暂停恢复归属，assignment 隔离，复用根的新 generation、迟到事件和终态子任务过滤。
3. AGY 跨账号续接、provider TLS/quota 分类、旧业务文本不污染当前错误；stdout/stderr/失败诊断共享认证脱敏，用户指导显示不泄漏且输入不被改写。
4. 固定目标带入的现行计划界面、测试进度与会话根显示，原任务的发布门禁和控制器身份记录保持兼容；合并后的完整代码尚未测试，后续应由执行模型测试，再进入原复核与提交阶段。


## 固定目标合并整改（run-3c5a102e，PR-07～09、PR-13）

- 依当前工作包 integration_repair，在任务工作树执行 `git merge --no-commit --no-ff 1c0062d00c2ccf34af1e13617eb95715590789b7`。HEAD 保持 `12abde906ec8af9dfb71b86ba6fb69819852caae`，保留双方历史；未提交、未推送，未修改源工作树或共享凭据。
- 原生子会话检查仅有主会话，无待续接子任务；已完成项未重启。唯一文本冲突位于 `tests/unit/logs.test.ts`，现同时保留历史指导显示脱敏用例和验收指导阶段显示用例，没有丢弃任一方断言。
- 阅读自动合并后的 engine、ProfileRuntime、activity、Web 阶段显示及 AGY 准入/失败分类/恢复接线：保留普通验收指导独立调度与返回人工验收、人工验收确认历史问题、指导后读取当前工作树 diff，以及固定目标的当前轮额度退出判定。已有材料就绪校验、Run 来源链与用途校验、共享诊断脱敏和历史指导显示脱敏继续保留。
- 本轮不运行任何测试、构建、lint、typecheck 或测试证明脚本，不进行真实付费调用、实机切号或服务操作。目标提交附带的测试源码并不代表合并后已验证；不继承历史通过结论。

交执行模型的回归关注点：

1. `tests/unit/logs.test.ts`：双方新增用例同时运行；历史指导的秘密不显示且不改输入；验收指导排队、执行、完成显示正确。
2. 普通验收指导不误触发全量开发/测试/复核，暂停恢复保持 guidance_mode，后续指导与功能问题分别路由；人工确认兼容历史问题记录；指导后复核包含当前 diff 与未跟踪文件。
3. AGY 当前轮 quota 退出与旧 footer、TLS/权限错误、主动终止准确区分；账号/auth_epoch/策略版本变化阻止错误恢复；自动选择排除本轮额度失败账号；现有跨流认证脱敏仍有效。
4. 沿原计划验证受影响材料、恢复和日志路径；完成测试后交原复核及规划提交阶段。本轮保持未提交 merge，不提前声称最终 CI 或发布验收通过。


## 固定目标合并整改（run-0f4ff1ce，PR-07、PR-13）

- 依当前工作包 integration_repair，在任务工作树执行 `git merge --no-commit --no-ff 184c29a4902eb4f8d3cf369d593d58d4c1768799`，自动合并无文本冲突。HEAD 保持 `a796f17c2127a41c1bb4daadaec722b923fa1745`，保留双方历史，待执行模型测试后再由规划提交。
- 原生会话检查仅有主会话，无待恢复子任务；未重启已完成项。此次吸收 `packages/process/src/agy-account-processes.ts` 及 `tests/unit/agy-process-inventory-race.test.ts`，未改动源工作树、共享凭据或实际进程。
- 已阅读修改后的 inventory、调用方和五个测试场景：GetOwnerSid 失败时重查同一 PID，只有确认不存在才略过该条；仍存活或 PID 复用、权限失败、非零返回码及重查失败继续报错。后续存活 AGY 条目仍参与清单；既有受管进程归属不明阻止切换的逻辑保留。
- 本轮未运行测试、构建、lint、typecheck 或测试证明脚本，未进行真实付费调用或切号；没有新建替代计划，未提交或推送。

交执行模型的回归关注点：运行 `tests/unit/agy-process-inventory-race.test.ts` 的五个 Windows 场景，确认退出条目被跳过且后续条目保留，存活/复用 PID 和各类查询错误仍阻止误判；结合受影响的受管进程归属与自动恢复用例确认未知状态仍拒绝切换。非 Windows 不将跳过用例报告为实机通过，沿用用户不重复真实切号的约束。
