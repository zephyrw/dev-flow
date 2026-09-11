# Plan JSON 合同

以 MCP `devflow_submit_plan` 暴露的参数 Schema 为结构真值，不要求业务项目包含 DevFlow 自身源码。MCP `devflow_submit_plan` 包含工作流 ID、版本、幂等键和 `plan`。

先读取登记项目的完整配置并计算 canonical JSON SHA-256，使用项目接口返回的配置哈希；每个仓库基线必须是已核实的 commit ID。

任务必须有 id、title、requirements、depends_on、paths、inputs、implementation、preserve、completion、test_ids、stop_conditions。路径为仓库内相对路径，禁止 `..`、反斜线和盘符；允许修改文件必须逐个明确列出。

测试必须有 id、task_ids、layer、command_id 或 scene_id、steps、assertions、expected_case_ids、timeout_seconds。用例 ID 必须与实际报告解析结果完全一致。不适用的测试层需填写具体理由并随计划批准。

复杂任务正文必须包含至少四张 Mermaid 图，含流程图、时序图、修改边界图、任务依赖图。普通任务至少一张。正文不得出现未解决决策或交由执行模型决定的备选方案。

调用 submit_plan 后给用户审批地址并结束当前回合。控制器会生成版本化的计划与进度文档。
