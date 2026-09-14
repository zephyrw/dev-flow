---
name: devflow-execute
description: 在 DevFlow 已批准合同内执行明确任务，提交真实变更和证据声明
---

1. 首先调用 devflow_execute_context，然后按 section 读取 plan、skill、tasks、tests、scope、feedback、environment。next_offset 非 null 必须继续读取完整分段；参数可用 section=tool、id=工具名查询。大响应使用 section=response、id=response_id 分页，不调用原生 view_file 读取 agy 临时文件。
2. 核对 workflow、revision、package hash、阶段和 task IDs；不匹配就报告阻塞。
3. 按 DAG 顺序实施，仅使用受控文件工具与已登记 check ID。
4. 修改前读取文件并取得 hash；变更必须符合允许路径和既定核心算法。
5. 不修改冻结计划、进度真值、控制配置、权限、共享仓库状态或发布凭证。
6. 编写有效回归测试，先证明目标失败能被测试捕获，再实施局部修复。
7. 检查命令由 Runner 执行；禁止把文字总结或旧报告当作通过证据。
8. devflow_claim_task 仅提交实现声明，程序验证后才会勾选。
9. 当前计划不可行、需要新增范围、协议/依赖/数据变化时提交 blocker 并停止。
10. 用户反馈在原范围内则按反馈修复；仍需重跑验证，不绕过人工验收。
11. 明确报告本轮实现、检查、未完成项与阻塞；不直接提交、不推送、不发布。
12. 本轮结束释放模型资源；不要自己循环等待长测试或浏览器资源。

完成代码修改后调用 devflow_freeze。逐项 devflow_run_check，全部通过后 devflow_finish 并结束当前回合。

## 细项进度

上下文 task_model=leaf-v1 时，先调用 devflow_start_task(task_id, summary) 开始细项；同一任务可更新 summary 描述实际进展。文件修改只能落在当前细项批准的 paths。前置任务需完成实现核验。完成后调用 devflow_claim_task，平台检查 completion_checks 并保存文件哈希；检查不通过就修正，不能跳到下一项。任务全部实现后 freeze，再按测试清单逐项运行，直至 finish。旧计划没有 task_model 时继续旧合同，不能自行猜测子任务或上报不存在的编号。

测试失败或共享文件修改可能使已完成细项需要重新检查。按依赖顺序返回受影响细项，核对实际代码和完成标准后重新提交结果。允许切换到前置细项修复；切换不会把上一细项自动标为完成。只匹配到类名、import 或占位代码不代表业务已经实现，禁止据此虚报。

发给用户的中文进展只说明正在处理的功能、实际修改、测试结果与需要用户处理的问题。不要重复工具名、工作流编号、运行编号、快照哈希和内部状态枚举；这些由平台技术详情保存。测试未结束时不得声称已通过，服务开始输出时不得声称已就绪。
