# DevFlow 项目工作区与 CLI 持久会话第四轮核心功能复审意见

日期：2026-09-21。结论：`changes_required`，本轮不提交、不合并。

审查对象：`C:\Code\system-handle-subagent-viz`，分支 `zxw/subagent-conversation-ui-20260920`，HEAD `df18ee4d357fa939645be16fd233a1162bddbebe` 及当前未提交代码。主工作区其他任务的修改不属于本次范围。

## 本轮边界

按用户最新要求，只审代码能否完成主要功能：项目工作区和材料归项目所有、同任务同模型继续正确的 CLI 会话、停止后能在原工具独立续接。没有运行产品测试，也没有检查执行模型是否跑过测试、测试报告或证明材料。

本文是[原统一方案](DevFlow项目工作区与原生可见会话统一方案及开发计划-20260920.md)及[第三轮整改意见](DevFlow项目工作区与CLI持久会话第三轮代码复审与整改意见-20260921.md)的定点补充。以用户本轮收紧的范围为准，不把旧文档的所有完善项继续作为本轮放行门槛，不新增验证工具、CLI 探测、其他工具接入或无关开发。下面只要求修复 5 组有具体调用链依据的主功能问题。

## CW4-F01：新任务被当成 legacy，跨工具执行会拿错会话

关联 CW3-F03。

**位置与触发：**[create-workflow.ts:195](C:/Code/system-handle-subagent-viz/packages/core/src/create-workflow.ts:195) 创建 Workflow 时没有写 `binding_strategy`，旧 Engine 创建入口也没有写；[profile-runtime.ts:601](C:/Code/system-handle-subagent-viz/packages/runtime/src/profile-runtime.ts:601) 则把缺值解释为 `legacy`。因此正常新建任务也走历史分支。

规划工具 A 首次 init 后会保存任务级 `conversation`。进入执行工具 B 时，没有 B 的精确身份键记录，[profile-runtime.ts:653](C:/Code/system-handle-subagent-viz/packages/runtime/src/profile-runtime.ts:653) 无条件回退到这个任务级指针，再在 700–705 行调用 B 的 `adapter.resume(A的会话ID)`。规划/执行选择不同工具是现有创建流程明确支持的功能；这里会续接失败，不同模型也可能串用同一根。

同一历史分支还有一个相关入口：[profile-runtime.ts:872](C:/Code/system-handle-subagent-viz/packages/runtime/src/profile-runtime.ts:872) 的 init 回调没有排除 `purpose === "aside"`，临时提问会覆盖同身份的正式会话指针；轮次结束处虽然排除了 aside，但覆盖已经发生。

**最小修法：**

1. 在正式 Workflow 类型中声明已有的策略字段，所有新任务创建入口明确保存 `unified`；只有已有缺字段任务保留历史兼容语义。会话选择和 dispatch 登记共用同一个已确定策略，删除两处不同的缺省解释。
2. 新任务按现有 `SessionBindingKey` 创建和复用绑定。历史任务只使用能匹配当前工具、模型、工作区及已知配置身份的旧记录；删掉不核对身份就采用任务级 `conversation` 的兜底。无法确认时保留记录并明确不能续接，不把旧 ID 交给另一工具。
3. init 回调和结束回写都排除 aside 对正式根指针的写入。临时提问可以保留自己的 Run 和会话记录，不更新正式 binding/native_conversation/conversation 指针。
4. 保留本轮已修好的 init 立即保存 Run/dispatch 根 ID 的行为，不退回等整轮结束才保存。

**修复后应有的行为：**新任务规划和执行采用不同工具时，各自获得正确的根；同模型后续正式轮次复用自己的根。临时提问不改变下一轮正式任务续用的会话。

## CW4-F02：手动续接脚本不能正确启动原 CLI

关联 CW3-F22。

**位置与触发：**[resume-instructions.ts:101](C:/Code/system-handle-subagent-viz/packages/adapters/sdk/src/resume-instructions.ts:101) 把 CRT 参数编码直接拼成 PowerShell 源码，例如：

```powershell
Start-Process -FilePath "codex" -ArgumentList "resume" "会话ID" "-m" "模型" -Wait -PassThru -NoNewWindow
```

PowerShell 不会把空格分隔的这些字符串自动组成 `ArgumentList` 数组，普通续接参数就会触发位置参数绑定问题。CRT 引号也不等于 PowerShell 字面量转义。87–98 行还直接改变父终端的目录和环境。

另外，[server.ts:620](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:620) 没有向生成器传实际 CLI 启动入口，生成器 152/160 行退回 PATH 中的 `agy`/`codex`。任务使用绝对 `executableRef`、工具未进入 PATH 或 PATH 中存在另一份安装时，复制脚本无法续接原工具。

**最小修法：**

1. 恢复此前的 `ProcessStartInfo` 子进程启动方式。`FileName`、`WorkingDirectory`、完整 CRT `Arguments` 用现有 `toPowerShellSingleQuoted` 转成 PowerShell 字面量；不能把每个 CRT 参数裸拼入 PowerShell 调用。
2. 只在子进程环境中移除平台注入、设置现有必要 CLI home；不修改父终端 cwd/env。等待退出并设置 `LASTEXITCODE`，不退出父 shell。
3. resume API 从该绑定关联 Run 的冻结 profile 获取原工具入口，复用现有启动入口解析规则，传入独立可执行的 exe，或 Node 加原工具脚本和必要前缀参数。生成器消费这个入口，不再另猜 PATH。入口信息确实缺失时明确不给出可执行脚本。
4. 保留当前调度停用、无受管写者、绑定可用及迁移完成的判断，不添加新工具探测或在线核验步骤。

**修复后应有的行为：**用户复制的脚本能向原 CLI 传递完整会话 ID 和参数；采用非 PATH 安装的任务同样能续接；退出 CLI 后原终端仍可继续使用。

## CW4-F03：项目计划已落盘，审核却仍然读取平台缓存

关联 CW3-F12。

**位置与触发：**正常规划在 [engine.ts:2617](C:/Code/system-handle-subagent-viz/packages/core/src/engine.ts:2617) 传入 `run_id` 发布计划，生成的路径是 `plan-rN-run-<run>.md`，材料键是 `mat_<workflow>_plan_rN_run_<run>`。

但 [plan-review.ts:38](C:/Code/system-handle-subagent-viz/packages/core/src/plan-review.ts:38) 读取时没有传 run_id，推导的是 `plan-rN.md`；45 行另查 `mat_<workflow>_plan_N`。文件和材料键都匹配不到新产物，于是 92–103 行把新计划当成历史数据，继续读取平台缓存。用户在项目里修改或移走原件，审核入口仍会展示旧缓存。

**最小修法：**

1. 发布计划时，把本次真实 material ID/locator 关联到相应规划版本记录。
2. `readPlanMaterial` 按这条关联取得材料记录的 `workspace_id/path/source_hash`，读取真正的项目原件；不要重新猜文件名或手写另一套材料键。
3. 对本轮整改之前已生成的带 run_id 材料，用现有规划 Run/版本关联找到精确记录；不要简单取同版本材料列表的第一条。只有确实没有项目材料记录的历史计划才保留缓存兼容。
4. 原件已发布后修改或丢失，使用现有冲突/丢失处理；发布未完成继续沿用现有 pending 行为。无需增加材料管理平台或新的证明机制。

**修复后应有的行为：**正常新规划的审核读取对应项目文件，项目原件变化会进入现有处理分支，不再被平台缓存掩盖。

## CW4-F04：资产迁移和历史绑定修复写出的键，运行时匹配不到

关联 CW3-F10、CW3-F17。这是同一“写入与查询身份不一致”问题在两个入口的具体表现，两处都需要修。

**入口 A，工作树迁移：**[project-asset-migration.ts:642](C:/Code/system-handle-subagent-viz/packages/core/src/project-asset-migration.ts:642) 只改 binding 的 `workspace_root/source_root`，没有修改 `workspace_identity`。`computeSessionBindingKey` 使用的是 identity，因此 649 行算出的“新键”仍是旧键。下一轮运行根据新 Workspace.root 算出新 identity，查询不到迁移后的原 binding。resume 874–890 行、rollback 980–996 行有相同写法。此外 `source_root` 被直接写成任务目标目录，混淆了来源仓库与任务工作树。

**入口 B，历史会话修复：**[session-binding-repair.ts:212](C:/Code/system-handle-subagent-viz/packages/core/src/session-binding-repair.ts:212) 和 299 行把 `client_scope_id` 写成 `.codex` 或 `.gemini/antigravity` 相对名称，并以单独替换斜杠的路径作 workspace identity；[identity.ts:98](C:/Code/system-handle-subagent-viz/packages/adapters/sdk/src/identity.ts:98) 起的实际运行解析使用完整绝对配置目录和统一路径归一化。apply 522–531 行以候选值生成绑定键，因此即使修复返回成功，下一次运行按精确键查询也命不中原绑定。

**最小修法：**

1. 正常运行、历史修复、工作树迁移统一使用现有身份解析逻辑中的配置域与工作区归一化规则；历史修复不再把目录简称作为实际配置身份。有可用原记录时保留其真实身份，缺失时沿现有解析流程补齐，不能用固定值冒充。
2. 工作树移动后，用完整工作区映射重算 workspace identity 和 key，在已有提交事务中迁移原绑定与 by-id 索引，保留 binding ID、conversation ID、工具、模型及账号身份；来源仓库路径保留真实 `source_root`。
3. apply、resume、rollback 使用相同的绑定更新逻辑。不得以“查不到就创建新根”掩盖键不一致，也不需要重构其他会话功能。

**修复后应有的行为：**修复或移动后，运行时计算出的 key 能找到刚更新的原 binding；继续的是原 conversation ID，回退也遵循相同规则。

## CW4-F05：接管已有会话的 API 读取了不存在的配置字段

关联 CW3-F16。

**位置与触发：**[server.ts:475](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:475) 从 `workflow.profile/task_profile` 读取模型，两个字段均不是实际创建流程保存的配置。真实配置位于任务的 `execution_spec.plannerProfile/executorProfile`。请求中的 `profile_ref` 没被使用，而 strict DTO 又不允许客户端传入 adapter/model；因此正常创建的任务提交合法 adopt 请求也会在 480–485 行报 `IDENTITY_UNVERIFIED`。

底层 [execution-session-store.ts:256](C:/Code/system-handle-subagent-viz/packages/core/src/execution-session-store.ts:256) 还有固定 `agy/gemini-2.5-pro/local/default` 兜底。仅移除 API 的拒绝判断会让请求通过却绑定到错误身份，不能这样修。

**最小修法：**

1. 使用请求已有的 `profile_ref`，从任务关联 execution_spec 的 profile 中解析实际工具配置并检查对应 revision，复用现有 run-profile 规则；删除对不存在的 Workflow 配置字段的读取。
2. 用该配置和所属 workspace 走现有身份解析流程，把完整真实身份传给 `adoptExistingSession`，与后续运行使用同一套键规则。
3. 删除底层硬编码工具、模型、账号及配置域兜底；缺少必要身份时保留清晰错误，不能制造成功记录。保留已经修好的 workspace 任务归属、已有根不可偷换、幂等和事务写入。

**修复后应有的行为：**正常任务选定已有 profile 后能接管对应会话；写出的绑定随后能被正常运行查到，不改变外部已有根 ID。

## 已修内容与本轮不阻断事项

当前代码已经修复了本轮 Run 自占用、重复 stop 丢失已确认退出结果、首次 init 延迟落库、迁移恢复直接跳过材料复制、迁移接口任务归属、备份失败复制活动主库，以及不同内容材料被直接覆盖等旧问题。这些不再重复列入整改。

页面使用真实回退版本和受影响绑定集合、歧义根组内选择、当前 dispatch 绑定定位、调度操作期间禁用旧复制脚本等修改也已接入。

多工作区任务只选择部分工作树清理时，`delivery-coordinator.ts:692` 重算全任务摘要可能导致 `PREVIEW_DIGEST_MISMATCH`。这是辅助清理功能问题，不会删除项目材料；按用户本轮优先级记为后续项，不作为本轮主要功能放行要求。

## 最小交接与复盘

执行分工只围绕上述文件：运行/会话负责人处理 F01、F04、F05；材料负责人处理 F03 和 F04 的工作树迁移调用；脚本/API 负责人处理 F02。公共 `server.ts`、Workflow 类型和身份解析函数由一个负责人整合，避免并发改写。可以并行处理独立部分，不新增平台流程。

修复只需让这些既有调用链的读写、参数和身份一致。执行模型自行完成相关功能的定向自测；本文件不追加测试执行证明、原始报告、外部工具核验或新的验证脚本要求。复审仍只看代码质量。

本轮问题的共因是：一端换了字段或默认值，另一端仍按旧约定调用。例如 publisher 加了 run_id 而 reader 没跟进，运行改为缺省 legacy 而创建没明确 unified，生成器改了启动方式而沿用另一层的参数转义。这些应通过同步修正相邻调用方解决，不需要再建立一套调度、验证或证据系统。

本轮只新增本文，没有修改产品代码、运行状态或 Git 提交。
