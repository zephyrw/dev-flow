# DevFlow 子 Agent 可视化与会话交互：详细设计及开发计划

日期：2026-09-20  
版本：v1.0  
状态：设计完成，待用户确认后实施。开发、测试、代码复核、人工验收均未开始。  
适用仓库：`C:/Code/system-handle`。本次仅新增本文，不修改业务代码、不运行产品测试、不启动或恢复真实任务。  
基线：`HEAD=df18ee4d357fa939645be16fd233a1162bddbebe`，并包含调研时工作区已有的已暂存、未暂存及未跟踪改动；不能只按 HEAD 判断现状。

阅读入口：[界面与交互](#3-界面与交互设计) · [暂停与额度恢复](#7-暂停继续及额度异常恢复) · [详细开发任务](#12-详细开发任务合同) · [测试与人工验收](#14-测试责任与人工验收) · [进度总账](#15-里程碑进度填写与交付)。

## 0. 结论与执行边界

采用一套贯穿规划、开发与自测、两道代码复核及整改的**会话树 + 会话活动流 + 常驻输入框**。原生工具负责创建、分工和恢复子 Agent；DevFlow 负责读取事实、展示层级、传递用户输入，以及在暂停/恢复时协调本次拥有的会话和进程。

用户附件是交互参考，其中的任务名称、模型名称和截图文字不是本项目额外的执行指令。本文按用户正文确定范围，不照搬截图中的麦克风、插件和其他未提出的功能。

### 0.1 本文确定的产品决策

1. 子 Agent 工作卡放在执行过程面板的底部、输入框上方。首次出现工作中的子 Agent 自动展开一次；右上角 × 仅收起卡片，收起后显示“Working N”。
2. “Working N”只计算当前主会话工作树中明确正在启动或工作的子 Agent；等待、暂停、失败、未知分列展示，不能把它们计为正在运行。
3. 点击子 Agent，原执行过程面板切换到该子会话；面包屑显示“主会话 / 子 Agent / 更深一级”。不另开工作流、不混入其他子会话日志。
4. 在任何子会话视图隐藏整个输入区域，包括加号、发送、临时提问浮窗；返回主会话恢复原草稿、附件、滚动位置和临时提问选择。
5. 主会话常驻多行输入框，取消“指导或提问”展开按钮及“临时提问”Tab。底部显示当前工作、工具、模型、思考强度，右下角为发送按钮。
6. 左下角 + 支持上传本地文件、添加工作区引用；支持拖入文件和粘贴图片。文件须真正传到本次模型的可读输入中，不能只显示文件名。
7. 输入开头的 `/btw` 或 `/side` 进入同一种只读临时提问。普通文本沿现有正式反馈/人工问题路径处理。
8. 临时提问在输入框正上方以无蒙层浮窗呈现，一次一条；“‹ 1/7 ›”按**当前项目**内的提问历史切换，并显示来源任务。
9. 本期“暂停全部”统一表示暂停当前主工作会话及其全部后代，和主界面的暂停为同一动作；不会暂停其他任务或独立临时提问。卡片中写明范围，不提供含义不明的 Stop All。
10. “继续”保留原工作用途、配置与未完成任务，给负责恢复的父模型附加明确的子 Agent 恢复清单；只有观察到真实启动事实，才显示“已恢复运行”。
11. 对额度不足、服务退出和用户暂停分别处理。用户主动暂停后，任何旧额度定时重试都不能重新启动该树。
12. 八种适配器都纳入能力合同和实施清单；原生能力不足必须明确展示具体限制。不能因网页做完就宣布八种工具全部支持，也不能虚构不存在的原生接口。

### 0.2 与既有设计的关系

- 继续保持“平台做调度和展示”的边界：不新增开发审批阶段、测试证明门禁、质量计数规则、监工模型或长期驻留的额外 Agent。
- 本文的会话观察记录不作为业务完成、代码质量通过或人工验收通过的依据。观察失败不拦住已有正常业务完成路径。
- 暂停后阻止重复执行，仅依据旧会话/进程是否仍可能工作，这是资源控制；不得扩张成材料、测试报告或覆盖率检查。
- [模型配置与运行中切换计划](./DevFlow模型配置与运行中切换详细实施计划-20260918.md)在调研时仍是计划文件。本文不假设其中的新模型目录、effort 配置、角色覆盖已经实现。
- 本次实现“准确显示当前模型和强度”及打开现有工具配置入口；完整模型配置能力按上述计划交付。若其已合入，则直接复用；若未合入，缺失值明确显示“未报告”，不能为了显示一行信息先实施整份模型配置计划。
- [执行会话隔离与恢复计划](./DevFlow执行会话隔离与恢复机制整改计划-20260917.md)中的原会话、purpose、continuation 保留原则延续。本文补足子会话树的身份、暂停与恢复。
- 不新增替代实施文档。执行模型直接按本文实施，禁止另建 `implementation_plan.md` 等实施计划；进度清单只引用本文编号，不改变范围、算法、接口、顺序和验收。

## 1. 需求追踪

| 需求 | 用户可见结果 | 设计章节 | 开发任务 | 主要验收 |
|---|---|---|---|---|
| SA-R01 | 规划、开发测试、复核均可显示子 Agent | 4、5 | D01–D08、D23 | U01、I01–I04、E01 |
| SA-R02 | 工作卡列出名称、当前工作和状态 | 3.1、4.3 | D02、D03、D16 | U02、E02 |
| SA-R03 | × 收起，Working N 展开，数量准确 | 3.1 | D16 | U02、E03 |
| SA-R04 | 点击子 Agent 查看专属执行过程 | 3.2、6 | D03、D15、D17 | I05、E04 |
| SA-R05 | 层级面包屑返回，子视图隐藏输入框 | 3.2 | D17、D18 | U03、E05 |
| SA-R06 | 常驻输入框、工作/模型/强度、发送按钮 | 3.3、8 | D18、D19 | U04、E06–E07 |
| SA-R07 | + 上传、拖放、粘贴图片、工作区引用 | 9 | D11–D13、D19 | I14–I17、E08–E10 |
| SA-R08 | 暂停/继续覆盖完整子树 | 7.1–7.3 | D09、D10 | I06–I09、E11–E12 |
| SA-R09 | 额度恢复时提醒负责人恢复异常子 Agent | 7.4–7.6 | D10、D23 | I10–I13、E13 |
| SA-R10 | 取消临时提问 Tab，支持 /btw 与 /side | 3.4、8.1 | D14、D18、D20 | U05、I18、E14 |
| SA-R11 | 提问浮窗位于输入框上方、无蒙层 | 3.4 | D20 | E15 |
| SA-R12 | 当前项目历史单条呈现及 1/N 左右切换 | 3.4、10 | D14、D20 | I19、E16–E17 |
| SA-R13 | 临时提问不干扰主执行，可取消/转正式反馈 | 8.2、10 | D14、D20、D21 | I20、E18–E19 |
| SA-R14 | 刷新、重连、切任务后状态可信，不串流 | 4、6、11 | D02、D03、D15、D17 | U06–U09、I21、E20–E21 |
| SA-R15 | 旧任务、原审批/反馈/质量/交付行为兼容 | 11、13 | D21、D24 | I22–I24、E22–E24 |
| SA-R16 | 一个文件包含方案、细任务和可更新进度 | 12–15 | D24 | H12 |

表中的任务、测试和人工验收简写均统一加前缀 `SA-`，例如 D01 指 `SA-D01`，E01 指 `SA-E01`。

## 2. 当前代码核查结果

以下事实来自本次读取的工作树，不把旧方案当作实现结果。

| 基线 | 位置 | 现状与本次影响 |
|---|---|---|
| B01 | `apps/web/src/interactions.tsx`，`TaskInteraction / GuidanceComposer` | 默认先显示“指导或提问”；打开后使用 feedback/aside 单选 Tab。发送成功会收起。需改为常驻 composer。 |
| B02 | `apps/web/src/components/AsideHistoryDialog.tsx` | `modal-backdrop`、`aria-modal=true`，逆序一次展示全部记录。需改为锚定浮窗和单条分页。 |
| B03 | `apps/web/src/execution-panel.tsx` | 只有一个 entries 流及 interaction 插槽，没有 conversation 选择；滚动跟随状态只属于整个面板。 |
| B04 | `apps/web/src/main.tsx` | 用工作流事件生成日志，WebSocket + catchup 已存在；不能为每个子 Agent 再建立独立轮询连接。 |
| B05 | `packages/contracts/src/run-observation.ts` | 只有 run/conversation 和当前活动；没有父子身份、运行尝试、子状态。 |
| B06 | `packages/runtime/src/run-telemetry.ts`、`agent-telemetry.ts` | 聚合键以 item ID 或 step index 为主。同一 Run 多个子会话若复用这些 ID，会覆盖活动；原始 session 字段也可能错误覆盖主会话 ID。 |
| B07 | `packages/runtime/src/profile-runtime.ts`，`invoke` | 当前把收到的 session/thread 字段当作主会话身份；多会话事件接入前必须先分流，再做根会话续接校验。 |
| B08 | `packages/runtime/src/codex-session-observer.ts` | 精确读取一个 Codex 会话，当前只提取 model/effort/quota。可复用有限读取和归属验证，不可扫描账户所有日志。 |
| B09 | `packages/adapters/sdk/src/interface.ts` | 能力合同没有子会话发现、活动、暂停、恢复、文件输入能力。八种适配器多数复用 base-adapter。 |
| B10 | `packages/adapters/sdk/src/invocation.ts` | Grok 带 `--no-subagents`；Claude 只读用途只允许 Read/Glob/Grep 并禁止 Agent；Qoder 只允许三种读工具，OpenCode 只读 agent 默认拒绝其他工具。必须调整委派权限且保留只读边界。 |
| B11 | `packages/core/src/engine.ts`，`stop`；`packages/runtime/src/runtime.ts`，`stop` | 停止入口围绕 w.run_id 和受管进程。没有独立原生会话/后台子 Agent 清单，不能据此断言所有后代退出。 |
| B12 | `packages/runtime/src/recovery.ts`、`packages/core/src/model-retry.ts` | 已有预计额度恢复与原任务续接；没有子 Agent 恢复清单。`resumeApproved` 的计划批准检查也需区分尚在规划的恢复。 |
| B13 | `packages/contracts/src/feedback.ts`、`RequirementComposer.tsx` | refs 是工作区文件/目录引用，不是本地文件上传；当前输入框要求正文非空。 |
| B14 | `apps/api/src/server.ts` | 现有 asides 按 workflow 查询，默认返回最早 50 条；无项目聚合及真正文件上传 API。全局 bodyLimit 为 8 MiB。 |
| B15 | `packages/asides/src/service.ts` | 保留全局最多 1 个 active、每任务最多 3 个 queued、10 分钟过期等既有规则；本次不借分页改动扩大并发。 |
| B16 | `packages/store/src/store.ts`、`migrations/index.ts` | SQLite entities/events/dedup/outbox 已能承载新增数据。迁移实际执行的是 index.ts 内注册 SQL，不能只增加孤立 .sql 文件。 |
| B17 | `playwright.config.ts`、`tests/e2e/fixture-server.ts`、`native-helper.ts` | 固定端口 14811、固定 .cache/e2e-state.json 和报告路径；直接启动多个测试进程会冲突，须先参数化隔离。 |
| B18 | `packages/presentation/src/run-observation.ts`、`CurrentRuntime.tsx` | 已区分 requested 与 actual model，可以复用；不能把父模型、配置模型当成子 Agent 实际模型。 |

调研未启动八种工具的付费模型调用，也未验证本机八种客户端当前版本的全部子 Agent 协议；原生文档核查仅用于确定接入方向，实施必须有对应版本的脱敏事件样本和可重复验证。缺少本机凭据时记录真实能力阻塞，不能把 fixture 通过写成真实客户端通过。

## 3. 界面与交互设计

### 3.1 主会话、工作卡和收起态

~~~text
┌ 执行过程 ──────────────────────────────────────── 收起 ┐
│ 项目需求实现                                         │
│ 当前主会话的公开消息、工具动作、结果                   │
│ ……（日志区域独立滚动）                               │
├──────────────────────────────────────────────────────┤
│ Working 4                       暂停全部          ×  │
│ ◌ 核心接口闭环        正在运行指定测试文件             │
│ ◌ 附件接线            修复附件读取状态                 │
│ ◌ 暂停恢复            核对已停止的子会话               │
│ ◌ 代码复核            检查会话归属                     │
├──────────────────────────────────────────────────────┤
│ [临时提问浮窗：仅打开时出现，始终锚定输入框上方]       │
├──────────────────────────────────────────────────────┤
│ [图片预览 ×] [设计说明.pdf ×]                         │
│ 输入指导，或输入 /btw、/side 临时提问……                │
│                                                      │
│ +  开发与自测 · 正在修复附件     Codex · 模型 · 极高 ↑ │
└──────────────────────────────────────────────────────┘

收起工作卡后：
[◌ Working 4] [等待 1] [异常 1]                         [暂停]
[输入框继续常驻]
~~~

布局规则：

- 工作卡属于 execution-sidebar 的 footer，不插进不断增长的日志里；卡片最大高度 200px，超出内部滚动。
- 首次出现活动子 Agent 自动展开；用户收起后，新活动不强制展开。展开偏好按 workflow + rootConversation 保存于 localStorage。
- 列显示“名称 + 当前工作摘要”；名称优先原生 label/task name，其次委派任务摘要，最后“子 Agent · 短 ID”。不能从工具调用次数伪造 Agent。
- 摘要最多两行，最长保存 500 字，完整公开内容在下钻日志中读取。模型、强度和更新时间在行的次要信息/悬停详情中呈现。
- 多层树在当前列表中压平显示活动后代，附父路径；统计按去重后的 conversation ID，祖先等待子节点时不重复算作“工作”。
- `working_count = starting + running`。`waiting`、`pausing`、`paused`、`failed`、`interrupted`、`unknown` 不计入 N，各有清晰文字。
- stale 是新鲜度，不是完成状态。来源无法确认仍在工作时，计入“状态待确认”，保留最后活动时间；不能显示“Working 0，一切完成”。
- 全部完成时展示“子 Agent · 已完成 N”，保留历史入口，不永久占用展开空间。尚未发现子 Agent 且能力可读时隐藏空卡；能力未知/不可读时显示一句能力说明，不能据此声称没有子 Agent。
- × 的 aria-label 是“收起子 Agent 工作卡”，与面板级“收起执行过程”区分。× 绝不发 stop/cancel 请求。
- “暂停全部”作用域是当前主工作会话及后代；悬停和无障碍名称写出完整范围。子视图仍可通过面板头部执行“暂停主会话及全部子 Agent”，不是暂停所查看的一项。

### 3.2 子会话下钻与面包屑

~~~text
┌ 执行过程 ─────────────────────────────────────── 收起 ┐
│ 需求实现 / 开发测试 / 核心接口测试                     │
│            ↑可点击返回祖先                            │
│ 核心接口测试 · 正在工作 · 工具 / 实际模型 / 思考强度    │
│                                                      │
│ 仅此子 Agent 的公开消息和工具执行过程                  │
│ 可继续点开其下级子 Agent                              │
│ ……                                                   │
│                                                      │
│ 没有输入框、加号、发送按钮或临时提问浮窗               │
└──────────────────────────────────────────────────────┘
~~~

- 面包屑首项是主会话名称，不使用内部 Run ID 作为主标题。中间项可点击；当前项不可点击；长名称单行省略，完整名称可查看。
- 任意深度支持返回祖先；浏览器前进/后退保持一致。URL 使用 `?workflow=<id>&conversation=<id>`，进入时校验其归属，非法或过期选择回到主会话并提示。
- `selectedConversationId` 是查看状态，`activeRootConversationId` 是当前实际运行状态，两者独立。只看历史不能改变执行目标。
- 每个 conversation 单独保存 scrollTop、followLatest、beforeSeq、已读 cursor；返回后不跳回最新、不清空草稿。
- 从主会话进入子会话时，草稿状态存放在上层 store/hook，不能依赖被卸载的 textarea 内部 state。
- 日志标题、连接状态、复制公开文本和历史分页保留；“当前运行信息”局部显示所查看子会话，页面全局工作流状态仍保持主任务。
- 子 Agent 结束后继续显示原日志和最终状态，不自动跳回主会话。重启后新 attempt 追加分隔线；重建的子会话显示“接续自……”。
- 除系统公开的说明、消息、工具活动和结果外，不展示私有推理正文；“思考强度”只是配置/运行元数据。

### 3.3 常驻输入框

- 主视图始终有输入区。任务已结束时输入区显示只读完成说明及现有“新一轮反馈”入口，不能默默复活已结束任务。
- 文本框默认 3 行，高度随内容增长，最大 240px；附件条放在文字上方；圆角、弱边框、与现有主题变量一致。
- Enter 发送、Shift+Enter 换行；中文输入法 composition 期间 Enter 不发送。按钮提交与键盘提交共用同一防重逻辑。
- 右下角 ↑ 永远是发送；暂停/继续另放在工作状态操作位，防止同一按钮因流式更新突然从发送变成停止。
- 文本非空或存在 ready 附件时可发送。文件尚上传中/失败/不被目标工具支持时禁用发送并就地说明；不丢弃附件后继续发送。
- 文件单独发送时使用透明展示的默认请求“请查看本次附件，结合当前任务处理”；临时提问模式下只附文件则仍要求补充问题。
- 发送中保留草稿，收到持久化成功响应才清空；超时/失败保留全部内容。同一 request_id 重试只创建一次消息。
- 普通反馈发送前按钮旁显示“发送后调整当前任务”；运行中通过完整暂停/续接路径处理，发送成功后显示“指导已接收，正在交接”，不虚称模型已经读过。
- 底部左侧是 +；中部显示工作用途及当前公开活动；右侧显示当前工具、模型、思考强度和发送按钮。
- 展示优先级：所查看会话的实际观测 > 本轮冻结请求配置（标“请求”）> “工具默认，实际未报告”。子会话缺数据不继承父值冒充实际值。
- 强度未知显示“思考强度未报告”；无该能力显示“不适用”。禁止按 high 等默认常量填充所有工具。
- 当前未运行则显示“已暂停 · 上次模型……”或“等待规划 · 下一轮配置……”，避免将下一轮配置标成当前正在工作的模型。
- 点击模型信息复用现有 `ToolModelDrawer`。已实现模型切换计划时使用其规范控件；未实现时不伪造可编辑强度下拉。
- 没有模型自行决策的权限切换、自动降档和自动换模型。

### 3.4 临时提问浮窗

~~~text
日志继续滚动和可点击，页面无灰色背景、无遮罩
                              ┌─────────────────────────────┐
                              │ 临时提问 · 来源任务   ‹ 1/7 › ×│
                              │ 问：这个测试为什么需要等待？ │
                              │ 答：……                       │
                              │ [取消本次提问] / [转正式反馈]│
                              └─────────────────────────────┘
                              [常驻输入框                    ]
~~~

- 移除 guidance-mode-tabs，不以 Tab、独立路由页或覆盖整个面板的模态框承载提问。
- 浮窗由 footer 的相对定位容器锚定，`bottom:100%`，间距 8px；宽度跟随输入框，最大高度 `min(360px, 45vh)`，内容内部滚动。
- 使用 `role=dialog`、`aria-modal=false`；不锁 body 滚动、不设置页面 inert、不做焦点圈闭。打开后不抢走正在输入的焦点。
- Esc 或 × 关闭浮窗但不取消回答、不删除历史；取消必须点“取消本次提问”。关闭后保留“临时提问 N”轻量入口。
- 当前项目下按 created_at、id 稳定倒序，最新为 1。新问题提交成功后立刻选中该条；若正在看旧问题，后台新增只提示有新问题，不强制跳转。
- “当前”指选中的提问，可能 queued/active/completed/expired/cancelled；不跳过失败和已取消记录。
- 左右按钮在边界禁用，不循环；总数始终来自服务端，不能把当前页条数当作总数。
- 同项目其他任务的提问显示来源任务名称。只读浏览不切换主任务；取消/转正式反馈操作始终提交到提问原属任务，按钮明确写“转为〈来源任务〉的正式反馈”。
- 项目切换时卸载旧请求并清空选择；任务切换但项目未变时可保留选中问题，同时明显显示其来源。
- 浮窗覆盖区域只拦截自身点击；之外的日志、任务导航和输入框仍可操作。窄屏使用同一非模态卡片，不退回全屏遮罩。
- 进入子会话隐藏浮窗；返回主会话恢复其打开状态。待授权卡片属于主交互区，显示操作来源会话；不能因此在子视图重新出现输入框。

## 4. 架构、身份与状态合同

### 4.1 总体架构

~~~mermaid
flowchart LR
  A["原生工具及已绑定子会话"] --> B["适配器：身份分流与规范事件"]
  B --> C["ConversationObserver：树与活动快照"]
  C --> D["SQLite entities + events"]
  D --> E["同一 WebSocket / catchup"]
  D --> F["树快照与分页活动 API"]
  E --> G["执行过程：主/子视图"]
  F --> G
  H["常驻输入框 + 文件"] --> I["正式反馈 / 独立 aside"]
  J["暂停 / 继续"] --> K["树范围控制 + 恢复清单"]
  K --> A
  I --> A
~~~

结论：D01–D15 建立数据与控制，D16–D21 接界面；现有业务调度继续负责角色切换。SA-I01、SA-I06、SA-E04 验证上述边界。

### 4.2 四层身份，不能混为一个 ID

1. **Workflow**：业务任务，拥有计划、审批、质量流程。
2. **Run**：平台派发的一轮规划、执行、复核或 aside；使用原有 purpose/profile/continuation。
3. **ConversationNode**：一个真实原生主/子会话，跨相容的续接 Run 保持逻辑身份。
4. **ConversationAttempt**：该会话某次实际启动/恢复，绑定具体 run_id 和 generation；父进程退出不等于每个子会话已完成。

拟新增 `packages/contracts/src/conversation.ts`：

~~~ts
type ConversationStatus =
  | "discovered" | "starting" | "running" | "waiting"
  | "pausing" | "paused" | "completed" | "failed"
  | "interrupted" | "cancelled" | "unknown";

interface ConversationNode {
  id: string;                         // DevFlow 生成，不能只用名称
  project_id: string;
  workflow_id: string;
  root_id: string;
  parent_id?: string;
  kind: "main" | "subagent" | "aside";
  adapter_id: string;
  native_session_id?: string;
  native_agent_id?: string;
  native_parent_session_id?: string;
  spawn_call_id?: string;
  title: string;
  task_summary?: string;
  purpose: string;
  lineage_id: string;                  // 本轮主工作链，不串上一轮复核
  current_attempt_id?: string;
  replaces_conversation_id?: string;
  created_at: string;
  updated_at: string;
}

interface ConversationAttempt {
  id: string;
  conversation_id: string;
  root_id: string;
  workflow_id: string;
  run_id: string;
  generation: number;
  status: ConversationStatus;
  reason?: "user_pause" | "quota" | "process_exit" | "parent_exit"
    | "service_restart" | "permission" | "native_error" | "unknown";
  requested_model?: string;
  actual_model?: string;
  requested_effort?: string;
  actual_effort?: string;
  model_source?: "native_event" | "native_session";
  activity_summary?: string;
  observed_at: string;
  activity_at?: string;
  terminal_at?: string;
  source_cursor?: string;
  freshness: "fresh" | "stale" | "unavailable";
  stop_confirmation?: "native" | "owned_process_tree" | "unconfirmed";
  recovery_id?: string;
}
~~~

补充约束：

- Node 的原生身份唯一范围是 adapter + 本地工具配置作用域 + workflow + lineage + native_session/native_agent；不同任务同名、不同客户端相同 ID 都不能合并。
- 原生恢复明确续同一 ID时增加 attempt；无法原生续接而重建时新建 node，填 replaces_conversation_id，不覆盖旧历史。
- 暂时只有 spawn_call_id 时创建 discovered 节点，原生返回子 ID 后补齐绑定，不另加一行。
- 嵌套父子关系只能来自原生结构事实或经过校验的委派调用/返回关联；不从普通文本“我启动了 3 个 Agent”推断。
- 父节点尚未到达时短暂挂到该根的“关系待补全”，记 pending-parent；父信息到达后补齐。不同根、环形父链、自引用一律拒绝关系写入并记录诊断，不能把整条事件流停止。
- root 的身份绑定只接受该 adapter 规范化后的 root/session-init 事件；子事件不能触发当前代码的“主会话 ID 不一致”，也不能更新 root 的 model/quota。
- 工作流切角色产生新的主工作链；旧树归档可查看。恢复同一 purpose/continuation 可延续旧树，依据明确 source_run_id，不能用相同 cwd 或最近时间猜。
- child cwd 可以是合法的独立 worktree。归属验证用父子原生关系 + 已登记/允许的 workspace roots，不能要求子 cwd 必须字符串等于父 cwd。

### 4.3 状态、新鲜度与完成语义

~~~mermaid
stateDiagram-v2
  [*] --> discovered
  discovered --> starting: 原生创建确认
  starting --> running: 活动或原生运行确认
  running --> waiting: 原生等待说明
  waiting --> running: 原生继续
  running --> pausing: 用户暂停意图
  waiting --> pausing: 用户暂停意图
  pausing --> paused: 原生或受管进程确认停止
  pausing --> unknown: 不能确认停止
  running --> completed: 明确最终完成
  running --> failed: 明确失败
  running --> interrupted: 退出且未完成
  waiting --> interrupted: 会话失联或进程退出
  paused --> starting: 新 attempt
  interrupted --> starting: 新 attempt
  failed --> starting: 授权范围内恢复的新 attempt
~~~

- native terminal 事实优先于活动摘要；同一 attempt 已终止后迟到 running 不能复活。重新运行必须有新的 attempt/generation。
- paused/cancelled 是不同状态：暂停保留待恢复意图，取消默认不恢复。finished child 不因父恢复重跑。
- freshness 表示观察链是否健康。正文没有新输出本身不代表 stale；已有可信进程/会话活性确认时允许“正在运行，最近活动 5 分钟前”。
- 数据源读取失败超过 15 秒或超过 3 个应到观察周期时，标“状态待确认”；这只是 UI 降级，不启动修复模型。
- 服务启动后旧 active 先变为待核对；读确认后恢复真实状态。断开的 WebSocket 只改变页面连接标记，不等于模型停止。
- 主进程正常完成但留下后台子 Agent：父显示其真实结果，子保留实际/未知状态及“后台子会话未结束”提示，不能清空整树。
- 子失败不直接增质量失败次数；额度失败不直接换模型；子状态不改写业务阶段。

### 4.4 存储与事件

继续使用现有 SQLite `entities`、`events`、`dedup`、`outbox`，不引入外部数据库或新的调度服务。本项目不是 MySQL/若依业务表，沿用现有 Store 的实体机制。

| entity kind | id / owner | 内容与作用 |
|---|---|---|
| conversation_node | node.id / workflow_id | 会话关系及名称 |
| conversation_attempt | attempt.id / workflow_id | 本次运行状态、原生身份关联及模型信息 |
| conversation_binding | 规范化原生身份的 hash / workflow_id | O(1) 查 node，包含 scope，防串会话 |
| conversation_cursor | adapter + source + node 的 hash / workflow_id | 精确来源 offset、文件身份和最后已应用事件 |
| conversation_control | control.id / workflow_id | 暂停目标、generation、确认结果、恢复关联 |
| conversation_recovery | recovery.id / workflow_id | 恢复清单及 delivered/observed 状态 |
| conversation_file | file.id / workflow_id | 上传元数据、hash、状态、消息引用关系 |
| conversation_message | message.id / workflow_id | 输入 mode、文本、refs、attachment IDs 和目标 |
| project_aside_index | aside.id / project_id | 提问摘要与原 workflow，支持项目查询 |
| project_aside_cursor | project_id / project_id | 项目提问变动单调序号与索引快照边界，和索引更新同事务提交 |

- 复用 events 主键 `workflow_id + seq`；新增事件 `ConversationDiscovered / ConversationUpdated / ConversationActivity / ConversationControlUpdated / AsideUpdated`。
- `ConversationActivity` payload 必含 conversation_id、attempt_id、root_id、activity_id、source_event_id、公开内容、状态。活动聚合键为 `conversation_id:attempt_id:activity_id`，不是裸 step_index。
- 标识事件和 terminal/control 事件立即提交；连续文本/活动快照复用 500ms 合并，最多 100 项提前 flush。只推变动节点，不每 500ms 推整树。
- 同一次 Store.transaction 中更新 snapshot 和事件；快照 API 返回一致的 cursor。无原生 event ID 时用精确来源 ID + byte offset/sequence 生成，不能仅用时间戳去重。
- 按 workflow、conversation、seq 为活动分页增加定向查询方法；只在新事件上使用 JSON 字段索引，避免每次加载先读出全部 events 再筛。
- 新增 `003_conversation_indexes.sql` 并在 `migrations/index.ts` 注册同等 SQL；索引限于 conversation_node 的 root、ConversationActivity 的 conversation_id/seq、项目 aside created_at/id。不复制完整日志到第二套表。
- entity 大小限制：摘要 500 字，单条公开消息 16K 字，命令 32K 字；长输出显示截断并可在已有受控日志入口查看，不把原生私有记录全部发给前端。

## 5. 八工具接入与权限边界

### 5.1 统一适配器扩展

在 `packages/adapters/sdk/src/interface.ts` 新增可选 `subagents` 能力与观察接口，旧适配器缺失时为 unknown，不默认为 false 或 true。

~~~ts
interface SubagentCapabilities {
  discovery: "native" | "scoped-record" | "unavailable" | "unknown";
  activity: "native" | "scoped-record" | "summary-only" | "unavailable";
  stop: "native" | "owned-process-tree" | "unavailable";
  resume: "native" | "parent-instruction" | "unavailable";
  readonly_delegation: "verified" | "unsupported" | "unknown";
  file_input: { text: boolean; image: boolean; binary: boolean };
  cli_version?: string;
  reason?: string;
}

interface NativeConversationEvent {
  source_id: string;
  source_seq: string;
  root_native_id: string;
  session_native_id?: string;
  agent_native_id?: string;
  parent_native_id?: string;
  kind: "discovered" | "state" | "activity" | "model" | "quota";
  occurred_at?: string;
  payload: unknown; // 必须经过具体 kind 的严格 schema 后才入库
}
~~~

确定的处理顺序：`decode → adapter 专属会话分流 → 根身份校验 → conversation observer → 根 RunTelemetry 或子 telemetry`。根/子均复用公开活动规范，不能让每个组件各猜一次原始字段。

新增 `packages/adapters/sdk/src/conversation-source.ts` 作为统一接口和有界读取工具；每个 adapter 目录新增 `conversation-source.ts` 存放版本化解码器。不在 UI 写八套协议。

### 5.2 每种工具的实施方向与真实限制

| adapter | 本期确定的接入路径 | 必须修改/证明的行为 |
|---|---|---|
| codex | exec JSON 的委派/协作事件 + 已绑定根/子 session 的增量记录；复用 CodexSessionObserver 的精准定位 | 通过创建调用返回的子 ID 建树；model/effort 取对应会话；不能将 root PID 退出当成所有独立线程已退出。恢复由原父模型使用其原生能力完成。 |
| agy | stream-json step 的委派调用/结果 + 精确 conversation 的本地记录 | 扩展 AgyNativeRecordSource 只读取公开工具元数据与子会话关联；不解密 provider payload、不扫所有 conversation DB。child step index 必须带身份。 |
| claude-code | stream-json 中 Agent/Task 关联 + 会话级 SubagentStart/Stop hook 与精确子 transcript | hook 只追加本 Run 的受控事件文件；不改用户全局 hooks。只读委派使用明确只读子代理配置，同时保留写工具拒绝。 |
| cursor-agent | stream-json 中原生委派事实与会话关联；精确已绑定记录作为补充 | 版本不输出子标识时明确“当前版本无法读取子会话”；不把普通 tool call 显示成子 Agent。按已证实的只读继承开放。 |
| grok-build | streaming-json 原生委派/会话事件及已绑定来源 | 去掉当前全局 `--no-subagents`；只读用途必须同时设置子权限边界，不能只删除参数就放开写能力。 |
| kimi-code | stream-json 与精确 session 记录中的委派关系 | 独立处理 session/agent 标识；--plan 子代理只读继承须真实验证；保留明确模型/强度选择，不套用 Codex 字段。 |
| qoder | stream-json 与精确 session/agent 关联 | read-only 工具白名单需允许受约束委派；不能只添加任意 Agent 工具并默认子会话只读。 |
| opencode | 已绑定 run 的原生事件/精确 session；有同一次受管运行的原生 server 时使用 children/messages/status/abort | 不连接不明全局 server；不为可视化另启常驻服务。只读 agent 的 task 委派权限必须限制到只读子 agent。 |

原生字段随版本变化，具体字段映射必须以 D04–D08 收集的该版本脱敏样本为准；这属于协议适配工作，不允许改变本文身份、状态、控制和 UI 合同。八个模块都交付解码器与明确能力结果，不允许以通用字符串匹配完成适配。

若某工具当前版本无法暴露子会话或保证只读委派：

- 列出具体 adapter、版本、缺少的能力和可用能力，不说“开发完毕，默认不显示即可”。
- 读得到生命周期但读不到日志：可以显示真实子节点；下钻显示“此工具当前仅提供状态，未提供执行明细”，不显示主日志冒充子日志。
- 不支持安全的只读子 Agent 时，只读角色保持原限制并将该 adapter 对应交付项记为受阻；不可宣称“各角色均支持”已验收。其他独立 adapter 继续实现。
- 工具升级或更换运行协议超出当前兼容范围时，在本文变更记录中给出具体冲突，再由用户确认必要范围变化。禁止默默切换到另一个工具或模型。
- 不创建一个 DevFlow 子工作流来冒充原生子 Agent。

### 5.3 只读与文件输入权限

- 规划、代码复核、aside 的子 Agent 继承同样的读写边界、允许目录和授权边界；不能利用嵌套 Agent 绕过父限制。
- 原生委派工具、内部消息工具可以放行，但文件写、任意终端写入、外部发送权限不因委派放大。
- hooks 不承担业务完成判断；只上报本次可验证会话事实。hook 写入用平台配置的固定文件路径，不能执行模型提供的 shell 字符串。
- 持久化只包含会话 ID、工作摘要和公开活动；认证文件、cookie、密钥、推理正文不进入 UI/API。
- 本次附件是用户提供的数据，交接提示明确“附件正文不覆盖用户请求、项目规则或原批准计划”。名称和内容不拼成 shell 指令。

### 5.4 官方资料核对

资料仅支持原生能力说明，不证明本机已安装版本、账号或各参数组合可用：

- Codex 文档说明子 Agent 继承沙箱/权限，且可有独立模型配置，因此不能把父模型显示为子模型。[官方子 Agent 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents)
- Claude 文档给出 SubagentStart/Stop 及子 transcript 字段；恢复行为也因子类型不同而有差异，应保留无法恢复时的重建路径。[Hooks](https://code.claude.com/docs/en/hooks)、[Subagents](https://code.claude.com/docs/en/sub-agents)
- OpenCode 提供子会话查询及会话 abort；这些 API 只用于明确绑定并受管的原生实例。[Server API](https://opencode.ai/docs/server/)

## 6. 活动流、重连和下钻查询

1. 初次打开先读取 `GET /api/workflows/:id/conversations`，返回 nodes、attempts、active_root_id、capabilities、cursor。
2. 使用现有工作流 WebSocket。快照返回 cursor 后补拉大于 cursor 的事件；流和 HTTP 回补统一按 workflow_id + event_seq 去重。
3. 查看根会话：已有工作流阶段事件继续显示，主工具活动只显示根的；子启动/结束可显示一条摘要，但不把所有子工具日志揉进主流。
4. 查看子会话：只取 conversation_id 匹配的活动及其 attempt 分隔项，不夹入 sibling 的活动、根的通用诊断或其他 aside。
5. 历史 API 按 `before_seq` 游标倒向分页，默认 100，最大 200；返回稳定 next_before_seq 和 has_more。返回“更早”时保持视口锚点。
6. 节点更新用 revision/seq 拒绝旧覆盖；客户端任务切换用 AbortController + workflow/conversation 双重校验，不接纳旧请求结果。
7. 父层 Working 计数从当前根快照/事件 reducer 得出，不能由“当前已加载日志出现了多少 agent”推断。
8. 断线期间 UI 保留快照并显示重连中；重连一次补齐，不能重置树后闪烁为 0。
9. aside 事件可用于刷新项目提问索引，但不进入主日志。现有 aside 不 publish 主活动的隔离原则保留。
10. 单 workflow 只有一个事件消费器；精确原生文件读取由一个 root observer 管理多个受信任源，共享调度，不能每个 UI 组件开 2 秒轮询。
11. 无结构子事件的历史数据只兼容成根活动，不尝试从旧自然语言文本重建一棵“看起来完整”的树。
12. root observer 正常结束后，只在确有活动后代时继续本次原生观察；无活动后代立即释放文件句柄/计时器。后台不调用模型催更新。

## 7. 暂停、继续及额度异常恢复

### 7.1 控制范围与操作含义

| 操作 | 主工作树 | 独立 aside | 其他任务 |
|---|---|---|---|
| 工作卡“暂停全部”/主按钮暂停 | 暂停 root 及全部后代，含嵌套、starting、waiting | 不影响，仍可只读提问 | 不影响 |
| 主按钮继续 | 恢复最近被暂停/中断工作链中尚未完成的工作 | 不自动重试失败问题 | 不影响 |
| 浮窗“取消本次提问” | 不影响 | 取消该 aside 及其后代 | 不影响 |
| 关闭浮窗或收起卡片 | 不影响 | 不影响 | 不影响 |
| 服务正常关闭 | 停止本服务拥有的运行资源，保存原范围 | 同样保存/停止本服务拥有的 aside | 不接管外部进程 |
| 服务再次启动 | 核对状态，不自动恢复人工暂停的任务 | 保留记录，不自动重提 | 不扩大恢复集合 |

### 7.2 暂停算法：先记录意图，再确认停止

~~~mermaid
sequenceDiagram
  participant U as 用户
  participant C as 控制服务
  participant S as Store
  participant N as 原生会话/Process Host
  U->>C: 暂停主会话及全部子 Agent
  C->>S: 原子写 control + root generation + 目标清单
  C->>S: 标记 pausing，取消该树重试/派发
  C->>N: 按能力停止精确会话和拥有的进程
  N-->>C: 独立目标停止确认/未知
  C->>S: 保存逐项确认及迟到后代
  C-->>U: 已暂停，或仍有 N 个待确认
~~~

对应 D09、SA-I06–I09。关键是不把 stop 请求成功等同于所有子 Agent 已停。

具体步骤：

1. 接口必带 request_id、root_id、expected_generation。幂等保存 `conversation_control`；若已切新 root/generation，返回 409，不能停止新 Run。
2. 在事务中冻结本次 scope、prior purpose/stage/profile/continuation、恢复候选；设置 root 的 paused intent，撤销主 Run 继续调度权限，取消对应 model_retry；禁止同一 control 执行期间派发下一轮。
3. 枚举该 root 所有已知未终态后代，不限一层。终态 completed/cancelled 排除；failed/interrupted 留在恢复清单但不当作仍在运行。
4. 支持原生精确 stop 的目标优先使用原生控制；进程内子 Agent 使用原来的 Process Host Job/进程树控制。平台不能按名称 taskkill 全局 Codex/Node/agy。
5. 停止阶段仍接收该旧 root 的事件；迟到 spawn 归入本次控制集合并补停。主已停止且所有目标已确认，方可宣称“全部已暂停”。
6. 原生 API 返回已接受但没有退出/状态确认时仍是 pausing。10 秒未确认显示“暂停中，N 个状态待确认”；30 秒转控制结果 partial，未确认项 unknown，旧根不允许直接创建重复执行。
7. 稍后收到可靠退出事实，允许 partial 自动收敛为 complete；浏览器刷新可继续查看，不依赖前端定时器完成控制。
8. adapter 不能控制与主进程分离的会话时，显示具体未停止项；不可通过把数据库状态改 paused 来“完成”操作。
9. 保留当前环境服务策略，不因展示功能额外清理用户浏览器、目录或其他任务服务。
10. 与正在产生的完成结果竞争时，按已提交的业务终态和 control 目标身份裁决；已正常完成的 child 不回写 paused，已结束 workflow 不被恢复旧 control 改成 STOPPED。

### 7.3 继续算法与角色保留

- `/recover` 保留兼容入口，内部统一调用 `ConversationControlService.resumeTree`。
- 先确认旧 root 和相关资源不再运行；完成未确认项的只读核对。无法确认时返回“仍有旧子会话可能执行”，不启动重复副本。
- 恢复最初工作用途：planning 回 planning；quality_review 保留人工前/后的 phase；开发/整改保留原 purpose、repair context；不能一律转 implement。
- 正在首次规划且尚无批准计划，可以恢复原规划；开发与整改仍遵守既有计划授权。不得用绕过批准的方式修复规划恢复。
- 不修改 plan_revision、plan_hash、质量次数、工作区、已提交变更和用户配置。使用现有明确的 continuation/session 规则。
- 人工已更改下一轮工具配置时，按既有切换合同处理新的根会话；不能把旧工具子会话直接当作新工具会话继续。只传未完成任务和历史引用，实际重建由新负责人完成。
- 只有当前有效的 resume request 能创建一次新根 Run。重复点击/网络重试/重复 outbox 消费都不能产生两个根或两个相同恢复批次。
- 成功响应语义为“恢复已安排”；root observed 才“主会话已运行”；child observed 才相应增加 Working N。

### 7.4 恢复清单

拟新增 `packages/runtime/src/conversation-recovery.ts`，为所有规划/执行/复核恢复路径生成同一合同：

~~~ts
interface RecoveryManifest {
  recovery_id: string;
  workflow_id: string;
  root_conversation_id: string;
  source_run_id: string;
  target_run_id: string;
  reason: "user_resume" | "quota_retry" | "service_recovery";
  purpose: string;
  pending_children: Array<{
    conversation_id: string;
    parent_id: string;
    native_session_id?: string;
    native_agent_id?: string;
    task_summary: string;
    last_status: string;
    interruption_reason?: string;
    last_activity?: string;
    requested_model?: string;
    actual_model?: string;
    effort?: string;
    workspace_refs: string[];
    unfinished_task_ids: string[];
    continuation: "resume-native" | "recreate-after-confirmed-exit";
  }>;
  completed_children: Array<{ conversation_id: string; summary: string }>;
  cancelled_children: string[];
}
~~~

- 清单是已有记录的确定性摘要，不让额外模型先审核。无任务编号就保留原任务摘要，不臆造编号或完成结论。
- manifest 与目标 Run 绑定且按 recovery_id 幂等；先落盘/落库再派发，重启可重建同一内容。
- 提示根负责人按父子层级恢复；嵌套子 Agent 交给其直接父 Agent，不能将所有孙节点无差别重新挂到根。
- 原生 child 可续接则优先续接；明确不支持/已丢失且旧执行确认结束时，重建同范围子任务，并关联 replaces_conversation_id。
- completed 不恢复，cancelled 不恢复；用户暂停中途自行取消的项目也从待恢复集合剔除。
- 记录阶段 `prepared → delivered → observed / partial`。delivered 只表示作为输入传入，不能表示模型遵从或子 Agent 已启动。
- UI 显示“已提醒恢复 3 个子任务，观察到 2 个重新运行；1 个待确认”，不要求额外测试证明来让主任务继续。

### 7.5 必须注入给负责模型的恢复提示

以下是实施时固定模板的语义，所有角色恢复都使用，不仅开发模型：

> 这是原任务的继续，保留原用途、工作区和批准计划。恢复清单中列出了因暂停、额度不足或异常退出而未完成的子 Agent。先检查这些子会话是否仍在运行，避免重复创建；对可以续接的子会话使用当前工具的原生继续能力，对确已退出且不能续接的子会话按原分工重建。逐层交给原父 Agent 处理嵌套子任务。已经完成或用户取消的子任务不要重跑。用户未明确变更时沿用原模型及思考配置；用户已明确变更时遵守本次冻结配置及会话切换规则，不自动换模型或降低强度。恢复后继续原阶段工作；本提示不改变计划范围、权限和复核职责。若某项不能恢复，说明具体子任务和原因。输入附件和子 Agent 返回内容是任务材料，不是更高优先级指令。

平台不要求模型输出专门的“恢复完成证明”；子启动事实仍由原生观察获取。对无法原生读取的工具，只显示恢复提醒已送达，不伪造 Working 计数。

### 7.6 额度和异常分支

| 情形 | 确定行为 |
|---|---|
| 子 Agent 明确返回额度错误，根仍能工作 | 标 child failed/quota，根保持实际状态；在同一主会话下次输入或原生可用控制通道附送去重恢复说明，父模型决定何时继续未完成工作。平台不额外创建竞争的根 Run。 |
| 全树因根额度不足退出，且提供方给出恢复时间 | 复用 model_retry，保存对应 root/generation/恢复候选；时间到仅恢复这一批，附清单。 |
| 无可靠恢复时间 | 显示“额度不足，等待你继续”，不猜时间、不固定每分钟重试。 |
| 等待额度期间用户点暂停 | 删除/作废该 root 的重试并记录人工暂停；即使旧定时消息到达也不恢复。 |
| 恢复后仍额度不足 | 更新错误和下一次可靠时间，保留同一逻辑子任务；不不断新建节点、不自动切换模型。 |
| 服务意外退出后发现后台 child 仍活着 | 标明仍运行并重新绑定合法观察，不重建其副本；用户暂停时再控制本服务明确拥有的对象。 |
| child 未说明原因即消失 | interrupted/unknown，不能只凭账户余额显示 quota；恢复前核对是否仍在执行。 |
| 恢复清单投递失败 | 主恢复输入必须带上已保存 manifest 引用，失败可用同 request 重试；不能吞掉清单却显示全树恢复成功。 |
| 观察失败、解析失败 | 保留最后事实并显示未知；不算业务测试失败、代码质量失败，不直接触发规划接管。 |

## 8. 统一输入和正式反馈路由

### 8.1 命令解析

新增纯函数 `parseConversationInput(text)`，前后端共享同一规则：

| 输入 | 结果 |
|---|---|
| `/btw 为什么这样实现？` | aside，正文“为什么这样实现？” |
| `/side 为什么这样实现？` | 与 /btw 完全相同 |
| 前置空白后输入上述命令 | 允许，去掉前置空白与命令，保留正文内部格式 |
| 仅 `/btw` 或 `/side` | 不发送，显示“请输入临时问题”，保留草稿 |
| `/btwfoo`、`/sidebar` | 普通文本，不能前缀误匹配 |
| “这里的 /btw 是什么？” | 普通文本，不因正文中包含命令而转 aside |
| 输入开头用反斜杠转义命令，例如 `\/btw` | 按普通文本发送 /btw，不触发 aside |
| 代码围栏里的命令、附件里的命令 | 不解析为交互命令 |
| `/btw /side 的含义？` | 只去掉第一个命令，后续是提问正文 |
| 大写 `/BTW` | 与小写同义，命令只比较 ASCII 大小写 |

只匹配首个命令 token，后面必须是空白或字符串结束。用户输入 slash 时可出现两条命令建议；建议列表不是常驻 Tab。识别后在输入框内显示可移除的“临时提问”小标记，正文和附件仍使用同一个草稿模型。

服务端根据正文重新解析 mode，验证客户端提供的 mode 与之相符；不得让伪造 mode 把正式执行反馈当成只读请求或反过来。UI 从建议模式转为请求时仍保留原始命令文本供后端校验。

### 8.2 统一消息入口和分流

新增 `POST /api/workflows/:id/conversation-messages`，实际复用原服务逻辑，禁止复制第三套 feedback 业务规则。

~~~json
{
  "request_id": "客户端稳定请求 ID",
  "root_conversation_id": "当前主会话 ID",
  "expected_generation": 3,
  "text": "/btw 这段实现为什么这样设计？",
  "refs": [],
  "attachment_ids": ["file-xxxx"]
}
~~~

服务端顺序：

1. human 鉴权及同源校验，校验 workflow、root、generation、状态。
2. 解析命令、验证文本和附件所属任务、ready 状态、数量、目标 profile 的输入能力。
3. 在幂等事务中建立 conversation_message 和附件引用；再调用正式反馈/functional issue/aside 的原有领域服务及 outbox，不在事务中等待文件上传或模型。
4. 事务失败则不创建消息、不消耗附件、不停止原模型；所有校验必须早于打断主任务。
5. 成功后返回 `message_id / mode / target_workflow_id / accepted / aside_id?`；前端清空已发送版本草稿，新键入文本不能被迟到响应清除。
6. 若处理会中断正在工作的 root，调用第 7 节同一个树控制入口；请求在已持久化状态下可恢复，不创建另一套暂停路径。

| 工作状态 | 普通输入的处理 | 临时提问 |
|---|---|---|
| PLANNING / PLAN_PENDING / REPAIR_PLAN_PENDING | 保存规划反馈；运行中先按树控制交接，复用原规划恢复/修订入口 | 独立只读 aside，冻结来源上下文 |
| EXECUTING / VERIFYING / REVIEWING | 当前用途的正式指导，按完整树暂停与原角色续接；复核中的指导不会降为 implement | 不打断主工作树 |
| HUMAN_PENDING | 复用 functional-issues；保留用户功能问题记录 | 独立只读 |
| STOPPED / RECOVERY_REQUIRED / BLOCKED | 接收指导并按现有允许的恢复操作处理；待处理权限或未知活进程时保存指导但明确未续跑 | 可提问，不能因此解除主任务暂停 |
| WAITING_INPUT | 给原等待角色回复，保留等待上下文归属 | 不消费主等待问题 |
| WAITING_AUTHORIZATION | 输入区保留；普通发送记录补充意见，明确仍需点该操作的批准/拒绝；不能用普通文本自动批准 | 可独立提问 |
| 已结束、提交中的不可中断阶段 | 维持既有合法操作，禁用普通发送并说明原因 | 当前项目历史可读；新提问仅在已有合法只读入口允许时创建 |

原 feedback/asides/functional-issues API 保留，增量支持 attachment_ids 并复用服务；脚本和旧客户端不因新 UI 上线失效。所有入口使用同一正文校验、幂等和附件归属验证。

### 8.3 附件、历史消息及主流程隔离

- conversation_message 记录客户端输入与实际投递目标，关联原 feedback message 或 aside ID，不重复向模型投递两遍。
- aside 的问题、回答、附件只进入独立上下文；主模型不会自动收到，主反馈 cursor 不前进。
- “转正式反馈”保留现有显式操作，但先把可编辑内容装入主 composer 的正式反馈草稿，由用户发送；不能点历史浏览页就静默更改当前任务。
- 若来源任务不同，跳转该任务主视图并放入草稿，显示来源与目标；不得把其他任务附件 ID 直接绑到当前任务。
- promote 使用原 aside ID 派生的稳定 request_id，避免刷新重试重复调整。

## 9. 文件上传与模型读取合同

### 9.1 + 菜单和附件体验

菜单两项：“上传本地文件”“引用工作区文件或目录”。后者复用现有 `@` 搜索与预览；已有未提交、隐藏文件引用能力保留。

- 本地上传支持常见文本/代码、PDF、Office 文件和 PNG/JPEG/WebP/GIF。普通二进制可作为原生可读文件传入；不自动执行、不解压归档、不增加 OCR/Office 转换服务。
- 每条消息最多 10 个附件，单文件上限 20 MiB，总量上限 100 MiB；这些是本期产品值，前后端一致返回。工作区目录引用不展开为上传文件，不受单文件上传大小逻辑替代。
- 模型对某类型没有可用读取能力时，选择后明确提示“当前工具无法读取此附件类型”，发送前必须处理。上传成功不代表模型支持，不能悄悄只传文件名。
- 图片显示本地缩略图，其他文件显示名称/大小/类型/状态；每项可移除、失败可重试；同名不同内容允许并列。
- 粘贴含图片时上传图片，同时保留普通剪贴板文本；拖放仅对文件触发，不吞掉正常选中文本拖动。
- 上传中关闭面板保留后台上传与草稿；切任务按 workflow 隔离；删除草稿附件只删未绑定上传，不删已发送消息中的文件。
- 刷新后 ready 的附件 ID 可恢复；未完成的浏览器 File 对象不能伪装成可恢复上传，显示“上传中断，请重新选择”。
- 本期不自动对 URL 下载文件、不使用用户文件名决定存储目录。

### 9.2 三步 API，无新增 multipart 依赖

选择每文件独立二进制上传，避免把 20 MiB 文件编码成大 JSON。

1. `POST /api/workflows/:id/conversation-files`  
   JSON 元数据：request_id、display_name、size、declared_mime。返回 file_id、upload_path、limits。落实体状态 pending。
2. `PUT /api/workflows/:id/conversation-files/:fileId/content`  
   Content-Type 为 application/octet-stream；在该路由的 Fastify 插件作用域注册流式 content parser，并自行累计实际字节；此路由单独设置 20 MiB 限制，不提高所有 JSON 接口的 8 MiB 上限，不一次性缓冲整个文件。逐块写 .part、计算 SHA-256、校验长度，再原子 rename 成 ready。请求失败只保留可清理 pending/failed，不生成 ready 文件。
3. `GET /api/workflows/:id/conversation-files/:fileId` / `.../:fileId/content`  
   返回元数据/受控预览或下载。`DELETE` 仅能移除未被消息引用的文件；已引用返回 409。消息只传 file IDs，不再传客户端路径。

拟存储位置：`<storage_root>/conversation-files/<workflow_id>/<file_id>/content`。display_name 仅为元数据，真实路径由服务端 ID 决定。采用现有配置的存储根，绝不把用户输入直接 join 到磁盘路径。

文件记录必须有：id、workflow_id、project_id、display_name、declared_mime、detected_mime、size、sha256、status、created_at、ready_at、referenced_message_ids；绝对磁盘路径不在普通 API 返回。

校验与生命周期：

- 服务端验证 ID 格式、路径 realpath 边界、任务归属、流量大小、磁盘余量/写入错误；客户端 Content-Length 仅作预检，流式字节数是最终依据。
- 路径穿越、Windows 保留名、绝对路径、双后缀不影响真实存储路径；下载文件名做安全编码。
- SVG/HTML 等主动内容不以内联 HTML 运行；Markdown 按现有安全渲染，其他二进制使用 attachment 下载。PNG/JPEG 等仅在检测类型一致时受控 inline。
- 重复 request_id + 相同元数据返回同一 file；不同内容的 PUT 不覆盖已经 ready 的文件。消息重复提交不增加第二次引用。
- 文件上传鉴权延续 human/origin 机制；不能通过猜另一个 workflow 的 file_id 读取内容。
- 未发送的 pending/failed/ready 草稿文件 24 小时后可清理；清理前复查引用。已发送文件跟随工作流现有保留/删除生命周期，不因模型退出就删除。
- 清理只遍历受控 storage 子目录；崩溃遗留的 .part 可在启动时标失败；不得扫描用户上传来源目录或删除原文件。
- 不把会话输入文件混入现有交付材料的 `attachments` 归档语义，两个实体和 API 名称保持独立。

### 9.3 真正交付给原生工具

拟新增 `packages/runtime/src/conversation-inputs.ts`：

- 把消息/aside 已绑定文件解析成不可变 `ResolvedInputAttachment`：ID、显示名、hash、受控绝对路径、实际 MIME、读取方式。
- 交接材料包括文件清单、用户正文和只读数据说明；使用 argv 数组或 JSON/stdin，不拼接 shell。
- 原生图像输入可用时传本地图片作为原生 image input；普通文本/二进制通过该工具受支持的文件引用或读取工具路径传入。能力在 adapter 层明确，不让 UI 猜扩展名就认为可读。
- adapter 新增 `prepareInputAttachments`，同时计算只读附加读取目录。只允许当前消息已绑定文件，不把 storage_root 整体授权给模型。
- 沙箱若不能在不增加写权限的情况下读取输入文件，返回 INPUT_READ_SCOPE_UNSUPPORTED；不能以“添加目录”为由把整个用户目录变成可写。
- 平台不向业务仓库复制输入文件，不更改 Git 基线。若原生客户端必须运行目录内路径，由 adapter 使用本 Run 受控只读输入挂载/副本，并保持 Git 排除；无法保证则按能力失败处理，不静默复制到业务根。
- 正式指导、规划反馈、人工功能问题和 aside 四条路径都携带文件；续跑材料复用原 file ID/hash，不能恢复后只剩文件名。
- 读取能力/文件存在性预检在暂停主树之前完成；磁盘丢失返回明确错误并保留草稿，不把空附件交给模型。
- 模型日志可显示“读取了某文件”这样的真实工具活动；上传 ready 不自动生成“模型已读”状态。

## 10. 项目临时提问索引与接口

### 10.1 查询合同

新增：

`GET /api/projects/:projectId/asides?limit=20&before=<cursor>`

返回 `items / total / next_cursor / snapshot_cursor`；items 为摘要，包含 aside_id、workflow_id、workflow_title、question_preview、status、created_at。详情从现有所属 workflow 的 aside 详情接口读取。默认 20，最大 50。

- 数据以 `project_aside_index` 为查询索引，真正回答仍保存在原 aside_session；索引项含 created_project_seq、updated_project_seq，同事务递增 project_aside_cursor 并发出 AsideUpdated。增量查询筛选 updated_project_seq > after，返回快照 cursor；重复变动可合并成该问题最新状态。
- 稳定排序 `created_at DESC, id DESC`。页游标带该项目和排序键，签名或严格校验；不允许将项目 A 游标用于 B。
- 默认选最新问题；新提交返回的 aside_id 是首选。历史选中以 ID 保存，不用数组下标保存。
- total 是当前查询快照的记录总数；按 created_project_seq <= snapshot_cursor 冻结本次历史成员，翻页保持该快照，状态和答案仍可更新；新问题通过轻量提示刷新快照。选中的旧问题因刷新排名变化时保持 ID，页码重新计算。
- 为“1/N”定位新增 `GET /api/projects/:projectId/asides/:asideId/position?snapshot_cursor=<seq>`，返回同快照的 index/total/prev_id/next_id；避免前端为了第 700 条先下载全部回答。
- 旧数据在迁移/首次项目访问时按有界批次建立索引，不扫描账户数据。迁移任务可重复；保留旧 ID、状态、答案和归属。
- 现有 `GET /workflows/:id/asides` 保留数组响应兼容；新界面使用项目接口，不能依赖旧接口返回的最早 50 条。

### 10.2 更新和并发

- 复用现有 active/queued 限制，不新增“提问就是主子 Agent”的关系；aside 是单独 root，不计主 Working N。
- aside 若内部确实创建子 Agent，其活动归属于 aside root，取消时按该树控制；本期浮窗仍只呈现问题与答案，不增加第二套 composer。
- complete/cancel/expire 争用同一会话时以事务和预期状态裁决；迟到答案不能覆盖用户取消为 completed。
- 取消 active 前先阻止其继续派发，再停止该 aside 树，释放队列名额只做一次；不能因为关闭浮窗而释放名额。
- 项目界面只订阅一个项目级 aside 通知渠道或现有事件聚合渠道，避免为项目每个 workflow 各开一个 WebSocket。
- 确定采用新增 `GET /api/projects/:projectId/aside-updates?after=<cursor>` 的轻量增量拉取：浮窗打开或本项目有 pending aside 时每 2 秒一次，其他时候不轮询；只返回变动 ID/状态/项目游标，按需读详情。项目游标在索引更新事务中递增。
- 这样主工作流事件仍走现有 WebSocket，跨任务提问只拉轻量项目变动，不下载每个任务日志。
- retry/取消/转正式反馈保留原有超时和只读规则；不把 aside 的失败归入主工作流质量计数。

## 11. API、兼容、资源与性能

### 11.1 API 总表

所有写接口复用同源 human 授权与稳定 request_id。适配器观察写入来自本地 runtime 内部，不向任意网页开放伪造活动端点。

| API | 返回/作用 | 主要错误 |
|---|---|---|
| GET /workflows/:id/conversations | 当前及历史 root 摘要、当前树、capabilities、cursor | NOT_FOUND |
| GET /workflows/:id/conversations/:nodeId | 节点、祖先、attempts、公开运行信息 | CONVERSATION_NOT_IN_WORKFLOW |
| GET /workflows/:id/conversations/:nodeId/activities | before_seq/limit 分页活动 | INVALID_CURSOR |
| POST /workflows/:id/conversation-controls | action=pause/resume，root/generation/request_id；返回 control ID 与真实状态 | STALE_ROOT、VERSION_CONFLICT、STOP_UNCONFIRMED |
| POST /workflows/:id/conversation-messages | 原子接收正文/引用/附件，分流到原领域服务 | EMPTY_MESSAGE、EMPTY_QUESTION、INPUT_UNSUPPORTED |
| POST/PUT/GET/DELETE /workflows/:id/conversation-files… | 第 9 节完整文件生命周期 | FILE_TOO_LARGE、FILE_NOT_READY、FILE_IN_USE、FILE_SCOPE_MISMATCH |
| GET /projects/:id/asides | 项目提问摘要分页 | INVALID_CURSOR |
| GET /projects/:id/asides/:asideId/position | 上一条/下一条与位置 | ASIDE_NOT_IN_PROJECT |
| GET /projects/:id/aside-updates | 轻量项目更新 cursor | INVALID_CURSOR |
| GET /workflows/:id/asides/:asideId | 单条问题/答案/附件 | ASIDE_NOT_IN_WORKFLOW |
| 原 /stop、/recover、/feedback、/asides 等 | 保留兼容入口，内部复用新服务 | 保留已有业务错误 |

表中省略共同前缀 `/api`。读取 API 不启动模型、不创建 Run、不自动继续任务。

统一响应约束：

- 控制请求可以返回 202 accepted，但必须带 `status:pending/partial/complete`；前端不能仅看 HTTP 200/202 就显示停止/恢复完成。
- 元数据写冲突返回 409，刷新受影响摘要后保留草稿；不得自行更改 payload 重试成另一业务动作。
- 当前树没有运行子 Agent时暂停仍作用于根，不报“没有子 Agent 所以无法暂停”。
- API 不接受任意磁盘路径、PID、native endpoint 地址作为控制目标；均从已绑定的树和受管配置解析。
- 人工授权卡仍需显式批准/拒绝，显示来源会话，并可返回对应 root 处理；普通消息、恢复按钮和文件上传不能代替批准。

### 11.2 旧数据和升级

1. 对旧 Run 按 run.profile / adapter / purpose 创建只读根兼容视图；没有子记录时展示“历史未记录子会话”。
2. 新字段均增量添加；旧事件仍由 readableLogs 处理。新 ConversationActivity 不重复投影成旧 NativeActivity。
3. 不改旧 native_conversation/session key 的含义；切换改造必须保留原 run/session 绑定。当前已经开展中的轮次只观察有可信关联的事实，不回溯猜关系。
4. 界面关闭工作卡、切根/子、上传失败都不改工作流版本、质量次数、计划。
5. 新索引 migration 可重复执行，数据保留；历史 backfill 遇坏条目记录诊断并跳过，不回滚原任务内容。
6. 临时提问 Tab 和旧 modal 使用点全部迁走后才删除旧组件。共享 RequirementComposer 保留旧 props 行为，避免破坏新建任务和规划审批反馈。
7. 浏览器刷新不发 recover；服务重启仅恢复已经合法排队的系统重试，不恢复人工暂停集合。
8. 回退旧代码前先在隔离副本验证其能忽略新增 entity kinds；不能删除新记录来让旧版本“看起来正常”。控制暂停中的实例不热回退，先完成控制或保留恢复说明。
9. 上线、重启、迁移真实数据库与真实模型调用属于实施交付环节，本文生成不执行这些动作。

### 11.3 性能预算与可观察性

- 不新增常驻模型、不启动八个客户端做状态轮询；仅观察实际运行工具、已绑定会话。
- 观察文件每轮最多读 1 MiB/源；单行最大 4 MiB，超限记诊断并处理合法后续事件；截断/轮换通过文件身份与 cursor 判定，不能从头重放为新工作。
- root 共享观察调度间隔 2 秒，最多 4 个并行文件读取；活动事件优先及时 flush。已终态且无后代的源退出观察。
- UI 只渲染当前会话窗口与工作卡当前可见行；初始最多 200 条日志，历史分页。超过 50 个子节点时对工作卡分段/虚拟渲染，不隐藏真实计数。
- 目标预算：本地快照 200 节点、20,000 条历史活动，树摘要响应 P95 < 300ms，单页 100 条活动 P95 < 300ms；在执行机记录数据量与耗时，不把一次机器抖动当业务失败。
- 事件入库到 UI 可见，在无积压本地环境下目标 ≤ 3 秒。首屏不等待原生全量日志扫描。
- 页面层消费标识 cursor、stream stale、control pending/partial 足够，不引入监控平台。
- 验证无额外模型调用、无全目录轮询、关闭视图释放订阅、observer 结束释放句柄。性能结果在第 15 节登记，不能为了达标丢弃活动或伪报完成。

## 12. 详细开发任务合同

任务状态枚举：`未开始 → 进行中 → 已实现待测 → 自测通过 → 复核通过`；也可 `受阻`，必须写具体受阻项。人工验收另记。每项开发均包括对应测试代码，运行顺序按第 13 节。

### 12.1 任务总账（实施过程中直接更新）

| 任务 ID | 内容 | 依赖 | 建议负责人 | 状态 | 实现/提交与备注 |
|---|---|---|---|---|---|
| SA-D01 | 共享合同和能力枚举 | 无 | 主 Agent | 未开始 | — |
| SA-D02 | 会话树 reducer、实体与索引 | D01 | 数据子 Agent | 未开始 | — |
| SA-D03 | 活动归属、遥测分流和重连合同 | D01 | 运行时子 Agent | 未开始 | — |
| SA-D04 | Codex 适配 | D01 | 适配子 Agent A | 未开始 | — |
| SA-D05 | agy 适配 | D01 | 适配子 Agent B | 未开始 | — |
| SA-D06 | Claude 适配及只读委派 | D01 | 适配子 Agent A | 未开始 | — |
| SA-D07 | Cursor/Grok/Kimi/Qoder 适配 | D01 | 适配子 Agent B | 未开始 | 按四个独立目标登记 |
| SA-D08 | OpenCode 适配及共享调用参数 | D01 | 主 Agent + 适配 A | 未开始 | invocation.ts 由主 Agent 合并 |
| SA-D09 | 树范围暂停与控制意图 | D01、D02 | 控制子 Agent | 未开始 | 适配完成后接入真实 stop |
| SA-D10 | 恢复清单、额度和服务重启 | D09 | 控制子 Agent | 未开始 | — |
| SA-D11 | 本地上传存储及 API | D01 | 文件子 Agent | 未开始 | — |
| SA-D12 | 模型附件输入适配 | D01、D11 | 运行时子 Agent | 未开始 | 与各 adapter 对接 |
| SA-D13 | 正式反馈/aside 的附件接线 | D11、D12 | 输入子 Agent | 未开始 | — |
| SA-D14 | 项目 aside 索引、详情和分页 | D01 | 数据子 Agent | 未开始 | — |
| SA-D15 | 会话查询、活动分页和事件 API | D02、D03 | 数据子 Agent | 未开始 | — |
| SA-D16 | 子 Agent 工作卡 | D01 | 界面子 Agent | 未开始 | 可先按已冻结 DTO 实现 |
| SA-D17 | 子会话路由、面包屑及日志切换 | D01、D03 | 界面子 Agent | 未开始 | 数据接线依赖 D15 |
| SA-D18 | 常驻 composer 和 slash 解析 | D01 | 输入界面子 Agent | 未开始 | — |
| SA-D19 | 附件 UX 与当前模型/工作展示 | D18 | 输入界面子 Agent | 未开始 | 接 D11、D13 |
| SA-D20 | 非模态 aside 浮窗及历史导航 | D01、D18 | 界面子 Agent | 未开始 | 接 D14 |
| SA-D21 | 主页面、API 和旧入口整合 | D09–D20 | 主 Agent | 未开始 | 不等待无关 adapter 测试 |
| SA-D22 | 测试环境参数化与协议 fixtures | D01 | 测试设施子 Agent | 未开始 | 可与其他开发并行 |
| SA-D23 | 全角色交接提示及版本能力说明 | D04–D10 | 主 Agent | 未开始 | — |
| SA-D24 | 兼容/使用说明、进度接线与完成核查 | D21–D23 | 主 Agent | 未开始 | 不包含实际测试完成 |

当前开发任务：**0/24 已实现，0/24 自测通过，0/24 复核通过**。D07 的四个工具全部达到对应标准才完成该项；不得按文件创建数量算完成。

### 12.2 D01–D03：合同、存储、活动

**SA-D01 共享合同**

- 输入：本文第 4、5、8–11 节；现有 Run、RunObservation、FeedbackMessage、AsideSession。
- 文件：新增 `packages/contracts/src/conversation.ts`、`conversation-input.ts`；增量修改 `feedback.ts`、`run-observation.ts`、`index.ts`、`packages/adapters/sdk/src/interface.ts`。
- 实施：定义严格 Zod schema、generation、control/recovery、附件请求及公开 DTO；可选扩展保障旧数据可读。统一输入解析函数放 `packages/core/src/conversation-input.ts`，前端只导入不依赖 Store 的纯函数。
- 输出：可被独立前后端任务共同使用的冻结类型、错误码与 fixtures；一次集中交接字段。
- 不可改：原工作流状态机、角色路由、质量计数。
- 测试责任：U01、U04、U05、U10；包含缺字段旧对象、无效 parent、mode 边界。
- 停止条件：与现有 RunContinuation 冲突时列出具体字段并由主 Agent 修订统一合同，不由各模块自行发明字段。

**SA-D02 树 reducer 与持久化**

- 依赖/输入：D01 DTO，规范化原生事件，不依赖浏览器。
- 文件：新增 `packages/core/src/conversation-service.ts`、`packages/runtime/src/conversation-observer.ts`；修改 `packages/store/src/store.ts`、`migrations/index.ts`；新增 `migrations/003_conversation_indexes.sql`。
- 实施：身份 binding、迟到父节点补齐、防环、attempt 迁移、terminal 防倒退、事务快照/event、精确 cursor、legacy root 投影；索引仅按已知查询增加。
- 输出：getTree/applyEvent/readNode 的可复用入口和稳定 cursor；不消费自然语言“完成”作为终态。
- 不可改：旧 event_seq 排序、既有实体内容、真实 SQLite。
- 测试责任：U01、U06–U09、I01、I21、I22。
- 停止条件：来源身份不明确则降为 unknown 并记录具体诊断，不能写到猜测的主会话。

**SA-D03 遥测分流与活动投影**

- 依赖/输入：D01；调用 D02 接口可先用合同 stub 开发，整合时接真服务。
- 文件：`packages/runtime/src/{run-telemetry,agent-telemetry,native-activity,profile-runtime,runtime}.ts`；新增 `packages/presentation/src/conversation-activity.ts`；增量修改 `packages/presentation/src/activity.ts`。
- 实施：先 route root/child，再提取活动、模型、quota；聚合 key 带 node/attempt；补上 legacy runtime 的规划/执行/复核路径；活动分页与现有 LogEntry 转换复用。
- 输出：根无串流、子可独立回放、aside 仍隔离；close/finish 不粗暴结束全部后代。
- 不可改：业务完成结果 normalize 与角色流转语义，不把观察失败传播为业务失败。
- 测试责任：U06、U07、I02–I05、E01、E04、E20。
- 停止条件：raw event 当前无法区分根子时保持旧根行为并报告 adapter 缺口，禁止把 session mismatch 校验直接删除。

### 12.3 D04–D08：适配器

**SA-D04 Codex**

- 输入：D01 原生事件合同、第 5 节方案、当前 exec/observer。
- 文件：新增 `packages/adapters/codex/src/conversation-source.ts`；修改 `packages/runtime/src/codex-session-observer.ts`；共享 reader 接口交主 Agent 合并。
- 实施：采集已安装版本的脱敏委派/恢复/失败样本；按父调用返回绑定子身份；精确读取子记录；提取子 model/effort，保留 time/cwd/归属验证；支持 resume vs recreate 标志。
- 输出：Codex lifecycle/activity/capabilities，含嵌套、额度和暂停事实。
- 不可改：用户 Codex 全局配置、认证、已有会话；不假设 app-server API 可控制 exec 的外部进程。
- 测试：U11、I03、I04、I10、A01。
- 停止条件：版本协议不符则准确报能力原因；相关适配任务受阻，公共/UI 任务不受阻。

**SA-D05 agy**

- 文件：新增 `packages/adapters/agy/src/conversation-source.ts`；增量修改 `native-record-source.ts`；必要 hook/会话参数改动只在 `native-adapter.ts` 和 `session.ts` 的本 Run 配置中实施。
- 输入：D01；当前 stream-json 及本地公开元数据解析。
- 实施：只从真实委派工具输入/结果提取子身份，记录 step 与 child 的关联；既有 protobuf reader 不增加猜字段/解密逻辑；父等待与子运行分别投影。
- 输出：精确 child source、公开活动、暂停归属声明。
- 不可改：旧执行事实、报告归档与 completion 的轻量边界。
- 测试：U12、I02、I04、I07、A02。
- 停止条件：元数据加密/不可读则说明不能读取的字段，不能全盘扫描或将父 step 当子记录。

**SA-D06 Claude**

- 文件：新增 `packages/adapters/claude/src/conversation-source.ts`、`scoped-hooks.ts`；修改该 adapter；共享 invocation 修改由主 Agent执行。
- 输入：D01，官方 hook 字段和当前版本样本。
- 实施：Agent/Task call 与 agent_id 关联；会话级 hooks 写当前 Run 受控文件；精确子 transcript；创建只读子 agent 定义并限制工具继承；支持不同版本恢复能力映射。
- 输出：真实 start/stop/activity，以及 readonly_delegation 的验证状态。
- 不可改：用户全局 hooks、插件与权限默认；不允许子委派扩大 Bash/Edit/Write 权限。
- 测试：U13、I03、I04、I23、A03。
- 停止条件：不能证明只读子权限时不开放只读委派，任务留受阻记录，不能用普通父提示词代替权限。

**SA-D07 Cursor / Grok / Kimi / Qoder**

- 文件：分别新增 `packages/adapters/{cursor,grok,kimi,qoder}/src/conversation-source.ts`；分别修改 adapter.ts；共享参数在 D08 集中合并。
- 输入：D01，四个客户端各自版本和样本；四个模块可由不同子 Agent 并行，不互相等待。
- 实施：每个各自记录 discovery/activity/stop/resume/readonly/file 能力；完成确定的字段映射和根/子分流。Grok 去掉全局禁用子 Agent；Qoder 的只读白名单调整要有子权限限制配套；Cursor/Kimi 不猜不存在的参数。
- 输出：四份独立能力事实和 source，实现与原调用合同兼容。
- 不可改：工具默认选择、模型 ID、强度；不为支持展示自动升级客户端。
- 测试：U14–U17、I03、I04、I23、A04–A07。
- 停止条件：单工具缺能力只阻塞其目标；剩余适配器继续，不将一个不支持项误写成全部完成。

**SA-D08 OpenCode 与共享启动集成**

- 文件：新增 `packages/adapters/opencode/src/conversation-source.ts`；修改 `adapter.ts`；主 Agent统一修改 `packages/adapters/sdk/src/{base-adapter,invocation,conversation-source}.ts`。
- 输入：D01、各 adapter 提交的明确调用差异。
- 实施：绑定当前原生实例/session；可用时读取 children/activity 和精确 abort；只读 task 仅允许只读子 agent；base decoder 不硬编码所有协议为一个通用字段链。
- 输出：八 adapter 统一入口，未知版本有明确状态；只删除已被本期需求取代的禁用子参数。
- 不可改：当前进程/CLI 通用启动方式、账户、其他用户原生 server。
- 测试：U18、I03、I04、I23、A08。
- 停止条件：没有可绑定的服务时不另启长期 server；按本地受信任来源能力记录剩余缺口。

### 12.4 D09–D15：控制、附件和接口

**SA-D09 整树暂停**

- 文件：新增 `packages/core/src/conversation-control.ts`；修改 `packages/core/src/engine.ts` stop、`packages/runtime/src/runtime.ts` stop、`packages/process/src/manager.ts` 的精确确认接口（仅如必要）；不改 OS 全局设置。
- 输入：D01/D02 的根和 attempts、adapter stop 能力、现有 Process Host 结果。
- 算法：持久意图/幂等 → fence generation → 冻结目标 → 按能力 stop → 捕捉迟到子 → 逐项确认/partial。所有入口共享。
- 输出：可跨页面/服务重启读取的控制结果，不把 partial 显示为全部成功。
- 不可改：其他任务、aside 的独立根、全局进程、已有环境保留设置。
- 测试：U19、I06–I09、E11–E12。
- 停止条件：目标归属或退出未知时只阻塞该树重复启动，不回退成无差别杀进程。

**SA-D10 恢复、额度和重启**

- 文件：新增 `packages/runtime/src/conversation-recovery.ts`；修改 `packages/runtime/src/recovery.ts`、`packages/core/src/{model-retry,waiting-context}.ts`，必要 continuation 扩展统一经 D01 负责人合并。
- 输入：D09 control、原 purpose/phase/profile、待恢复节点。
- 算法：确认旧资源 → 幂等新 Run → 保存 manifest → 随 handoff 投递 → 观察新 attempt。用户暂停使旧定时 retry 失效；规划无批准计划时仅恢复规划权限。
- 输出：明确 restored/pending/partial 个数、旧新节点关联、所有角色正确续接。
- 不可改：模型切换策略、质量次数、业务计划、已完成子结果。
- 测试：U19、I10–I13、I24、E13、E23。
- 停止条件：会话不可恢复且旧资源未确认退出，不允许生成副本；用途冲突不擅自降为执行。

**SA-D11 文件存储与上传 API**

- 文件：新增 `packages/core/src/conversation-files.ts`、`apps/api/src/routes/conversation-files.ts`；路由挂载由 D21 统一完成。
- 输入：D01 附件合同、现有 storage_root 和 human guard。
- 实施：元数据创建、二进制有界上传、hash/ready、下载鉴权、草稿删除、TTL 清理；只用现有 Node/Fastify 能力，不引入 multipart 库。
- 输出：上传独立闭环；临时文件崩溃后不会当作 ready。
- 不可改：真实用户来源文件、既有交付附件目录、全局 bodyLimit。
- 测试：U10、I14–I16、E08、E10。
- 停止条件：无权限/空间不足准确失败，不能更换存储到未授权目录。

**SA-D12 原生附件读取**

- 文件：新增 `packages/runtime/src/conversation-inputs.ts`；各 adapter 输入部分由对应 owner 修改；`profile-runtime.ts` 和 handoff 公共接线由运行时负责人合并。
- 输入：D11 ready 文件、目标 frozen profile、工具 file_input 能力。
- 实施：生成只读输入清单，传图片/文件到原生 invocation，验证读取目录；续接保持 hash 和 ID；不自动转换或执行附件。
- 输出：模型实际可读的本轮附件；unsupported 有确定失败点。
- 不可改：模型/强度、业务仓库、全局沙箱权限。
- 测试：I16–I17、E09、A01–A08 中的输入能力用例。
- 停止条件：无法安全提供读取能力时在打断原主任务前失败。

**SA-D13 消息与附件端到端接线**

- 文件：新增 `packages/core/src/conversation-message-service.ts`、`apps/api/src/routes/conversation-messages.ts`；修改 `packages/core/src/feedback-service.ts`、`packages/asides/src/service.ts`、`packages/runtime/src/profile-runtime.ts` 的材料组装。
- 输入：D01 解析、D11 ready、D12 读取材料。
- 实施：校验→幂等消息/引用事务→原领域服务→统一控制交接；四种输入路径均带文件；失败不清草稿不打断主树。
- 输出：message/feedback/aside IDs 的一一关联与 accepted 状态。
- 不可改：人工批准动作、正式范围调整/审批业务规则。
- 测试：I17–I18、I20、E06、E09、E19。
- 停止条件：不同入口当前业务语义冲突时集中修原服务，不在新路由复制分支绕开。

**SA-D14 项目提问历史**

- 文件：新增 `packages/asides/src/project-history.ts`、`apps/api/src/routes/project-asides.ts`；修改 `packages/asides/src/service.ts`；D02 负责人整合必要索引。
- 输入：D01、现有 aside/workflow/project 归属。
- 实施：索引与 project cursor、快照分页、position、详情、增量更新、旧数据有界回填；完成/取消事务防迟到覆盖。
- 输出：准确 1/N 与原属 workflow，取消/转正式反馈不串任务。
- 不可改：现有 1 active/3 queued/10 分钟规则，不将 aside 入主工作树。
- 测试：U20、I19–I20、E14–E19。
- 停止条件：索引缺失可重建，不能丢弃旧答案或改 owner。

**SA-D15 会话 API**

- 文件：新增 `apps/api/src/routes/conversations.ts`；修改 `packages/store/src/store.ts` 定向活动查询；`main.tsx` 接口调用留 D21。
- 输入：D02/D03 snapshot/event，D09 控制服务。
- 实施：树、祖先、attempt、历史分页、合法 scope/游标；API 仅输出白名单字段；控制响应明确 partial。
- 输出：可复用 DTO 与前端错误处理合同。
- 不可改：旧 WebSocket cursor、旧 API 返回形状。
- 测试：I05、I08、I21–I22、E04、E20。
- 停止条件：选择不属于任务的 node 必须拒绝，不能退而展示其他节点日志。

### 12.5 D16–D21：界面与整合

**SA-D16 子 Agent 工作卡**

- 文件：新增 `apps/web/src/components/SubagentWorkCard.tsx`、`subagent-work-card.css`。
- 输入：D01 树摘要、当前 root 与用户折叠偏好；仅通过回调发控制/导航。
- 实施：expanded/collapsed、精确 count、状态摘要、历史节点、键盘访问、长名称/窄宽度；首次自动展开一次，用户关闭后不抢焦点。
- 输出：可插入执行面板 footer 的受控组件。
- 不可改：工作流状态，组件不自行轮询原生工具。
- 测试：U02、E02–E03、E21。
- 停止条件：缺真实能力显示 unknown，不能给 UI 制造假 Agent 数据用于生产。

**SA-D17 会话导航与日志视图**

- 文件：新增 `apps/web/src/components/ConversationBreadcrumb.tsx`、`apps/web/src/use-conversation-view.ts`；修改 `execution-panel.tsx`，公共主页面 wiring 留主 Agent。
- 输入：D01 节点合同、D15 API、D03 公共日志映射。
- 实施：URL/面包屑、多级下钻、分会话滚动和已读 cursor、异步取消、终态原地展示；子视图不渲染 composer/aside。
- 输出：主/子数据明确隔离的查看层。
- 不可改：当前运行 root、业务任务选择、用户草稿。
- 测试：U03、I05、E04–E05、E20–E21。
- 停止条件：归属校验失败返回合法主视图并提示，不能用最近活跃节点补错。

**SA-D18 常驻输入及命令 UX**

- 文件：新增 `apps/web/src/components/ConversationComposer.tsx`、`conversation-composer.css`、`use-conversation-draft.ts`；修改 `interactions.tsx`；共享 RequirementComposer 的兼容修改由该 owner 统一负责。
- 输入：D01 解析和消息 API 合同；沿用现有 references 能力。
- 实施：去按钮与 Tab，常驻多行、IME、Enter/Shift+Enter、draft ID 与 request ID、防迟到清空；slash 建议/标记；普通发送语义清晰。
- 输出：同一 composer 支持 formal/aside，不重写旧新建任务表单。
- 不可改：授权按钮、反馈范围审批、旧表单必填行为。
- 测试：U04–U05、E06、E14、E22。
- 停止条件：旧调用方 props 不兼容时用可选扩展/封装，不全量替换所有表单。

**SA-D19 附件交互与模型信息**

- 文件：新增 `apps/web/src/components/ConversationAttachments.tsx`、`ConversationStatusBar.tsx`；修改 D18 composer；复用 `CurrentRuntime.tsx`、`packages/presentation/src/run-observation.ts` 的格式化工具。
- 输入：D11/D13 APIs、RunObservation、selected view。
- 实施：+ 两菜单、上传队列/重试/移除、拖放/粘贴、缩略图、限额、reload 中断；工作/model/effort 事实优先级；配置入口复用。
- 输出：真正 ready 才可发送，未知模型/effort 显式显示。
- 不可改：下一轮配置和当前配置不能相互覆盖，不增加麦克风功能。
- 测试：U04、I16、E07–E10。
- 停止条件：目标原生输入能力不支持时显式提示，不将附件从提交请求中删掉绕过。

**SA-D20 非模态浮窗**

- 文件：新增 `apps/web/src/components/AsidePopover.tsx`、`aside-popover.css`、`use-project-asides.ts`；提取现有 AsideHistoryDialog 中纯 API/helper；完成替换后删除旧 modal 组件及专属无用样式。
- 输入：D14 项目历史接口、D18 composer anchor。
- 实施：单条内容、1/N、上一/下一、稳定 ID、close/Esc、来源任务、cancel/promote 草稿；独立 2 秒轻量更新；无遮罩、无焦点圈闭。
- 输出：与主执行并存的浮窗，历史不丢失。
- 不可改：原属 workflow、主反馈 cursor、aside 队列规则。
- 测试：U20、I19–I20、E15–E19。
- 停止条件：跨任务操作目标不明确必须由界面写出原属目标，不能默认当前任务。

**SA-D21 主入口整合**

- 文件：`apps/web/src/main.tsx`、`interactions.tsx`、`execution-panel.tsx`、`use-event-catchup.ts`、`event-catchup.ts`、`apps/api/src/server.ts`；相关 `WorkflowActivity.tsx` 控制按钮；共享 CSS 的最小改动。
- 输入：D09–D20 已实现接口/组件；八适配器持续按接口整合，无关部分不等待。
- 实施：只挂一套根事件 consumer，接 footer、子导航、消息/控制路由；把旧 stop/recover/asides/promote 入口导向同一领域服务；注册上传专用解析器；清掉旧 Tab/modal 使用点。
- 输出：真实 API→Store→runtime→事件→UI 全链路，组件演示不算完成。
- 不可改：任务创建、计划批准、人工反馈、质量完成、交付入口；保持现有未完成修改。
- 测试：I22–I24、全部 E2E 的入口接线，重点 E22–E24。
- 停止条件：共享文件冲突交主 Agent 合并，子 Agent 不各自覆盖整文件。

### 12.6 D22–D24：隔离、提示和文档

**SA-D22 测试设施与协议样本**

- 文件：`playwright.config.ts`、`tests/e2e/fixture-server.ts`、`tests/e2e/native-helper.ts`、`tests/fixtures/native-cli.mjs`、`tests/helpers.ts`；新增 `tests/fixtures/conversations/` 脱敏数据和目标测试文件。
- 输入：各 adapter 的真实脱敏样本与 D01 合同。
- 实施：通过 DEVFLOW_TEST_PORT / DEVFLOW_TEST_RUN_DIR 参数化端口、state、SQLite、报告、下载与 trace；所有测试读取同一实例配置；模拟嵌套、慢启动、quota、服务退出、附件读取，保持真实 API/Store/Process Host。
- 输出：独立测试进程可并行，fixture 不可从生产开关启用。
- 不可改：生产固定服务端口、用户数据库、真实工具认证目录。
- 测试责任：为 U/I/E/A 各自准备必要 fixtures；隔离本身由 I24、E24 验证。
- 停止条件：共享 host build 可一次预建后只读复用，不能一边重建一边被其他测试替换。

**SA-D23 全角色恢复提示与能力说明**

- 文件：`packages/core/src/execution-guidance.ts`、`packages/runtime/src/profile-runtime.ts`、`runtime.ts`、`packages/bridge/src/{planner,review}.ts`；涉及的 `packages/skills/devflow-{plan,execute,test,review}/SKILL.md` 仅在需保持仓库内交接一致时增量修改。
- 输入：D04–D10 的能力事实和 manifest。
- 实施：规划/执行/复核/修复/aside 分别正确携带只读边界、父子恢复提示和附件说明；不自动重启完成/取消项；能力限制如实交接。
- 输出：所有实际 runtime 路径都覆盖，不仅 native profile 的开发分支。
- 不可改：不能在技能加入测试证明门禁、新增审批或平台监督职责；不更新用户全局 skills。
- 测试：I10–I13、I23–I24、E01、E13、E23。
- 停止条件：安装副本同步属于另外的显式交付步骤，仓库修改不等于已部署用户客户端。

**SA-D24 文档与实施收口**

- 文件：本文；`docs/guide/使用指南.md`、`docs/guide/使用与恢复指南.md` 的相应章节；必要 README 入口最小更新。
- 输入：D21–D23 的最终实现、已知能力限制、实际文件位置。
- 实施：记录原编号→实现位置→测试目标；更新真实使用、暂停/继续、文件限制和临时提问说明；删除被本次功能明确替代的旧 Tab/modal 操作说明。
- 输出：所有代码与测试代码已整合，公共类型静态检查可过，待正式测试目标齐备；记录实现未验证边界。
- 不可改：不把未执行测试标通过，不把文档勾选作为平台角色门禁。
- 测试责任：后续结果回填本文第 15 节；D24 本身完成不代表测试/复核/人工验收完成。
- 停止条件：存在漏接线/已知边界未实现则保持“进行中”，不能以只补核心页面结束范围。

## 13. 开发、测试、复核的执行安排

### 13.1 不可省略的阶段规则

**先完成正式计划中的全部开发任务，包括功能实现、端到端接线、异常与边界处理及测试代码，再进入单元、集成和 E2E 测试阶段。将独立测试目标分配给多个子 Agent 并行执行，各子 Agent 每条命令只指定一个测试类、文件或用例，并负责相关问题的定位、修复和重跑。某个目标失败不阻塞其他无关目标；不同测试层之间不设固定先后顺序。仅有真实依赖或共享资源冲突的目标需要协调、隔离或局部串行。禁止无筛选的全量命令、全库通配符和一次拼接多个测试目标；受影响回归也按独立目标分派并行，不因局部修改重跑整个套件。**

实施顺序是：**全部开发及测试代码完成 → 多个子 Agent 并行负责独立的单元/集成/E2E 目标 → 各自修复与定向重跑 → 汇总结果 → 独立代码质量复核 → 人工功能验收 → 人工后代码质量复核。**

- 开发中可以做静态类型检查、协议格式核对和编译准备，不把单模块正式测试先行伪装成整个范围完成。
- 测试阶段允许每个目标自行定位、修复和重跑；修复影响其他目标时只通知相关负责人，已经通过且未受影响的目标不重跑。
- 三层测试本次均适用，无预先豁免。真实客户端验证属于集成层，不能用浏览器测试替代。
- 以上是执行模型的工作安排，不是平台自动检查任务证明/子 Agent 数量的新门禁；复核只看实现质量，不审计测试声明。

### 13.2 依赖图与并行开发

~~~mermaid
flowchart TD
  D1["D01 合同冻结"] --> A["D02/D03 树与遥测"]
  D1 --> B["D04-D08 八工具适配"]
  D1 --> C["D11-D14 附件与提问"]
  D1 --> U["D16-D20 交互组件"]
  D1 --> F["D22 隔离与样本"]
  A --> P["D09/D10 控制与恢复"]
  A --> Q["D15 查询"]
  P --> J["D21 整合"]
  Q --> J
  C --> J
  U --> J
  B --> K["D23 提示与能力"]
  P --> K
  J --> Z["D24 全部实现与测试代码收口"]
  K --> Z
  F --> Z
  Z --> T["独立单元/集成/E2E 目标并行"]
  T --> R["并行独立代码复核与汇总"]
  R --> H["人工功能验收"]
  H --> R2["人工后代码复核"]
~~~

图中的大分组可交错开发。例如前端按 D01 DTO 实现不必等八种适配器完成；文件上传不等待暂停恢复；D07 四个工具不互相依赖。跨组调用在 D21 接通，不以虚构前置条件强制串行。

建议以主 Agent + 最多 3 个活动子 Agent 起步，随本机资源和实际客户端并发能力调节，不能擅自更换或降低用户的模型/思考配置。

| 开发工作包 | 原任务 | 子 Agent 输入/输出与文件边界 |
|---|---|---|
| 树和控制 | D02、D03、D09、D10、D15 | 输入 D01；输出领域服务、运行事实、控制结果；负责 core/runtime/conversation 新模块；engine/runtime 公共整合由主 Agent 协调唯一写入人 |
| 原生工具 | D04–D08 | 各自 adapter 专属目录及脱敏样本；共享 sdk/invocation 修改提给主 Agent；各工具可并行或按空余槽分批 |
| 文件和提问 | D11–D14 | 新 service/routes，attachment 与 aside 索引；不得同时改 server.ts 总路由文件 |
| 交互界面 | D16–D20 | 专属新组件/hooks/css；D18 owner 唯一修改 composer/interactions，D17 owner 修改 execution-panel，main 由主 Agent 整合 |
| 测试设施 | D22 | fixture 端口/路径与样本；主 Agent 固定共享 helper 修改窗口，不打断无关组件开发 |
| 主协调 | D01、D08 公共接线、D21、D23、D24 | 合同/共享文件、冲突合并、影响核查和原任务进度；不替每个子 Agent重做其任务 |

子 Agent 委派消息必须带：本文完整路径、原任务编号、依赖 DTO、允许修改文件、输入输出、工作区/资源归属、测试代码责任、不得另建计划。主 Agent 在现有槽位空出后派下一工作包，不要求所有表格行同时启动。

### 13.3 工作区、数据库和测试资源隔离

- 当前工作树改动很多，实施先记录 staged/unstaged/untracked 基线。若使用 worktree，必须显式带入本计划所依赖的当前工作树改动；只从 HEAD 创建一个空白 worktree 会遗漏已读基础，不能宣称等价基线。
- 新建分支沿默认前缀 `zxw/`，不覆盖用户现有分支。共享接口由一个 owner 修改，其他 Agent 的独立模块可用独立工作树或明确文件所有权。
- 依赖用现有 pnpm lockfile；需要新 worktree 依赖时按冻结 lockfile 安装，不复制主目录 node_modules。
- 每个集成目标使用独立临时 Git 仓库、SQLite、storage_root、输入文件目录和测试原生会话目录；绝不使用 `.devflow/devflow.sqlite` 中真实任务。
- 每个 E2E 执行进程使用独立的空闲端口、human_origin、DEVFLOW_TEST_RUN_DIR、state 文件、浏览器上下文、下载目录、trace、JSON/HTML 报告及 Playwright outputDir。先做端口占用检查，再启动真实测试服务。
- 当前固定 14811、.cache/e2e-state.json、.cache/e2e-report.json 是真实冲突，不在 D22 修好前并行启动多份 Playwright。
- Windows Process Host 由主 Agent一次构建并固定只读产物，各目标只读使用；需要修改 host 时先协调依赖目标，不全局停止不相关单元测试。
- 测试修复修改共享文件时，由一个负责人修复；其他读取该文件的目标协调暂停/换隔离工作区。非共享目录持续推进。
- 模型真实集成验证逐工具明确 quota/授权边界，先使用无业务写入的短小委派任务；没有账号或工具能力就记受阻，不能拿生产任务作验证。
- 未安装客户端不自动安装/升级；执行者报告对应 A 编号未验证。该项是否可随明确限制交付由用户决定，不能静默删掉范围。

### 13.4 测试任务分组和单目标命令

| 执行工作包 | 可并行的目标 | 允许修复位置 | 真实依赖 |
|---|---|---|---|
| SA-T01 规则与状态 | U01–U10、U19–U20 的独立文件 | contracts/core/reducer/presentation 相关实现及目标测试 | 代码已整合；公共类型修改需主协调 |
| SA-T02 适配协议 | U11–U18、A01–A08 | 各 adapter/source/原生输入及各自 fixtures | 真实客户端账号/版本；同一客户端不可同时争抢同一原生会话 |
| SA-T03 存储/控制/输入集成 | I01–I24 的独立文件 | 对应服务、runtime、API 和该目标测试 | 隔离 DB/host/端口已准备 |
| SA-T04 浏览器 | E01–E24 的独立文件或用例 | 对应 UI/服务接线与该目标测试 | 真实应用/后端/Store 及独立浏览器资源 |
| 主 Agent | 汇总、类型检查、构建、跨模块合并 | 唯一公共 owner 文件 | 根据实际共因协调，不重跑每个通过目标 |

每条命令只选一个文件或一个用例。例如：

~~~powershell
pnpm exec vitest run tests/unit/conversation-reducer.test.ts
~~~

~~~powershell
pnpm exec vitest run tests/integration/conversation-control.test.ts
~~~

~~~powershell
pnpm exec playwright test tests/e2e/subagent-navigation.spec.ts
~~~

多个独立目标分派给不同 Agent，而不是在同一条命令拼接多个文件。测试目标通过后无需重复重跑；最终统一执行 `pnpm run typecheck` 和 `pnpm run build` 各一次，有后续影响编译的改动时再重验。禁止使用 `pnpm test`、`pnpm run check` 或无筛选的 `test:e2e` 作为本期验收捷径。

上面的新文件名是本计划确定的目标文件，执行者可在文件内组织具体测试函数；新增其他目标必须仍映射原 U/I/E/A 编号，不能改变验证范围。

## 14. 测试责任与人工验收

本节列出 **76 项测试责任：单元 20 项、集成 32 项（含 8 个真实工具验证）、E2E 24 项**。每项下面的“目标文件”可承载多个断言；责任编号不等于运行结果。当前全部未执行。

### 14.1 单元 U01–U20

| ID | 目标文件（tests/unit/） | 场景与必须断言的结果 |
|---|---|---|
| SA-U01 | conversation-reducer.test.ts | 同名子节点、不同 adapter 相同原生 ID、三层树；不串节点、不自引用、不成环，unknown parent 可补齐 |
| SA-U02 | conversation-display.test.ts | starting/running 计 N，waiting/paused/failed/unknown 分列；去重、stale 降级、0 和全完成显示正确 |
| SA-U03 | conversation-view.test.ts | 深层路径、祖先返回、非法 ID、每会话滚动/草稿恢复；child 输入区不可渲染 |
| SA-U04 | conversation-input.test.ts | actual/requested/unknown/not-applicable 的模型强度优先级；旧对象无 effort 不伪造；文件单独消息与禁用状态 |
| SA-U05 | conversation-input.test.ts | /btw、/side、空问题、命令 token 边界、正文含命令、转义、代码围栏、大小写及 mode 验证 |
| SA-U06 | conversation-reducer.test.ts | root/child 重复 activity ID 与 step_index 不覆盖；child model/session/quota 不改 root |
| SA-U07 | conversation-reducer.test.ts | 重复/乱序/迟到事件，completed 不倒退；新 attempt 才能重新 running |
| SA-U08 | conversation-reducer.test.ts | source cursor 复读、文件截断/轮换、超长行、恶意路径、无归属来源；不重放、不读越界 |
| SA-U09 | conversation-reducer.test.ts | 多 Run 同一续接链与不同 role 新根，旧树保留、旧 control 不影响新根 |
| SA-U10 | conversation-files.test.ts | 数量/大小/hash/名称/MIME/ready 校验，ready 不可覆盖、被引用不可删、TTL 排除已引用 |
| SA-U11 | codex-conversation-source.test.ts | Codex 真实脱敏样本：创建、嵌套、活动、暂停、恢复、quota；未知版本事件不误识别 |
| SA-U12 | agy-conversation-source.test.ts | agy 委派与子 step 归属；不可读/加密元数据不猜测，不从父输出构造子明细 |
| SA-U13 | claude-conversation-source.test.ts | hook/stream/transcript 去重、agent_id 绑定、恢复能力与只读子工具限制 |
| SA-U14 | cursor-conversation-source.test.ts | Cursor 有/无结构子字段、根/子分流、能力降级与文件输入参数 |
| SA-U15 | grok-conversation-source.test.ts | Grok 子 Agent 默认不再被禁；只读委派保留写限制；未知字段不冒充已支持 |
| SA-U16 | kimi-conversation-source.test.ts | Kimi session/child 状态与计划模式、异常退出、文件/图片能力处理 |
| SA-U17 | qoder-conversation-source.test.ts | Qoder 委派白名单、只读权限边界、agent/session 不串和恢复标识 |
| SA-U18 | opencode-conversation-source.test.ts | OpenCode 当前实例/session 绑定、children/activity/abort 结果、task 权限及外部实例拒绝 |
| SA-U19 | conversation-recovery.test.ts | 恢复集合排除 completed/cancelled，保留 paused/interrupted/quota；嵌套归原父、清单 hash/idempotency、用户暂停撤销重试 |
| SA-U20 | project-asides.test.ts | 稳定排序与 1/N、快照游标、ID 选择保留、跨项目游标拒绝、来源任务及迟到 complete/cancel 竞争 |

### 14.2 集成 I01–I24

| ID | 目标文件（tests/integration/） | 真实模块交互与预期 |
|---|---|---|
| SA-I01 | conversation-observation.test.ts | adapter 事件→observer→真实 SQLite snapshot/events；树与 cursor 原子一致，重建后同结果 |
| SA-I02 | conversation-observation.test.ts | 同一 Run 的父子并发活动与重复 step：各自可查，根身份/usage 不被子污染；legacy agy 路径同样覆盖 |
| SA-I03 | conversation-adapters.test.ts | 八 adapter 的版本化 fixture 经过真实 decode/路由，所有支持的事件进入正确节点，能力缺口准确返回 |
| SA-I04 | conversation-readonly.test.ts | 规划、开发测试、人工前后复核、修复各用途创建子节点；只读委派的写操作被原生/受控边界拒绝 |
| SA-I05 | conversation-api.test.ts | 树、祖先、历史分页和节点归属校验；相同 cursor 重查不重复，越 workflow 节点拒绝 |
| SA-I06 | conversation-control.test.ts | root + child + grandchild 全暂停；只有确认退出才 paused，control 幂等 |
| SA-I07 | conversation-control.test.ts | 暂停中迟到 spawn/后台子会话/慢 stop，补停且 partial 明确；主进程退出不伪造全停 |
| SA-I08 | conversation-control.test.ts | 旧 generation stop 与新 Run、完成与暂停竞争；不能停止新树或复活已完成任务 |
| SA-I09 | conversation-control.test.ts | 服务在控制中崩溃，重启读 control 继续核对；其他 workflow/aside/外部进程未被停止 |
| SA-I10 | conversation-recovery.test.ts | 额度中断后复用原配置/purpose 恢复，manifest 真正进入目标 invocation，delivered≠observed |
| SA-I11 | conversation-recovery.test.ts | 先恢复父再嵌套恢复，native resume 与确认退出后 recreate，旧新节点关联；已完成不重跑 |
| SA-I12 | conversation-recovery.test.ts | quota timer 与人工暂停、配置改变、重复 outbox/重复 recover 竞争，最多一个有效新 Run |
| SA-I13 | conversation-recovery.test.ts | 原生恢复失败、再次额度不足、缺可靠 reset 时间、旧进程仍活着：状态和重试符合第 7 节 |
| SA-I14 | conversation-files.test.ts | 真实二进制上传/原子写/hash/下载；JSON bodyLimit 未全局放宽，20 MiB 与100 MiB 边界生效 |
| SA-I15 | conversation-files.test.ts | 越任务文件、伪 ID、路径穿越、SVG/HTML、上传中断/磁盘错误；不越界、不 ready、不执行内容 |
| SA-I16 | conversation-files.test.ts | 上传请求幂等、重复内容不覆盖、移除/TTL/消息引用竞争、重启遗留 .part 处理 |
| SA-I17 | conversation-messages.test.ts | formal/planning/functional/aside 四路径真正把文件内容交给原生 fixture，重启/恢复仍可读同 hash |
| SA-I18 | conversation-messages.test.ts | slash 分流、文件单独消息、未知能力拒绝、重复请求只一条；校验失败前不停止主树 |
| SA-I19 | project-asides.test.ts | 同项目两任务超过50条历史，分页/位置/新问题快照一致；另一项目不可见 |
| SA-I20 | project-asides.test.ts | active+queued 限制、取消与完成竞争、转正式反馈原属任务幂等；主反馈 cursor 未因只读提问变化 |
| SA-I21 | conversation-catchup.test.ts | snapshot/WebSocket/catchup 竞争、断线补齐、旧 workflow 响应迟到，节点/活动只应用一次；用 200 节点/20,000 活动验证第 11.3 节分页预算、查询索引和观察器释放 |
| SA-I22 | conversation-compatibility.test.ts | 旧 SQLite/旧事件/旧 Run 不含子字段仍可读；新索引反复初始化与 aside 回填不改旧内容 |
| SA-I23 | conversation-compatibility.test.ts | 原 feedback/stop/recover/asides/授权入口保持原结果；授权卡需显式决定，不因恢复或消息绕过 |
| SA-I24 | conversation-lifecycle.test.ts | 规划未批准恢复、review phase 保留、后台子存活、主交付不加观察门禁；隔离测试实例资源不相互停止 |

### 14.3 真实工具集成 A01–A08

每项使用独立临时工作区和该工具真实安装版本，短任务要求“主 Agent 启动一个子 Agent 只读列出临时目录中的固定文件，再汇报”；随后用另一个短任务验证暂停/恢复和本工具支持的文件读取。开发模式写权限的测试只写本测试临时文件。额度分支用脱敏协议样本/受控故障注入，不真实耗尽账号额度。

| ID | 目标文件（tests/live/，集成层） | 核验与记录 |
|---|---|---|
| SA-A01 | codex-subagents.ts | Codex 实际版本、子身份、独立活动/model/effort、精确暂停/恢复及文件能力 |
| SA-A02 | agy-subagents.ts | agy 真实子会话、活动读取、父子隔离、停止范围与恢复 |
| SA-A03 | claude-subagents.ts | Claude hook/stream/transcript 关联及只读子 Agent 写拒绝，真实恢复支持 |
| SA-A04 | cursor-subagents.ts | Cursor 当前版本暴露的子活动/控制/输入能力，缺口不能按样本结果冒充通过 |
| SA-A05 | grok-subagents.ts | 去掉禁用后实际创建成功；规划/复核委派仍只读 |
| SA-A06 | kimi-subagents.ts | Kimi 真实委派、session 归属、计划模式限制及恢复 |
| SA-A07 | qoder-subagents.ts | Qoder 真实可执行文件、委派白名单、只读继承及模型输入 |
| SA-A08 | opencode-subagents.ts | 本 Run 原生实例绑定、children/activity/abort、只读 task 和恢复 |

每项结果填写 `verified / blocked / unsupported` 和具体原因、版本、日期、原始脱敏样本位置。安装/帮助成功不等于子 Agent 可用；样本测试通过不等于真实模型可调用。能力未确认的适配器不进入“八工具全支持”的完成口径。

### 14.4 浏览器 E2E E01–E24

所有 Web E2E 都用真实浏览器连接真实前端、API、SQLite和测试执行进程。外部模型可使用生产不可启用的确定性原生 CLI fixture；浏览器业务 API不得全链路拦截返回固定数据。八工具真实协议另由 A01–A08 覆盖。

| ID | 目标文件（tests/e2e/） | 用户操作及必须观察的业务结果 |
|---|---|---|
| SA-E01 | subagent-working.spec.ts | 分别进入规划、开发测试、两道复核/整改，实际执行 fixture spawn 后 UI出现正确工作卡和角色 |
| SA-E02 | subagent-working.spec.ts | 同时 running/waiting/failed，名称与当前工作逐项更新；状态与 API 重查一致 |
| SA-E03 | subagent-working.spec.ts | × 仅收起；Working N 准确；再次展开、刷新保持偏好；控制 API没有被调用 |
| SA-E04 | subagent-navigation.spec.ts | 点 child 再点 grandchild，各只显示自己的命令和结果；返回祖先可读原日志 |
| SA-E05 | subagent-navigation.spec.ts | 子视图 DOM 无输入框/+ /发送/aside；返回主层文字、附件、滚动和浮窗选择恢复 |
| SA-E06 | conversation-composer.spec.ts | 不点击旧按钮直接输入；Enter/Shift+Enter/IME；发送产生一次正确反馈，失败保留草稿 |
| SA-E07 | conversation-composer.spec.ts | 实际模型/强度与请求模型区分；切子视图数据正确，未报告不填父值；当前工作随事件更新 |
| SA-E08 | conversation-files.spec.ts | + 上传真实临时图片/文本，显示 ready 后发送；刷新可查消息与附件，原生 fixture 读到固定内容 |
| SA-E09 | conversation-files.spec.ts | 拖文件、粘贴图片、@ 引用、文件单独发送，以及 /btw 附件；模型输入路径和内容都验证 |
| SA-E10 | conversation-files.spec.ts | 超大/超数、上传失败、能力不支持、删除重试、切任务：失败不丢草稿也不错误发送 |
| SA-E11 | subagent-control.spec.ts | 点击暂停全部，真实测试进程/子进程停止且页面逐项确认；继续只恢复原未完成项 |
| SA-E12 | subagent-control.spec.ts | 子视图暂停作用域清楚；后台/迟到/未确认 child 显示 partial，不能重复启动；另一个任务继续工作 |
| SA-E13 | subagent-control.spec.ts | 注入 quota 中断→继续，检查恢复提示实际传入，显示等待/已恢复数量；手动暂停取消旧自动重试 |
| SA-E14 | aside-popover.spec.ts | 无临时提问 Tab；/btw 与 /side 各成功创建独立提问，普通文本仍走正式反馈 |
| SA-E15 | aside-popover.spec.ts | 回答卡位于输入框上方、无 backdrop；浮窗外可点击日志/输入，Esc只关闭显示，回答继续 |
| SA-E16 | aside-popover.spec.ts | 同项目两任务 7 条提问，默认最新 1/7，左右逐条切换；取消/失败记录也可查看 |
| SA-E17 | aside-popover.spec.ts | 看旧问题时收到新回答不抢选中；刷新/翻页不丢历史；跨项目不出现旧项目提问 |
| SA-E18 | aside-popover.spec.ts | 主执行持续时提问并取消，只停止该 aside 树；主工作流状态、反馈cursor、Working N不变 |
| SA-E19 | aside-popover.spec.ts | 把历史回答转正式反馈草稿再发送，作用于标明的原任务且只产生一次反馈，附件仍可读 |
| SA-E20 | conversation-resilience.spec.ts | WebSocket 断开后重连、回补，主子活动无重复/丢失；刷新与浏览器前进后退会话正确 |
| SA-E21 | conversation-resilience.spec.ts | 320px/520px 侧栏、长名称、大量子节点、键盘导航；浮窗/输入不越屏，状态计数完整 |
| SA-E22 | interactions.spec.ts | 回归旧新建任务、规划反馈、工作区引用、操作批准/拒绝；共享 composer 改造未破坏必填/提交 |
| SA-E23 | review-pause-resume.spec.ts | 回归 planning/quality_review/functional fix 暂停继续，用途/phase保持；不能意外开始开发 |
| SA-E24 | native-delivery-display.spec.ts | 回归正常交付/质量轮次/附件归档失败显示；无子观察数据仍可正常完成，测试实例互不干扰 |

此外按实际 diff 定向复用现有 `devflow-v2-aside.spec.ts`、`activity-resilience.spec.ts`、`run-telemetry.spec.ts`、`runtime-failure.spec.ts` 及对应 integration 目标，把旧断言更新为新需求；不能简单删除失败断言让旧功能无人验证。与 E22–E24 有重复责任时记录映射，无须重复执行同一行为多次。

### 14.5 独立代码质量复核

自测结束后使用不同于实现自查的复核子 Agent并行进行：

| 复核 ID | 负责范围 | 必查问题 |
|---|---|---|
| SA-Q01 | 身份、状态、适配器、观察链 | 根子身份污染、事件顺序、作用域、未知状态、只读继承、版本事实 |
| SA-Q02 | 暂停、恢复、额度、进程边界 | 迟到 stop 杀新 Run、重复恢复、误重跑完成任务、漏恢复嵌套、用户暂停被自动重启 |
| SA-Q03 | 输入、附件、aside、Web UI | 发送前校验、文件归属与真实交付、跨项目/任务混淆、浮窗语义、草稿与刷新兼容 |
| 主审 | 跨模块与需求遗漏 | R01–R16 实现完整性、统一服务是否真接线、公共文件冲突、可维护性和原有业务回归风险 |

- 复核只检查代码遗漏、正确性、边界和维护性，不核验测试证明、不重新运行测试、不另造功能验收模型。
- 发现问题按原 D/R 编号记录可执行修复意见；先核清同轮全部已知根因，再整批修复和定向测试，禁止每个小修反复跑全量。
- 人工功能确认之前完成第一道独立代码复核；人工反馈修复后，按既有流程做人工后代码复核。两道结果单独记录。
- 子 Agent工作状态 UI不会把“代码复核通过”自动等同“用户已验收”。

### 14.6 人工验收 H01–H12

| ID | 用户实际操作 | 接受条件 | 当前状态 |
|---|---|---|---|
| SA-H01 | 观察规划/开发/测试/复核中的真实子 Agent | 名称、工作和状态符合实际，无静默缺失的已支持工具 | 未开始 |
| SA-H02 | 收起/展开工作卡 | × 不停止任务，Working N 与正在运行数量一致 | 未开始 |
| SA-H03 | 进入二层及更深子 Agent后返回 | 层级清楚、日志不混、祖先可点 | 未开始 |
| SA-H04 | 检查子视图与主视图输入 | 子视图完全隐藏，返回主视图草稿和附件还在 | 未开始 |
| SA-H05 | 直接发送指导 | 无旧展开按钮，当前工作/工具/模型/强度可理解，发送语义清楚 | 未开始 |
| SA-H06 | 上传图片和文件并要求模型引用内容 | 模型实际读取成功，失败提示具体，附件可查看 | 未开始 |
| SA-H07 | 用 /btw、/side 提问 | 没有临时提问 Tab，主工作不中断 | 未开始 |
| SA-H08 | 操作浮窗及 1/7 历史导航 | 无蒙层，位置正确，一次一条，同项目历史可追溯来源 | 未开始 |
| SA-H09 | 暂停然后继续含多层子 Agent的工作 | 主子都纳入控制，真实未停项不隐瞒，恢复不重做已完成项 | 未开始 |
| SA-H10 | 演示额度中断恢复 | 原负责人收到清单，异常/暂停子任务被恢复或明确说明不能恢复 | 未开始 |
| SA-H11 | 刷新、切任务、断线重连 | 会话归属、历史、草稿和活动状态可信，其他项目不混入 | 未开始 |
| SA-H12 | 核对本文进度及限制 | 每项有实现位置/真实结果，未验证客户端如实列出，不把计划当成果 | 未开始 |

## 15. 里程碑、进度填写与交付

### 15.1 里程碑

| 里程碑 | 包含范围 | 完成定义 | 当前状态 |
|---|---|---|---|
| SA-M0 设计基线 | 本文 R/D/U/I/A/E/Q/H 合同 | 用户可审阅同一份完整方案与计划 | 文档已形成，待确认 |
| SA-M1 合同与基础模块 | D01–D08、D11、D14、D22 可交错推进 | 会话事实/上传/索引/工具能力实现及测试代码可整合 | 未开始 |
| SA-M2 端到端完整开发 | 全部 D01–D24 | UI、全部服务接线、异常恢复、权限与测试代码完成；静态集成无遗留错误 | 未开始 |
| SA-M3 并行自测 | T01–T04、U/I/A/E | 各责任的实际结果齐备，受阻项单列，修复后定向重跑 | 未开始 |
| SA-M4 人工前代码复核 | Q01–Q03 + 主审 | 实现缺陷已修复并完成本轮独立复核 | 未开始 |
| SA-M5 人工功能验收 | H01–H12 | 用户确认功能符合需求；未接受项回到原任务修复 | 未开始 |
| SA-M6 人工后复核与交付 | 人工后 Q、文档、构建及部署说明 | 最终代码复核完成，能力限制和部署结果如实记录 | 未开始 |

不承诺“某天一定完工”或按模型轮次估算工期。任务依赖、并行分工和完成条件已经固定；真正进度以已落地结果更新，不靠耗时猜百分比。

### 15.2 进度计算规则

显示四个独立进度，禁止混成一个 100%：

1. **开发实现**：达到“已实现待测”及以后状态的 D 项数 / 24。
2. **测试验证**：通过的 U/I/A/E 责任数 / 76；受阻、跳过和 unsupported 均不算通过，同时单列原因。一个责任含多分支时所有规定分支完成才通过。
3. **独立复核**：人工前和人工后分别记录 Q01/Q02/Q03/主审结果，不能用执行 Agent 自查代替。
4. **人工验收**：用户接受的 H 项数 / 12。模型不得自行勾选。

D07 及其他多工具任务不得因部分工具完成而改为整项完成。需要展示细进度时在该任务备注内按 adapter 列出，不拆掉原任务降低分母。用户若接受某原生版本的明确能力限制，必须在本文变更记录说明批准的范围变化及对应验收调整。

### 15.3 实施日志模板（只在本文追加事实）

| 日期 | 原任务/需求 | 执行负责人 | 实现位置/提交 | 状态变化 | 测试目标及结果 | 阻塞/下一步 |
|---|---|---|---|---|---|---|
| 2026-09-20 | SA-M0、SA-R01–R16 | 规划 | 本文 | 形成设计，开发未开始 | 仅文档检查；产品测试未运行 | 等待用户确认实施范围 |

每次任务状态变化至少更新相应 D 行和一条日志。测试结果写实际命令、时间、环境隔离目录、退出码和通过/失败/受阻；报告路径只作可选查看材料，不是平台准入条件。

### 15.4 未完成项台账模板

| 问题 ID | 关联 R/D/U/I/A/E/H | 实际问题与影响 | 责任人 | 决定/修复位置 | 状态 |
|---|---|---|---|---|---|
| 暂无实施问题记录 | — | 目前尚未实施；八工具真实验证均未进行 | — | 开发时按真实结果填写 | — |

代码复核发现缺陷使用稳定 `SA-F001` 起的编号；关闭时附修复文件及受影响的目标结果。原生工具能力缺口与代码缺陷分开记录，不把“没有凭据”写成“功能测试通过”。

### 15.5 交付检查

- [ ] D01–D24 完整实现及端到端接线，未擅自减少工具/角色/恢复/附件范围。
- [ ] 用户已有工作树改动、计划、工作区、账号和真实任务状态保留。
- [ ] U/I/A/E 结果逐项真实记录，单元/集成/E2E 均有覆盖；真实工具未验证项突出说明。
- [ ] 主 Agent 汇总并去重并行复核意见，人工前代码复核完成。
- [ ] 用户完成 H01–H12 功能验收；反馈修复沿原编号追踪。
- [ ] 人工后代码复核完成，必要的定向回归和最终类型检查/构建通过。
- [ ] 使用指南与恢复说明同步，旧 Tab/modal 使用说明已移除。
- [ ] 数据升级、回退和真实部署安排写清，未自动恢复任何人工暂停任务。
- [ ] 最终交付只声称实际完成的工具能力；delivered 不冒充 resumed，未知不冒充成功。

### 15.6 本次规划的验证边界

本次只读取当前代码、现有计划和必要官方资料，写本文。未修改源代码，未执行产品单元/集成/E2E，未新建或审批 DevFlow 工作流，未消耗额度验证真实模型，未操作暂停/继续、用户原生会话或数据库迁移。本文中拟新增的文件/API/测试是开发合同，不表示当前已经存在。

文档检查：24 个开发任务、76 个测试责任和 12 个人工验收编号完整且各自唯一；本地正式引用链接有效；代码围栏配对和 JSON 示例解析通过；4 张 Mermaid 图均通过本地 Mermaid 解析器语法检查。这些是文档检查，不是产品实现或测试通过。

实施者开始前完整阅读本文及第 0.2 节正式引用，核对当前工作树差异。若基线改变，只核对受影响设计，不另建替代计划；必要修订直接更新本文版本、变更记录和受影响原编号。

## 16. 版本记录

| 版本 | 日期 | 变更 | 实施授权/状态 |
|---|---|---|---|
| v1.0 | 2026-09-20 | 基于附件交互和当前工作树形成统一会话树、常驻输入、附件、临时提问、暂停恢复设计；24 项开发任务、76 项测试责任、12 项人工验收 | 仅规划，未启动实施 |
