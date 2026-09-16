# 复核结果合同

读取 `ReviewSchema`。必须返回匹配的 review_request_id、workflow_id、plan_revision、snapshot_id，以及完整 coverage 和 findings。

tests_validity_checked 只有在适用的单元、集成、E2E 三层及新需求全流程、受影响旧功能回归覆盖完成核对后才为 true；Web E2E 需核实真实浏览器、应用、后端、测试数据与结果断言。独立 OpenTabs/真实浏览器验收不再是必需证据，用户功能确认仍保留。漏测或伪测试应记录具体 finding；无法获得必要证据时 verdict 为 incomplete。

coverage.files 用 `repo_id:path` 枚举每个变更文件。必须逐项确认 all_changed_files_reviewed、all_requirements_checked、upstream_downstream_checked、security_checked、tests_validity_checked。未完成检查时 verdict 为 incomplete。

每项 finding 提供严重性、文件与行号、触发条件、证据和后果，并区分 introduced、in_scope、historical、suggestion；误报和范围外项必须写明处置依据。

确认当前范围问题时 verdict 为 findings，repair_plan 为完整的 Plan JSON；只有缺少必要用户决策时可将 repair_plan 设为 null 并列出 unresolved_questions。不得在未知情况下编造确定方案。

通过时 verdict 为 pass、repair_plan 为 null、unresolved_questions 为空，给出符合项目约定的本地提交消息。复核者只读，服务端负责提交。
