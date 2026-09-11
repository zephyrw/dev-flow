---
name: devflow-browser-accept
description: 在获得场景租约后通过现有 OpenTabs 验证真实 UI 操作并采集可核对证据
---

1. 读取当前场景、snapshot、环境 revision、URL 和测试账号引用。
2. 由项目接入时登记固定 OpenTabs recipe；执行时调用 devflow_run_check，控制器按批准场景调用真实 OpenTabs 工具并校验结果断言。不能自由增加浏览器脚本。
3. 每次切换页面检查 workflow 标记、账号、tab ID 和允许 origin。
4. 按步骤点击、输入、提交、刷新并检查结果；后端 API 调用不能替代 UI 验收动作。
5. 对照场景断言收集截图、工具轨迹和可用的 console/network 证据。
6. 不进入 DevFlow 审批页面，不批准自己的工作，不导航其他任务或生产系统。
7. 用户接管、场景租约撤销或身份不符时立即停止操作。
8. 证据不够就报告缺口；不修改源码，不虚构通过，不扩大场景。
