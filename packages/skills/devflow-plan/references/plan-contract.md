# Plan JSON 合同

以 MCP `devflow_submit_plan` 暴露的参数 Schema 为结构真值，不要求业务项目包含 DevFlow 自身源码。MCP `devflow_submit_plan` 包含工作流 ID、版本、幂等键和 `plan`。

先读取登记项目的完整配置并计算 canonical JSON SHA-256，使用项目接口返回的配置哈希；每个仓库基线必须是已核实的 commit ID。

任务必须有 id、title、requirements、depends_on、paths、inputs、implementation、preserve、completion、test_ids、stop_conditions。路径为仓库内相对路径，禁止 `..`、反斜线和盘符；允许修改文件必须逐个明确列出。

新计划优先使用 `task_model: "native-v2"`（兼容保留 `leaf-v1`）。在 `native-v2` 下：
- 规划提供确定、完整的架构与详细设计正文，搭配精简结构化索引（包含需求、模块 `modules`、任务 `tasks`、验收项 `tests`、依赖与设计引用）；
- 验收项使用稳定业务编号，规定验证层次、场景和预期结果；具体测试名称、命令参数不在规划阶段锁定，由执行模型编写具体测试用例并在交付清单中建立映射；
- 索引不重复存储整段正文，执行模型通过原生文件工具直接阅读完整设计正文 `HANDOFF.md`。

旧细项模式 `task_model: "leaf-v1"`：保留功能分组与逐项检查用于历史兼容。同一测试组的 expected_case_ids 不允许重复。旧工作包迁移保留修改范围、基准提交和用例清单，提交新的计划版本并由用户批准。

测试必须有 id、task_ids、layer、steps、assertions、expected_case_ids、timeout_seconds；新计划只使用 unit、integration、e2e 三层。旧受管模式还需登记 command_id，历史 OpenTabs 记录保留 scene_id 兼容；native-v2 不预先绑定具体命令，不新增独立 OpenTabs 测试或豁免项。E2E 必须枚举新需求全部流程及变更影响分析确认的旧功能回归，将覆盖依据、步骤和结果断言写入正文与测试索引；Web E2E 本身使用真实浏览器，人工功能确认另行保留。在 `native-v2` 下，验收项规定稳定业务场景 ID，执行模型实现的具体测试用例通过交付映射 `acceptance_mappings` 绑定；在 `leaf-v1` 旧模式下，用例 ID 与实际报告解析结果保持一致。不适用的测试层需填写具体理由并随计划批准。

复杂任务正文必须包含至少四张 Mermaid 图，含流程图、时序图、修改边界图、任务依赖图。普通任务至少一张。正文不得出现未解决决策或交由执行模型决定的备选方案。

调用 submit_plan 后给用户审批地址并结束当前回合。控制器会生成版本化的计划与进度文档。
