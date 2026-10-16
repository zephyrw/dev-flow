# DevFlow

**本地运行的 AI 开发工作流调度器。**

为规划、开发和复核选择合适的工具与模型，让需求、计划、代码和反馈在同一任务中衔接。你在工作台确认计划、查看进度、验收结果。

[开始使用](#开始使用) · [使用指南](docs/guide/使用指南.md) · [安装与升级](docs/guide/安装与升级.md) · [Releases](https://github.com/zephyrw/dev-flow/releases)

## 从需求到交付

```mermaid
flowchart LR
    A["需求与计划"] --> B["你批准计划"]
    B --> C["AI 开发与测试"]
    C --> D["代码质量复核"]
    D --> E["你验收功能"]
    E --> F["最终复核<br/>本地交付"]

    classDef agent fill:#eff6ff,stroke:#3b82f6,color:#1e3a8a
    classDef human fill:#fff7ed,stroke:#f59e0b,color:#7c2d12
    classDef delivery fill:#ecfdf5,stroke:#10b981,color:#064e3b
    class A,C,D agent
    class B,E human
    class F delivery
```

代码或功能问题在原任务中修复；推送与发布由你另行授权。完整分工见 [职责与调度](packages/skills/devflow/references/role-and-schedule.md)。

| 能力 | 你可以做什么 |
| --- | --- |
| **模型分工** | 分别配置规划、执行与复核模型，自动衔接各阶段 |
| **过程可见** | 在工作台查看计划、执行日志与代码差异，随时暂停或反馈 |
| **任务续接** | 保留上下文与进度，中断后从原任务继续 |
| **范围可控** | 按批准的范围修改，保留已有工作，只提交本次任务变更 |

## 开始使用

### 一行安装

支持 **Windows x64、macOS Intel / Apple Silicon、Linux x64**。安装包内置 Node.js 和运行依赖，无需先搭建 DevFlow 开发环境。

**macOS（Intel / Apple Silicon）与 Linux x64**

```bash
bash -o pipefail -c 'curl -fsSL https://github.com/zephyrw/dev-flow/releases/latest/download/install.sh | bash'
```

**Windows x64 · PowerShell**

```powershell
irm -ErrorAction Stop https://github.com/zephyrw/dev-flow/releases/latest/download/install.ps1 | iex
```

安装完成后，用 `devflow` 打开工作台，按提示接入编程助手、完成授权并选择模型。固定版本、离线安装与更新方法见 [安装与升级](docs/guide/安装与升级.md)。

### 从源码运行

获取源码后，准备 **Node.js ≥ 22.23.2** 和 **pnpm 11.7.0**，在仓库目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

服务启动后打开 [本地工作台](http://localhost:4810)。客户端与 Skill 配置、开发及检查入口见 [开发指南](docs/development/开发指南.md)。

### 第一个任务

安装并配置 DevFlow 后，以 Codex 为例：打开你的业务项目，新建任务并输入：

> 用 DevFlow 帮我修复客户列表筛选的问题：选择负责人后，列表没有变化。先给我计划，确认后再修改。

随后在工作台批准计划、查看执行过程并验收功能。

## 客户端与平台

已实现 **Codex、Antigravity CLI、Claude Code、Cursor Agent、Kimi Code、MiMo Code、Grok Build、Qoder、OpenCode** 的客户端适配。

安装包构建目标为 **Windows x64、macOS Intel / Apple Silicon、Linux x64**。各平台与客户端的实测范围见 [客户端兼容性](docs/guide/客户端兼容性.md)；macOS Apple Silicon 的完整包安装与 AGY 任务记录见 [验收记录](docs/test/macos-install-20261008/验收记录.md)。

## 使用须知

- 模型账号、订阅和额度由所选客户端或服务商提供。
- DevFlow 在本机运行；调用云端模型时，客户端会发送任务所需内容。
- 关闭网页不会停止任务。暂停、反馈与恢复在工作台操作。
- 代码检查与测试由相应模型执行，功能验收由你完成；DevFlow 负责调度与展示。

## 文档与贡献

| 文档 | 内容 |
| --- | --- |
| [使用指南](docs/guide/使用指南.md) | 首个任务、计划审批、反馈与验收 |
| [安装与升级](docs/guide/安装与升级.md) | 安装、更新、诊断与卸载 |
| [使用与恢复](docs/guide/使用与恢复指南.md) | 日常操作与任务中断恢复 |
| [客户端兼容性](docs/guide/客户端兼容性.md) | 工具、平台及验证范围 |
| [开发指南](docs/development/开发指南.md) · [贡献指南](CONTRIBUTING.md) | 工具链、构建、测试与贡献流程 |

## 许可证

[Apache License 2.0](LICENSE)
