# DevFlow 跨平台通用工作流平台

DevFlow 是一个面向现代 AI 编程助手（Codex、Antigravity CLI、Claude Code、Cursor Agent、Kimi Code、Grok Build、Qoder、OpenCode）的轻量级调度与全生命周期协同平台。

## 核心特性

- **跨平台与单进程互斥**：提供用 Go 编写的高性能本地宿主守护进程（`devflow-host`），基于 Windows JobObject / POSIX 进程组精准强杀进程树，并以具名互斥体/flock 维护严格单控制器所有权。
- **两道质量防线与自动接管**：
  1. 开发自测 → 程序调度执行模型逐项复核正式计划（问题修复及重测） → 第一次规划模型审查/整改 → 人工功能确认/修复 → 第二次质量审查/整改 → 安全本地交付。
  2. 审查文档严格对齐 `repair-document-contract` 契约，两阶段独立执行“三次失败规划模型自动接管”。
- **零污染安全 Git 交付**：主工作区模式下强制使用独立临时 `GIT_INDEX_FILE`，仅暂存任务批准变更，绝对不破坏或夹带用户原有的 staged/unstaged 文件。
- **旁路提问 (/btw)**：全局单活跃槽位管控，支持只读提问、排队、完成唤醒与幂等转正式反馈，绝不中断主执行链路。
- **多客户端渲染与 Skill 白名单分发**：支持 8 大主流客户端的 MCP 配置解析与 6 个标准 DevFlow Skill（`devflow`, `devflow-project-onboard`, `devflow-plan`, `devflow-execute`, `devflow-test`, `devflow-review`）递归安全分发。

## 快速开始

### 运行环境
- Node.js >= 22.23.2
- pnpm 11.7.0
- Go >= 1.24 (用于编译跨平台 Host)

### 常用命令
```powershell
# 1. 静态类型检查
pnpm typecheck

# 2. 运行自动化测试
pnpm test:unit         # 单元测试
pnpm test:integration  # 集成测试
pnpm test              # 全量自动化测试

# 3. 生产打包构建
pnpm build             # 前端与 Node API 构建
pnpm build:host        # 跨平台 Go Host 编译

# 4. 启动服务
pnpm start             # 启动 DevFlow 本地 API 服务
```

## 验证边界

八种客户端均有独立适配器和配置/Skill 分发入口。版本和帮助探测仅表示发现了客户端，不代表真实模型工作流已经认证；平台状态见 `compatibility.json`。自动回归使用隔离 Git、SQLite、真实后端/浏览器及外部 CLI 子进程替身。未提供有效执行事实的客户端轮次会阻断交付，不返回占位成功。

发布包包含 Node、Go Host、服务及六个 Skill。尚未安装或未通过探测的所选客户端返回退出码 10，登录与原生客户端安装需按该客户端指引完成；不会把它们标成真实模型验收通过。发布资产由 CI 生成，未发布前不能声称远程一行安装命令已可下载。

## 许可证
[Apache License 2.0](LICENSE)
