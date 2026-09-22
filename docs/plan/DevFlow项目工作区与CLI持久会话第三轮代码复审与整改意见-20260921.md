# DevFlow 项目工作区与 CLI 持久会话第三轮代码复审与整改意见

日期：2026-09-21。代码结论：`changes_required`。本轮不提交、不合并。

本次重新读取了 `C:\Code\system-handle-subagent-viz` 的当前完整文件，包含暂存、未暂存及未跟踪实现。分支 `zxw/subagent-conversation-ui-20260920`，HEAD 仍为 `df18ee4d357fa939645be16fd233a1162bddbebe`；不能用 HEAD 不变推断没有整改。主工作区为 `C:\Code\system-handle`，其独立 AGY 账号整改及其他修改不在本次实现提交范围。

主审及三个审查 Agent 均只读检查代码和必要上下游。本轮没有运行单元、集成、E2E、真实模型 CLI、迁移、清理或构建，没有审计执行报告。本文的验证要求交执行模型实施，不表示本轮已运行通过。

## 1. 执行依据与结论

<!-- devflow-plan-authority:v1 -->

本文是[第二轮整改及复盘](DevFlow项目工作区与CLI持久会话第二轮代码复审整改及计划复盘-20260921.md)的定点补充，并继续引用[第一轮修复计划](DevFlow项目工作区与CLI持久会话代码质量修复计划-20260921.md)和[原统一方案](DevFlow项目工作区与原生可见会话统一方案及开发计划-20260920.md)。原 `NV-* / CW-* / CW2-*` 要求与验证全部保留，桌面会话展示继续延期。

执行模型完整读取这些正式文件，保留文件路径、hash和编号；禁止自建替代实施计划。只可维护“执行进度（非计划）”事实记录。发现具体合同冲突时报告原章节及代码证据，由规划角色修订受阻部分，其他独立工作继续。

本轮分为 **26 个可定位整改条目（16 个 P1、10 个 P2）**。这是把新回归及同一旧问题中的不同根因分别定位，不能与上一轮19个问题直接相减来衡量进度。`CW3-F*` 与 `CW2-F*` 的对应关系写在每项内。

### 确实已改善的行为

- ProfileRuntime 已接 prepare/claim/finish，冲突 outbox 已加检查；不能再说派发 helper 完全没接。但当前接法会把本轮 Run 当作其他写者。
- LocalRuntime.stop 已返回 StopResult，Engine 不再把 unknown 无条件写成 STOPPED；但调用链重复 stop 引入了相反方向的阻断。
- 原空 catch 的根绑定错误现在设置 failure；固定身份默认值从运行 resolver 移除，但真实配置读取及事务绑定尚未完成。
- move 前材料已改写旧树，materials_only 不再改 root；旧脚本 DB-only 导出已拒绝，preview 已用只读连接，mutation 已走 HTTP。
- 规划磁盘异常不再直接判模型失败；整改新增项目正文；默认计划原件 hash 变更会报冲突。
- 单仓库缺省 repo 统一为 main；existing linked workspace 的预览保持所选根；source-change 首次/结束计算共用 scanOptions。
- 正常整合仍保留 worktree；显式清理现在可选部分工作区。
- adopt 外部身份字段已收紧，revision=0 不再绕过已有绑定，相关写入放入事务；repair增加部分版本、候选选择和路径处理；空回退清单不再对非空 patch 放行。
- command_line 响应/生成/复制兜底已删除；脚本清理真实 RUN_TOKEN/BASE_URL，并用 LASTEXITCODE 保留父 PowerShell。
- 原同任务 A→B 切换的 dispatch 迟到覆盖已修，跨任务保护保留。下面的当前绑定标识、旧脚本快照及表单问题是不同调用点。
- 前两轮已经确认修复的 Kimi 只读拒绝、正常整合不自动删树等行为继续保留。

## 2. 运行、会话与控制

### CW3-F01 / P1：派发把本轮尚未启动的 Run 判成已有写者

对应 CW2-F08；第二轮 §7.1–7.5、T08。

**代码事实：**[cli-dispatch.ts:493](C:/Code/system-handle-subagent-viz/packages/runtime/src/cli-dispatch.ts:493)把所有 `status=running` 的 Run 算占用。Engine 规划/执行/复核在调用 runtime 前就保存本轮 running Run（engine.ts:2565、2904、2914）；ProfileRuntime:711 随后调用 prepareDispatch→checkDispatchEligibility，拒绝自己的首次启动。claim 排除 dispatch ID 也没有排除该 Run。

**修法：**在真实 dispatch/process/Host 事实中区分“当前已核验准备意图”和“其他未退出调用”。内部 prepare/claim 接收并核验当前 Run/dispatch 身份，仅排除同一准备意图的自占用；不能忽略整个任务的 running Run，也不能在对外 occupancy 中把真实正在启动的调用当 idle。准备状态的业务 Run 不直接等同 OS 写者。保留旧调用及 unknown 的占用保护。

**执行验证：**扩充 `tests/integration/cli-dispatch-recovery.test.ts` 的 CW2-T08，从 Engine 真实规划/执行/复核进入可控假 CLI；断言本轮首启一次、另一个 Run/旧未知进程阻止启动。用只测 CliDispatchManager 的 fixture 不能覆盖这个新回归。

### CW3-F02 / P1：持久派发恢复和最终 claim 仍未闭合

对应 CW2-F08；第二轮 §7.1–7.5。

**代码事实：**[cli-dispatch.ts:529](C:/Code/system-handle-subagent-viz/packages/runtime/src/cli-dispatch.ts:529)的 reconcileDispatch 没有生产调用，仅处理 starting/no-PID。reconcileProcesses 更新旧 process_record，不收尾对应 Run/dispatch；重启后已退出的旧 running 记录仍长期占用。claim:322–342 只对 prepared 检查，随后任何状态都可改 starting；没有匹配版本的 CAS。[runtime.ts:644](C:/Code/system-handle-subagent-viz/packages/runtime/src/runtime.ts:644)、1373 的 legacy 模型启动仍绕门面。ProfileRuntime:750 的 `res.code ?? 0` 还把无退出码当成功。

**修法：**所有模型启动统一到同一个派发服务；普通检查/浏览器进程保留自身合同。claim 只接受匹配 Run、control、绑定或 legacy 来源版本的 prepared，在事务内 CAS 后交付启动。completed/interrupted/unknown 不得直接重新 starting。启动及重启恢复必须关联 Host/process、Run、dispatch、根事件和结果；确认退出、合法业务结果分别记录，null 退出码不能转0。恢复已确认终态，未知保留待核对；重复相同调用不得再次 spawn。

**执行验证：**CW2-T08 加服务重建后 Host 已退出、starting回执丢失、completed再次claim、准备期间停用及 legacy 启动；断言旧记录正确收尾、未知不补发、结束 dispatch 不重开、null退出码不标成功。

### CW3-F03 / P1：legacy/pending 和根确认仍未实现完整分支

对应 CW2-F09；第二轮 §8.1、T09。

**代码事实：**[profile-runtime.ts:595](C:/Code/system-handle-subagent-viz/packages/runtime/src/profile-runtime.ts:595)所有正式调用直接 getOrCreateBinding，缺策略在717行默认 unified。只有旧会话的任务会生成 reserved 后走新根，或强续接报错；unavailable/retired 仍可凭非空ID续接。809行直接 bindConversationId；该方法分开写 binding/owner且重复 init 增 revision。Run根ID到轮次结束才保存，dispatch根确认未接，950/1014附近继续写旧权威表。

**修法：**新任务显式 unified；缺策略的历史任务按 legacy 只读核验，未处理旧候选/pending阻止误建根。按绑定状态选择动作。根确认以 dispatch/Run/进程来源/代次和完整身份作同步事务：unified 原子写 binding、owner/by-id、Run、dispatch；legacy只确认旧来源和Run/dispatch，不隐式造binding。重复同init幂等，迟到代次拒绝；删除 unified 旧权威表双写。已改为 failure 的错误处理保留。

**执行验证：**CW2-T09覆盖旧唯一根、多候选/pending、retired/unavailable、重复init和旧代次；断言原ID不变、没有隐式新根、关联记录无半写、相同init不增版本。

### CW3-F04 / P1：Codex 模型解析读取错误配置格式

对应 CW2-F10；第二轮 §8.2、T10。

**代码事实：**[identity.ts:39](C:/Code/system-handle-subagent-viz/packages/adapters/sdk/src/identity.ts:39)只读取 Codex config.json。本仓 installer.ts:123–125、setup.mjs:34 使用 config.toml；本轮也只读核实本机 config.toml 有模型设置而 config.json 不存在。因此正常 native-config 仍缺 canonical_model_id。ProfileRuntime:568–576 仍只传首 workspace 和父 process.env，没有实际 ResolvedCliLaunch/invocation.env；DEVFLOW_RESOLVED_MODEL仍优先于配置。

**修法：**按实际工具格式和已支持优先级读取有限配置字段，Codex使用实际TOML；解析器、身份verifier和运行器共用真实安装入口/有效环境，不用假JSON或DevFlow模型env替代。AGY独立按真实格式解析；账号缺事实明确缺项，不猜。完整repo映射生成workspace身份，原生init可核验字段与冻结值比较。目标分支没有agy-accounts，不拉入主工作区其他任务代码。

**执行验证：**CW2-T10使用实际格式和路径的隔离配置，经真实ProfileRuntime入口验证；至少包括TOML仅有真实配置、profile覆盖/CLI home不同、账号未知、第二仓库变化。只给resolver写一个假config.json不能证明生产路径正确；真实工具能力仍按旧L项执行。

### CW3-F05 / P1：重复停止把已确认退出改成永久 STOPPING

对应 CW2-F11；第二轮 §7.6、T11。

**代码事实：**[server.ts:1496](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:1496)先 pauseActiveTree→conversation-control:375→runtime:1482→ProcessManager.stop，已等待退出并从Map删除。随后Engine.stop在[engine.ts:2158](C:/Code/system-handle-subagent-viz/packages/core/src/engine.ts:2158)再次pause，再2162 runtime.stop；第二次Map空返回unknown，Engine留STOPPING并写unknown。直接Engine.stop也有先停树再停根的重复调用；逐child循环仍存在。

**修法：**停止只由一个以根 dispatch/request 为幂等身份的服务发出一次；API、Engine、conversation-control消费同一持久StopResult。重复请求返回既有可信退出事实，不因Map清空降级unknown。删除逐child补停/STOP_ROUNDS式重复控制，子Agent只观测。未确认的根保持未知；不得反向用“Map空”推断未启动。

**执行验证：**CW2-T11从实际HTTP /stop及直接Engine.stop各进入一次；根stop次数=1，已退出最终STOPPED，重复请求仍相同确认；真正unknown仍STOPPING，子Agent没有独立控制调用。覆盖服务重启后读取停止回执。

### CW3-F06 / P1：控制 CAS 和明确恢复仍在入口丢失

对应 CW2-F12；第二轮 §3.2、§7.7–7.9、T12。

**代码事实：**[server.ts:569](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:569)仅解析enabled/reason，静默丢弃页面request_id/expected_control_revision；add/removeControlReason仍read+put。[recovery.ts:224](C:/Code/system-handle-subagent-viz/packages/runtime/src/recovery.ts:224)无来源/版本地解除workflow_pause，quota路径88行也调同一函数。retryReview仍只排队；manual_handoff/migration没有完整合法解除入口。解除原因与阶段转换/入队分离。

**修法：**严格解析并传递完整控制DTO，幂等查询先于首次版本检查；在同一控制互斥/事务内CAS原因、业务阶段和唯一入队。明确恢复输入来源、request、预期workflow/Run/control/会话版本及必要migration_id；自动恢复从类型和入口禁止解除用户原因。retryReview/feedback/交回/迁移继续接同一服务，只解除本动作负责原因，保留其他停用；未知根和未完成迁移不得继续。

**执行验证：**CW2-T12增加迟到开启覆盖较新停用、同请求重放、原因已解除但路由失败、自动quota恢复、review重试、迁移完成后明确继续。每种成功只入队一次；版本冲突和失败全不写。

## 3. 项目资产、路径及材料

### CW3-F07 / P1：迁移 resume 跳过阶段，rollback缺少当前事实和任务归属

对应 CW2-F01/F02；第二轮 §5.3、T01/T02/T03。

**代码事实：**[project-asset-migration.ts:594](C:/Code/system-handle-subagent-viz/packages/core/src/project-asset-migration.ts:594)–623不按原阶段恢复，从prepared/部分copy直接move并标verified/committed，未补备份/材料或核验Git/CLI；目标已存在也可能跳过move后改root。rollback:636–674只看较新Run，未查真实写者及用户文件/index/HEAD。API:480–495解析URL workflow后不传服务，A路由带B migration/request可操作B。

**修法：**apply/resume共用一套阶段推进器，严格按持久意图和实际文件/Git/CLI事实补步骤；任何不一致进入needs_reconcile，不能直接赋终态。服务输入并检查workflow/workspace/migration归属、操作版本和完整请求hash；rollback使用独立幂等请求、重新预览并核验操作后无新使用/变化。恢复不是“尽量move后改库”。

**执行验证：**CW2-T01/T02在每个阶段及每文件发布前后中断恢复；缺任一文件不得完成。旧根缺失/目标抢占不得改root；A路由引用B拒绝且双方不动。用户原CLI修改后回退拒绝；同请求丢回执返回原结果。

### CW3-F08 / P1：修正复制位置后会覆盖旧树已有原件

对应 CW2-F02；第二轮 §5.1/5.2、T02。

**代码事实：**预览只查新target的final_destination，实际[project-asset-migration.ts:467](C:/Code/system-handle-subagent-viz/packages/core/src/project-asset-migration.ts:467)–480写旧树copyDest。旧树已有同相对路径用户文件、新target不存在时，预览通过后writeFileSync直接覆盖，无需并发。

**修法：**清单同时冻结copy_destination和final_destination并预检两端；逐文件持久意图、自有temp、flush及hash/字节数校验后原子no-replace发布。相同字节复用不取得删除权，异内容冲突保留；禁止普通writeFileSync/可覆盖rename充当独占发布。

**执行验证：**CW2-T02增加旧树预先存在异内容、预览后抢写、同字节复用、发布已完成但未记账；所有异内容原字节保持不变。

### CW3-F09 / P1：数据库备份未隔离，失败又降级为不一致主文件复制

对应 CW2-F02/F06；第二轮 §5.2，旧D02/D12。

**代码事实：**[project-asset-migration.ts:421](C:/Code/system-handle-subagent-viz/packages/core/src/project-asset-migration.ts:421)–434把store.db写source/docs，未先登记精确Git exclude和备份排除；backupRoots无生产提供者。Git snapshot[git.ts:250](C:/Code/system-handle-subagent-viz/packages/git/src/git.ts:250)的untracked扫描可收集它，附件路径也未排除，其他任务数据可能成为普通项目输入。backup失败直接复制活动SQLite主文件，忽略WAL；只验manifest便标backed_up，用户文件/index仍未实际备份。

**修法：**先建立持久备份登记、精确实际Git exclude及受限读/附件/提交规则，再执行SQLite一致性backup和旧计划要求的文件/index保全。任何备份失败停留原阶段，删掉主文件复制兜底；逐项hash/字节数确认后才能backed_up。不得整库还原覆盖其他任务。

**执行验证：**CW2-T02/T06覆盖WAL有已提交数据、backup抛错、二进制/ignored/index保全、重启后snapshot/search/附件/提交仍排除精确备份子树；普通docs/process内容仍可正常读取。

### CW3-F10 / P1：资产 apply 仍无最终 CAS、精确选择及绑定迁移

对应 CW2-F02；第二轮 §3.2、§5.1–5.3。

**代码事实：**[project-asset-migration.ts:542](C:/Code/system-handle-subagent-viz/packages/core/src/project-asset-migration.ts:542)事务仅put root；预期版本来自JSON `.version??1`，新增Store版本接口未使用。backup await期间其他版本改变仍覆盖。占用漏prepared/needs_reconcile及旧进程，未做原CLI cwd核验；绑定/owner/材料引用不更新。selected_material_ids=[]变全部，duplicate不拒绝；同request异正文直接返回旧记录。

**修法：**严格DTO、精确选择和规范请求hash；通过唯一占用/控制服务冻结真实`entities.version`。prepared要始终登记migration原因（包括之前无control记录），不覆盖其他原因。提交前核验所有冻结版本、源/Git/材料/原精确会话cwd，事务CAS Workspace、绑定及索引和当前材料引用。历史Run/cwd保持原事实，附迁移映射。

**执行验证：**CW2-T01/T02增加backup等待期间修改workspace/control/binding、空选择/重复选择、异正文同request、没有control记录；验证不覆盖、不多迁、未知不完成，移动后原session ID及当前引用正确。

### CW3-F11 / P1：“安全发布”未传 expectedHash 时仍覆盖正文

对应 CW2-F04；第二轮 §6.1/6.3、T04。

**代码事实：**[project-materials.ts:149](C:/Code/system-handle-subagent-viz/packages/core/src/project-materials.ts:149)–171，expectedHash未传且正文不同就atomicWrite；Engine规划/整改正好不传。新发布也不是no-replace；材料ID与审核/整改默认文件只含kind/revision，多个Run可互相覆盖。

**修法：**既有异内容默认冲突；只有明确更新意图且expected hash匹配才能改，否则独立版本保存。新文件独占发布。材料键和文件名包含真实Run/round/revision，保留既有用户原件及其路径，不能用“安全”函数名替代限制。

**执行验证：**CW2-T04从真实规划/整改handler进入，预先放异内容文件、同revision重试、同round不同Run及发布抢写；原件不变，各版完整可读。

### CW3-F12 / P2：locator仍猜路径，材料outbox和完整reader链缺失

对应 CW2-F04；第二轮 §6、T04。

**代码事实：**[project-materials.ts:82](C:/Code/system-handle-subagent-viz/packages/core/src/project-materials.ts:82)不读Project.primary_repo_id/material_paths，按不存在的标志、main/primary名称和首项猜根。Engine:2615–2635先写文件后提交业务，没有material-write outbox或恢复消费者；pending不会自动补。两道审核未接统一发布，reader重新算默认路径；plan-review:78的旧缓存回退未检查“确无material”，已发布原件丢失也回退。报告读首workspace拼路径仍会取错仓库。

**修法：**按用户原件引用、Project配置和明确primary解析并持久locator；完整业务结果、正文引用、locator和材料outbox同事务，恢复只补写不重走业务。所有计划/review/repair/report/导出reader消费该locator；严格区分result_pending、原件冲突/缺失与历史无locator兼容。不能用缓存掩盖已发布原件丢失。

**执行验证：**CW2-T04覆盖第二仓库primary、自定义路径、两道审核和报告、业务事务后发布前崩溃、重启补写、原件丢失/变化、平台缓存移走；断言精确来源且不重发模型。

### CW3-F13 / P2：多仓库预览和创建仍使用不同项目决策

对应 CW2-F05；第二轮 §4.1–4.3、T05。

**代码事实：**[server.ts:287](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:287)可预览多repo真实Project；[create-workflow.ts:157](C:/Code/system-handle-subagent-viz/packages/core/src/create-workflow.ts:157)仅承认单repo，否则新造main项目并丢配置。预览仍允许客户端project_configured_path兜底，创建不同；缺预览摘要/配置版本与冻结意图贯通。MCP/旧GitManager/页面没有全接线，source resolver仍取Git首条。

**修法：**落实第二轮指定的唯一创建意图服务；全入口解析真实Project/repo/source/current，消费同一冻结目标和分支。配置只服务端读取；首次核对预览，已有意图按冻结值恢复。不要继续给每个handler分别补默认值。

**执行验证：**CW2-T05用真实多repo Project通过HTTP/MCP/旧入口，预览与创建逐字段相等；配置改变分首次意图前/后处理；不得意外新造main项目或第二worktree。

### CW3-F14 / P2：扫描参数未获得跨任务真实登记上下文

对应 CW2-F06；第二轮 §4.4–4.5、T06。

**代码事实：**[current-delivery.ts:146](C:/Code/system-handle-subagent-viz/packages/evidence/src/current-delivery.ts:146)和observer仅传当前任务workspaces，来源根其他任务子树不在其中；fingerprint.ts:71只信Store路径不核Git。旧登记变成普通目录后可能误排真实代码，search/snapshot及备份未共用上下文。source-change成对参数不一致这个旧症状已经修好。

**修法：**用全局已确认Workspace映射结合实际Git登记/common-dir建立冻结ScanContext；所有扫描、搜索、snapshot、observer、delivery显式消费；当前扫描根不排除，失效登记不排普通代码，备份独立持久登记，重启保持。

**执行验证：**CW2-T06增加另一个workflow在同source下的非默认名称worktree、失效登记普通目录、当前根、重启和备份；子树变化不误报，主代码变化不漏报。

### CW3-F15 / P1：清理预览存在，但删除不校验用户批准摘要

对应 CW2-F07；第二轮 §4.6–4.7、T07。

**代码事实：**[delivery-coordinator.ts:645](C:/Code/system-handle-subagent-viz/packages/git/src/delivery-coordinator.ts:645)接受preview参数却不比较；[server.ts:801](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:801)允许字符串ID再补当前root/branch，版本可省。占用漏未知旧进程，材料摘要只是目录名，ignored唯一原件未保全核验后即可能remove。默认模板仍含cleanup，历史reconcile仅从cleanup/retry调用。

**修法：**删除旧字符串删除选择的可写兼容，强制精确workspace/path/branch/版本/内容材料摘要；执行前重新核验预览与唯一occupancy、保全事实。只删本次明确集合，不force。默认模板不自动cleanup，历史完成恢复接服务启动且保留树。

**执行验证：**CW2-T07经真实API提交过期摘要、改path/branch/index、unknown、唯一ignored原件、部分repo选择；拒绝时无删除，正常整合/旧重试/恢复仍不自动删。

## 4. 接入、历史绑定修复和命令入口

### CW3-F16 / P1：adopt严格外形之下仍写假身份，并可引用其他任务workspace

对应 CW2-F13；第二轮 §9.1、§3.2、T13。

**代码事实：**[execution-session-store.ts:222](C:/Code/system-handle-subagent-viz/packages/core/src/execution-session-store.ts:222)全局取workspace不验workflow；229–236仍补agy/local/default。唯一生产调用server:431没传可信options或调verifier，profile/expected workflow/control不消费，随意ID可bound。相关版本/owner读取在事务外；成功幂等重放还先被API当前占用门禁阻挡。

**修法：**外部DTO→服务端归属及精确原生核验→不可默认化内部命令→共同控制锁和事务重读版本/owner/writer→写入与幂等回执，必须整链接通。尚未绑定槽或同根确认才可adopt，不偷换根/cwd。保留已经收紧的DTO和revision0拒绝。

**执行验证：**CW2-T13正常最小DTO、任意不存在ID、跨任务workspace、陈旧workflow/control、两个任务争根、同request在后续状态变化后重放；失败不生成半个绑定/索引。

### CW3-F17 / P1：repair仍用最后Run和固定账号猜历史身份

对应 CW2-F14；第二轮 §9.2.1–9.2.3、T14。

**代码事实：**[session-binding-repair.ts:193](C:/Code/system-handle-subagent-viz/packages/core/src/session-binding-repair.ts:193)–208用旧值或最后Run推工具/模型，目录名猜域、固定account，凭ID/cwd/非default模型标verified。333–340的摘要不含模型/账号及来源实体版本，旧来源身份改变可保留同digest。

**修法：**每条旧来源关联其自己的冻结Run/profile及可核验原生事实，禁止最后Run代替历史来源、目录猜身份和固定account。未知不可apply；完整身份去重并保存全部来源引用；digest纳入相关实体真实版本及核验摘要。

**执行验证：**CW2-T14建立两工具/两账号/多Run历史，候选不串；仅修改旧模型/账号/来源版本也使preview过期；无证据单候选仍不可应用，成功保留真实cwd。

### CW3-F18 / P1：repair独立占用算法遗漏未知写者和事务内复核

对应 CW2-F15；第二轮 §3.2.6、§9.2.5/9.3.2、T15。

**代码事实：**[session-binding-repair.ts:127](C:/Code/system-handle-subagent-viz/packages/core/src/session-binding-repair.ts:127)只识别starting/running/stopping，漏prepared/needs_reconcile和旧process_record而默认idle。apply前检查与435行事务分离；rollback没有实际writer/expected control检查。新严格repair schema仅定义，HTTP未parse，缺版本仍走undefined分支。

**修法：**注入唯一实际occupancy/控制服务，所有未知状态阻止修改；共享严格schema真正用于HTTP/MCP/CLI，删除必填版本的default0/optional。控制锁及事务内重验digest、所有版本、owner、writer和选择后一次提交，不能用transaction外壳代替CAS。

**执行验证：**CW2-T15用prepared/needs_reconcile/旧Host未知且Run已结束场景，缺版本、预览后状态变动均拒绝；任一中途写失败全回滚。

### CW3-F19 / P1：绑定 rollback 会复用旧CAS版本且缺完整索引/幂等

对应 CW2-F15；第二轮 §9.3、T15。

**代码事实：**[session-binding-repair.ts:658](C:/Code/system-handle-subagent-viz/packages/core/src/session-binding-repair.ts:658)写prev.revision+1，apply已写同值：A r3→B r4→回退A仍r4，旧CAS重新有效。patch无完整应用后版本/索引；恢复旧绑定不撤新owner，原不存在则删历史版本。只验请求当前revision，不能证明没新修改；重复request返回ALREADY_ROLLED_BACK，没有幂等回执。

**修法：**patch保存完整前后业务关系、应用后真实版本及使用基线。锁内核验未被后续Run/dispatch使用或改动；回退版本严格大于当前值，原子恢复owner/by-id/策略/pending并保留撤销历史，结果同事务幂等保存。不能用请求者最新revision授权覆盖patch之后改动。

**执行验证：**CW2-T15断言A r3→B r4→A r5或更高；旧CAS失效；所有索引精确恢复，后续修改/使用阻止，丢回执同request重放同结果且不再增版本。

### CW3-F20 / P2：两个脚本仍把 API 地址当 human_origin

对应 CW2-F03/F16；第二轮 §3.2.5/9.4、T03/T16。

**代码事实：**[migrate-cli-session-bindings.ts:115](C:/Code/system-handle-subagent-viz/scripts/migrate-cli-session-bindings.ts:115)及资产脚本:115–120直接Origin=apiBase；默认human_origin为localhost而合法请求地址可为127.0.0.1，相同URL尾斜杠也不等于origin，写请求仍403。只读预览已修，不重复要求改回Store。

**修法：**共享控制台客户端从所选本机服务的可信配置读精确human_origin，规范化传输地址和允许Host；使用JSON、不带Authorization、不关闭现有CSRF；禁止用模型token或新增登录绕过。

**执行验证：**CW2-T03/T16实际脚本访问默认localhost、允许的127.0.0.1和尾斜杠形式均按同服务配置工作；非法Host/Origin/模型Authorization拒绝且不改DB。

### CW3-F21 / P2：资产 CLI 预览与服务使用不同 storage_root，MCP/UI未贯通

对应 CW2-F03；第二轮 §3.1/5.1、T03。

**代码事实：**[migrate-project-assets.ts:75](C:/Code/system-handle-subagent-viz/scripts/migrate-project-assets.ts:75)构造core不传真实storage_root，扫描脚本cwd下默认.devflow；API则用engine.config.storage_root。自定义数据目录时inventory/digest不同。生产MCP和现有页面没有完整资产迁移入口。

**修法：**preview从明确所选服务配置读取同一storage_root及只读DB，不从cwd猜；HTTP/MCP/UI都调用同core和同DTO。页面在已有工作区/资料位置接精确preview/选择/apply/resume/rollback，不新建管理平台、不离线改库。

**执行验证：**CW2-T03及E03用自定义数据目录、不同启动cwd，CLI/API/MCP预览清单和digest一致；页面实际选择能完成同一操作及恢复。

## 5. 手动续接和页面状态

### CW3-F22 / P2：resume API不传真实状态和启动描述，生成器默认放行

对应 CW2-F18；第二轮 §10.1–10.3、T18。

**代码事实：**[server.ts:549](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:549)不传bindingState、实际executable/home/env；生成器:123默认bound，143/151回退PATH。retired/unavailable真实GET仍可生成，非PATH或独立配置域启动错误；未完成迁移也未识别。env清理/父shell保留已修。

**修法：**生成器必须接收已核验bound binding、ResolvedCliLaunch和当前控制/迁移/占用；删除状态/安装/idle的猜测默认值。解析独立exe或Node+原工具脚本，配置域不可复现无copy_script；只有已完成安全迁移及可用cwd才允许生成。

**执行验证：**CW2-T18从真实GET调用覆盖retired/unavailable、非PATH、CLI home变化和未完成迁移；不只是直接向生成器手填正确参数。保留env/argv/父shell及真实TUI回归。

### CW3-F23 / P2：调度变化期间仍能复制旧的合格脚本

对应 CW2-F17/F19的剩余快照生命周期；第二轮 §10.6–10.8、T17/T19。

**代码事实：**[CliSessionDetails.tsx:238](C:/Code/system-handle-subagent-viz/apps/web/src/components/CliSessionDetails.tsx:238)开始恢复调度不清resumeInfo，627按钮及285handler只看旧copy_script；服务端已开启而响应在途仍可复制。组件也未接占用/绑定事件，因此外部状态变化不使可执行快照失效。这不是已经删除的command_line兜底。

**修法：**mutation开始立即清脚本；渲染、disabled、handler共用当前身份/revision/状态/busy的eligibility。接入现有占用/绑定事件失效并重取，查询失败禁用旧可执行内容；不增加常驻模型监督或新轮询平台。

**执行验证：**CW2-T19延迟“开启调度”响应，开始请求即clipboard调用为0；外部占用变化、404/409/网络错误使旧脚本不可复制。保留已修A→B generation竞态。

### CW3-F24 / P2：页面回退硬编码workflow版本并发送全任务绑定

对应 CW2-F15/F19；第二轮 §9.3.1/10.7、T15/T19。

**代码事实：**[CliSessionDetails.tsx:421](C:/Code/system-handle-subagent-viz/apps/web/src/components/CliSessionDetails.tsx:421)–437固定expected_workflow_version=1，revisions来自整个任务。服务已检查真实workflow版本和patch精确集合，version>1或只迁部分绑定时页面回退必失败。

**修法：**读取并保留真实版本信封和migration受影响集合，重新获取该patch全部当前revision后展示明确回退，提交仅该集合及真实workflow/control版本。不自动用新版本重放旧确认，也不放宽服务端精确集合要求。

**执行验证：**CW2-T15/T19通过真实页面对version>1任务及部分binding patch回退，正确集合可用，缺项/过期仍拒绝。

### CW3-F25 / P2：已核验但同键歧义的根无法在页面选择

对应 CW2-F14；第二轮 §9.2.4、T14/E06。

**代码事实：**[CliSessionDetails.tsx:755](C:/Code/system-handle-subagent-viz/apps/web/src/components/CliSessionDetails.tsx:755)禁用全部非verified候选，包含ambiguous。两个已核验同键旧根无法由用户明确选一个完成修复。

**修法：**数据合同区分“身份是否核验”与“同键候选是否歧义”，按核验后的键分组单选；未知/conflict仍禁用。服务端继续每键最多一个真实根校验；不能为了能选把未知标verified。

**执行验证：**E06真实页面两个已核验同键根仅能选一个并应用；未知字段/冲突根仍禁用，提交两个根仍被服务拒绝。

### CW3-F26 / P2：服务把首个 bound 冒充当前 Run 绑定

对应 CW2-F19；第二轮 §3.2/10.7、T19。

**代码事实：**[server.ts:396](C:/Code/system-handle-subagent-viz/apps/api/src/server.ts:396)用bindings.find(bound)填current_binding_id。页面新逻辑信任该字段，多模型历史时仍自动选错；只是把首项fallback从组件移到了服务。

**修法：**从当前workflow.run_id对应、归属一致的持久Run/dispatch取实际binding ID；legacy或无已确认当前绑定就不返回current_binding_id。唯一合法绑定的页面便利选择按原合同保留，多个历史绑定不得冒充当前。

**执行验证：**CW2-T19建立A/B两个bound，当前Run为B且列表A在前，GET及页面选B；没有实际当前绑定时字段缺省并保持明确未选。

## 6. 开发、验证和复审交接

沿第二轮分工：A负责F07–F15及F21资产逻辑；B负责F01–F06、F16–F19；C负责F20脚本客户端、F22–F26页面/适配器，并与B完成F04真实配置解析。主执行Agent独占公共contracts、Store、Engine、server和MCP注册的最终写入，其他Agent提供对应修改片段；不得并发改同一公共文件。各组保留原隔离DB、端口、合成Git仓库、临时输出归属，主工作区其他任务文件不改。

先完成正式计划中的全部开发任务，包括功能实现、端到端接线、异常与边界处理及测试代码，再进入单元、集成和 E2E 测试阶段。将独立测试目标分配给多个子 Agent 并行执行，各子 Agent 每条命令只指定一个测试类、文件或用例，并负责相关问题的定位、修复和重跑。某个目标失败不阻塞其他无关目标；不同测试层之间不设固定先后顺序。仅有真实依赖或共享资源冲突的目标需要协调、隔离或局部串行。禁止无筛选的全量命令、全库通配符和一次拼接多个测试目标；受影响回归也按独立目标分派并行，不因局部修改重跑整个套件。

本文每项“执行验证”是在已有CW2-T目标中补反例，文件与旧验证编号保留。每个反例具名并检查实际命中，不接受零用例；通过实际生产handler进入，仅在最外层CLI/OS边界使用可控fixture，真实Git用合成仓库。已有单元、集成、E2E、L01–L05及受影响旧回归仍按原计划定向执行，不能删除原用例来绕开回归，也不能用fixture替代真实工具能力。

运行命令沿第二轮§11.4：一次只指定一个文件或一个具名场景；主执行Agent整合后按原合同做typecheck/build，Host有变化才加对应构建。代码问题定向修复重跑；网络、账号、额度、工具不支持单独如实记录，其他独立目标继续。禁止读写真实任务DB、对用户worktree试迁移/清理、把备份或凭据写报告/提交。

执行回执汇总实际改动与验证情况；复审仍按三域只读检查代码，不重跑产品测试、不审计报告真假。原范围内整改不再增审批步骤；如果代码仍有缺陷，不提交合并。最终有条件提交仍须白名单保留主工作区与实现worktree现场，不附带删除树或材料。

## 7. 本轮归因与记录

本轮已出现真实改善，不能重复上一轮“全无生产接线”的结论。但实现仍常在新增函数/字段后保留不同入口的旧行为：占用算法各写一份、状态和版本传不到服务、恢复另写一条简化路径、正确生成器依赖调用方未提供的参数。

新回归尤其体现了整体生命周期未串联：本轮Run先标running再被自己拦截；第一次stop确认退出后第二次stop改unknown；copy改旧树却未把冲突检查同步到旧树；新增resume未复用阶段推进。这些都有当前代码依据，不推测执行模型读没读计划或是否测试。

本补充不重新复制完整设计，修法固定复用第二轮已经规定的唯一入口、真实事实、版本事务和最终读者合同。下一轮应按这些实际调用关系关闭问题，不能仅凭函数名、注释、增加了transaction或旧反例不再命中判断整项完成。

本轮只新增本文，产品源码、运行状态、Git提交和合并均未修改。
