# DevFlow 八工具适配方案本机核查

核查日期：2026-09-14。对应 `docs/plan/DevFlow跨平台通用工作流平台实施方案.md` 1.2 修订。环境：Windows x64；源码基线 `2316d7d`，工作区有其他正在进行的修改。

本次完成源码、官方文档及本机版本/帮助参数核查，用于修正实施合同。没有实施八适配器，没有运行真实模型、测试 MCP 往返、安装新 Skill 或执行跨平台业务闭环，下面的“通过”仅表示所列探针通过。

## 1. 本机结果

| 工具 | 版本证据 | 实际检查 | 结果与范围 |
|---|---|---|---|
| Codex CLI | npm 包 0.152.0；桌面原生 CLI 0.154.0-alpha.6.2 | npm JS 入口的 `exec --help`；桌面 exe 的 `--version` | 通过；help 明确支持 json、model、resume、read-only、ignore-user-config/rules；临时 arg0 目录出现权限警告，不据此声称鉴权可用 |
| Antigravity CLI（agy） | 1.2.2 | `--version`、`--help` | 通过；print、stream-json、conversation、model、effort 可见；正式八工具中的 Antigravity CLI，命令入口为 agy |
| Claude Code | 2.1.270 | 安装完成后发现 npm claude 入口，运行 `--version`、`--help` | 通过；print、stream-json、verbose、model、resume、tools、strict-mcp-config、settings 可见 |
| OpenCode | 1.18.30 | npm 声明入口与平台实际 exe 分别检查；实际 exe 的 `--version`、`run --help`、`debug --help` | npm 入口启动失败；实际 Windows x64 exe 通过；format json、pure、agent、model、session、dir 与 debug skill 可见 |
| Cursor Agent CLI | 2026.08.11-e8db854 | `agent.ps1 --version`、`agent.ps1 --help`，读取包装器定位规则 | 通过；print、stream-json、model、resume、workspace、MCP 可见；这是 Agent CLI，独立于编辑器 cursor 命令 |
| Kimi Code | 0.37.2 | npm 安装元信息与 `kimi --version` | 版本通过；本次未重跑其完整 headless 协议 |
| Grok Build | 无本机版本证据 | 官方 headless、MCP、Skills、权限、安装文档核查 | 本机未测 |
| Qoder CLI | 无本机版本证据 | 官方 CLI、MCP、Skills、权限、安装文档核查 | 本机未测；官方明确 Windows arm64 不支持 |

## 2. 可复核的入口与命令

路径以 `<USER_HOME>` 表示实际用户目录，避免公共文档包含私人路径。这些是本次实际发现的本机位置，不是新安装器的固定路径。

| 工具 | 本机执行入口 | 参数 |
|---|---|---|
| npm Codex | Node + `<USER_HOME>/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js` | `exec --help` |
| 桌面 Codex | `<USER_HOME>/AppData/Local/OpenAI/Codex/bin/bffc5354119c8421/codex.exe` | `--version` |
| Antigravity CLI（agy） | `<USER_HOME>/AppData/Local/agy/bin/agy.exe` | `--version`、`--help` |
| Claude Code | `<USER_HOME>/AppData/Roaming/npm/claude.ps1` | `--version`、`--help` |
| OpenCode 有效入口 | `<USER_HOME>/AppData/Roaming/npm/node_modules/opencode-ai/node_modules/opencode-windows-x64/bin/opencode.exe` | `--version`、`run --help`、`debug --help` |
| Cursor Agent | `<USER_HOME>/AppData/Local/cursor-agent/agent.ps1` | `--version`、`--help` |
| Kimi Code | `<USER_HOME>/AppData/Roaming/npm/kimi.ps1` | `--version` |

OpenCode 的 npm 声明入口 `opencode-ai/bin/opencode.exe` 实际为 479 字节文本文件，开头是 `echo "Error: opencode-ai's ...`，无法作为 Windows PE 执行；错误为“不是此操作系统平台的有效应用程序”。真实平台依赖中的 exe 能启动，因此只能判定当前 npm 入口有问题，不能判定 OpenCode 整体不可用。本次没有修改或重新安装用户的 OpenCode。

额外尝试的 Node 批量探针在当前执行环境中遭遇 `spawn EPERM`；本报告采用 PowerShell 直接调用上述入口取得的结果，不把该运行环境错误归为某一 CLI 的功能失败。

## 3. 已写入实施方案的修正

1. 八种工具分别实现适配器、客户端安装、原生模型继承、权限约束和真实终态解析；Antigravity CLI（agy）纳入正式八工具，并承担原有流程迁移。
2. 单工具模式绑定四角色，所有 AI 节点的 adapter 必须一致；测试 Agent 调普通测试程序不算第二个 AI 工具。
3. 增加 `devflow-test`，七个 Skill 在八客户端共 56 个基础安装格子；安装、发现、真实触发分别验证。
4. Grok 的 `streaming-json`、OpenCode 的 `--format json` 与各家的 `stream-json` 分别解析，不能共用一个厂商事件 schema。
5. 安装发现检查 executable 格式、CPU、实际版本与帮助协议，处理 npm 文本占位入口、重复版本、陈旧 PATH 和编辑器/Agent 混淆。
6. 单工具完整验收为八工具 × 四个必需目标，共 32 个真实闭环；本机只读探针不计入这些完成数。

## 4. 官方依据

| 工具 | 本次使用的主要资料 |
|---|---|
| Antigravity CLI（agy） | [Headless](https://www.agy.dev/docs/cli/headless/)、[Plugins 与 Skills](https://www.agy.dev/docs/cli/plugins/)、本机 1.2.2 help |
| Codex | [非交互模式](https://learn.chatgpt.com/docs/non-interactive-mode)、[Skills](https://learn.chatgpt.com/docs/build-skills) |
| Grok Build | [Headless](https://docs.x.ai/build/cli/headless-scripting)、[CLI](https://docs.x.ai/build/cli/reference)、[MCP](https://docs.x.ai/build/features/mcp-servers)、[Skills](https://docs.x.ai/build/features/skills-plugins-marketplaces) |
| Claude Code | [Headless](https://code.claude.com/docs/en/headless)、[CLI](https://code.claude.com/docs/en/cli-reference)、本机 2.1.270 help |
| Kimi Code | [命令参考](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command) |
| Qoder | [脚本运行](https://docs.qoder.com/cli/run-in-scripts)、[MCP](https://docs.qoder.com/cli/mcp-servers)、[Skills](https://docs.qoder.com/cli/Skills)、[安装及架构限制](https://docs.qoder.com/cli/installation) |
| OpenCode | [CLI](https://opencode.ai/docs/cli/)、[配置](https://opencode.ai/docs/config/)、[MCP](https://opencode.ai/docs/mcp-servers/)、本机 run/debug help |
| Cursor | [参数](https://prod.cursor.com/docs/cli/reference/parameters)、[安装](https://prod.cursor.com/docs/cli/installation)、[MCP](https://prod.cursor.com/docs/cli/mcp)、[Skills](https://cursor.com/docs/skills) |

最终支持状态以实施方案第 14 节对应发布 commit 的完整认证为准。当前本机结果不代表其他操作系统、其他 CLI 版本或账号配置已经通过。
