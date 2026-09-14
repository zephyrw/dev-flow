# DevFlow 通用平台验收合同（1.3）

所属任务：DevFlow v1.0 跨平台与八工具通用平台完整开发；workflow_id：wf-508be4f4-4c5a-453c-9ac6-c6dafe717a08。

当前实现测试状态：not_run。原143个PF用例保留；新增94个TC用例，共237个稳定ID。这是待执行合同，不是测试已通过报告。

## 执行与报告规则

P00-02提供scripts/devflow/verify.mjs。命令为node scripts/devflow/verify.mjs unit、integration、e2e、certification；复用登记命令及报告路径，报告写DEVFLOW_REPORT_PATH并保留真实退出码。Vitest用顶层it的fullName，Playwright用spec.title，JUnit不加classname使case.name等于清单ID。不能将没有运行的用例合成为passed。

普通确定性测试使用合成Profile与受控进程；TC-CERT才是付费/真实模型验证。已有PF-BROWSER的7个OpenTabs固定断言保持不变，验证真实浏览器适配兼容；新增复杂交互由TC-E2E真实API/Web、TC-CERT真实工具及人工验收验证。缺资源保存blocked及实际原因，不能豁免必需认证。

每条用例独立记录输入fixture、动作时间线、期望断言、实际输出、command/exit、原始报告路径和hash、源码/plan/spec/bundle/epoch；UI截图不能替代数据和进程证据。测试fixture的错误、故障注入与清理都只能影响本次隔离环境。

## PF-UNIT（26项）

原完整开发合同用例原样保留。

- 层次：unit；入口：unit；超时：7200秒
- 关联细项：P00-01, P00-02, P00-03, P00-04, P01-01, P01-02, P01-03, P01-04, P02-01, P02-02, P02-03, P02-04, P02-05, P03-01, P03-02, P03-03, P03-04, P04-01, P04-02, P04-03, P04-04, P04-05, P04-06, P04-07, P04-08, P05-01, P05-02, P05-03, P05-04, P05-05, P05-06, P05-07, P05-08, P05-09, P05-10, P05-11, P06-01, P06-02, P06-03, P06-04, P07-01, P07-02, P07-03, P07-04, P08-01, P08-02, P08-03, P08-04, P08-05, P09-01, P09-02, P09-03, P09-04, P09-05, P09-06, P10-01, P10-02, P10-03
- 操作：执行全部原有unit与新增portable单元测试；新用例覆盖配置语义、事件/路径边界、权限、DAG和安装事务，不镜像函数实现
- 断言：原有回归无新增失败；26个命名用例真实运行，零skip/零失败

| 稳定用例 ID | 当前状态 |
|---|---|
| PF-U-CONFIG | not_run |
| PF-U-SINGLE-TOOL | not_run |
| PF-U-PROFILE-FREEZE | not_run |
| PF-U-MODEL-EVIDENCE | not_run |
| PF-U-UTF8 | not_run |
| PF-U-UNKNOWN-TERMINAL | not_run |
| PF-U-PATHS | not_run |
| PF-U-EXECUTABLE | not_run |
| PF-U-DAG | not_run |
| PF-U-CHECK-CHILD | not_run |
| PF-U-DEPENDENCY-CLOSURE | not_run |
| PF-U-INSTALL-JOURNAL | not_run |
| PF-U-SKILL-COMPILER | not_run |
| PF-U-SKILL-OWNERSHIP | not_run |
| PF-U-TOKEN-SCOPE | not_run |
| PF-U-MIGRATION-HASH | not_run |
| PF-U-ROLLBACK | not_run |
| PF-U-EXPORT-SOURCE | not_run |
| PF-U-ADAPTER-codex | not_run |
| PF-U-ADAPTER-agy | not_run |
| PF-U-ADAPTER-grok-build | not_run |
| PF-U-ADAPTER-claude-code | not_run |
| PF-U-ADAPTER-kimi-code | not_run |
| PF-U-ADAPTER-qoder | not_run |
| PF-U-ADAPTER-opencode | not_run |
| PF-U-ADAPTER-cursor-agent | not_run |

## PF-INTEGRATION（48项）

原完整开发合同用例原样保留。

- 层次：integration；入口：integration；超时：7200秒
- 关联细项：P00-01, P00-02, P00-03, P00-04, P01-01, P01-02, P01-03, P01-04, P02-01, P02-02, P02-03, P02-04, P02-05, P03-01, P03-02, P03-03, P03-04, P04-01, P04-02, P04-03, P04-04, P04-05, P04-06, P04-07, P04-08, P05-01, P05-02, P05-03, P05-04, P05-05, P05-06, P05-07, P05-08, P05-09, P05-10, P05-11, P06-01, P06-02, P06-03, P06-04, P07-01, P07-02, P07-03, P07-04, P08-01, P08-02, P08-03, P08-04, P08-05, P09-01, P09-02, P09-03, P09-04, P09-05, P09-06, P10-01, P10-02, P10-03
- 操作：运行原有integration及56条AC中非真实模型部分；真实SQLite/进程/安装事务/HTTP/MCP/broker状态交互，报告绑定当前tree hash
- 断言：48个稳定AC用例均实际通过；错误哈希、虚假passed、权限越界、残留进程和配置冲突被拒绝

| 稳定用例 ID | 当前状态 |
|---|---|
| PF-AC-01 | not_run |
| PF-AC-02 | not_run |
| PF-AC-03 | not_run |
| PF-AC-04 | not_run |
| PF-AC-05 | not_run |
| PF-AC-06 | not_run |
| PF-AC-07 | not_run |
| PF-AC-08 | not_run |
| PF-AC-09 | not_run |
| PF-AC-10 | not_run |
| PF-AC-11 | not_run |
| PF-AC-12 | not_run |
| PF-AC-13 | not_run |
| PF-AC-14 | not_run |
| PF-AC-15 | not_run |
| PF-AC-16 | not_run |
| PF-AC-17 | not_run |
| PF-AC-18 | not_run |
| PF-AC-19 | not_run |
| PF-AC-20 | not_run |
| PF-AC-21 | not_run |
| PF-AC-22 | not_run |
| PF-AC-23 | not_run |
| PF-AC-24 | not_run |
| PF-AC-25 | not_run |
| PF-AC-26 | not_run |
| PF-AC-27 | not_run |
| PF-AC-28 | not_run |
| PF-AC-29 | not_run |
| PF-AC-30 | not_run |
| PF-AC-31 | not_run |
| PF-AC-32 | not_run |
| PF-AC-33 | not_run |
| PF-AC-34 | not_run |
| PF-AC-35 | not_run |
| PF-AC-36 | not_run |
| PF-AC-45 | not_run |
| PF-AC-46 | not_run |
| PF-AC-47 | not_run |
| PF-AC-48 | not_run |
| PF-AC-49 | not_run |
| PF-AC-50 | not_run |
| PF-AC-51 | not_run |
| PF-AC-52 | not_run |
| PF-AC-53 | not_run |
| PF-AC-54 | not_run |
| PF-AC-55 | not_run |
| PF-AC-56 | not_run |

## PF-E2E（8项）

原完整开发合同用例原样保留。

- 层次：e2e；入口：e2e；超时：7200秒
- 关联细项：P05-01, P05-02, P05-03, P05-04, P05-05, P05-06, P05-07, P05-08, P05-09, P05-10, P05-11, P06-01, P06-02, P06-03, P06-04, P07-01, P07-02, P07-03, P07-04, P09-01, P09-02, P09-03, P09-04, P09-05, P09-06
- 操作：执行原有Playwright与八个新场景；使用隔离端口/数据，浏览器从私有Playwright获取，真实API设置绑定与模板
- 断言：八工具目录无重复；单工具/组合保存持久化；报告状态真实且保留旧紧凑布局和执行侧栏

| 稳定用例 ID | 当前状态 |
|---|---|
| PF-E2E-CATALOG | not_run |
| PF-E2E-SINGLE-TOOL | not_run |
| PF-E2E-COMPOSED | not_run |
| PF-E2E-TEMPLATE | not_run |
| PF-E2E-SWITCH | not_run |
| PF-E2E-REPORTS | not_run |
| PF-E2E-MIGRATION | not_run |
| PF-E2E-COMPACT | not_run |

## PF-CERT（54项）

原完整开发合同用例原样保留。

- 层次：integration；入口：certification；超时：7200秒
- 关联细项：P02-01, P02-02, P02-03, P02-04, P02-05, P04-01, P04-02, P04-03, P04-04, P04-05, P04-06, P04-07, P04-08, P08-01, P08-02, P08-03, P08-04, P08-05, P09-01, P09-02, P09-03, P09-04, P09-05, P09-06, P10-01, P10-02, P10-03
- 操作：在精确目标OS/CPU的认证runner执行32单工具闭环、16组合闭环、6原生平台检查；真实CLI发起方案、改动、测试失败修复、报告以及人工后复核，汇总原始签名/哈希/版本证明
- 断言：全部54个认证用例有同一源码树的真实记录；账号/runner缺失和unsupported不计通过；OpenCode占位入口被识别、Antigravity项目与conversation正确

| 稳定用例 ID | 当前状态 |
|---|---|
| PF-LIVE-codex-windows-x64 | not_run |
| PF-LIVE-codex-darwin-x64 | not_run |
| PF-LIVE-codex-darwin-arm64 | not_run |
| PF-LIVE-codex-linux-x64 | not_run |
| PF-LIVE-agy-windows-x64 | not_run |
| PF-LIVE-agy-darwin-x64 | not_run |
| PF-LIVE-agy-darwin-arm64 | not_run |
| PF-LIVE-agy-linux-x64 | not_run |
| PF-LIVE-grok-build-windows-x64 | not_run |
| PF-LIVE-grok-build-darwin-x64 | not_run |
| PF-LIVE-grok-build-darwin-arm64 | not_run |
| PF-LIVE-grok-build-linux-x64 | not_run |
| PF-LIVE-claude-code-windows-x64 | not_run |
| PF-LIVE-claude-code-darwin-x64 | not_run |
| PF-LIVE-claude-code-darwin-arm64 | not_run |
| PF-LIVE-claude-code-linux-x64 | not_run |
| PF-LIVE-kimi-code-windows-x64 | not_run |
| PF-LIVE-kimi-code-darwin-x64 | not_run |
| PF-LIVE-kimi-code-darwin-arm64 | not_run |
| PF-LIVE-kimi-code-linux-x64 | not_run |
| PF-LIVE-qoder-windows-x64 | not_run |
| PF-LIVE-qoder-darwin-x64 | not_run |
| PF-LIVE-qoder-darwin-arm64 | not_run |
| PF-LIVE-qoder-linux-x64 | not_run |
| PF-LIVE-opencode-windows-x64 | not_run |
| PF-LIVE-opencode-darwin-x64 | not_run |
| PF-LIVE-opencode-darwin-arm64 | not_run |
| PF-LIVE-opencode-linux-x64 | not_run |
| PF-LIVE-cursor-agent-windows-x64 | not_run |
| PF-LIVE-cursor-agent-darwin-x64 | not_run |
| PF-LIVE-cursor-agent-darwin-arm64 | not_run |
| PF-LIVE-cursor-agent-linux-x64 | not_run |
| PF-COMPOSED-0-windows-x64 | not_run |
| PF-COMPOSED-0-darwin-arm64 | not_run |
| PF-COMPOSED-1-windows-x64 | not_run |
| PF-COMPOSED-1-darwin-arm64 | not_run |
| PF-COMPOSED-2-windows-x64 | not_run |
| PF-COMPOSED-2-darwin-arm64 | not_run |
| PF-COMPOSED-3-windows-x64 | not_run |
| PF-COMPOSED-3-darwin-arm64 | not_run |
| PF-COMPOSED-4-windows-x64 | not_run |
| PF-COMPOSED-4-darwin-arm64 | not_run |
| PF-COMPOSED-5-windows-x64 | not_run |
| PF-COMPOSED-5-darwin-arm64 | not_run |
| PF-COMPOSED-6-windows-x64 | not_run |
| PF-COMPOSED-6-darwin-arm64 | not_run |
| PF-COMPOSED-7-windows-x64 | not_run |
| PF-COMPOSED-7-darwin-arm64 | not_run |
| PF-NATIVE-windows-x64 | not_run |
| PF-NATIVE-darwin-x64 | not_run |
| PF-NATIVE-darwin-arm64 | not_run |
| PF-NATIVE-linux-x64 | not_run |
| PF-NATIVE-windows-arm64 | not_run |
| PF-NATIVE-linux-arm64 | not_run |

## PF-BROWSER（7项）

原完整开发合同用例原样保留。

- 层次：opentabs；入口：portable-console；超时：600秒
- 关联细项：P05-01, P05-02, P05-03, P05-04, P05-05, P05-06, P05-07, P05-08, P05-09, P05-10, P05-11, P06-01, P06-02, P06-03, P06-04, P07-01, P07-02, P07-03, P07-04, P09-01, P09-02, P09-03, P09-04, P09-05, P09-06
- 操作：启动登记preview真实控制台；按固定OpenTabs recipe检查八工具目录并保存Antigravity单工具四角色绑定；保留截图、动作结果和身份，结束仅关闭本轮标签页
- 断言：隔离预览来源与工作流身份正确；绑定持久化为Antigravity，规划实施测试复核均相同；七个稳定浏览器断言真实通过

| 稳定用例 ID | 当前状态 |
|---|---|
| PF-BROWSER-ADAPTERS | not_run |
| PF-BROWSER-COUNT | not_run |
| PF-BROWSER-MODE | not_run |
| PF-BROWSER-PLANNER | not_run |
| PF-BROWSER-IMPLEMENTER | not_run |
| PF-BROWSER-TESTER | not_run |
| PF-BROWSER-REVIEWER | not_run |

## TC-UNIT（22项）

覆盖创建时继承、精确模型、叶子约束、稳定文档读取、路径/大小拒绝、变更分类、ack和旁路保留策略。

- 层次：unit；入口：unit；超时：7200秒
- 关联细项：P11-01, P11-02, P11-03, P11-04, P11-05, P11-06, P11-07, P11-08, P11-09, P11-10, P11-11, P11-12, P11-13, P11-14, P11-15, P11-16, P11-17, P11-18, P11-19, P11-20
- 操作：构造确定的Profile/role/leaf/文档/epoch/aside纯数据夹具；逐项测试解析、校验、哈希、拒绝条件。；所有case为顶层it，fullName严格等于清单ID；模型和文本为合成数据，不调用真实CLI。
- 断言：每个稳定ID对应独立行为断言，退出码为0且无failed/skipped/missing/duplicate。；报告绑定当前workflow、plan、source snapshot、document bundle、spec、run及原始报告哈希；旧证据不能计入。

| 稳定用例 ID | 当前状态 |
|---|---|
| TC-UNIT-single-tool-all-bindings | not_run |
| TC-UNIT-explicit-role-defaults | not_run |
| TC-UNIT-task-default-isolation | not_run |
| TC-UNIT-provider-model-key | not_run |
| TC-UNIT-model-no-fallback | not_run |
| TC-UNIT-leaf-role-restrictions | not_run |
| TC-UNIT-model-cache-fingerprint | not_run |
| TC-UNIT-bundle-stable-read | not_run |
| TC-UNIT-bundle-path-escape | not_run |
| TC-UNIT-bundle-size-limit | not_run |
| TC-UNIT-diff-baseline | not_run |
| TC-UNIT-projection-not-evidence | not_run |
| TC-UNIT-change-cas | not_run |
| TC-UNIT-change-idempotency | not_run |
| TC-UNIT-change-classification | not_run |
| TC-UNIT-ack-full-read | not_run |
| TC-UNIT-epoch-fencing | not_run |
| TC-UNIT-evidence-invalidation | not_run |
| TC-UNIT-aside-context-cutoff | not_run |
| TC-UNIT-aside-no-content-persistence | not_run |
| TC-UNIT-aside-queue-policy | not_run |
| TC-UNIT-migration-history-unknown | not_run |

## TC-INTEGRATION（28项）

重点断言新epoch生效后旧令牌写入失败、停止超时不释放租约、successor唯一、旧结果不影响本轮；临时问答canary不出现在主DB事件/文档/prompt/日志/摘要。

- 层次：integration；入口：integration；超时：7200秒
- 关联细项：P11-01, P11-02, P11-03, P11-04, P11-05, P11-06, P11-07, P11-08, P11-09, P11-10, P11-11, P11-12, P11-13, P11-14, P11-15, P11-16, P11-17, P11-18, P11-19, P11-20
- 操作：使用临时SQLite、独立worktree、受控长运行子进程和可记录MCP的测试适配器，注入停止失败、重启、迟到及CAS竞争。；对照FileBroker文件、进程身份、tokens、outbox、事件和三文档逐项断言；用canary问题全文扫描主prompt与持久数据，不能只检查UI不展示。
- 断言：每个稳定ID对应独立行为断言，退出码为0且无failed/skipped/missing/duplicate。；报告绑定当前workflow、plan、source snapshot、document bundle、spec、run及原始报告哈希；旧证据不能计入。

| 稳定用例 ID | 当前状态 |
|---|---|
| TC-INTEGRATION-concurrent-task-profiles | not_run |
| TC-INTEGRATION-leaf-tester-partition | not_run |
| TC-INTEGRATION-global-profile-edit | not_run |
| TC-INTEGRATION-model-mismatch-stop | not_run |
| TC-INTEGRATION-document-watch-no-loop | not_run |
| TC-INTEGRATION-new-requirement-replan | not_run |
| TC-INTEGRATION-test-definition-change | not_run |
| TC-INTEGRATION-in-scope-instruction | not_run |
| TC-INTEGRATION-revoke-before-stop | not_run |
| TC-INTEGRATION-write-stop-race | not_run |
| TC-INTEGRATION-stop-timeout-retains-lease | not_run |
| TC-INTEGRATION-commit-critical-section | not_run |
| TC-INTEGRATION-ack-before-write | not_run |
| TC-INTEGRATION-old-ack-rejected | not_run |
| TC-INTEGRATION-late-result-rejected | not_run |
| TC-INTEGRATION-new-snapshot-required | not_run |
| TC-INTEGRATION-crash-after-outbox | not_run |
| TC-INTEGRATION-crash-after-stop | not_run |
| TC-INTEGRATION-duplicate-successor | not_run |
| TC-INTEGRATION-two-tab-stale-base | not_run |
| TC-INTEGRATION-aside-main-still-running | not_run |
| TC-INTEGRATION-aside-tools-denied | not_run |
| TC-INTEGRATION-aside-cancel-isolated | not_run |
| TC-INTEGRATION-aside-no-main-prompt | not_run |
| TC-INTEGRATION-aside-expiry-restart | not_run |
| TC-INTEGRATION-aside-upstream-storage | not_run |
| TC-INTEGRATION-aside-promote-explicit | not_run |
| TC-INTEGRATION-api-role-isolation | not_run |

## TC-E2E（12项）

真实控制台和API，验证独立任务配置、调整预览和批准、状态顺序、临时问题与转正式入口、双tab冲突保留输入。

- 层次：e2e；入口：e2e；超时：7200秒
- 关联细项：P11-18, P11-19, P11-20
- 操作：在受管preview真实API/Web中完成任务搭配、文档改向和临时问答；使用确定性测试适配器及受控子进程，不伪造后端完成状态。；两个浏览器上下文制造旧版本提交；保存截图、trace、真实返回和主任务状态；浏览器test标题严格等于清单ID。
- 断言：每个稳定ID对应独立行为断言，退出码为0且无failed/skipped/missing/duplicate。；报告绑定当前workflow、plan、source snapshot、document bundle、spec、run及原始报告哈希；旧证据不能计入。

| 稳定用例 ID | 当前状态 |
|---|---|
| TC-E2E-task-single-tool | not_run |
| TC-E2E-task-composed | not_run |
| TC-E2E-same-tool-multi-model | not_run |
| TC-E2E-leaf-override | not_run |
| TC-E2E-document-diff-preview | not_run |
| TC-E2E-change-approval | not_run |
| TC-E2E-change-status-stages | not_run |
| TC-E2E-aside-separate-panel | not_run |
| TC-E2E-aside-promote | not_run |
| TC-E2E-two-tab-conflict | not_run |
| TC-E2E-model-unavailable | not_run |
| TC-E2E-progress-denominator | not_run |

## TC-CERT（32项）

32格：8工具×4必需目标，每格运行完整交互场景。真实工具不支持原生btw或热注入时使用本设计的独立会话与Host停止机制；无法强制只读或隔离不得判通过。

- 层次：integration；入口：certification；超时：7200秒
- 关联细项：P11-04, P11-15, P11-16, P11-20
- 操作：八工具在Windows x64/macOS x64/macOS arm64/Linux x64分别运行，记录精确CLI/model/Profile和受管进程身份。；每格同时执行任务级绑定、真实改向文档交接/ack、同工具同模型旁路并发或排队、旁路工具拒绝与主记录无污染；；32格分别保留真实stdout、脱敏命令、原始JUnit、文档hash和进程退出证据；缺账号/runner为blocked，不造passed。
- 断言：每格真实执行全部子场景，不接受模型自述或只有连接探针。；报告绑定当前workflow、plan、source snapshot、document bundle、spec、run及原始报告哈希；旧证据不能计入。

| 稳定用例 ID | 当前状态 |
|---|---|
| TC-CERT-codex-windows-x64 | not_run |
| TC-CERT-codex-darwin-x64 | not_run |
| TC-CERT-codex-darwin-arm64 | not_run |
| TC-CERT-codex-linux-x64 | not_run |
| TC-CERT-agy-windows-x64 | not_run |
| TC-CERT-agy-darwin-x64 | not_run |
| TC-CERT-agy-darwin-arm64 | not_run |
| TC-CERT-agy-linux-x64 | not_run |
| TC-CERT-grok-build-windows-x64 | not_run |
| TC-CERT-grok-build-darwin-x64 | not_run |
| TC-CERT-grok-build-darwin-arm64 | not_run |
| TC-CERT-grok-build-linux-x64 | not_run |
| TC-CERT-claude-code-windows-x64 | not_run |
| TC-CERT-claude-code-darwin-x64 | not_run |
| TC-CERT-claude-code-darwin-arm64 | not_run |
| TC-CERT-claude-code-linux-x64 | not_run |
| TC-CERT-kimi-code-windows-x64 | not_run |
| TC-CERT-kimi-code-darwin-x64 | not_run |
| TC-CERT-kimi-code-darwin-arm64 | not_run |
| TC-CERT-kimi-code-linux-x64 | not_run |
| TC-CERT-qoder-windows-x64 | not_run |
| TC-CERT-qoder-darwin-x64 | not_run |
| TC-CERT-qoder-darwin-arm64 | not_run |
| TC-CERT-qoder-linux-x64 | not_run |
| TC-CERT-opencode-windows-x64 | not_run |
| TC-CERT-opencode-darwin-x64 | not_run |
| TC-CERT-opencode-darwin-arm64 | not_run |
| TC-CERT-opencode-linux-x64 | not_run |
| TC-CERT-cursor-agent-windows-x64 | not_run |
| TC-CERT-cursor-agent-darwin-x64 | not_run |
| TC-CERT-cursor-agent-darwin-arm64 | not_run |
| TC-CERT-cursor-agent-linux-x64 | not_run |

## 人工验收步骤

1. 创建A只用agy、B按阶段搭配、C同OpenCode不同模型的三个合成业务任务；观察彼此配置互不影响，修改全局默认后旧任务不变。
2. B执行中修改设计、进度说明和测试定义；预览完整diff和受影响细项，提交调整；确认先停旧运行，再批准完整新计划，新运行确认新文档后才能写入。
3. 新模型根据新需求完成实现并重跑测试；观察旧验收失效、返工项和新增分母。
4. 主任务执行时临时提问，确认回答只出现在临时面板，主任务继续；取消和清空不改主状态。选择转正式指令时必须进入可编辑预览。
5. 核对所有新旧测试当前快照证据后人工验收，再由冻结reviewer新会话只读复核；禁止让原planner持续监工。

## 规划阶段核验

本轮只运行文档、结构化合同、ID/依赖/范围和Mermaid解析渲染检查；记录见docs/process/DevFlow通用平台开发进度.md。没有执行78项产品开发，也没有调用真实执行模型。

## 临时提问入口隔离补充

TC-INTEGRATION-api-role-isolation和aside-no-main-prompt必须验证：planner/worker主MCP的tools/list不含问答工具；CLI devflow btw打开独立界面，问题在独立界面输入；问答结果不返回原模型的工具调用链。已经发入主聊天的内容不能事后伪装为未记入历史。
