# DevFlow 跨平台通用工作流平台

DevFlow 是一个面向现代 AI 编程助手（Codex、Antigravity CLI、Claude Code、Cursor Agent、Kimi Code、Grok Build、Qoder、OpenCode）的轻量级调度与全生命周期协同平台。

## 核心特性

- **跨平台与单进程互斥**：提供用 Go 编写的高性能本地宿主守护进程（`devflow-host`），基于 Windows JobObject / POSIX 进程组精准强杀进程树，并以具名互斥体/flock 维护严格单控制器所有权。
- **两道质量防线与自动接管**：
  1. 开发与自测 → 人工前代码质量审查/整改 → 人工功能确认/修复 → 人工后代码质量审查/整改 → 安全本地交付。
  2. 首次发现问题不计失败；两阶段分别在执行模型完成正式整改后，连续三次独立复核仍不合格才由规划模型接管。编译、测试、超时及基础设施失败不计入质量整改次数，也不触发换模型；复核通过清零连续次数。平台调度角色切换，不核验测试证明。
- **零污染安全 Git 交付**：主工作区模式下强制使用独立临时 `GIT_INDEX_FILE`，仅暂存任务批准变更，绝对不破坏或夹带用户原有的 staged/unstaged 文件。
- **旁路提问 (/btw)**：全局单活跃槽位管控，支持只读提问、排队、完成唤醒与幂等转正式反馈，绝不中断主执行链路。工作台用常驻输入框识别 `/btw`、`/side`，并以非模态浮窗展示项目提问历史；已不再使用临时提问 Tab 或整页弹窗。
- **会话树展示**：执行过程底部列出当前主会话下的子 Agent；暂停全部只作用于该树。各客户端能力以探测结果为准，未知保持 unknown，不把八种工具都当成已完整支持子 Agent。
- **附件上限**：单个文件 20MiB，普通 JSON 8MiB；文件正文仅专用上传接口接受 `application/octet-stream`。
- **多客户端渲染与 Skill 白名单分发**：支持 8 大主流客户端的 MCP 配置解析与 6 个标准 DevFlow Skill（`devflow`, `devflow-project-onboard`, `devflow-plan`, `devflow-execute`, `devflow-test`, `devflow-review`）递归安全分发。
- **前端真实浏览器核验与通用人机交互**：前端相关任务保留单元/集成/E2E 三层测试，执行模型额外使用原生 OpenTabs 操作真实浏览器进行仿人工核验，实际核对视觉截图与可见数据；本地场景优先免密开发会话；确需人工登录或决策时通过通用弹窗暂停，用户确认后无缝续接原执行上下文。
- **worktree 本地环境与端口隔离**：每个独立 worktree 拥有独立的前端、后端、E2E 测试与调试端口，同步更新 API 代理与开发 Origin；临时端口清单与运行文件仅保存在本地忽略目录中，绝对不提交、不合并回主工作区。

## 快速开始

### 运行环境

- Node.js >= 22.23.2
- pnpm 11.7.0
- Go >= 1.24 (用于编译跨平台 Host)

### 常用命令

```powershell
# 1. 静态类型检查
pnpm typecheck

# 2. 构建服务、runner 和 credential worker
pnpm build             # 前端与 Node API 构建

# 3. 运行自动化测试（使用上一步生成的受管子进程入口）
pnpm test:unit         # 单元测试
pnpm test:integration  # 集成测试
pnpm test              # 全量自动化测试

# 4. 启动服务
pnpm start             # 启动 DevFlow 本地 API 服务
```

## 验证边界

八种客户端均有独立适配器和配置/Skill 分发入口。版本和帮助探测仅表示发现了客户端，不代表真实模型工作流已经认证，也不代表该工具已完整支持子 Agent；平台状态见 `compatibility.json`。自动回归使用隔离 Git、SQLite、真实后端/浏览器及外部 CLI 子进程替身。

使用入口见 [使用指南](docs/guide/使用指南.md) 与 [使用与恢复指南](docs/guide/使用与恢复指南.md)。

发布包包含 Node、koffi 原生依赖、服务及六个 Skill。进程管理与 Windows 凭据 worker 统一由 Node 实现。尚未安装或未通过探测的所选客户端返回退出码 10，登录与原生客户端安装需按该客户端指引完成。发布资产由 CI 生成，未发布前不能声称远程一行安装命令已可下载。

## 许可证

[Apache License 2.0](LICENSE)
