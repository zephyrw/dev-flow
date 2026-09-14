# DevFlow 阶段更新报错验收合同

修复必须同时满足：到期前合法claim不因凭证抢先失效被拒；到期后拒绝新任务操作并明确TIMEOUT；真实停止原因保留；界面显示执行暂停与原因；继续保留原工作流但使用新run和凭证；旧权限与证据不可复用。

## 当前调查证据
现行版本7项相关回归全部通过。隔离复现验证401被包装成POLICY_DEFAULT_DENY、130无result被归为EXECUTION_FAILED。此处不宣称修复完成。

## 固定测试清单
### U-ADAPTER / unit
层：unit；关联细项：T01；超时600秒。
- DF-STAGE-U01 rejects missing isolated preview environment

操作：用隔离临时目录调用适配器，删除必需的环境变量后启动preview。
断言：缺少端口、数据目录或identity即拒绝；不访问默认4810。

### U-DEADLINE / unit
层：unit；关联细项：T02；超时600秒。
- DF-STAGE-U02 one deadline includes preparation time
- DF-STAGE-U03 credential grace never authorizes expired run
- DF-STAGE-U04 first termination reason wins

操作：虚拟时钟覆盖截止前1ms、到期0ms、余量窗口，模拟准备耗时及停止竞争。
断言：单一绝对截止时间；到期后工具拒绝；人工与timeout首因稳定。

### U-FAILURE / unit
层：unit；关联细项：T03；超时600秒。
- DF-STAGE-U05 policy reasons stay distinct from model auth
- DF-STAGE-U06 timeout without result retains TIMEOUT
- DF-STAGE-U07 exit 130 alone does not prove timeout

操作：对模拟ManagedProcess分别送入显式timeout、只有130、协议失败；校验脱敏分类。
断言：超时保留TIMEOUT；不从130猜原因；无内部凭证泄漏。

### U-LOG / unit
层：unit；关联细项：T04；超时600秒。
- DF-STAGE-U08 blocked event explains timeout without inventing history

操作：投影含blocker及历史不含blocker的StateChanged，混合不同run。
断言：暂停原因来自当前事件；旧历史使用中性文案；任务/测试计数不变。

### I-DEADLINE / integration
层：integration；关联细项：T02；超时600秒。
- DF-STAGE-I01 policy rejects at shared deadline before token expiry
- DF-STAGE-I02 process timeout and manual stop remain distinct
- DF-STAGE-I03 resumed run rejects old worker

操作：使用隔离SQLite及真实Engine/API，虚拟时钟注入60分钟截止；真实短时进程测试超时/人工停止；受控runtime执行恢复流程。
断言：到期前允许，到期后TIMEOUT且无任务证明写入；只停止本run；新run/凭证有效，旧凭证和旧run拒绝；不自动提交或跳过测试。

### I-POLICY / integration
层：integration；关联细项：T03；超时600秒。
- DF-STAGE-I04 hook preserves policy failure categories
- DF-STAGE-I05 hook rejects malformed or mismatched allow response
- IT-09 Windows Hook preserves Chinese JSON and enforces live run revocation

操作：以真实Windows Hook进程连接随机端口模拟policy响应：401/403/TIMEOUT/500/非JSON/超时；重复原撤销回归。
断言：全部失败为deny；固定安全原因准确；仅allowed且工具匹配的2xx允许。

### I-CERT / certification
层：integration；关联细项：T01；超时600秒。
- test DF-STAGE-C01 typecheck and whitespace pass

操作：node:test测试真实调用npm run typecheck与git diff --check并检查返回码；Node内建JUnit报告写批准路径。
断言：两个实际命令都为0才通过，未运行和失败不能输出passed。

### E-PAUSE / e2e
层：e2e；关联细项：T04；超时600秒。
- DF-STAGE-E01 timeout preserves progress and manual continuation
- DF-STAGE-E02 manual and historical pauses are not mislabeled

操作：隔离预览中打开真实Edge页面，使用稳定合成工作流和事件，查看任务进度、执行日志、暂停提示与继续按钮。
断言：显示明确到期原因；仍为6/42和0/81；未自动恢复/审批；人工停止和无原因历史不显示编造的到期解释；保存截图与trace。


## 原始报告
unit/integration为Vitest JSON；e2e为Playwright JSON并保存截图、trace；certification为node:test原生JUnit。报告优先输出DEVFLOW_REPORT_PATH，默认对应已登记.reports/portable-*.json或xml。不允许跳过、空报告、复制历史报告或手写passed。

## 人工验收
打开本分支隔离预览，观察到期暂停、任务进度6/42与测试0/81、可见继续入口。自动测试不得触发真实CRM的继续、审批、数据库写入或凭证修改。人工停止及旧历史事件不能被标成超时。人工验收之后才触发独立复核。

## OpenTabs豁免
现有固定场景portable-console仅覆盖未落地的八工具设置。该场景不适用；登记修改会影响另一待审批计划。本次Playwright使用真实Edge页面，真实Hook/API及进程集成负责实际执行边界。豁免与本计划一并审批。



执行分组：U-ADAPTER/U-DEADLINE/U-FAILURE/U-LOG合并为U-ALL，I-DEADLINE/I-POLICY合并为I-ALL，每条命令运行一次；I-CERT与E-PAUSE保持独立。以上用例编号均保留。原生Node JUnit默认classname=test，因此certification完整用例ID含test前缀。
