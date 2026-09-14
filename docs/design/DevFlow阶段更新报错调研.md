# DevFlow 阶段更新报错调研
日期：2026-09-14。排障工作流：wf-203cb2b8-aff1-4da5-9a22-495dcacafe4a。

结论：截图不是阶段迁移接口本身失败。旧执行轮次在60分钟边界先失去worker凭证，合法任务工具被Hook拒绝；随后进程退出，实际原因没有传入展示层。需要统一截止时间、保留结构化失败原因，并明确展示到期暂停。

## 已确认事实
原工作流 wf-9fe59b2c-e9cb-4ddd-aa9e-07dd05d3f2e3，计划第2版；执行轮次 run-15e5b307-6cd4-4a59-a24e-7bcc2ef208f6。
时间均为北京时间，数据库原值为UTC：

| 时刻 | 事实 | 证据 |
|---|---|---|
| 15:58:02.916 | 本轮开始 | run.started_at |
| 16:57:55.307 | T02-01实现核验完成 | 事件3111 |
| 16:58:01.345 | T02-02开始成功 | 事件3116 |
| 16:58:03.057 | 本轮worker凭证过期 | tokens仅只读提取角色、run_id、expires，不输出凭证或哈希 |
| 16:58:06.995 | 第一次claim被Hook拒绝 | 事件3120：tool call denied by pre-tool hook: POLICY_DEFAULT_DENY |
| 16:58:10附近 | 第二次claim被同样拒绝 | 事件3123 |
| 16:58:12.299 | Host登记进程退出，code=130 | process_record |
| 16:58:12.304 | EXECUTING正常转为BLOCKED | 事件3124，仅含from/to/stage |
| 16:58:12.306 | run记录通用执行失败 | run.result |

当前凭证已撤销。上述过期时刻早于两次失败，是可直接验证的触发条件。日志没有result、AgentDiagnostic或人工Stopped事件。code=130是Host终止Job使用的码，现有记录无法仅凭该退出码区分超时或人工停止；结合60分钟配置与调用链可判定这是需要修复的截止边界，但不能声称现有日志记录了明确的timeout原因。
T02-02这两次claim未进入completion_checks，不能据此判断CRM实现或测试通过。已完成6/42、测试0/81是业务现场状态，不是本次修复验证结果。

## 代码链路
- packages/core/src/engine.ts：dispatch签发token时即开始按agent_minutes计时；worker检查凭证和run归属；block把FlowError保存为blocker。
- packages/core/src/auth.ts：expires <= Date.now()返回401 UNAUTHORIZED。
- packages/runtime/src/runtime.ts：完成容器与会话准备后才启动ProcessManager，另从启动点计时60分钟。
- packages/bridge/src/hook.ts：非2xx响应不解析错误，保持POLICY_DEFAULT_DENY。
- packages/process/src/manager.ts：超时调用与手动停止共用stop，completion只保留code/signal。
- packages/adapters/agy/src/session.ts：只从result和stderr分类；无result且stderr空时得到EXECUTION_FAILED。
- packages/presentation/src/activity.ts：BLOCKED的StateChanged显示“阶段更新”，没有具体blocker说明。

## 可重复验证
隔离脚本 .cache/stage-error-repro.mjs 使用合成凭证及本机随机端口，未向业务服务发起写请求：
1. 固定时钟在16:58:01，verify成功。
2. 推进至16:58:05，得到UNAUTHORIZED / 401。
3. 本机合成401响应经过当前已构建Hook，得到deny / POLICY_DEFAULT_DENY。
4. 无result、code=130的模拟进程经过observeAgy，得到EXECUTION_FAILED。
输出 .cache/stage-error-repro.json；现有hook/process/logs 7项基线测试通过，报告 .cache/stage-error-baseline.json。没有编写或修改产品实现。

## 环境与边界
入口锁定基线 d5bc298ac5be27a28a9a641be8ef583486da2c1a，新worktree隔离。调查期间主工作区出现另一提交25a1f919cd79e7b0234d6194cba92dbf6261b894（工作台视觉布局）；本计划仍按入口基线，不覆盖该提交，后续集成必须单独处理并重验。
原CRM工作区 D:/Code/crm/crm 不在修改范围。保持其原审批、会话、范围与证据门禁。
项目已登记commands引用 scripts/devflow/verify.mjs，但当前基线没有该文件；必须随本计划补齐最小执行适配。保留项目配置哈希，不改另一项待审批八工具计划。
已登记OpenTabs场景仅验证未来八工具设置，与本故障无关；本次明确申请豁免OpenTabs，用Playwright真实Edge渲染隔离故障夹具，并以真实Hook/API集成测试覆盖鉴权链路。

