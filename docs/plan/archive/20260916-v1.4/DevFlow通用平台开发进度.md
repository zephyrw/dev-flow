# DevFlow 通用平台开发进度（1.4）

唯一任务：DevFlow v1.0 跨平台与八工具通用平台完整开发；wf-508be4f4-4c5a-453c-9ac6-c6dafe717a08。

## 当前状态

用户选择主工作区最新已提交版本，基线更新为6eb47cca18dc65397aab125e96eb329cecc344d2；没有执行分支或Run，批准后从此版本创建。未提交业务修改保持原处；新版文档通过批准正文带入。新增代码起点选择与合并主工作区按钮的设计、开发和测试合同；功能尚未实现。当前共88细项、275用例，全部实现not_started、测试not_run。

## 完整顺序与细项

P00→P01→P02→P03→P04→P05→P06→P07→P11→P12→P08→P09→P10。P12增量估算8工程工作日；继续使用同一个工作流。

| 模块 | 细项数 | 实现完成 | 测试通过 |
|---|---:|---:|---:|
| P00 基线与接入 | 4 | 0 | 0 |
| P01 配置和适配器合同 | 4 | 0 | 0 |
| P02 跨平台宿主 | 5 | 0 | 0 |
| P03 通用运行器 | 4 | 0 | 0 |
| P04 八工具适配 | 8 | 0 | 0 |
| P05 Skill与客户端安装 | 11 | 0 | 0 |
| P06 流程模板与测试角色 | 4 | 0 | 0 |
| P07 工具与浏览器网关 | 4 | 0 | 0 |
| P11 任务级工具模型组合与执行中交互 | 20 | 0 | 0 |
| P12 代码起点选择与合并主工作区 | 10 | 0 | 0 |
| P08 安装器和发布包 | 5 | 0 | 0 |
| P09 迁移与完整验收 | 6 | 0 | 0 |
| P10 开源交付与发布准备 | 3 | 0 | 0 |

| 细项 | 内容 | 实现 | 测试 |
|---|---|---|---|
| P00-01 | 冻结当前代码与方案输入 | not_started | not_run |
| P00-02 | 提供受管命令与隔离预览入口 | not_started | not_run |
| P00-03 | 锁定跨平台构建工具链 | not_started | not_run |
| P00-04 | 生成可公开源码与排除清单 | not_started | not_run |
| P01-01 | 定义 v2 配置与单工具约束 | not_started | not_run |
| P01-02 | 持久化 Profile 修订和模型证据 | not_started | not_run |
| P01-03 | 实现版本化适配器 SDK | not_started | not_run |
| P01-04 | 定义四角色结果与子测试执行合同 | not_started | not_run |
| P02-01 | 实现 Go Host JSONL 控制协议 | not_started | not_run |
| P02-02 | 实现 Windows Job 和单控制器锁 | not_started | not_run |
| P02-03 | 实现 macOS/Linux 进程组与锁 | not_started | not_run |
| P02-04 | 解析跨平台路径与真实 CLI 入口 | not_started | not_run |
| P02-05 | 接入 Host 与稳定服务启动器 | not_started | not_run |
| P03-01 | 将运行调度改为 Profile 驱动 | not_started | not_run |
| P03-02 | 统一流式事件与厂商解码边界 | not_started | not_run |
| P03-03 | 实现受管 MCP 完成和测试结果提交 | not_started | not_run |
| P03-04 | 统一中止、恢复及任务交接 | not_started | not_run |
| P04-01 | Codex CLI 四角色执行适配 | not_started | not_run |
| P04-02 | Antigravity CLI 四角色执行适配 | not_started | not_run |
| P04-03 | Grok Build 四角色执行适配 | not_started | not_run |
| P04-04 | Claude Code 四角色执行适配 | not_started | not_run |
| P04-05 | Kimi Code 四角色执行适配 | not_started | not_run |
| P04-06 | Qoder CLI 四角色执行适配 | not_started | not_run |
| P04-07 | OpenCode 四角色执行适配 | not_started | not_run |
| P04-08 | Cursor Agent CLI 四角色执行适配 | not_started | not_run |
| P05-01 | 改写七个中立 Skill 的流程正文 | not_started | not_run |
| P05-02 | 编译并验证各客户端 Skill 产物 | not_started | not_run |
| P05-03 | 实现客户端配置安装事务 | not_started | not_run |
| P05-04 | Codex CLI 入口集成安装 | not_started | not_run |
| P05-05 | Antigravity CLI 入口集成安装 | not_started | not_run |
| P05-06 | Grok Build 入口集成安装 | not_started | not_run |
| P05-07 | Claude Code 入口集成安装 | not_started | not_run |
| P05-08 | Kimi Code 入口集成安装 | not_started | not_run |
| P05-09 | Qoder CLI 入口集成安装 | not_started | not_run |
| P05-10 | OpenCode 入口集成安装 | not_started | not_run |
| P05-11 | Cursor Agent CLI 入口集成安装 | not_started | not_run |
| P06-01 | 实现模板 schema 和 DAG 编译 | not_started | not_run |
| P06-02 | 实现节点调度及测试 Agent 子执行 | not_started | not_run |
| P06-03 | 实现配置冻结与停止后切换 | not_started | not_run |
| P06-04 | 把总状态改为节点状态投影 | not_started | not_run |
| P07-01 | 实现 MCP ToolGateway 注册与权限 | not_started | not_run |
| P07-02 | 统一受管命令和 FileBroker 作用域 | not_started | not_run |
| P07-03 | 实现 Playwright 浏览器 Provider | not_started | not_run |
| P07-04 | 迁移 OpenTabs Provider 和旧场景 | not_started | not_run |
| P11-01 | 定义任务组合和叶子绑定合同 | not_started | not_run |
| P11-02 | 实现组合解析与任务级配置隔离 | not_started | not_run |
| P11-03 | 绑定节点与细项的执行身份 | not_started | not_run |
| P11-04 | 扩展八工具的交互能力声明 | not_started | not_run |
| P11-05 | 生成不可变三文档版本包 | not_started | not_run |
| P11-06 | 生成设计变更及受影响细项差异 | not_started | not_run |
| P11-07 | 约束进度与测试文档的权威来源 | not_started | not_run |
| P11-08 | 持久化正式调整及原子派发 | not_started | not_run |
| P11-09 | 停止旧执行并保存一致检查点 | not_started | not_run |
| P11-10 | 接入重新规划与变更审批 | not_started | not_run |
| P11-11 | 校验新执行读取收据与上下文确认 | not_started | not_run |
| P11-12 | 使变更后的测试验收证据正确失效 | not_started | not_run |
| P11-13 | 恢复中断的改向事务并拒绝迟到事件 | not_started | not_run |
| P11-14 | 构造临时问答的一致只读上下文 | not_started | not_run |
| P11-15 | 实现临时会话权限与内容隔离 | not_started | not_run |
| P11-16 | 调度临时提问与资源释放 | not_started | not_run |
| P11-17 | 提供正式指令和临时问答接口 | not_started | not_run |
| P11-18 | 交付任务搭配选择与细项覆盖界面 | not_started | not_run |
| P11-19 | 交付执行调整与临时提问面板 | not_started | not_run |
| P11-20 | 统一七Skill文档迁移与完整交互测试 | not_started | not_run |
| P12-01 | 定义代码输入与执行基线修订合同 | not_started | not_run |
| P12-02 | 读取源状态并生成稳定输入快照 | not_started | not_run |
| P12-03 | 暂停执行并保存目标工作检查点 | not_started | not_run |
| P12-04 | 在隔离区域预合并与保留输入祖先 | not_started | not_run |
| P12-05 | 展示冲突并校准同一任务计划 | not_started | not_run |
| P12-06 | 发布同步结果并恢复中断事务 | not_started | not_run |
| P12-07 | 适配快照提交证据与完整复核范围 | not_started | not_run |
| P12-08 | 提供源预览和主工作区同步接口 | not_started | not_run |
| P12-09 | 交付审批代码起点与合并按钮 | not_started | not_run |
| P12-10 | 实现同步回归及六平台Git认证 | not_started | not_run |
| P08-01 | 计算组件闭包并管理安装状态 | not_started | not_run |
| P08-02 | 交付 Windows 一行安装入口 | not_started | not_run |
| P08-03 | 交付 macOS/Linux 一行安装入口 | not_started | not_run |
| P08-04 | 构建六平台运行包和便携依赖 | not_started | not_run |
| P08-05 | 实现稳定 CLI 与安装维护命令 | not_started | not_run |
| P09-01 | 迁移旧配置及历史证据 | not_started | not_run |
| P09-02 | 实现更新回滚和清理所有权 | not_started | not_run |
| P09-03 | 交付安装向导和工具模型设置页 | not_started | not_run |
| P09-04 | 交付模板与辅助工具设置页 | not_started | not_run |
| P09-05 | 交付任务切换和维护界面 | not_started | not_run |
| P09-06 | 实现完整用例与真实认证证据汇总 | not_started | not_run |
| P10-01 | 完成 Apache 开源材料和用户指南 | not_started | not_run |
| P10-02 | 交付公开构建与受保护认证流水线 | not_started | not_run |
| P10-03 | 验证完整发布候选与交付清单 | not_started | not_run |

## 历史与本轮规划核验

1.3已将原58细项扩为78细项，143用例扩为237用例；误建空任务已移除，原工作流ID保持不变。1.4保留全部上述细项与用例，增加P12。

原r2基线为d5bc298ac5be27a28a9a641be8ef583486da2c1a，本轮按明确选择改为6eb47cca18dc65397aab125e96eb329cecc344d2。差异为7个已提交变更、52个文件；源当前未提交内容不算本次代码输入。

提交前校验同任务ID、版本、基线、全部旧用例保留、任务DAG与Mermaid渲染；提交结果随后追加。

本轮已提交原任务第3次计划修订，仍为待批准状态；基线6eb47cca18dc65397aab125e96eb329cecc344d2核对一致，服务自动导出的计划/开发进度/测试进度包含88细项与275用例。10张Mermaid图已解析与渲染，原237用例完整保留。没有执行分支、没有启动Run，代码输入变更通过plan.baselines落实。计划hash：b88565042c4719e1b10062864a90813b8245abbcd53eff13d16401e6ee0e0475。
