# 复核结果合同

<!-- devflow-plan-authority:v1 -->
## 指定计划为执行依据，禁止执行模型另建计划

本节约束执行角色，不禁止经授权的规划角色首次制定计划或正式修订计划。用户指定/批准的原计划及正式引用的设计、整改版本共同构成执行依据；原有用户指令及后续明确范围变更继续有效。

执行模型必须完整读取原文并保留路径、现有版本/hash和任务/验收编号。禁止额外创建、重写或更新 implementation_plan.md、客户端计划工件、局部实施计划或其他替代方案，再按自己的版本开发；禁止把“细化”“重新组织”“先做核心”作为缩减原范围、接口链路、依赖顺序和验收条件的理由。即使同一工具/模型兼任规划和执行，当前执行角色也不能自行转为规划角色、自行批准改写。

只允许维护标明“执行进度（非计划）”的事实记录：原编号/章节→实际实现→原始测试证据→当前状态/未完成原因。不重定义设计或任务，不把记录作为新的执行依据。客户端自动产生的计划工件不自动取得授权，不能据其替代原文。

发现原文不可实施或存在设计冲突时，执行模型提交原章节、代码证据和受影响条目，暂停受阻部分，交规划模型修订原计划的正式版本；不受影响的既定工作可继续。范围内整改沿用现有授权，改变业务需求/批准范围才按原流程取得用户确认。审查和交付始终逐项核对原计划完整要求；替代清单全勾选或旧反例不再命中不能作为完成证据。

读取 `ReviewSchema`。必须返回匹配的 review_request_id、workflow_id、plan_revision、snapshot_id，以及完整 coverage 和 findings。

tests_validity_checked 只有在适用的单元、集成、E2E 三层及新需求全流程、受影响旧功能回归覆盖完成核对后才为 true；Web E2E 需核实真实浏览器、应用、后端、测试数据与结果断言。独立 OpenTabs/真实浏览器验收不再是必需证据，用户功能确认仍保留。漏测或伪测试应记录具体 finding；无法获得必要证据时 verdict 为 incomplete。

coverage.files 用 `repo_id:path` 枚举每个变更文件。必须逐项确认 all_changed_files_reviewed、all_requirements_checked、upstream_downstream_checked、security_checked、tests_validity_checked。未完成检查时 verdict 为 incomplete。

每项 finding 提供严重性、文件与行号、触发条件、证据和后果，并区分 introduced、in_scope、historical、suggestion；误报和范围外项必须写明处置依据。

确认当前范围问题时 verdict 为 findings，repair_plan 为完整的 Plan JSON；只有缺少必要用户决策时可将 repair_plan 设为 null 并列出 unresolved_questions。不得在未知情况下编造确定方案。

通过时 verdict 为 pass、repair_plan 为 null、unresolved_questions 为空，给出符合项目约定的本地提交消息。复核者只读，服务端负责提交。

repair_plan 的正文和每项任务还必须满足 [整改文档合同](repair-document-contract.md)：稳定问题映射、唯一设计、精确修改边界、依赖步骤、正反向验收和旧功能回归、完成/停止条件。旧 ReviewSchema 的 Plan JSON 与新 QualityReviewResult 的阶段性修复项均不能只填原则性建议；合同缺项先由规划模型补全，不能交给执行模型自由设计。

<!-- devflow-executor-plan-self-check:v1 -->
## 程序调度的正式计划逐项复核

native-v2 每轮初始开发、正式整改或用户反馈修复完成后，执行顺序固定为：完整开发 → 统一测试 → 交付核验及执行成功退出 → 程序再次调起执行模型对照正式计划逐项复核 → 核清全部遗漏/偏离的根因、整批修复后统一测试、交付核验及成功退出 → 规划模型独立代码质量审查。不得直接开放人工核验或把首次完成自述当成这次复核。人工核验前的质量审查通过后才交用户；人工核验后的整改也不能跳过执行复核。

复核必须重新读原始计划及当前正式批准的整改/修订全文，按原编号关联真实实现、测试和未完成项。使用 AUTHORITATIVE_PLANS.json、HANDOFF.md 与 handoff.json 中程序给出的版本及 self_check.check_ids；正式范围变更引用对应批准修订。禁止创建或使用 implementation_plan.md、客户端计划工件或其他局部计划替代原文。逐项报告属于执行事实记录，不是另一份实施计划。

当前复核轮次的交付清单必须包含 plan_self_check，并符合 plan-self-check.schema.json：绑定请求、源交付、当前 run_id、plan_revision、plan_hash、authority_hash；完整覆盖全部 check_ids，逐项提供代码/测试报告/用例定位，记录发现问题及实际修复证据。遗漏、重复编号、空证据、未解决问题、旧轮次/旧计划/旧输入报告、进程失败均阻断规划审查；代码改动后提交当前轮次有效测试与新交付。正常开发轮次不能自行填报告冒充程序调度。

程序校验报告及当前交付的绑定和完整性，不能保证模型判断语义正确；规划模型仍须独立检查实际代码、测试真实性与原计划覆盖。缺少本轮有效自查报告不得放行。自查不计入任何质量关卡的三次拒绝次数；暂停/停止后不得自行继续，不新增后台轮询，不改变既有界面布局。
