# Plan JSON 合同

以 MCP `devflow_submit_plan` 暴露的参数 Schema 为结构真值，不要求业务项目包含 DevFlow 自身源码。MCP `devflow_submit_plan` 包含工作流 ID、版本、幂等键和 `plan`。

先读取登记项目的完整配置并计算 canonical JSON SHA-256，使用项目接口返回的配置哈希；每个仓库基线必须是已核实的 commit ID。

任务必须有 id、title、requirements、depends_on、paths、inputs、implementation、preserve、completion、test_ids、stop_conditions。路径为仓库内相对路径，禁止 `..`、反斜线和盘符；允许修改文件必须逐个明确列出。

新计划使用 `task_model: "leaf-v1"`，`modules: [{id,title}]` 保存功能分组，每个 `tasks` 元素是一项可独立说明完成结果的细项，包含 `module_id` 和 `completion_checks: [{path,contains}]`。检查路径必须在该细项 paths 内，contains 至少五个字符，应选择具体实现或测试断言标志，不能把通用 import、类声明或占位代码当成功能完成证明。完成标准还需写清业务结果和对应测试，执行说明、实际文件、测试、人工验收与独立复核共同检查交付。分母分别统计细项和各测试组的 expected_case_ids，模块不叠加计数。

同一测试组的 expected_case_ids 不允许重复。旧工作包迁移保留修改范围、基准提交和用例清单，提交新的计划版本并由用户批准，不能把旧工作包声明复制成各细项的完成记录。

测试必须有 id、task_ids、layer、command_id 或 scene_id、steps、assertions、expected_case_ids、timeout_seconds。用例 ID 必须与实际报告解析结果完全一致。不适用的测试层需填写具体理由并随计划批准。

复杂任务正文必须包含至少四张 Mermaid 图，含流程图、时序图、修改边界图、任务依赖图。普通任务至少一张。正文不得出现未解决决策或交由执行模型决定的备选方案。

调用 submit_plan 后给用户审批地址并结束当前回合。控制器会生成版本化的计划与进度文档。
